import {
  startDeviceFlow,
  pollForAccessToken,
  getStoredToken,
  getCurrentUser,
  disconnectGitHub,
  listRepos,
  saveFileToRepo,
  starProject,
} from "./github.ts";
import { initI18n } from "./i18n.ts";
import { decodeBase64, copyToArrayBuffer } from "./zip.ts";

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
    URL.revokeObjectURL(url);
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
  }
});

/*
 * GitHub "owner/repo" full_name as returned by the GitHub
 * API: two path segments, each restricted to the characters
 * GitHub allows in user/org and repo names.
 */
const REPO_FULL_NAME_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/*
 * Matches the filenames buildFilename() in popup.ts generates:
 * no path separators, no traversal segments. buildFilename()
 * keeps Cyrillic characters (Ѐ-ӿ) as-is instead of
 * collapsing them to hyphens like every other non-ASCII script,
 * specifically so a Cyrillic ChatGPT conversation title still
 * produces a readable filename - so this pattern has to allow
 * that range too, or every export/GitHub-save of a
 * Cyrillic-titled conversation gets rejected here as an
 * "Invalid download request"/"Invalid save request" even though
 * popup.ts built a perfectly normal filename.
 */
const SAFE_FILENAME_PATTERN = /^[A-Za-z0-9Ѐ-ӿ._-]+$/;

const MAX_EXPORT_CONTENT_LENGTH = 10_000_000;
const MAX_BINARY_EXPORT_CONTENT_LENGTH = 45_000_000;

function isValidRepoFullName(value: unknown): value is string {
  return typeof value === "string" && REPO_FULL_NAME_PATTERN.test(value);
}

function isValidExportFilename(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 255 &&
    SAFE_FILENAME_PATTERN.test(value) &&
    !value.includes("..")
  );
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

  (async () => {
    let objectUrl: string | undefined;

    try {
      const bytes = decodeBase64(message.content);
      const blob = new Blob([copyToArrayBuffer(bytes)], {
        type: message.mimeType,
      });

      objectUrl = URL.createObjectURL(blob);

      const downloadId = await chrome.downloads.download({
        url: objectUrl,
        filename: message.filename,
        saveAs: message.saveAs,
      });

      trackedDownloadIds.add(downloadId);
      pendingObjectUrls.set(downloadId, objectUrl);

      if (typeof message.tabId === "number") {
        pendingDownloadTabIds.set(downloadId, message.tabId);
      }

      sendResponse({ success: true, data: { downloadId } });
    } catch (error) {
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }

      sendResponse({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();

  return true;
});

async function setupOffscreenDocument(): Promise<void> {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });

  if (existingContexts.length > 0) {
    return;
  }

  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["CLIPBOARD"],
    justification: "Copy exported ChatGPT conversation to clipboard.",
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "COPY_TO_CLIPBOARD") {
    return false;
  }

  if (!isOwnExtensionSender(sender)) {
    return false;
  }

  (async () => {
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
  })();

  /*
   * MUST return true synchronously so Chrome
   * keeps the message channel open until
   * sendResponse is called inside the async IIFE
   * above. Without this, the channel closes
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

  (async () => {
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
  })();

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

      if (!token) {
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

  (async () => {
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
  })();

  return true;
});
