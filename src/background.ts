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
} from "./github.ts";
import {
  connectNotionWithToken,
  createNotionPage,
  disconnectNotion,
  getNotionConnection,
  listNotionPages,
} from "./notion.ts";
import type { NotionBlock } from "./notion-blocks.ts";
import { initI18n } from "./i18n.ts";
import { decodeBase64, copyToArrayBuffer } from "./zip.ts";
import { asciiFileName, isSafeFileName } from "./file-names.ts";
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "COPY_TO_CLIPBOARD") {
    return false;
  }

  if (!isOwnExtensionSender(sender)) {
    return false;
  }

  void trackTask(async () => {
    try {
      await setupOffscreenDocument();

      const response = await chrome.runtime.sendMessage({
        type: "OFFSCREEN_COPY",
        data: message.data,
      });

      sendResponse(response);
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
