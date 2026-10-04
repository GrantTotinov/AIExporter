import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
 * no such lifecycle issue in either browser. The one thing that
 * differs between the browsers is where the download's blob:
 * URL comes from: Firefox runs background.ts as an event page,
 * which makes it itself, while Chrome runs it as an MV3 service
 * worker, which has no URL.createObjectURL() and asks the
 * offscreen document for one instead (see the "Chrome service
 * worker" tests at the bottom - calling URL.createObjectURL()
 * there is what broke every Chrome export). These tests exist
 * to make sure a future change to this flow can't silently
 * break one browser while "fixing" the other.
 */

const runtimeId = "test-extension-id";

const downloadsDownload = vi.fn();
const downloadsSearch = vi.fn();
const tabsSendMessage = vi.fn();
const storageSyncGet = vi.fn();
const runtimeSendMessage = vi.fn();
const runtimeGetContexts = vi.fn();
const runtimeReload = vi.fn();
const runtimeRequestUpdateCheck = vi.fn();
const alarmsCreate = vi.fn();
const alarmsClear = vi.fn();
const offscreenCreateDocument = vi.fn();
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
const onUpdateAvailableListeners: Array<
  (details: chrome.runtime.UpdateAvailableDetails) => void
> = [];
const onInstalledListeners: Array<
  (details: chrome.runtime.InstalledDetails) => void
> = [];
const onAlarmListeners: Array<(alarm: chrome.alarms.Alarm) => void> = [];

let runningVersion = "2.3.0";

/*
 * chrome.storage.local, kept in memory: the update flow reads
 * back the state it wrote. Values go through JSON like they do
 * in Chrome, so a property set to undefined is dropped.
 */
let localStorageItems: Record<string, unknown> = {};

const storageLocal = {
  get: vi.fn(async (keys?: string | string[] | null) => {
    if (keys === undefined || keys === null) {
      return { ...localStorageItems };
    }

    return Object.fromEntries(
      [keys]
        .flat()
        .filter((key) => key in localStorageItems)
        .map((key) => [key, localStorageItems[key]]),
    );
  }),
  set: vi.fn(async (items: Record<string, unknown>) => {
    Object.assign(localStorageItems, JSON.parse(JSON.stringify(items)));
  }),
  remove: vi.fn(async (keys: string | string[]) => {
    for (const key of [keys].flat()) {
      delete localStorageItems[key];
    }
  }),
};

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
 * DOWNLOAD_START (isSafeFileName() in file-names.ts), so it's
 * exercised by the Cyrillic-filename regression tests
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
    onUpdateAvailable: {
      addListener: (listener: (typeof onUpdateAvailableListeners)[number]) => {
        onUpdateAvailableListeners.push(listener);
      },
    },
    onInstalled: {
      addListener: (listener: (typeof onInstalledListeners)[number]) => {
        onInstalledListeners.push(listener);
      },
    },
    sendMessage: runtimeSendMessage,
    getContexts: runtimeGetContexts,
    getManifest: () => ({ version: runningVersion }),
    reload: runtimeReload,
    requestUpdateCheck: runtimeRequestUpdateCheck,
  },
  alarms: {
    create: alarmsCreate,
    clear: alarmsClear,
    onAlarm: {
      addListener: (listener: (typeof onAlarmListeners)[number]) => {
        onAlarmListeners.push(listener);
      },
    },
  },
  offscreen: {
    createDocument: offscreenCreateDocument,
  },
  downloads: {
    download: downloadsDownload,
    search: downloadsSearch,
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
    local: storageLocal,
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

/*
 * A fresh background.ts, as when the browser starts it - or,
 * in Chrome, wakes the service worker up again.
 */
async function startBackground(): Promise<void> {
  vi.resetModules();
  onMessageListeners.length = 0;
  onChangedListeners.length = 0;
  onUpdateAvailableListeners.length = 0;
  onInstalledListeners.length = 0;
  onAlarmListeners.length = 0;

  await import("../src/background");
}

describe("background.ts download flow (Chrome + Firefox parity)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    nextObjectUrlId = 0;
    localStorageItems = {};
    runningVersion = "2.3.0";

    storageSyncGet.mockImplementation((defaults: Record<string, unknown>) =>
      Promise.resolve(defaults),
    );
    downloadsDownload.mockResolvedValue(1);
    downloadsSearch.mockReset().mockResolvedValue([]);
    tabsSendMessage.mockResolvedValue(undefined);
    runtimeSendMessage.mockReset().mockResolvedValue(undefined);
    runtimeGetContexts.mockReset().mockResolvedValue([]);
    runtimeReload.mockReset();
    runtimeRequestUpdateCheck.mockReset();
    alarmsCreate.mockReset().mockResolvedValue(undefined);
    alarmsClear.mockReset().mockResolvedValue(true);
    offscreenCreateDocument.mockReset().mockResolvedValue(undefined);

    await startBackground();
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

    /*
     * The person's own file name pattern (Settings.fileNameTemplate)
     * can make names with spaces, punctuation and any script.
     */
    it("accepts names written with spaces, punctuation and any script", async () => {
      for (const filename of [
        "2026-10-04 Trip ideas (Rome).pdf",
        "ChatGPT - Café & croissants - 2026-10-04.docx",
        "如何学习编程.md",
        "שלום עולם.html",
      ]) {
        downloadsDownload.mockClear();

        const response = await dispatchMessage(
          validDownloadStartMessage({ filename }),
        );

        expect(response.success).toBe(true);
        expect(downloadsDownload).toHaveBeenCalledWith(
          expect.objectContaining({ filename }),
        );
      }
    });

    it("rejects names a browser would refuse", async () => {
      for (const filename of [
        "Trip: Rome.pdf",
        "What?.pdf",
        " leading space.pdf",
        "trailing space .pdf",
        "con.pdf",
        "a..b.pdf",
        "folder/file.pdf",
        "folder\\file.pdf",
        `bidi${String.fromCodePoint(0x202e)}fdp.exe.pdf`,
        "no-extension",
      ]) {
        const response = await dispatchMessage(
          validDownloadStartMessage({ filename }),
        );

        expect(response.success).toBe(false);
      }

      expect(downloadsDownload).not.toHaveBeenCalled();
    });
  });

  describe("a name the browser refuses", () => {
    it("is retried once as plain ASCII", async () => {
      downloadsDownload
        .mockRejectedValueOnce(new Error("Invalid filename"))
        .mockResolvedValueOnce(5);

      const response = await dispatchMessage(
        validDownloadStartMessage({ filename: "Café ideas.pdf" }),
      );

      expect(response).toEqual({ success: true, data: { downloadId: 5 } });
      expect(downloadsDownload).toHaveBeenCalledTimes(2);
      expect(downloadsDownload).toHaveBeenLastCalledWith(
        expect.objectContaining({ filename: "Cafe-ideas.pdf" }),
      );
    });

    it("isn't retried for an error that has nothing to do with the name", async () => {
      downloadsDownload.mockRejectedValueOnce(new Error("Download canceled"));

      const response = await dispatchMessage(
        validDownloadStartMessage({ filename: "Café ideas.pdf" }),
      );

      expect(response).toEqual({ success: false, error: "Download canceled" });
      expect(downloadsDownload).toHaveBeenCalledTimes(1);
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

  /*
   * Chrome runs background.ts as an MV3 service worker, where
   * URL.createObjectURL/revokeObjectURL don't exist - calling
   * them failed every Chrome export with "URL.createObjectURL is
   * not a function". There the offscreen document makes (and
   * later revokes) the blob: URL.
   */
  describe("in a Chrome service worker (no URL.createObjectURL)", () => {
    const offscreenUrl = "blob:chrome-extension://test-extension-id/7f3c2b1a";

    beforeEach(() => {
      URL.createObjectURL = undefined as unknown as typeof URL.createObjectURL;
      URL.revokeObjectURL = undefined as unknown as typeof URL.revokeObjectURL;

      runtimeSendMessage.mockImplementation(async (message: { type: string }) =>
        message.type === "OFFSCREEN_CREATE_BLOB_URL"
          ? { success: true, url: offscreenUrl }
          : { success: true },
      );
    });

    afterEach(() => {
      URL.createObjectURL = createObjectURL as typeof URL.createObjectURL;
      URL.revokeObjectURL = revokeObjectURL;
    });

    it("downloads a blob: URL made by the offscreen document", async () => {
      const response = await dispatchMessage(validDownloadStartMessage());

      expect(response).toEqual({ success: true, data: { downloadId: 1 } });
      expect(offscreenCreateDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "offscreen.html",
          reasons: expect.arrayContaining(["BLOBS"]),
        }),
      );
      expect(runtimeSendMessage).toHaveBeenCalledWith({
        type: "OFFSCREEN_CREATE_BLOB_URL",
        content: validContent,
        mimeType: "text/markdown",
      });
      expect(downloadsDownload).toHaveBeenCalledWith({
        url: offscreenUrl,
        filename: "conversation.md",
        saveAs: true,
      });
    });

    it("reuses an offscreen document that already exists", async () => {
      runtimeGetContexts.mockResolvedValue([
        { contextType: "OFFSCREEN_DOCUMENT" },
      ]);

      await dispatchMessage(validDownloadStartMessage());

      expect(offscreenCreateDocument).not.toHaveBeenCalled();
      expect(downloadsDownload).toHaveBeenCalledWith(
        expect.objectContaining({ url: offscreenUrl }),
      );
    });

    it("has the offscreen document revoke the URL once the download completes", async () => {
      await dispatchMessage(validDownloadStartMessage({ tabId: 7 }));

      emitDownloadChanged({
        id: 1,
        state: { previous: "in_progress", current: "complete" },
      } as chrome.downloads.DownloadDelta);

      expect(runtimeSendMessage).toHaveBeenCalledWith({
        type: "OFFSCREEN_REVOKE_BLOB_URL",
        url: offscreenUrl,
      });
      expect(tabsSendMessage).toHaveBeenCalledWith(7, {
        type: "SHOW_EXPORT_SUCCESS",
      });
    });

    it("has the offscreen document revoke the URL when downloads.download() rejects", async () => {
      downloadsDownload.mockRejectedValueOnce(new Error("Invalid filename"));

      const response = await dispatchMessage(validDownloadStartMessage());

      expect(response).toEqual({ success: false, error: "Invalid filename" });
      expect(runtimeSendMessage).toHaveBeenCalledWith({
        type: "OFFSCREEN_REVOKE_BLOB_URL",
        url: offscreenUrl,
      });
    });

    it("reports the offscreen document's error without starting a download", async () => {
      runtimeSendMessage.mockResolvedValueOnce({
        success: false,
        error: "Blob too large",
      });

      const response = await dispatchMessage(validDownloadStartMessage());

      expect(response).toEqual({ success: false, error: "Blob too large" });
      expect(downloadsDownload).not.toHaveBeenCalled();
    });

    it("creates the offscreen document once for a copy and a download started together", async () => {
      let finishCreating: () => void = () => undefined;
      offscreenCreateDocument.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finishCreating = resolve;
          }),
      );

      const copied = dispatchMessage({
        type: "COPY_TO_CLIPBOARD",
        data: "# hello",
      });
      const downloaded = dispatchMessage(validDownloadStartMessage());

      await vi.waitFor(() =>
        expect(offscreenCreateDocument).toHaveBeenCalledTimes(1),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      finishCreating();

      expect(await copied).toEqual({ success: true });
      expect(await downloaded).toEqual({
        success: true,
        data: { downloadId: 1 },
      });
      expect(offscreenCreateDocument).toHaveBeenCalledTimes(1);
    });
  });

  /*
   * The browser downloads an update but holds it back while the
   * extension is running - and in Chrome, the offscreen document
   * kept this extension "running" until the browser quit, so
   * people stayed on old versions for weeks. background.ts now
   * reloads to install a held-back update as soon as nothing
   * would be cut short by it (see updates.ts).
   */
  describe("installing a downloaded update", () => {
    let openContextTypes: string[];

    beforeEach(() => {
      openContextTypes = [];

      runtimeGetContexts.mockImplementation(
        async (filter: chrome.runtime.ContextFilter) =>
          openContextTypes
            .filter(
              (contextType) =>
                !filter.contextTypes ||
                (filter.contextTypes as string[]).includes(contextType),
            )
            .map((contextType) => ({ contextType })),
      );
    });

    function emitUpdateAvailable(version: string): void {
      for (const listener of onUpdateAvailableListeners) {
        listener({ version });
      }
    }

    function emitAlarm(name: string): void {
      for (const listener of onAlarmListeners) {
        listener({ name, scheduledTime: Date.now() } as chrome.alarms.Alarm);
      }
    }

    it("reloads to install it right away when nothing is running", async () => {
      emitUpdateAvailable("2.4.0");

      await vi.waitFor(() => expect(runtimeReload).toHaveBeenCalledTimes(1));
      expect(localStorageItems.updateState).toMatchObject({
        latestVersion: "2.4.0",
        readyVersion: "2.4.0",
        reloadedFor: "2.4.0",
      });
    });

    it("doesn't wait on the offscreen document, which never closes on its own", async () => {
      openContextTypes = ["OFFSCREEN_DOCUMENT", "BACKGROUND"];

      emitUpdateAvailable("2.4.0");

      await vi.waitFor(() => expect(runtimeReload).toHaveBeenCalledTimes(1));
    });

    it("waits while the popup is open, then installs it once the popup has closed", async () => {
      openContextTypes = ["POPUP"];

      emitUpdateAvailable("2.4.0");

      await vi.waitFor(() =>
        expect(alarmsCreate).toHaveBeenCalledWith("apply-pending-update", {
          delayInMinutes: 1,
        }),
      );
      expect(runtimeReload).not.toHaveBeenCalled();

      openContextTypes = [];
      emitAlarm("apply-pending-update");

      await vi.waitFor(() => expect(runtimeReload).toHaveBeenCalledTimes(1));
    });

    it("waits while the options page is open in a tab", async () => {
      openContextTypes = ["TAB"];

      emitUpdateAvailable("2.4.0");

      await vi.waitFor(() => expect(alarmsCreate).toHaveBeenCalled());
      expect(runtimeReload).not.toHaveBeenCalled();
    });

    it("waits for an export download to finish", async () => {
      await dispatchMessage(validDownloadStartMessage({ tabId: 7 }));

      emitUpdateAvailable("2.4.0");

      await vi.waitFor(() => expect(alarmsCreate).toHaveBeenCalled());
      expect(runtimeReload).not.toHaveBeenCalled();

      emitDownloadChanged({
        id: 1,
        state: { previous: "in_progress", current: "complete" },
      } as chrome.downloads.DownloadDelta);

      await vi.waitFor(() => expect(runtimeReload).toHaveBeenCalledTimes(1));
      expect(tabsSendMessage).toHaveBeenCalledWith(7, {
        type: "SHOW_EXPORT_SUCCESS",
      });
    });

    it("waits for a download it lost track of when the service worker restarted", async () => {
      downloadsSearch.mockResolvedValue([
        { id: 5, state: "in_progress", byExtensionId: runtimeId },
      ]);

      emitUpdateAvailable("2.4.0");

      await vi.waitFor(() => expect(alarmsCreate).toHaveBeenCalled());
      expect(downloadsSearch).toHaveBeenCalledWith({ state: "in_progress" });
      expect(runtimeReload).not.toHaveBeenCalled();
    });

    it("doesn't wait for the person's own downloads", async () => {
      downloadsSearch.mockResolvedValue([{ id: 5, state: "in_progress" }]);

      emitUpdateAvailable("2.4.0");

      await vi.waitFor(() => expect(runtimeReload).toHaveBeenCalledTimes(1));
    });

    it("waits for a clipboard copy in progress", async () => {
      let finishCopy: (response: unknown) => void = () => undefined;

      runtimeSendMessage.mockImplementation((message: { type: string }) =>
        message.type === "OFFSCREEN_COPY"
          ? new Promise((resolve) => {
              finishCopy = resolve;
            })
          : Promise.resolve(undefined),
      );

      const copied = dispatchMessage({
        type: "COPY_TO_CLIPBOARD",
        data: "# hello",
      });

      await vi.waitFor(() =>
        expect(runtimeSendMessage).toHaveBeenCalledWith(
          expect.objectContaining({ type: "OFFSCREEN_COPY" }),
        ),
      );

      emitUpdateAvailable("2.4.0");

      await vi.waitFor(() => expect(alarmsCreate).toHaveBeenCalled());
      expect(runtimeReload).not.toHaveBeenCalled();

      finishCopy({ success: true });

      expect(await copied).toEqual({ success: true });
      await vi.waitFor(() => expect(runtimeReload).toHaveBeenCalledTimes(1));
    });

    it("picks up an update still waiting from before the service worker stopped", async () => {
      localStorageItems.updateState = { readyVersion: "2.4.0" };

      await startBackground();

      await vi.waitFor(() => expect(runtimeReload).toHaveBeenCalledTimes(1));
    });

    it("reloads only once per downloaded version, so it can't loop", async () => {
      /*
       * A reload for 2.4.0 already happened, yet 2.3.0 is still
       * the version running: the browser no longer has 2.4.0.
       */
      localStorageItems.updateState = {
        readyVersion: "2.4.0",
        reloadedFor: "2.4.0",
      };

      await startBackground();

      await vi.waitFor(() =>
        expect(localStorageItems.updateState).toEqual({
          reloadedFor: "2.4.0",
        }),
      );
      expect(runtimeReload).not.toHaveBeenCalled();
    });

    it("tries again when the browser downloads the version again", async () => {
      localStorageItems.updateState = {
        readyVersion: "2.4.0",
        reloadedFor: "2.4.0",
      };

      await startBackground();
      await vi.waitFor(() =>
        expect(localStorageItems.updateState).toEqual({
          reloadedFor: "2.4.0",
        }),
      );

      emitUpdateAvailable("2.4.0");

      await vi.waitFor(() => expect(runtimeReload).toHaveBeenCalledTimes(1));
    });

    it("tries again when the version downloads again just as the service worker starts", async () => {
      localStorageItems.updateState = {
        readyVersion: "2.4.0",
        reloadedFor: "2.4.0",
      };

      await startBackground();
      emitUpdateAvailable("2.4.0");

      await vi.waitFor(() => expect(runtimeReload).toHaveBeenCalledTimes(1));
    });

    it("does nothing once the waiting version is the one running", async () => {
      runningVersion = "2.4.0";
      localStorageItems.updateState = {
        readyVersion: "2.4.0",
        reloadedFor: "2.4.0",
      };
      alarmsClear.mockClear();

      await startBackground();

      await vi.waitFor(() =>
        expect(alarmsClear).toHaveBeenCalledWith("apply-pending-update"),
      );
      expect(runtimeReload).not.toHaveBeenCalled();
    });

    it("installs it on UPDATE_APPLY even though the popup is open", async () => {
      openContextTypes = ["POPUP"];
      localStorageItems.updateState = { readyVersion: "2.4.0" };

      const response = await dispatchMessage({ type: "UPDATE_APPLY" });

      expect(response).toEqual({ success: true, data: { reloading: true } });
      expect(runtimeReload).toHaveBeenCalledTimes(1);
    });

    it("still lets an export download finish on UPDATE_APPLY", async () => {
      openContextTypes = ["POPUP"];
      localStorageItems.updateState = { readyVersion: "2.4.0" };
      await dispatchMessage(validDownloadStartMessage());

      const response = await dispatchMessage({ type: "UPDATE_APPLY" });

      expect(response).toEqual({ success: true, data: { reloading: false } });
      expect(runtimeReload).not.toHaveBeenCalled();
    });

    it("reports no reload on UPDATE_APPLY when nothing is downloaded", async () => {
      const response = await dispatchMessage({ type: "UPDATE_APPLY" });

      expect(response).toEqual({ success: true, data: { reloading: false } });
      expect(runtimeReload).not.toHaveBeenCalled();
    });

    it("rejects UPDATE_APPLY from a sender outside the extension", () => {
      localStorageItems.updateState = { readyVersion: "2.4.0" };

      for (const listener of onMessageListeners) {
        const result = listener(
          { type: "UPDATE_APPLY" },
          { id: "some-other-extension" } as chrome.runtime.MessageSender,
          vi.fn(),
        );

        if (result === true) {
          throw new Error(
            "UPDATE_APPLY handler must not claim a message from a foreign sender",
          );
        }
      }
    });
  });

  describe("after an update installs", () => {
    function emitInstalled(details: Partial<chrome.runtime.InstalledDetails>) {
      for (const listener of onInstalledListeners) {
        listener(details as chrome.runtime.InstalledDetails);
      }
    }

    it("clears what led up to it and leaves a notice for the popup", async () => {
      localStorageItems.updateState = {
        latestVersion: "2.3.0",
        checkedAt: 1000,
        readyVersion: "2.3.0",
        reloadedFor: "2.3.0",
      };

      emitInstalled({ reason: "update", previousVersion: "2.2.0" });

      await vi.waitFor(() =>
        expect(localStorageItems.updateNotice).toBe("2.3.0"),
      );
      expect(localStorageItems.updateState).toEqual({ checkedAt: 1000 });
    });

    it("keeps a store version that's newer still", async () => {
      localStorageItems.updateState = { latestVersion: "2.5.0" };

      emitInstalled({ reason: "update", previousVersion: "2.2.0" });

      await vi.waitFor(() =>
        expect(localStorageItems.updateNotice).toBe("2.3.0"),
      );
      expect(localStorageItems.updateState).toEqual({ latestVersion: "2.5.0" });
    });

    it("ignores reloading an unpacked build of the same version", async () => {
      emitInstalled({ reason: "update", previousVersion: "2.3.0" });
      emitInstalled({ reason: "install" });

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(localStorageItems.updateNotice).toBeUndefined();
    });
  });

  describe("UPDATE_CHECK", () => {
    it("asks Chrome's updater and remembers a newer version", async () => {
      runtimeRequestUpdateCheck.mockResolvedValue({
        status: "update_available",
        version: "2.4.0",
      });

      const response = await dispatchMessage({
        type: "UPDATE_CHECK",
        force: false,
      });

      expect(response.success).toBe(true);
      expect(response.data.result).toBe("update_available");
      expect(response.data.state).toEqual({
        latestVersion: "2.4.0",
        checkedAt: expect.any(Number),
      });
      expect(localStorageItems.updateState).toEqual(response.data.state);
    });

    it("doesn't ask the store again within six hours, unless forced", async () => {
      runtimeRequestUpdateCheck.mockResolvedValue({ status: "no_update" });

      const first = await dispatchMessage({ type: "UPDATE_CHECK" });
      const second = await dispatchMessage({ type: "UPDATE_CHECK" });

      expect(first.data.result).toBe("no_update");
      expect(second.data.result).toBe("recent");
      expect(runtimeRequestUpdateCheck).toHaveBeenCalledTimes(1);

      const forced = await dispatchMessage({
        type: "UPDATE_CHECK",
        force: true,
      });

      expect(forced.data.result).toBe("no_update");
      expect(runtimeRequestUpdateCheck).toHaveBeenCalledTimes(2);
    });

    it("asks again once the last answer is older than six hours", async () => {
      localStorageItems.updateState = {
        checkedAt: Date.now() - 7 * 60 * 60 * 1000,
      };
      runtimeRequestUpdateCheck.mockResolvedValue({ status: "no_update" });

      const response = await dispatchMessage({ type: "UPDATE_CHECK" });

      expect(response.data.result).toBe("no_update");
      expect(runtimeRequestUpdateCheck).toHaveBeenCalledTimes(1);
    });

    it("forgets an older store answer once the store says there's nothing newer", async () => {
      localStorageItems.updateState = { latestVersion: "2.4.0", checkedAt: 0 };
      runtimeRequestUpdateCheck.mockResolvedValue({ status: "no_update" });

      const response = await dispatchMessage({
        type: "UPDATE_CHECK",
        force: true,
      });

      expect(response.data.state).toEqual({ checkedAt: expect.any(Number) });
    });

    it("keeps what it knew when Chrome throttles the check", async () => {
      localStorageItems.updateState = { latestVersion: "2.4.0", checkedAt: 1000 };
      runtimeRequestUpdateCheck.mockResolvedValue({ status: "throttled" });

      const response = await dispatchMessage({
        type: "UPDATE_CHECK",
        force: true,
      });

      expect(response.data).toEqual({
        result: "throttled",
        state: { latestVersion: "2.4.0", checkedAt: 1000 },
      });
    });

    it("rejects a message from a sender outside the extension", () => {
      for (const listener of onMessageListeners) {
        const result = listener(
          { type: "UPDATE_CHECK", force: true },
          { id: "some-other-extension" } as chrome.runtime.MessageSender,
          vi.fn(),
        );

        if (result === true) {
          throw new Error(
            "UPDATE_CHECK handler must not claim a message from a foreign sender",
          );
        }
      }

      expect(runtimeRequestUpdateCheck).not.toHaveBeenCalled();
    });
  });
});
