import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * ---------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------
 *
 * background.ts's DOWNLOAD_START handler is the fix for the
 * Firefox "download failed" / "no success overlay" bugs: a
 * blob: URL created in popup.ts stopped being readable the
 * instant Firefox closed the popup for the native Save As
 * dialog, and routing the success overlay through a
 * popup-local DOWNLOAD_COMPLETE listener meant it could never
 * fire once the popup was gone.
 *
 * The fix moved both the chrome.downloads.download() call and
 * the success-overlay trigger into background.ts, which has
 * no such lifecycle issue in either browser. There is no
 * browser-specific branching left in this code at all - the
 * whole point is that the same code path now works identically
 * in Chrome and Firefox. These tests exist to make sure a
 * future change to this flow can't silently break one browser
 * while "fixing" the other: every assertion here must hold
 * regardless of which browser the WebExtensions APIs belong to.
 */

const runtimeId = "test-extension-id";

const downloadsDownload = vi.fn();
const tabsSendMessage = vi.fn();
const storageSyncGet = vi.fn();
const onMessageListeners: Array<
  (
    message: any,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: any) => void,
  ) => boolean | void
> = [];
const onChangedListeners: Array<
  (delta: chrome.downloads.DownloadDelta) => void
> = [];

/*
 * A minimal, spec-accurate URL.createObjectURL/revokeObjectURL
 * stub. Real object URLs are opaque strings scoped to the
 * realm that created them - all these tests care about is that
 * each blob gets a distinct URL, and that the URL handed to
 * chrome.downloads.download() is the exact one later revoked.
 */
let nextObjectUrlId = 0;
const createObjectURL = vi.fn((_blob: Blob) => {
  nextObjectUrlId += 1;

  return `blob:mock-url-${nextObjectUrlId}`;
});
const revokeObjectURL = vi.fn();

/*
 * GITHUB_SAVE_FILE shares isValidExportFilename() with
 * DOWNLOAD_START (see SAFE_FILENAME_PATTERN in background.ts),
 * so it's exercised by the Cyrillic-filename regression tests
 * below too. fetch is stubbed to reject so saveFileToRepo()
 * fails fast past validation instead of hanging on a real
 * network call - the tests only care whether the request got
 * past the filename gate, not whether the GitHub save itself
 * succeeds.
 */
const fetchMock = vi.fn().mockRejectedValue(new Error("network disabled in test"));

vi.stubGlobal("chrome", {
  runtime: {
    id: runtimeId,
    onMessage: {
      addListener: (listener: (typeof onMessageListeners)[number]) => {
        onMessageListeners.push(listener);
      },
    },
    sendMessage: vi.fn().mockResolvedValue(undefined),
    getContexts: vi.fn().mockResolvedValue([]),
  },
  downloads: {
    download: downloadsDownload,
    onChanged: {
      addListener: (listener: (typeof onChangedListeners)[number]) => {
        onChangedListeners.push(listener);
      },
    },
  },
  tabs: {
    sendMessage: tabsSendMessage,
  },
  storage: {
    sync: {
      get: storageSyncGet,
      set: vi.fn(),
    },
    local: {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn(),
      remove: vi.fn(),
    },
  },
  i18n: {
    getUILanguage: vi.fn(() => "en-US"),
  },
});

vi.stubGlobal("fetch", fetchMock);

/*
 * Patch the real URL class in place (rather than replacing the
 * global with a plain object) so `new URL(...)` elsewhere in
 * the import chain - e.g. github.ts building API request URLs
 * - keeps working.
 */
URL.createObjectURL = createObjectURL as typeof URL.createObjectURL;
URL.revokeObjectURL = revokeObjectURL;

/*
 * Dispatches a message to whichever registered listener claims
 * it (mirrors how chrome.runtime.onMessage actually dispatches:
 * each listener gets a chance to return true/handle it), and
 * resolves with whatever that listener passes to sendResponse -
 * exactly what `await chrome.runtime.sendMessage(...)` would
 * resolve to from popup.ts's perspective.
 */
async function dispatchMessage(
  message: any,
  sender: Partial<chrome.runtime.MessageSender> = { id: runtimeId },
): Promise<any> {
  for (const listener of onMessageListeners) {
    let settled = false;
    let resolvePromise: (value: any) => void;
    const responsePromise = new Promise<any>((resolve) => {
      resolvePromise = resolve;
    });

    const handled = listener(
      message,
      sender as chrome.runtime.MessageSender,
      (response?: any) => {
        settled = true;
        resolvePromise(response);
      },
    );

    if (handled === true) {
      return responsePromise;
    }

    if (settled) {
      return responsePromise;
    }
  }

  throw new Error(`No listener handled message type "${message.type}"`);
}

function emitDownloadChanged(delta: chrome.downloads.DownloadDelta): void {
  for (const listener of onChangedListeners) {
    listener(delta);
  }
}

describe("background.ts download flow (Chrome + Firefox parity)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    onMessageListeners.length = 0;
    onChangedListeners.length = 0;
    nextObjectUrlId = 0;

    storageSyncGet.mockImplementation((defaults: Record<string, unknown>) =>
      Promise.resolve(defaults),
    );
    downloadsDownload.mockResolvedValue(1);
    tabsSendMessage.mockResolvedValue(undefined);

    await import("../src/background");
  });

  const validContent = btoa("hello world");

  function validDownloadStartMessage(overrides: Record<string, unknown> = {}) {
    return {
      type: "DOWNLOAD_START",
      filename: "conversation.md",
      mimeType: "text/markdown",
      content: validContent,
      saveAs: true,
      tabId: 42,
      ...overrides,
    };
  }

  describe("DOWNLOAD_START validation", () => {
    it("rejects a message from a sender outside the extension", async () => {
      for (const listener of onMessageListeners) {
        const result = listener(
          validDownloadStartMessage(),
          { id: "some-other-extension" } as chrome.runtime.MessageSender,
          vi.fn(),
        );

        if (result === true) {
          throw new Error(
            "DOWNLOAD_START handler must not claim a message from a foreign sender",
          );
        }
      }

      expect(downloadsDownload).not.toHaveBeenCalled();
    });

    it("rejects a filename containing path traversal", async () => {
      const response = await dispatchMessage(
        validDownloadStartMessage({ filename: "../../etc/passwd" }),
      );

      expect(response.success).toBe(false);
      expect(downloadsDownload).not.toHaveBeenCalled();
    });

    it("rejects non-base64 content", async () => {
      const response = await dispatchMessage(
        validDownloadStartMessage({ content: "not-base64!!" }),
      );

      expect(response.success).toBe(false);
      expect(downloadsDownload).not.toHaveBeenCalled();
    });

    it("rejects a non-boolean saveAs", async () => {
      const response = await dispatchMessage(
        validDownloadStartMessage({ saveAs: "true" }),
      );

      expect(response.success).toBe(false);
      expect(downloadsDownload).not.toHaveBeenCalled();
    });

    it("rejects a non-numeric tabId", async () => {
      const response = await dispatchMessage(
        validDownloadStartMessage({ tabId: "42" }),
      );

      expect(response.success).toBe(false);
      expect(downloadsDownload).not.toHaveBeenCalled();
    });

    it("accepts a request with tabId omitted", async () => {
      const message = validDownloadStartMessage();
      delete (message as Record<string, unknown>).tabId;

      const response = await dispatchMessage(message);

      expect(response.success).toBe(true);
    });

    /*
     * Regression test. buildFilename() in popup.ts deliberately
     * keeps Cyrillic characters (Ѐ-ӿ) in the filename
     * instead of collapsing them to hyphens like other non-ASCII
     * scripts, so a Cyrillic ChatGPT conversation title still
     * produces a readable name, e.g.
     * "chatgpt-export-здравей-2026-10-01.pdf".
     * SAFE_FILENAME_PATTERN used to be ASCII-only
     * (/^[A-Za-z0-9._-]+$/), which silently rejected every such
     * filename as "Invalid download request." right after the
     * Firefox fix moved this validation in front of the actual
     * chrome.downloads.download() call - breaking exports for
     * any Cyrillic-titled conversation in both browsers.
     */
    it("accepts a filename containing Cyrillic characters", async () => {
      const response = await dispatchMessage(
        validDownloadStartMessage({
          filename: "chatgpt-export-здравей-2026-10-01.pdf",
        }),
      );

      expect(response.success).toBe(true);
      expect(downloadsDownload).toHaveBeenCalledWith(
        expect.objectContaining({
          filename:
            "chatgpt-export-здравей-2026-10-01.pdf",
        }),
      );
    });

    it("still rejects Cyrillic text combined with path traversal", async () => {
      const response = await dispatchMessage(
        validDownloadStartMessage({
          filename: "../здравей.pdf",
        }),
      );

      expect(response.success).toBe(false);
      expect(downloadsDownload).not.toHaveBeenCalled();
    });
  });

  describe("starting a download", () => {
    it("builds a blob: URL from the decoded base64 and downloads it", async () => {
      const response = await dispatchMessage(validDownloadStartMessage());

      expect(response).toEqual({ success: true, data: { downloadId: 1 } });

      expect(createObjectURL).toHaveBeenCalledTimes(1);

      const [blobArg] = createObjectURL.mock.calls[0];
      expect(blobArg.type).toBe("text/markdown");
      expect(await blobArg.text()).toBe("hello world");

      expect(downloadsDownload).toHaveBeenCalledWith({
        url: "blob:mock-url-1",
        filename: "conversation.md",
        saveAs: true,
      });
    });

    it("passes saveAs through as given (false skips the native dialog)", async () => {
      await dispatchMessage(validDownloadStartMessage({ saveAs: false }));

      expect(downloadsDownload).toHaveBeenCalledWith(
        expect.objectContaining({ saveAs: false }),
      );
    });

    it("surfaces an error and revokes the object URL if downloads.download() rejects", async () => {
      /*
       * This is the shape of failure Firefox used to produce
       * for the old data: URL approach ("Access denied for
       * URL ..."), and generally what any downloads.download()
       * rejection looks like in either browser.
       */
      downloadsDownload.mockRejectedValueOnce(
        new Error("Access denied for URL"),
      );

      const response = await dispatchMessage(validDownloadStartMessage());

      expect(response).toEqual({
        success: false,
        error: "Access denied for URL",
      });
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock-url-1");
    });
  });

  describe("download completion -> success overlay", () => {
    it("sends SHOW_EXPORT_SUCCESS to the originating tab once the download completes", async () => {
      await dispatchMessage(validDownloadStartMessage({ tabId: 7 }));

      emitDownloadChanged({
        id: 1,
        state: { previous: "in_progress", current: "complete" },
      } as chrome.downloads.DownloadDelta);

      expect(tabsSendMessage).toHaveBeenCalledWith(7, {
        type: "SHOW_EXPORT_SUCCESS",
      });
    });

    it("revokes the object URL once the download completes", async () => {
      await dispatchMessage(validDownloadStartMessage());

      emitDownloadChanged({
        id: 1,
        state: { previous: "in_progress", current: "complete" },
      } as chrome.downloads.DownloadDelta);

      expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock-url-1");
    });

    it("does NOT show the success overlay when the download is interrupted (e.g. Save As cancelled)", async () => {
      await dispatchMessage(validDownloadStartMessage({ tabId: 7 }));

      emitDownloadChanged({
        id: 1,
        state: { previous: "in_progress", current: "interrupted" },
      } as chrome.downloads.DownloadDelta);

      expect(tabsSendMessage).not.toHaveBeenCalled();
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock-url-1");
    });

    it("ignores onChanged events for downloads it isn't tracking", async () => {
      emitDownloadChanged({
        id: 999,
        state: { previous: "in_progress", current: "complete" },
      } as chrome.downloads.DownloadDelta);

      expect(tabsSendMessage).not.toHaveBeenCalled();
      expect(revokeObjectURL).not.toHaveBeenCalled();
    });

    it("does not crash and does not notify any tab when no tabId was provided", async () => {
      const message = validDownloadStartMessage();
      delete (message as Record<string, unknown>).tabId;

      await dispatchMessage(message);

      emitDownloadChanged({
        id: 1,
        state: { previous: "in_progress", current: "complete" },
      } as chrome.downloads.DownloadDelta);

      expect(tabsSendMessage).not.toHaveBeenCalled();
    });

    it("swallows a failed chrome.tabs.sendMessage (e.g. the ChatGPT tab was navigated away or closed)", async () => {
      tabsSendMessage.mockRejectedValueOnce(new Error("No tab with id: 7"));

      await dispatchMessage(validDownloadStartMessage({ tabId: 7 }));

      expect(() =>
        emitDownloadChanged({
          id: 1,
          state: { previous: "in_progress", current: "complete" },
        } as chrome.downloads.DownloadDelta),
      ).not.toThrow();
    });

    it("stops tracking a download after it completes, so a later duplicate event is a no-op", async () => {
      await dispatchMessage(validDownloadStartMessage({ tabId: 7 }));

      emitDownloadChanged({
        id: 1,
        state: { previous: "in_progress", current: "complete" },
      } as chrome.downloads.DownloadDelta);

      tabsSendMessage.mockClear();
      revokeObjectURL.mockClear();

      emitDownloadChanged({
        id: 1,
        state: { previous: "complete", current: "complete" },
      } as chrome.downloads.DownloadDelta);

      expect(tabsSendMessage).not.toHaveBeenCalled();
      expect(revokeObjectURL).not.toHaveBeenCalled();
    });
  });

  describe("multiple concurrent downloads", () => {
    it("routes each completion to its own tab independently", async () => {
      downloadsDownload.mockResolvedValueOnce(1).mockResolvedValueOnce(2);

      await dispatchMessage(
        validDownloadStartMessage({ tabId: 7, filename: "a.md" }),
      );
      await dispatchMessage(
        validDownloadStartMessage({ tabId: 9, filename: "b.md" }),
      );

      emitDownloadChanged({
        id: 2,
        state: { previous: "in_progress", current: "complete" },
      } as chrome.downloads.DownloadDelta);

      expect(tabsSendMessage).toHaveBeenCalledWith(9, {
        type: "SHOW_EXPORT_SUCCESS",
      });
      expect(tabsSendMessage).not.toHaveBeenCalledWith(
        7,
        expect.anything(),
      );

      emitDownloadChanged({
        id: 1,
        state: { previous: "in_progress", current: "complete" },
      } as chrome.downloads.DownloadDelta);

      expect(tabsSendMessage).toHaveBeenCalledWith(7, {
        type: "SHOW_EXPORT_SUCCESS",
      });
    });
  });

  /*
   * GITHUB_SAVE_FILE reuses isValidExportFilename() /
   * SAFE_FILENAME_PATTERN too (saveToGitHub() in popup.ts calls
   * buildFilename() the same way the download flow does), so it
   * carries the exact same Cyrillic-filename regression risk.
   * fetch is stubbed to reject, so a request that gets past
   * validation fails later for an unrelated reason ("network
   * disabled in test" / "Not connected to GitHub.") rather than
   * "Invalid save request." - these tests only check which side
   * of that line the response landed on.
   */
  describe("GITHUB_SAVE_FILE filename validation", () => {
    function validGithubSaveMessage(overrides: Record<string, unknown> = {}) {
      return {
        type: "GITHUB_SAVE_FILE",
        fullName: "octocat/Hello-World",
        filename: "conversation.md",
        content: "# hello",
        binary: false,
        ...overrides,
      };
    }

    it("rejects a message from a sender outside the extension", () => {
      for (const listener of onMessageListeners) {
        const result = listener(
          validGithubSaveMessage(),
          { id: "some-other-extension" } as chrome.runtime.MessageSender,
          vi.fn(),
        );

        if (result === true) {
          throw new Error(
            "GITHUB_SAVE_FILE handler must not claim a message from a foreign sender",
          );
        }
      }
    });

    it("rejects a filename containing path traversal", async () => {
      const response = await dispatchMessage(
        validGithubSaveMessage({ filename: "../../etc/passwd" }),
      );

      expect(response).toEqual({
        success: false,
        error: "Invalid save request.",
      });
    });

    it("does not reject a filename containing Cyrillic characters", async () => {
      const response = await dispatchMessage(
        validGithubSaveMessage({
          filename: "chatgpt-export-здравей-2026-10-01.md",
        }),
      );

      expect(response.success).toBe(false);
      expect(response.error).not.toBe("Invalid save request.");
    });
  });
});
