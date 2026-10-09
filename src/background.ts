import {
  startDeviceFlow,
  pollForAccessToken,
  getStoredToken,
  getCurrentUser,
  disconnectGitHub,
  hasGitHubAccess,
  listRepos,
  saveFileToRepo,
  starProject,
  commitFiles,
} from "./github.ts";
import {
  connectNotionWithToken,
  createNotionPage,
  disconnectNotion,
  getNotionConnection,
  listNotionPages,
} from "./notion.ts";
import type { NotionBlock } from "./notion-blocks.ts";
import { initI18n, t } from "./i18n.ts";
import { decodeBase64, copyToArrayBuffer, encodeBlobBase64 } from "./zip.ts";
import { asciiFileName, isSafeFileName } from "./file-names.ts";
import {
  CHAT_SITE_NAMES,
  PAGE_READ_SITES,
  getChatSite,
  isChatConversationUrl,
  type ChatSite,
} from "./chat-sites.ts";
import { buildClipboardContent } from "./clipboard-export.ts";
import type { ExportImageFile, Message } from "./export-builders.ts";
import { loadSettings, type Settings } from "./settings.ts";
import {
  PAUSE_BETWEEN_CHATS_MS,
  RETRY_DELAYS_MS,
  needsSaving,
  savedChats,
  withSavedChats,
} from "./bulk-export.ts";
import type {
  ConversationListPage,
  ConversationSummary,
} from "./conversation-list.ts";
import {
  BACKUP_CONFIG_KEY,
  BACKUP_SAVED_KEY,
  BACKUP_STATUS_KEY,
  backupStatus,
  backupTarget,
  buildBackupFiles,
  isBackupDue,
  loadBackupConfig,
  type BackupConfig,
  type BackupFile,
  type BackupFormat,
  type BackupStatus,
} from "./auto-backup.ts";
import {
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_NOTICE_KEY,
  type StoreCheckStatus,
  type UpdateState,
  changeUpdateState,
  checkStoreForUpdate,
  getRunningVersion,
  isNewerVersion,
  loadUpdateState,
} from "./updates.ts";

const devError = (...args: unknown[]): void => {
  if (import.meta.env.DEV) {
    console.error(...args);
  }
};

/*
 * Resolves the active language once per service worker
 * lifetime, so the error messages github.ts throws (e.g.
 * "Not connected to GitHub.") come back translated. MV3
 * service workers are spun up fresh for practically every
 * burst of activity, so this effectively re-syncs with the
 * stored `language` preference every time it matters, without
 * needing a storage-change listener.
 */
void initI18n();

/*
 * ---------------------------------------------------------
 * SENDER / INPUT VALIDATION
 * ---------------------------------------------------------
 *
 * chrome.runtime.onMessage fires for messages from any
 * frame belonging to this extension (popup, options,
 * content scripts, offscreen document). There is no
 * externally_connectable entry in the manifest, so an
 * arbitrary web page cannot reach these listeners directly.
 * isOwnExtensionSender is still checked as defense in depth,
 * in case a future manifest change or a compromised content
 * script tries to relay a forged message.
 */
function isOwnExtensionSender(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id;
}

/*
 * ---------------------------------------------------------
 * DOWNLOAD COMPLETION TRACKING
 * ---------------------------------------------------------
 *
 * chrome.downloads.download()'s returned Promise resolves as
 * soon as the download is QUEUED - with saveAs: true, that's
 * the moment the native "Save As" dialog opens, not the
 * moment the person actually picks a folder and the file is
 * written. Showing a success message right after that
 * Promise resolves is misleading: it fires before the person
 * has even chosen where to save, or even if they cancel the
 * dialog entirely.
 *
 * chrome.downloads.onChanged is the correct signal - it fires
 * when a download's state actually changes to "complete" (or
 * "interrupted", e.g. the person cancelled the Save As
 * dialog). This listener lives in the service worker rather
 * than popup.ts because many Chrome versions close/suspend
 * the popup the moment a native OS dialog (like Save As)
 * steals focus, so a popup-local listener could simply never
 * fire. The service worker has no such lifecycle issue.
 *
 * Download IDs we're tracking (from the DOWNLOAD_START handler
 * below) map to the object URL that download reads from and to
 * the ChatGPT tab the export was started from. When that
 * download's state actually becomes "complete", this sends
 * SHOW_EXPORT_SUCCESS straight to that tab's content script -
 * NOT via the popup. The popup is usually long gone by the time
 * a download finishes (Firefox closes it the instant the native
 * Save As dialog steals focus, and even Chrome can), so routing
 * the success overlay through a popup-local listener means it
 * just never shows up. Going tab-direct from the background
 * page, which has no such lifecycle issue, is what actually
 * gets the overlay on screen.
 */
const trackedDownloadIds = new Set<number>();
const pendingObjectUrls = new Map<number, string>();
const pendingDownloadTabIds = new Map<number, number>();

function revokePendingObjectUrl(downloadId: number): void {
  const url = pendingObjectUrls.get(downloadId);

  if (url !== undefined) {
    pendingObjectUrls.delete(downloadId);
    revokeDownloadUrl(url);
  }
}

function notifyDownloadTab(downloadId: number, type: string): void {
  const tabId = pendingDownloadTabIds.get(downloadId);

  pendingDownloadTabIds.delete(downloadId);

  if (tabId === undefined) {
    return;
  }

  chrome.tabs.sendMessage(tabId, { type }).catch(() => {
    /*
     * Content script may not be running in this tab anymore
     * (e.g. the person navigated away from chatgpt.com while
     * the download was in flight) - nothing to show it on, so
     * just drop it silently. The file was still saved
     * successfully either way.
     */
  });
}

chrome.downloads.onChanged.addListener((delta) => {
  if (!trackedDownloadIds.has(delta.id)) {
    return;
  }

  if (delta.state?.current === "complete") {
    trackedDownloadIds.delete(delta.id);
    revokePendingObjectUrl(delta.id);
    notifyDownloadTab(delta.id, "SHOW_EXPORT_SUCCESS");
    void applyPendingUpdate();

    return;
  }

  /*
   * "interrupted" covers both explicit cancellation (the
   * person closed the Save As dialog without picking a
   * location) and genuine failures. Either way, no success
   * overlay should appear.
   */
  if (delta.state?.current === "interrupted") {
    trackedDownloadIds.delete(delta.id);
    revokePendingObjectUrl(delta.id);
    pendingDownloadTabIds.delete(delta.id);
    void applyPendingUpdate();
  }
});

/*
 * GitHub "owner/repo" full_name as returned by the GitHub
 * API: two path segments, each restricted to the characters
 * GitHub allows in user/org and repo names.
 */
const REPO_FULL_NAME_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

const MAX_EXPORT_CONTENT_LENGTH = 10_000_000;
const MAX_BINARY_EXPORT_CONTENT_LENGTH = 45_000_000;

function isValidRepoFullName(value: unknown): value is string {
  return typeof value === "string" && REPO_FULL_NAME_PATTERN.test(value);
}

/*
 * Only names file-names.ts could have made (see buildFilename()):
 * one file, no folder, no "..", and nothing either browser would
 * refuse - the person's own name pattern can put spaces, any
 * script and punctuation into it.
 */
function isValidExportFilename(value: unknown): value is string {
  return isSafeFileName(value);
}

function isValidExportContent(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_EXPORT_CONTENT_LENGTH
  );
}

function isValidBinaryExportContent(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_BINARY_EXPORT_CONTENT_LENGTH &&
    value.length % 4 === 0 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  );
}

/*
 * ---------------------------------------------------------
 * DOWNLOAD URLS
 * ---------------------------------------------------------
 *
 * chrome.downloads.download() reads the file from a URL. Firefox
 * runs this file as an event page, which can make a blob: URL
 * itself. Chrome runs it as an MV3 service worker, which has no
 * URL.createObjectURL() at all, so there the offscreen document
 * (created with the BLOBS reason) makes the blob: URL instead -
 * it belongs to the extension's origin, so chrome.downloads can
 * read it from here. A data: URL is no substitute: Firefox
 * rejects data: URLs with saveAs: true, and a PDF or ZIP export
 * would make one megabytes long.
 */
function canCreateObjectUrls(): boolean {
  return typeof URL.createObjectURL === "function";
}

async function createDownloadUrl(
  content: string,
  mimeType: string,
): Promise<string> {
  if (canCreateObjectUrls()) {
    const bytes = decodeBase64(content);

    return URL.createObjectURL(
      new Blob([copyToArrayBuffer(bytes)], { type: mimeType }),
    );
  }

  await setupOffscreenDocument();

  const response = await chrome.runtime.sendMessage({
    type: "OFFSCREEN_CREATE_BLOB_URL",
    content,
    mimeType,
  });

  if (!response?.success || typeof response.url !== "string") {
    throw new Error(response?.error ?? "Could not prepare the download.");
  }

  return response.url;
}

function revokeDownloadUrl(url: string): void {
  if (canCreateObjectUrls()) {
    URL.revokeObjectURL(url);

    return;
  }

  chrome.runtime
    .sendMessage({ type: "OFFSCREEN_REVOKE_BLOB_URL", url })
    .catch(() => {
      /*
       * The offscreen document is already gone - and its blob:
       * URLs went with it.
       */
    });
}

/*
 * ---------------------------------------------------------
 * DOWNLOAD START
 * ---------------------------------------------------------
 *
 * Does the actual chrome.downloads.download() call. This has
 * to run here rather than in popup.ts - see the big comment
 * above trackedDownloadIds for why a popup-owned blob: URL (or
 * a data: URL) doesn't survive the native Save As dialog on
 * Firefox. popup.ts hands over the file as base64 (the same
 * binary-content encoding already used for the GitHub save
 * path) instead of building a blob/object URL itself.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "DOWNLOAD_START") {
    return false;
  }

  if (!isOwnExtensionSender(sender)) {
    return false;
  }

  if (
    !isValidExportFilename(message.filename) ||
    !isValidBinaryExportContent(message.content) ||
    typeof message.mimeType !== "string" ||
    typeof message.saveAs !== "boolean" ||
    (message.tabId !== undefined && typeof message.tabId !== "number")
  ) {
    sendResponse({ success: false, error: "Invalid download request." });

    return true;
  }

  void trackTask(async () => {
    let objectUrl: string | undefined;

    try {
      objectUrl = await createDownloadUrl(message.content, message.mimeType);

      const url = objectUrl;
      const download = (filename: string): Promise<number> =>
        chrome.downloads.download({ url, filename, saveAs: message.saveAs });

      /*
       * A browser that still turns the name down ("Invalid
       * filename" in Chrome, "filename must not contain illegal
       * characters" in Firefox) gets a plain ASCII one instead,
       * rather than the export failing over its name.
       */
      const downloadId = await download(message.filename).catch(
        (error: unknown) => {
          const fallback = asciiFileName(message.filename);

          if (
            fallback === message.filename ||
            !/file\s*name/i.test(error instanceof Error ? error.message : String(error))
          ) {
            throw error;
          }

          return download(fallback);
        },
      );

      trackedDownloadIds.add(downloadId);
      pendingObjectUrls.set(downloadId, objectUrl);

      if (typeof message.tabId === "number") {
        pendingDownloadTabIds.set(downloadId, message.tabId);
      }

      sendResponse({ success: true, data: { downloadId } });
    } catch (error) {
      if (objectUrl) {
        revokeDownloadUrl(objectUrl);
      }

      sendResponse({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return true;
});

/*
 * One offscreen document serves both the clipboard and (in
 * Chrome) download blob URLs - an extension can only have one.
 * creatingOffscreenDocument lets a copy and a download that
 * start together share the one being created, instead of the
 * second createDocument() call failing.
 */
let creatingOffscreenDocument: Promise<void> | null = null;

async function setupOffscreenDocument(): Promise<void> {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });

  if (existingContexts.length > 0) {
    return;
  }

  creatingOffscreenDocument ??= chrome.offscreen
    .createDocument({
      url: "offscreen.html",
      reasons: ["CLIPBOARD", "BLOBS"],
      justification:
        "Copy exported conversations to the clipboard and hand export files to the downloads API.",
    })
    .finally(() => {
      creatingOffscreenDocument = null;
    });

  await creatingOffscreenDocument;
}

/*
 * ---------------------------------------------------------
 * CLIPBOARD
 * ---------------------------------------------------------
 *
 * A copied chat goes on the clipboard as Markdown (text/plain)
 * and, when it comes with one, as formatted HTML (text/html) too -
 * see clipboard-export.ts. Chrome's service worker has no
 * clipboard, so the offscreen document writes it there. Firefox
 * has no offscreen documents, but runs this file as an event page
 * with a clipboard of its own, which the clipboardWrite permission
 * lets it write - so it copies right here, the way offscreen.ts
 * does (a classic script that can't share code with this one).
 */
function hasOffscreenDocuments(): boolean {
  return typeof chrome.offscreen?.createDocument === "function";
}

function copyWithExecCommand(text: string, html: string): boolean {
  if (typeof document === "undefined" || !document.body) {
    return false;
  }

  const textarea = document.createElement("textarea");
  const fill = (event: ClipboardEvent): void => {
    if (!html) {
      return;
    }

    event.preventDefault();
    event.clipboardData?.setData("text/plain", text);
    event.clipboardData?.setData("text/html", html);
  };

  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.top = "-9999px";
  document.body.append(textarea);
  document.addEventListener("copy", fill);

  try {
    textarea.select();

    return document.execCommand("copy");
  } finally {
    document.removeEventListener("copy", fill);
    textarea.remove();
  }
}

async function copyInThisPage(text: string, html: string): Promise<boolean> {
  try {
    if (html && navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([text], { type: "text/plain" }),
          "text/html": new Blob([html], { type: "text/html" }),
        }),
      ]);

      return true;
    }

    if (!html && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);

      return true;
    }
  } catch (error) {
    devError("AI Exporter: clipboard API failed, trying execCommand", error);
  }

  return copyWithExecCommand(text, html);
}

async function copyToClipboard(
  text: string,
  html: string,
): Promise<{ success: boolean; error?: string }> {
  if (!hasOffscreenDocuments()) {
    return (await copyInThisPage(text, html))
      ? { success: true }
      : { success: false, error: "Clipboard write failed" };
  }

  await setupOffscreenDocument();

  return chrome.runtime.sendMessage({
    type: "OFFSCREEN_COPY",
    data: text,
    ...(html ? { html } : {}),
  });
}

function isValidClipboardText(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_EXPORT_CONTENT_LENGTH;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "COPY_TO_CLIPBOARD") {
    return false;
  }

  if (!isOwnExtensionSender(sender)) {
    return false;
  }

  if (
    !isValidClipboardText(message.data) ||
    (message.html !== undefined && !isValidClipboardText(message.html))
  ) {
    sendResponse({ success: false, error: "Invalid copy request." });

    return true;
  }

  void trackTask(async () => {
    try {
      sendResponse(await copyToClipboard(message.data, message.html ?? ""));
    } catch (error) {
      devError("AI Exporter: background clipboard failed", error);

      sendResponse({
        success: false,
        error: String(error),
      });
    }
  });

  /*
   * MUST return true synchronously so Chrome
   * keeps the message channel open until
   * sendResponse is called inside the async
   * task above. Without this, the channel closes
   * immediately and you get a DOMException.
   */
  return true;
});

/*
 * ---------------------------------------------------------
 * KEYBOARD SHORTCUTS
 * ---------------------------------------------------------
 *
 * The manifest's "commands": Alt+Shift+E opens the popup (the
 * browser does that one itself, as _execute_action), and
 * Alt+Shift+M copies the chat open in the active tab without
 * opening anything - the same copy as the popup's "Copy the whole
 * chat" (M for Markdown: Chrome keeps Alt+Shift+C for itself).
 * The page itself says how the copy went (SHOW_TOAST in
 * content.ts); a page of no chat site, which AI Exporter can't
 * write on, gets a mark on the toolbar button instead.
 */
const COPY_CHAT_COMMAND = "copy-chat";
/* Error messages longer than this are technical; a plain one replaces them */
const MAX_SHORTCUT_ERROR_LENGTH = 90;
const BADGE_MS = 4000;
/* As in popup.ts: the wait for a reloaded tab's content script */
const RELOAD_SETTLE_MS = 2000;
const CONTENT_SCRIPT_WAIT_MS = 15_000;
const CONTENT_SCRIPT_POLL_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function hasContentScript(tabId: number): Promise<boolean> {
  try {
    const answer = await chrome.tabs.sendMessage(tabId, {
      type: "AIEXPORTER_PING",
    });

    return answer?.ok === true;
  } catch {
    /* Nothing in the tab answers. */
    return false;
  }
}

/*
 * Every chat site's pages get content.js from the manifest, but
 * Chrome only adds it to pages loaded after AI Exporter was
 * installed or updated. A tab open since before is reloaded, as the
 * popup does it (see popup.ts) - the page waits for its content
 * script, ChatGPT's page bridge for the page's own first requests.
 * False when the content script doesn't come in time.
 */
async function ensureContentScript(tabId: number): Promise<boolean> {
  if (await hasContentScript(tabId)) {
    return true;
  }

  await chrome.tabs.reload(tabId);
  await sleep(RELOAD_SETTLE_MS);

  const deadline = Date.now() + CONTENT_SCRIPT_WAIT_MS;

  do {
    if (await hasContentScript(tabId)) {
      return true;
    }

    await sleep(CONTENT_SCRIPT_POLL_MS);
  } while (Date.now() < deadline);

  return false;
}

function showPageToast(
  tabId: number,
  text: string,
  tone: "info" | "success" | "error" = "success",
): Promise<void> {
  return chrome.tabs
    .sendMessage(tabId, { type: "SHOW_TOAST", text, tone })
    .then(() => undefined)
    .catch(() => {
      /* The page went away meanwhile - nothing to show it on. */
    });
}

/* A "!" on the toolbar button, with what to do as its tooltip */
function flashBadge(tabId: number, title: string): void {
  if (!chrome.action?.setBadgeText) {
    return;
  }

  void chrome.action.setBadgeBackgroundColor({ tabId, color: "#cf222e" });
  void chrome.action.setBadgeText({ tabId, text: "!" });
  void chrome.action.setTitle({ tabId, title });

  setTimeout(() => {
    void chrome.action.setBadgeText({ tabId, text: "" }).catch(() => undefined);
    void chrome.action
      .setTitle({
        tabId,
        title: chrome.runtime.getManifest().action?.default_title ?? "AI Exporter",
      })
      .catch(() => undefined);
  }, BADGE_MS);
}

function pasteShortcut(): string {
  return navigator.userAgent.includes("Mac") ? "⌘V" : t("popup.pasteShortcut");
}

async function copyChatWithShortcut(
  commandTab: chrome.tabs.Tab | undefined,
): Promise<void> {
  const tab =
    commandTab?.id !== undefined
      ? commandTab
      : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];

  if (tab?.id === undefined) {
    return;
  }

  const tabId = tab.id;

  if (!getChatSite(tab.url)) {
    flashBadge(tabId, t("popup.error.openSupportedSite"));

    return;
  }

  let reachable = false;

  try {
    reachable = await ensureContentScript(tabId);
  } catch (error) {
    devError("AI Exporter: couldn't reach the chat page", error);
  }

  if (!reachable) {
    flashBadge(tabId, t("popup.error.loadConversationFailed"));

    return;
  }

  if (!isChatConversationUrl(tab.url)) {
    await showPageToast(tabId, t("popup.chat.openTitle"), "error");

    return;
  }

  await showPageToast(tabId, t("shortcut.copying"), "info");

  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: "LOAD_CONVERSATION",
      downloadImagesLocally: false,
    });

    if (!response?.success) {
      throw new Error(response?.error ?? t("popup.error.loadConversationFailed"));
    }

    const messages = ((response.data?.messages ?? []) as Message[])
      .slice()
      .sort((a, b) => a.order - b.order);

    if (messages.length === 0) {
      throw new Error(t("popup.error.noMessagesFound"));
    }

    const { text, html } = await buildClipboardContent(messages, {
      tabTitle: tab.title,
      tabUrl: tab.url,
    });
    const copied = await copyToClipboard(text, html);

    if (!copied?.success) {
      throw new Error(t("popup.toast.copyFailed"));
    }

    await showPageToast(
      tabId,
      t("popup.toast.copied", { shortcut: pasteShortcut() }),
    );
  } catch (error) {
    devError("AI Exporter: copying with the shortcut failed", error);

    const message = error instanceof Error ? error.message : "";

    await showPageToast(
      tabId,
      message && message.length <= MAX_SHORTCUT_ERROR_LENGTH
        ? message
        : t("popup.toast.copyFailed"),
      "error",
    );
  }
}

chrome.commands?.onCommand.addListener((command, tab) => {
  if (command === COPY_CHAT_COMMAND) {
    void trackTask(() => copyChatWithShortcut(tab));
  }
});

/*
 * ---------------------------------------------------------
 * GITHUB: STAR PROJECT
 * ---------------------------------------------------------
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "GITHUB_STAR_PROJECT") {
    return false;
  }

  if (!isOwnExtensionSender(sender)) {
    return false;
  }

  (async () => {
    try {
      await starProject();

      sendResponse({ success: true });
    } catch (error) {
      sendResponse({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();

  return true;
});

/*
 * ---------------------------------------------------------
 * GITHUB: DEVICE FLOW AUTH
 * ---------------------------------------------------------
 *
 * This must live in background.ts, not popup.ts or
 * options.ts: the device flow polling loop runs for up to
 * several minutes while the person goes to github.com/login/device
 * in a different tab, and a popup's JS context is destroyed
 * the moment the popup closes (which happens as soon as the
 * person clicks away to go authorize). The service worker has
 * no such lifecycle constraint, so the poll survives even if
 * the popup/options page that started it is long gone.
 *
 * GITHUB_START_AUTH kicks off the flow and immediately
 * returns the user_code/verification_uri for the UI to show,
 * without waiting for the poll to finish. The poll itself
 * runs in the background and reports its outcome via the
 * GITHUB_AUTH_COMPLETE runtime message once it resolves,
 * which whichever UI is open (if any) can listen for.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "GITHUB_START_AUTH") {
    return false;
  }

  if (!isOwnExtensionSender(sender)) {
    return false;
  }

  /*
   * Tracked as one task until the poll ends, so an update
   * waiting to install doesn't reload the extension (and drop
   * the poll) while the person is still approving on GitHub.
   */
  void trackTask(async () => {
    try {
      const deviceCode = await startDeviceFlow();

      sendResponse({
        success: true,
        data: {
          userCode: deviceCode.user_code,
          verificationUri: deviceCode.verification_uri,
        },
      });

      /*
       * Poll in the background, independent of whether the
       * caller (popup/options) is still open. Broadcast the
       * result when it's done; any open UI can listen for it,
       * and if none is open, the token is still stored for
       * next time the person opens the popup/options page.
       */
      try {
        await pollForAccessToken(
          deviceCode.device_code,
          deviceCode.interval,
          deviceCode.expires_in,
        );

        chrome.runtime
          .sendMessage({ type: "GITHUB_AUTH_COMPLETE", success: true })
          .catch(() => {
            /*
             * No listener currently open - fine, the token
             * is already stored; the UI will pick it up next
             * time it checks connection status.
             */
          });
      } catch (pollError) {
        chrome.runtime
          .sendMessage({
            type: "GITHUB_AUTH_COMPLETE",
            success: false,
            error:
              pollError instanceof Error
                ? pollError.message
                : String(pollError),
          })
          .catch(() => {
            /* No listener currently open - nothing to do. */
          });
      }
    } catch (error) {
      sendResponse({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return true;
});

/*
 * ---------------------------------------------------------
 * GITHUB: CONNECTION STATUS
 * ---------------------------------------------------------
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "GITHUB_GET_STATUS") {
    return false;
  }

  if (!isOwnExtensionSender(sender)) {
    return false;
  }

  (async () => {
    try {
      const token = await getStoredToken();

      /*
       * A token is no use without the permission to reach GitHub
       * (taken back in the browser's settings, say): that counts
       * as not connected, and Connect GitHub asks for it again.
       */
      if (!token || !(await hasGitHubAccess())) {
        sendResponse({ success: true, data: { connected: false } });

        return;
      }

      const user = await getCurrentUser();

      sendResponse({
        success: true,
        data: { connected: true, login: user.login },
      });
    } catch (error) {
      /*
       * If the token is bad, getCurrentUser already clears it
       * (see github.ts githubApiRequest). Report as
       * disconnected rather than surfacing an error here -
       * this endpoint is used for silent status checks, not
       * user-initiated actions.
       */
      sendResponse({ success: true, data: { connected: false } });
    }
  })();

  return true;
});

/*
 * ---------------------------------------------------------
 * GITHUB: DISCONNECT
 * ---------------------------------------------------------
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "GITHUB_DISCONNECT") {
    return false;
  }

  if (!isOwnExtensionSender(sender)) {
    return false;
  }

  (async () => {
    try {
      await disconnectGitHub();

      sendResponse({ success: true });
    } catch (error) {
      sendResponse({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();

  return true;
});

/*
 * ---------------------------------------------------------
 * GITHUB: LIST REPOS
 * ---------------------------------------------------------
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "GITHUB_LIST_REPOS") {
    return false;
  }

  if (!isOwnExtensionSender(sender)) {
    return false;
  }

  (async () => {
    try {
      const repos = await listRepos();

      sendResponse({ success: true, data: repos });
    } catch (error) {
      sendResponse({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();

  return true;
});

/*
 * ---------------------------------------------------------
 * GITHUB: SAVE FILE
 * ---------------------------------------------------------
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "GITHUB_SAVE_FILE") {
    return false;
  }

  if (!isOwnExtensionSender(sender)) {
    return false;
  }

  if (
    !isValidRepoFullName(message.fullName) ||
    !isValidExportFilename(message.filename) ||
    (message.binary === true
      ? !isValidBinaryExportContent(message.content)
      : !isValidExportContent(message.content)) ||
    (message.binary !== undefined && typeof message.binary !== "boolean")
  ) {
    sendResponse({
      success: false,
      error: "Invalid save request.",
    });

    return true;
  }

  void trackTask(async () => {
    try {
      const result = await saveFileToRepo(
        message.fullName,
        message.filename,
        message.content,
        message.binary === true,
      );

      sendResponse({ success: true, data: result });
    } catch (error) {
      sendResponse({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return true;
});

/*
 * ---------------------------------------------------------
 * NOTION
 * ---------------------------------------------------------
 *
 * See notion.ts. The popup builds the page's blocks (that needs
 * a DOM) and this sends them. Signing in lives here for the same
 * reason the GitHub one does: the sign-in window closes the popup.
 */
const NOTION_ID_PATTERN =
  /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

function isValidNotionBlocks(value: unknown): value is NotionBlock[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (block) =>
        typeof block === "object" &&
        block !== null &&
        (block as NotionBlock).object === "block" &&
        typeof (block as NotionBlock).type === "string",
    ) &&
    JSON.stringify(value).length <= MAX_EXPORT_CONTENT_LENGTH
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function handleNotion(
  type: string,
  run: (message: Record<string, unknown>) => Promise<unknown>,
  tracked = false,
): void {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type !== type || !isOwnExtensionSender(sender)) {
      return false;
    }

    const task = async (): Promise<void> => {
      try {
        sendResponse({ success: true, data: await run(message) });
      } catch (error) {
        sendResponse({ success: false, error: errorText(error) });
      }
    };

    if (tracked) {
      void trackTask(task);
    } else {
      void task();
    }

    return true;
  });
}

handleNotion("NOTION_GET_STATUS", async () => {
  const connection = await getNotionConnection();

  return {
    connected: connection !== null,
    workspaceName: connection?.workspaceName ?? "",
  };
});

handleNotion("NOTION_CONNECT_TOKEN", async (message) => {
  if (typeof message.token !== "string" || message.token.length > 500) {
    throw new Error("Invalid request.");
  }

  const connection = await connectNotionWithToken(message.token);

  return { workspaceName: connection.workspaceName ?? "" };
});

handleNotion("NOTION_DISCONNECT", async () => {
  await disconnectNotion();
  return null;
});

handleNotion("NOTION_LIST_PAGES", () => listNotionPages());

handleNotion(
  "NOTION_SAVE_PAGE",
  async (message) => {
    if (
      typeof message.parentId !== "string" ||
      !NOTION_ID_PATTERN.test(message.parentId) ||
      typeof message.title !== "string" ||
      message.title.length === 0 ||
      message.title.length > 2000 ||
      !isValidNotionBlocks(message.blocks)
    ) {
      throw new Error("Invalid save request.");
    }

    return createNotionPage(message.parentId, message.title, message.blocks);
  },
  true,
);

/*
 * ---------------------------------------------------------
 * UPDATES
 * ---------------------------------------------------------
 *
 * updates.ts explains why this is needed. In short: the
 * browser downloads an update, then holds it back while the
 * extension is running - and Chrome never sees this one stop
 * running once the offscreen document is open.
 * runtime.onUpdateAvailable reports an update being held back,
 * and reloading the extension installs it.
 *
 * A reload closes the popup and the options page and cuts off
 * whatever this file is in the middle of, so it waits until
 * none of that is going on. While it waits, an alarm tries
 * again every minute - a setTimeout() wouldn't survive Chrome
 * shutting the service worker down in between.
 */
const APPLY_UPDATE_ALARM = "apply-pending-update";

/*
 * Downloads being prepared, clipboard copies, GitHub sign-ins
 * and saves in progress. A count, not a flag, since they can
 * overlap.
 */
let activeTaskCount = 0;

async function trackTask(task: () => Promise<void>): Promise<void> {
  activeTaskCount++;

  try {
    await task();
  } finally {
    activeTaskCount--;
    void applyPendingUpdate();
  }
}

/*
 * Only downloads this extension started count, not the
 * person's own. trackedDownloadIds forgets them whenever Chrome
 * restarts the service worker mid-download (say, while the
 * Save As dialog sits open), so the downloads API is asked too.
 */
async function hasDownloadInProgress(): Promise<boolean> {
  if (trackedDownloadIds.size > 0) {
    return true;
  }

  const downloads = await chrome.downloads.search({ state: "in_progress" });

  return downloads.some((item) => item.byExtensionId === chrome.runtime.id);
}

/*
 * The popup, or the options page in a tab - a reload would
 * close them in the middle of whatever the person is doing.
 */
async function hasOpenExtensionPage(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["POPUP", "TAB"],
  });

  return contexts.length > 0;
}

async function isBusy(ignoreOpenPages: boolean): Promise<boolean> {
  if (activeTaskCount > 0) {
    return true;
  }

  try {
    return (
      (await hasDownloadInProgress()) ||
      (!ignoreOpenPages && (await hasOpenExtensionPage()))
    );
  } catch (error) {
    /*
     * Can't tell - better to install a minute later than to
     * cut something off.
     */
    devError("AI Exporter: could not check for running work", error);

    return true;
  }
}

/*
 * Set once reload() has been called, so an attempt that lands
 * before the extension actually goes down doesn't reload it a
 * second time.
 */
let reloadRequested = false;

async function installPendingUpdate(
  ignoreOpenPages: boolean,
): Promise<boolean> {
  if (reloadRequested) {
    return true;
  }

  const { readyVersion, reloadedFor } = await loadUpdateState();

  if (!isNewerVersion(readyVersion, getRunningVersion())) {
    await chrome.alarms.clear(APPLY_UPDATE_ALARM);

    return false;
  }

  /*
   * One reload per downloaded version. If the version a reload
   * was for still isn't the one running afterwards, the browser
   * no longer has that download, and reloading again would only
   * loop - Chrome shuts down an extension that keeps reloading
   * itself. Its next update round downloads the version again
   * and fires onUpdateAvailable, which starts this over (so the
   * state is only cleared if that hasn't just happened).
   */
  if (reloadedFor === readyVersion) {
    await changeUpdateState((state) =>
      state.reloadedFor === state.readyVersion
        ? { ...state, readyVersion: undefined }
        : state,
    );
    await chrome.alarms.clear(APPLY_UPDATE_ALARM);

    return false;
  }

  if (await isBusy(ignoreOpenPages)) {
    await chrome.alarms.create(APPLY_UPDATE_ALARM, { delayInMinutes: 1 });

    return false;
  }

  reloadRequested = true;
  await changeUpdateState((state) => ({ ...state, reloadedFor: readyVersion }));
  chrome.runtime.reload();

  return true;
}

let updateInstallQueue: Promise<boolean> = Promise.resolve(false);

/*
 * Attempts run one after another, so two that land together
 * (an alarm and a finished download, say) can't both decide to
 * reload. `ignoreOpenPages` is the popup's "Update now" button:
 * the person asked for the reload, so their open popup isn't
 * something to wait for - work in progress still is.
 */
function applyPendingUpdate(ignoreOpenPages = false): Promise<boolean> {
  updateInstallQueue = updateInstallQueue.then(() =>
    installPendingUpdate(ignoreOpenPages).catch((error) => {
      devError("AI Exporter: installing the update failed", error);

      return false;
    }),
  );

  return updateInstallQueue;
}

chrome.runtime.onUpdateAvailable.addListener(({ version }) => {
  changeUpdateState((state) => ({
    ...state,
    latestVersion: version,
    readyVersion: version,
    /* A fresh download gets a fresh reload. */
    reloadedFor: undefined,
  }))
    .then(() => applyPendingUpdate())
    .catch((error) => {
      devError("AI Exporter: could not record the update", error);
    });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === APPLY_UPDATE_ALARM) {
    void applyPendingUpdate();
  }
});

/*
 * Clears what led up to the update and leaves the new version
 * for the popup to mention once. Reloading an unpacked build
 * fires "update" too, with the same version on both sides -
 * nothing was updated then.
 */
chrome.runtime.onInstalled.addListener(({ reason, previousVersion }) => {
  const runningVersion = getRunningVersion();

  if (reason !== "update" || previousVersion === runningVersion) {
    return;
  }

  changeUpdateState(({ latestVersion, checkedAt }) => ({
    latestVersion: isNewerVersion(latestVersion, runningVersion)
      ? latestVersion
      : undefined,
    checkedAt,
  }))
    .then(() =>
      chrome.storage.local.set({ [UPDATE_NOTICE_KEY]: runningVersion }),
    )
    .catch((error) => {
      devError("AI Exporter: could not record the update", error);
    });
});

/*
 * Every start of the background - in Chrome, every time the
 * service worker wakes up - picks up an update that was still
 * waiting when the previous one shut down.
 */
void applyPendingUpdate();

/*
 * ---------------------------------------------------------
 * UPDATES: CHECK THE STORE
 * ---------------------------------------------------------
 *
 * The popup asks every time it opens. This only goes to the
 * store when its last answer is older than
 * UPDATE_CHECK_INTERVAL_MS, or when `force` is set (the person
 * clicked "Check for updates"). An answer of "throttled",
 * "unlisted" or "error" leaves what was known as it was.
 */
async function checkForUpdate(
  force: boolean,
): Promise<{ result: StoreCheckStatus | "recent"; state: UpdateState }> {
  const known = await loadUpdateState();
  const age =
    known.checkedAt === undefined ? Infinity : Date.now() - known.checkedAt;

  if (!force && age >= 0 && age < UPDATE_CHECK_INTERVAL_MS) {
    return { result: "recent", state: known };
  }

  const { status, version } = await checkStoreForUpdate(getRunningVersion());

  const state = await changeUpdateState((current) => {
    switch (status) {
      case "update_available":
        return { ...current, latestVersion: version, checkedAt: Date.now() };
      case "no_update":
        return { ...current, latestVersion: undefined, checkedAt: Date.now() };
      default:
        return current;
    }
  });

  return { result: status, state };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "UPDATE_CHECK") {
    return false;
  }

  if (!isOwnExtensionSender(sender)) {
    return false;
  }

  (async () => {
    try {
      const data = await checkForUpdate(message.force === true);

      sendResponse({ success: true, data });
    } catch (error) {
      sendResponse({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();

  return true;
});

/*
 * ---------------------------------------------------------
 * UPDATES: INSTALL NOW (the popup's "Update now" button)
 * ---------------------------------------------------------
 *
 * Reports whether the reload is happening. It isn't when
 * there's no downloaded update after all, or when an export
 * is still running - the alarm installs it once that's done.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "UPDATE_APPLY") {
    return false;
  }

  if (!isOwnExtensionSender(sender)) {
    return false;
  }

  void applyPendingUpdate(true).then((reloading) => {
    sendResponse({ success: true, data: { reloading } });
  });

  return true;
});

/*
 * ---------------------------------------------------------
 * AUTOMATIC BACKUP
 * ---------------------------------------------------------
 *
 * See auto-backup.ts. An alarm looks every half hour for chat sites
 * that are due and open in a tab, and so does content.ts, half a
 * minute after a chat site's page opens - a site that's only open
 * now and then would otherwise rarely be open when the alarm goes
 * off. Each due site's tab lists its chats, and those that are new
 * or have changed since the last backup are loaded one at a time,
 * built into files and saved: into Downloads, over their old copy,
 * or into GitHub, a commit at a time. A chat counts as backed up
 * only once its files are saved, so a backup cut short (the tab
 * closed, the browser quit) goes on where it stopped next time.
 */
const BACKUP_ALARM = "auto-backup";
const BACKUP_CHECK_MINUTES = 30;
/* After a chat site's page opens: the page gets ready first */
const BACKUP_AFTER_PAGE_OPENS_MINUTES = 0.5;
/* GitHub gets the chats in commits of up to this many chats or bytes */
const BACKUP_COMMIT_CHATS = 25;
const BACKUP_COMMIT_BYTES = 5_000_000;
/* A site that fails this many chats in a row has stopped answering */
const BACKUP_FAILURES_IN_A_ROW = 5;
/* A file that isn't on disk by then is waiting for a Save As dialog */
const BACKUP_DOWNLOAD_WAIT_MS = 2 * 60 * 1000;
/*
 * Chrome stops a service worker that has gone 30 seconds without
 * calling the browser; one chat with many images can take longer to
 * load than that.
 */
const BACKUP_KEEPALIVE_MS = 20_000;

async function scheduleBackup(soon = false): Promise<void> {
  const { enabled } = await loadBackupConfig();
  const alarm = await chrome.alarms.get(BACKUP_ALARM);

  if (!enabled) {
    if (alarm) {
      await chrome.alarms.clear(BACKUP_ALARM);
    }

    return;
  }

  if (soon || !alarm) {
    await chrome.alarms.create(BACKUP_ALARM, {
      delayInMinutes: soon ? BACKUP_AFTER_PAGE_OPENS_MINUTES : BACKUP_CHECK_MINUTES,
      periodInMinutes: BACKUP_CHECK_MINUTES,
    });
  }
}

/* The chat tab is gone: closed, or showing another site now */
class TabUnavailableError extends Error {}

/* The browser asked where to save a backup file, and nobody chose */
class SaveAsError extends Error {}

/*
 * Without the "tabs" permission a tab's address doesn't show, so every
 * tab is asked: only one with AI Exporter's content script answers,
 * and it says which site it shows. Tabs of private windows are left
 * alone, and so are the sites read from the page, which can't list
 * their chats.
 */
async function findChatTabs(): Promise<Map<ChatSite, number>> {
  const found = new Map<ChatSite, number>();
  const tabs = await chrome.tabs.query({});

  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id === undefined || tab.incognito || tab.discarded) {
        return;
      }

      try {
        const answer = await chrome.tabs.sendMessage(tab.id, {
          type: "AIEXPORTER_PING",
        });
        const site =
          answer?.ok === true && typeof answer.host === "string"
            ? getChatSite(`https://${answer.host}/`)
            : null;

        if (site && !PAGE_READ_SITES.includes(site) && !found.has(site)) {
          found.set(site, tab.id);
        }
      } catch {
        /* No content script of AI Exporter's there. */
      }
    }),
  );

  return found;
}

/*
 * Asks the chat tab, after checking it still shows `site` - the
 * person may have gone on to another chat site in it meanwhile.
 */
async function sendToChatTab<T>(
  tabId: number,
  site: ChatSite,
  message: Record<string, unknown>,
): Promise<T> {
  let response: { success?: boolean; data?: T; error?: string } | undefined;

  try {
    const answer = await chrome.tabs.sendMessage(tabId, { type: "AIEXPORTER_PING" });

    if (getChatSite(`https://${answer?.host}/`) !== site) {
      throw new Error("The tab shows another site now.");
    }

    response = await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    throw new TabUnavailableError(errorText(error));
  }

  if (!response?.success) {
    throw new Error(response?.error ?? t("popup.error.loadConversationFailed"));
  }

  return response.data as T;
}

/*
 * The whole list, a page at a time, as the "Save many chats" page
 * loads it. A page that fails after the first leaves the chats found
 * so far; the rest are found next time.
 */
async function listAllConversations(
  tabId: number,
  site: ChatSite,
): Promise<ConversationSummary[]> {
  const found = new Map<string, ConversationSummary>();
  let cursor: string | null = null;

  try {
    do {
      const page: ConversationListPage = await sendToChatTab(tabId, site, {
        type: "LIST_CONVERSATIONS_PAGE",
        cursor,
      });
      let added = 0;

      for (const conversation of page.conversations) {
        if (!found.has(conversation.id)) {
          found.set(conversation.id, conversation);
          added++;
        }
      }

      // A page with nothing new means an API that ignores paging.
      cursor = added > 0 ? page.nextCursor : null;
    } while (cursor !== null);
  } catch (error) {
    if (found.size === 0) {
      throw error;
    }
  }

  return [...found.values()];
}

async function loadBackupFiles(
  tabId: number,
  site: ChatSite,
  conversation: ConversationSummary,
  format: BackupFormat,
  settings: Settings,
): Promise<BackupFile[]> {
  for (let attempt = 0; ; attempt++) {
    try {
      const data = await sendToChatTab<{
        messages?: Message[];
        images?: ExportImageFile[];
      }>(tabId, site, {
        type: "LOAD_CONVERSATION",
        conversationId: conversation.id,
        downloadImagesLocally: settings.downloadImagesLocally,
      });

      if (!data.messages?.length) {
        throw new Error(t("popup.error.noMessagesFound"));
      }

      return await buildBackupFiles(
        site,
        conversation,
        [...data.messages].sort((a, b) => a.order - b.order),
        data.images ?? [],
        format,
        settings,
      );
    } catch (error) {
      if (error instanceof TabUnavailableError || attempt >= RETRY_DELAYS_MS.length) {
        throw error;
      }

      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
}

/* Settles a backup download's wait, by its id */
const downloadWaiters = new Map<number, (error: string | null) => void>();

chrome.downloads.onChanged.addListener((delta) => {
  const state = delta.state?.current;

  if (state === "complete") {
    downloadWaiters.get(delta.id)?.(null);
  } else if (state === "interrupted") {
    downloadWaiters.get(delta.id)?.(delta.error?.current ?? "INTERRUPTED");
  }
});

/*
 * Resolves once the file is on disk. A browser set to ask where to
 * save every file asks for a backup file too, whatever saveAs says:
 * that dialog cancelled, or left unanswered, is a SaveAsError.
 */
function downloadFinished(id: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const settle = (error: string | null): void => {
      downloadWaiters.delete(id);
      clearTimeout(timer);

      if (error === null) {
        resolve();
      } else if (error === "USER_CANCELED") {
        reject(new SaveAsError(t("backup.error.saveAs")));
      } else {
        reject(new Error(t("backup.error.download", { error })));
      }
    };
    const timer = setTimeout(() => {
      void chrome.downloads.cancel(id).catch(() => undefined);
      settle("USER_CANCELED");
    }, BACKUP_DOWNLOAD_WAIT_MS);

    downloadWaiters.set(id, settle);

    // It may have finished before anyone waited for it.
    void chrome.downloads.search({ id }).then(([item]) => {
      if (item?.state === "complete") {
        downloadWaiters.get(id)?.(null);
      } else if (item?.state === "interrupted") {
        downloadWaiters.get(id)?.(item.error ?? "INTERRUPTED");
      }
    });
  });
}

/*
 * One backup file into the Downloads folder, over its old copy and
 * without asking where; then it's taken off the browser's list of
 * downloads, which a backup of hundreds of chats would fill.
 */
async function saveBackupDownload(file: BackupFile): Promise<void> {
  const url = canCreateObjectUrls()
    ? URL.createObjectURL(file.blob)
    : await createDownloadUrl(
        await encodeBlobBase64(file.blob),
        file.blob.type || "application/octet-stream",
      );

  try {
    const id = await chrome.downloads.download({
      url,
      filename: file.path,
      conflictAction: "overwrite",
      saveAs: false,
    });

    try {
      await downloadFinished(id);
    } finally {
      void chrome.downloads.erase({ id }).catch(() => undefined);
    }
  } finally {
    revokeDownloadUrl(url);
  }
}

/* The chats saved so far where the backup goes now, by site */
async function loadBackedUp(target: string): Promise<Record<string, unknown>> {
  const stored = (await chrome.storage.local.get(BACKUP_SAVED_KEY))[
    BACKUP_SAVED_KEY
  ] as { target?: unknown; chats?: Record<string, unknown> } | undefined;

  return stored?.target === target && stored.chats ? stored.chats : {};
}

async function rememberBackedUp(
  target: string,
  site: ChatSite,
  conversations: ConversationSummary[],
): Promise<void> {
  const chats = withSavedChats(await loadBackedUp(target), site, conversations);

  await chrome.storage.local.set({ [BACKUP_SAVED_KEY]: { target, chats } });
}

interface SiteBackup {
  saved: number;
  failed: number;
  /* Why the site stopped early: it's tried again within the hour */
  error?: string;
  /* The place the chats go refused them: no use going on with any site */
  stopped?: unknown;
}

async function backupSite(
  site: ChatSite,
  tabId: number,
  config: BackupConfig,
  settings: Settings,
): Promise<SiteBackup> {
  const target = backupTarget(config);
  const result: SiteBackup = { saved: 0, failed: 0 };
  let conversations: ConversationSummary[];

  try {
    conversations = await listAllConversations(tabId, site);
  } catch (error) {
    return { ...result, error: errorText(error) };
  }

  const saved = savedChats(await loadBackedUp(target), site);
  const batch: { conversation: ConversationSummary; files: BackupFile[] }[] = [];
  let failuresInARow = 0;

  /*
   * The first chat goes to GitHub on its own, which shows straight
   * away whether the repository takes them; then a commit at a time.
   */
  const commit = async (): Promise<void> => {
    if (batch.length === 0) {
      return;
    }

    await commitFiles(
      config.repo,
      batch.flatMap((item) => item.files),
      `Back up ${batch.length} ${CHAT_SITE_NAMES[site]} chats with AI Exporter`,
    );
    await rememberBackedUp(target, site, batch.map((item) => item.conversation));
    result.saved += batch.length;
    batch.length = 0;
  };

  try {
    for (const conversation of conversations) {
      if (!needsSaving(conversation, saved)) {
        continue;
      }

      let files: BackupFile[];

      try {
        files = await loadBackupFiles(tabId, site, conversation, config.format, settings);
        failuresInARow = 0;
      } catch (error) {
        if (error instanceof TabUnavailableError) {
          result.error = t("backup.error.tabClosed", { site: CHAT_SITE_NAMES[site] });
          break;
        }

        devError("AI Exporter: couldn't back up a chat", conversation.id, error);
        result.failed++;

        if (++failuresInARow >= BACKUP_FAILURES_IN_A_ROW) {
          result.error = t("backup.error.siteFailed", { site: CHAT_SITE_NAMES[site] });
          break;
        }

        continue;
      }

      if (config.target === "downloads") {
        for (const file of files) {
          await saveBackupDownload(file);
        }

        await rememberBackedUp(target, site, [conversation]);
        result.saved++;
      } else {
        batch.push({ conversation, files });

        const bytes = batch.reduce(
          (sum, item) => sum + item.files.reduce((size, file) => size + file.blob.size, 0),
          0,
        );

        if (
          result.saved === 0 ||
          batch.length >= BACKUP_COMMIT_CHATS ||
          bytes >= BACKUP_COMMIT_BYTES
        ) {
          await commit();
        }
      }

      await sleep(PAUSE_BETWEEN_CHATS_MS);
    }

    await commit();
  } catch (error) {
    return { ...result, stopped: error };
  }

  return result;
}

async function runBackup(force: boolean): Promise<BackupStatus> {
  const config = await loadBackupConfig();
  let status = backupStatus(
    (await chrome.storage.local.get(BACKUP_STATUS_KEY))[BACKUP_STATUS_KEY],
  );
  const saveStatus = (): Promise<void> =>
    chrome.storage.local.set({ [BACKUP_STATUS_KEY]: status });

  if (!config.enabled && !force) {
    return status;
  }

  if (config.target === "github") {
    const problem = !isValidRepoFullName(config.repo)
      ? t("backup.error.noRepo")
      : !(await getStoredToken()) || !(await hasGitHubAccess())
        ? t("github.error.notConnected")
        : null;

    if (problem) {
      status = { ...status, error: problem };
      await saveStatus();
      return status;
    }
  }

  // A new place or file type has none of the chats yet: every site is due.
  const target = backupTarget(config);

  if (status.target !== target) {
    status = { ...status, target, sites: {} };
  }

  const tabs = await findChatTabs();
  const startedAt = Date.now();
  const sites = [...tabs.keys()].filter(
    (site) => force || isBackupDue(status.sites[site], config.every, startedAt),
  );

  if (sites.length === 0) {
    if (force) {
      throw new Error(t("backup.error.noTabs"));
    }

    return status;
  }

  const settings = await loadSettings();
  const keepAlive = setInterval(() => {
    void chrome.runtime.getPlatformInfo();
  }, BACKUP_KEEPALIVE_MS);
  let saved = 0;
  let failed = 0;
  let error: string | undefined;

  try {
    for (const site of sites) {
      const result = await backupSite(site, tabs.get(site)!, config, settings);

      saved += result.saved;
      failed += result.failed;

      /*
       * The site wasn't backed up, so it keeps what it had and stays
       * due. Asked where to save every file, a backup would ask again
       * every half hour: it's turned off, and the settings say why.
       */
      if (result.stopped !== undefined) {
        error = errorText(result.stopped);

        if (result.stopped instanceof SaveAsError) {
          await chrome.storage.local.set({
            [BACKUP_CONFIG_KEY]: { ...config, enabled: false },
          });
        }

        break;
      }

      status = {
        ...status,
        sites: {
          ...status.sites,
          [site]: { at: startedAt, ...(result.error ? { error: result.error } : {}) },
        },
      };
      await saveStatus();
    }
  } finally {
    clearInterval(keepAlive);
  }

  status = { ...status, at: Date.now(), saved, failed, error };
  await saveStatus();

  return status;
}

/* One backup at a time; asking during one gets that one's outcome */
let backupRun: Promise<BackupStatus> | null = null;

function startBackup(force: boolean): Promise<BackupStatus> {
  backupRun ??= new Promise<BackupStatus>((resolve, reject) => {
    void trackTask(() => runBackup(force).then(resolve, reject));
  }).finally(() => {
    backupRun = null;
  });

  return backupRun;
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === BACKUP_ALARM) {
    startBackup(false).catch((error) => {
      devError("AI Exporter: the automatic backup failed", error);
    });
  }
});

/* content.ts, as a chat site's page opens */
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type !== "AIEXPORTER_PAGE_OPENED" || !isOwnExtensionSender(sender)) {
    return false;
  }

  scheduleBackup(true).catch((error) => {
    devError("AI Exporter: couldn't schedule the backup", error);
  });

  return false;
});

/* The settings page's "Back up now" */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "BACKUP_RUN" || !isOwnExtensionSender(sender)) {
    return false;
  }

  startBackup(true).then(
    (status) => sendResponse({ success: true, data: status }),
    (error) => sendResponse({ success: false, error: errorText(error) }),
  );

  return true;
});

/* Turned on or off, or changed, in the settings */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[BACKUP_CONFIG_KEY]) {
    scheduleBackup(true).catch((error) => {
      devError("AI Exporter: couldn't schedule the backup", error);
    });
  }
});

/*
 * The browser may drop alarms when it restarts, and does when the
 * extension updates: every start of the background puts it back.
 */
scheduleBackup().catch((error) => {
  devError("AI Exporter: couldn't schedule the backup", error);
});
