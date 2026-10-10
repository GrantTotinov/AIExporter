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
const alarmsGet = vi.fn(async (_name: string) => undefined as unknown);
const downloadsErase = vi.fn(async () => []);
const offscreenCreateDocument = vi.fn();
const tabsQuery = vi.fn();
const tabsReload = vi.fn();
const actionSetBadgeText = vi.fn();
const actionSetBadgeBackgroundColor = vi.fn();
const actionSetTitle = vi.fn();
const onCommandListeners: Array<
  (command: string, tab?: chrome.tabs.Tab) => void
> = [];
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
const onStorageChangedListeners: Array<
  (changes: Record<string, chrome.storage.StorageChange>, area: string) => void
> = [];

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

/* Whether github.com and api.github.com are allowed (optional permissions) */
let githubAllowed = true;
const permissionsContains = vi.fn(async () => githubAllowed);

vi.stubGlobal("chrome", {
  permissions: {
    contains: permissionsContains,
  },
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
    getPlatformInfo: vi.fn(async () => ({ os: "win" })),
    getManifest: () => ({ version: runningVersion }),
    reload: runtimeReload,
    requestUpdateCheck: runtimeRequestUpdateCheck,
  },
  alarms: {
    create: alarmsCreate,
    clear: alarmsClear,
    get: alarmsGet,
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
    erase: downloadsErase,
    cancel: vi.fn(async () => undefined),
    onChanged: {
      addListener: (listener: (typeof onChangedListeners)[number]) => {
        onChangedListeners.push(listener);
      },
    },
  },
  tabs: {
    sendMessage: tabsSendMessage,
    query: tabsQuery,
    reload: tabsReload,
  },
  commands: {
    onCommand: {
      addListener: (listener: (typeof onCommandListeners)[number]) => {
        onCommandListeners.push(listener);
      },
    },
  },
  action: {
    setBadgeText: actionSetBadgeText,
    setBadgeBackgroundColor: actionSetBadgeBackgroundColor,
    setTitle: actionSetTitle,
  },
  storage: {
    sync: {
      get: storageSyncGet,
      set: vi.fn(),
    },
    local: storageLocal,
    onChanged: {
      addListener: (listener: (typeof onStorageChangedListeners)[number]) => {
        onStorageChangedListeners.push(listener);
      },
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
  onCommandListeners.length = 0;
  onStorageChangedListeners.length = 0;

  await import("../src/background");
}

describe("background.ts download flow (Chrome + Firefox parity)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    nextObjectUrlId = 0;
    localStorageItems = {};
    runningVersion = "2.3.0";
    githubAllowed = true;

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

    it("accepts a file of tens of megabytes", async () => {
      // A long chat's picture: a regex repeating a group per four
      // characters overflowed the stack on this.
      const response = await dispatchMessage(
        validDownloadStartMessage({
          filename: "conversation.png",
          mimeType: "image/png",
          content: "QUJD".repeat(5_000_000),
        }),
      );

      expect(response.success).toBe(true);
    });

    it("rejects padding anywhere but the end", async () => {
      const response = await dispatchMessage(
        validDownloadStartMessage({ content: "QU=I" }),
      );

      expect(response.success).toBe(false);
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
   * github.com and api.github.com are optional permissions. A
   * token without them counts as not connected - Connect GitHub
   * in the settings asks for them again - but is kept, since
   * allowing GitHub again brings that connection straight back.
   */
  describe("GITHUB_GET_STATUS", () => {
    beforeEach(() => {
      localStorageItems.githubAccessToken = "tok";
      fetchMock.mockClear();
    });

    it("says who is connected", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "",
        json: async () => ({ login: "octocat", avatar_url: "" }),
      });

      expect(await dispatchMessage({ type: "GITHUB_GET_STATUS" })).toEqual({
        success: true,
        data: { connected: true, login: "octocat" },
      });
    });

    it("counts a token without the permission as not connected, and keeps it", async () => {
      githubAllowed = false;

      expect(await dispatchMessage({ type: "GITHUB_GET_STATUS" })).toEqual({
        success: true,
        data: { connected: false },
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(localStorageItems.githubAccessToken).toBe("tok");
    });

    it("refuses to save to GitHub without the permission", async () => {
      githubAllowed = false;

      const response = await dispatchMessage({
        type: "GITHUB_SAVE_FILE",
        fullName: "octocat/Hello-World",
        filename: "conversation.md",
        content: "# hello",
        binary: false,
      });

      expect(response.success).toBe(false);
      expect(response.error).toContain("isn't allowed to reach GitHub");
      expect(fetchMock).not.toHaveBeenCalled();
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

  /*
   * A copied chat goes on the clipboard as Markdown and as
   * formatted HTML (see clipboard-export.ts): through the offscreen
   * document in Chrome, and right in the event page in Firefox,
   * which has no offscreen documents.
   */
  describe("copying a chat", () => {
    it("hands the text and the formatted chat to the offscreen document", async () => {
      runtimeSendMessage.mockResolvedValue({ success: true });

      const response = await dispatchMessage({
        type: "COPY_TO_CLIPBOARD",
        data: "## User",
        html: "<h2>User</h2>",
      });

      expect(response).toEqual({ success: true });
      expect(runtimeSendMessage).toHaveBeenCalledWith({
        type: "OFFSCREEN_COPY",
        data: "## User",
        html: "<h2>User</h2>",
      });
    });

    it("turns down a copy that isn't text", async () => {
      const response = await dispatchMessage({
        type: "COPY_TO_CLIPBOARD",
        data: { text: "## User" },
      });

      expect(response).toEqual({ success: false, error: "Invalid copy request." });
      expect(offscreenCreateDocument).not.toHaveBeenCalled();
    });

    describe("in Firefox (no offscreen documents)", () => {
      const chromeApi = globalThis.chrome as unknown as { offscreen?: unknown };
      const globals = globalThis as unknown as { ClipboardItem?: unknown };
      const clipboardWrite = vi.fn();
      let offscreen: unknown;

      class FakeClipboardItem {
        items: Record<string, Blob>;

        constructor(items: Record<string, Blob>) {
          this.items = items;
        }
      }

      beforeEach(() => {
        offscreen = chromeApi.offscreen;
        delete chromeApi.offscreen;
        clipboardWrite.mockReset().mockResolvedValue(undefined);
        globals.ClipboardItem = FakeClipboardItem;
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: { write: clipboardWrite, writeText: vi.fn() },
        });
      });

      afterEach(() => {
        chromeApi.offscreen = offscreen;
        delete globals.ClipboardItem;
        delete (navigator as unknown as { clipboard?: unknown }).clipboard;
      });

      it("writes both versions itself", async () => {
        const response = await dispatchMessage({
          type: "COPY_TO_CLIPBOARD",
          data: "## User",
          html: "<h2>User</h2>",
        });

        expect(response).toEqual({ success: true });
        expect(offscreenCreateDocument).not.toHaveBeenCalled();

        const [[[item]]] = clipboardWrite.mock.calls as [[[FakeClipboardItem]]];

        expect(await item.items["text/plain"].text()).toBe("## User");
        expect(await item.items["text/html"].text()).toBe("<h2>User</h2>");
      });

      it("says so when the clipboard can't be written", async () => {
        vi.spyOn(console, "error").mockImplementation(() => undefined);
        clipboardWrite.mockRejectedValue(new Error("denied"));

        const response = await dispatchMessage({
          type: "COPY_TO_CLIPBOARD",
          data: "## User",
          html: "<h2>User</h2>",
        });

        expect(response).toEqual({ success: false, error: "Clipboard write failed" });
      });
    });
  });

  /*
   * Alt+Shift+M copies the chat open in the active tab without the
   * popup; the page says how it went.
   */
  describe("copying with the keyboard shortcut", () => {
    const CHAT_URL = "https://chatgpt.com/c/0b2f7a52-1c3d-4e5f-8a9b-0c1d2e3f4a5b";
    const MESSAGES = [
      { id: "2", role: "assistant", content: "Lisbon.", order: 1 },
      { id: "1", role: "user", content: "Where should I go?", order: 0 },
    ];

    let pageAnswers: Record<string, unknown>;

    beforeEach(() => {
      pageAnswers = {
        AIEXPORTER_PING: { ok: true },
        LOAD_CONVERSATION: { success: true, data: { messages: MESSAGES, images: [] } },
        SHOW_TOAST: { ok: true },
      };
      tabsSendMessage.mockReset().mockImplementation(
        async (_tabId: number, message: { type: string }) => pageAnswers[message.type],
      );
      runtimeSendMessage.mockResolvedValue({ success: true });
      tabsReload.mockReset().mockResolvedValue(undefined);
      actionSetBadgeText.mockReset().mockResolvedValue(undefined);
      actionSetBadgeBackgroundColor.mockReset().mockResolvedValue(undefined);
      actionSetTitle.mockReset().mockResolvedValue(undefined);
    });

    function press(command: string, tab: Partial<chrome.tabs.Tab>): void {
      for (const listener of onCommandListeners) {
        listener(command, tab as chrome.tabs.Tab);
      }
    }

    function toasts(): { text: string; tone: string }[] {
      return tabsSendMessage.mock.calls
        .map(([, message]) => message)
        .filter((message) => message.type === "SHOW_TOAST");
    }

    it("copies the chat as text and formatted, and says so on the page", async () => {
      press("copy-chat", { id: 7, url: CHAT_URL, title: "Trip - ChatGPT" });

      await vi.waitFor(() =>
        expect(toasts().map((toast) => toast.text)).toEqual([
          "Copying the chat…",
          "Copied! Paste it anywhere with Ctrl+V.",
        ]),
      );

      const copy = runtimeSendMessage.mock.calls
        .map(([message]) => message)
        .find((message) => message.type === "OFFSCREEN_COPY");

      expect(copy.data).toBe("## User\n\nWhere should I go?\n\n## ChatGPT\n\nLisbon.");
      expect(copy.html).toContain("<h2>User</h2>");
      expect(tabsSendMessage).toHaveBeenCalledWith(7, {
        type: "LOAD_CONVERSATION",
        downloadImagesLocally: false,
      });
      expect(tabsReload).not.toHaveBeenCalled();
    });

    /*
     * Chrome only gives content.js to pages loaded after AI Exporter
     * was installed or updated.
     */
    it("reloads a tab opened before AI Exporter, then copies its chat", async () => {
      vi.useFakeTimers();

      try {
        let reloaded = false;

        tabsReload.mockImplementation(async () => {
          setTimeout(() => {
            reloaded = true;
          }, 2500);
        });
        tabsSendMessage.mockImplementation(
          async (_tabId: number, message: { type: string }) => {
            if (!reloaded) {
              throw new Error("Could not establish connection.");
            }

            return pageAnswers[message.type];
          },
        );

        press("copy-chat", {
          id: 9,
          url: "https://grok.com/c/0b2f7a52-1c3d-4e5f-8a9b-0c1d2e3f4a5b",
          title: "Cats - Grok",
        });
        await vi.advanceTimersByTimeAsync(5000);

        expect(tabsReload).toHaveBeenCalledWith(9);
        expect(toasts().map((toast) => toast.tone)).toEqual(["info", "success"]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("marks the toolbar button when the tab never answers", async () => {
      vi.useFakeTimers();

      try {
        tabsSendMessage.mockRejectedValue(new Error("Could not establish connection."));

        press("copy-chat", {
          id: 9,
          url: "https://grok.com/c/0b2f7a52-1c3d-4e5f-8a9b-0c1d2e3f4a5b",
          title: "Cats - Grok",
        });
        await vi.advanceTimersByTimeAsync(20_000);

        expect(tabsReload).toHaveBeenCalledTimes(1);
        expect(actionSetBadgeText).toHaveBeenCalledWith({ tabId: 9, text: "!" });
        expect(toasts()).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("asks for a chat on another page of a chat site", async () => {
      press("copy-chat", { id: 7, url: "https://chatgpt.com/", title: "ChatGPT" });

      await vi.waitFor(() =>
        expect(toasts()).toEqual([
          { type: "SHOW_TOAST", text: "Open a chat first", tone: "error" },
        ]),
      );
      expect(tabsSendMessage).not.toHaveBeenCalledWith(7, expect.objectContaining({
        type: "LOAD_CONVERSATION",
      }));
    });

    it("marks the toolbar button on a page of no chat site", async () => {
      press("copy-chat", { id: 3, url: "https://example.com/", title: "Example" });

      await vi.waitFor(() =>
        expect(actionSetBadgeText).toHaveBeenCalledWith({ tabId: 3, text: "!" }),
      );
      expect(actionSetTitle).toHaveBeenCalledWith({
        tabId: 3,
        title: "Open a chat on a supported AI site first: ChatGPT, Claude, Gemini, DeepSeek, Copilot, Kimi, Qwen and more.",
      });
      expect(tabsSendMessage).not.toHaveBeenCalled();
    });

    it("says what went wrong when the chat can't be read", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      pageAnswers.LOAD_CONVERSATION = {
        success: false,
        error: "Sign in to ChatGPT to export this conversation.",
      };

      press("copy-chat", { id: 7, url: CHAT_URL, title: "Trip - ChatGPT" });

      await vi.waitFor(() =>
        expect(toasts().at(-1)).toEqual({
          type: "SHOW_TOAST",
          text: "Sign in to ChatGPT to export this conversation.",
          tone: "error",
        }),
      );
      expect(runtimeSendMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "OFFSCREEN_COPY" }),
      );
    });

    it("leaves other commands to the browser", async () => {
      press("_execute_action", { id: 7, url: CHAT_URL });

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(tabsSendMessage).not.toHaveBeenCalled();
    });
  });

  /*
   * The automatic backup (see auto-backup.ts): every tab is asked
   * which site it shows, the chat site's tab lists and loads the
   * chats, and the new ones go into Downloads - remembered, so the
   * next backup leaves them alone until they change.
   */
  describe("automatic backup", () => {
    const CHAT = {
      id: "0b2f7a52-1c3d-4e5f-8a9b-0c1d2e3f4a5b",
      title: "Trip ideas",
      url: "https://chatgpt.com/c/0b2f7a52-1c3d-4e5f-8a9b-0c1d2e3f4a5b",
      createdAt: new Date(2026, 9, 1, 12).getTime(),
      updatedAt: new Date(2026, 9, 8, 12).getTime(),
    };
    const MESSAGES = [
      { id: "2", role: "assistant", content: "Lisbon.", order: 1 },
      { id: "1", role: "user", content: "Where should I go?", order: 0 },
    ];

    beforeEach(() => {
      localStorageItems.autoBackup = {
        enabled: true,
        every: "day",
        target: "downloads",
        repo: "",
        format: "md",
      };
      // Tab 5 has no content script; tab 7 shows ChatGPT
      tabsQuery.mockResolvedValue([{ id: 5 }, { id: 7 }]);
      tabsSendMessage.mockImplementation(
        async (tabId: number, message: { type: string }) => {
          if (tabId !== 7) {
            throw new Error("Could not establish connection. Receiving end does not exist.");
          }

          switch (message.type) {
            case "AIEXPORTER_PING":
              return { ok: true, host: "chatgpt.com" };
            case "LIST_CONVERSATIONS_PAGE":
              return { success: true, data: { conversations: [CHAT], nextCursor: null } };
            case "LOAD_CONVERSATION":
              return { success: true, data: { messages: MESSAGES, images: [] } };
          }
        },
      );
      // Every file is on disk as soon as it's downloaded.
      downloadsSearch.mockResolvedValue([{ state: "complete" }]);
    });

    const backUpNow = (): Promise<any> => dispatchMessage({ type: "BACKUP_RUN" });

    it("saves the new chats of an open chat site into Downloads, once", async () => {
      const first = await backUpNow();

      expect(first).toMatchObject({ success: true, data: { saved: 1, failed: 0 } });
      expect(downloadsDownload).toHaveBeenCalledWith({
        url: "blob:mock-url-1",
        filename: "AI Exporter backup/ChatGPT/2026-10-01-trip-ideas-2e3f4a5b.md",
        conflictAction: "overwrite",
        saveAs: false,
      });
      expect(await (createObjectURL.mock.calls[0][0] as Blob).text()).toContain(
        "## User\n\nWhere should I go?",
      );
      // Off the browser's list of downloads again
      expect(downloadsErase).toHaveBeenCalledWith({ id: 1 });
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock-url-1");
      expect(localStorageItems.autoBackupSaved).toEqual({
        target: "downloads:md",
        chats: { chatgpt: { [CHAT.id]: CHAT.updatedAt } },
      });

      downloadsDownload.mockClear();

      const second = await backUpNow();

      expect(second).toMatchObject({ success: true, data: { saved: 0, failed: 0 } });
      expect(downloadsDownload).not.toHaveBeenCalled();
    });

    it("turns itself off when the browser asks where to save each file", async () => {
      downloadsSearch.mockResolvedValue([{ state: "interrupted", error: "USER_CANCELED" }]);

      const response = await backUpNow();

      expect(response.data.error).toMatch(/asks where to save each file/);
      expect(localStorageItems.autoBackup).toMatchObject({ enabled: false });
      expect(localStorageItems.autoBackupSaved).toBeUndefined();
      // Not backed up, so still due once the backup is back on
      expect(response.data.sites).toEqual({});
    });

    it("starts over at once when the file type changes", async () => {
      await backUpNow();
      downloadsDownload.mockClear();
      localStorageItems.autoBackup = {
        ...(localStorageItems.autoBackup as object),
        format: "html",
      };

      for (const listener of onAlarmListeners) {
        listener({ name: "auto-backup", scheduledTime: Date.now() } as chrome.alarms.Alarm);
      }

      // Joins the alarm's backup, which doesn't wait for the next day.
      const response = await backUpNow();

      expect(response).toMatchObject({ success: true, data: { saved: 1 } });
      expect(downloadsDownload).toHaveBeenCalledWith(
        expect.objectContaining({
          filename: "AI Exporter backup/ChatGPT/2026-10-01-trip-ideas-2e3f4a5b.html",
        }),
      );
    });

    it("asks for a chat site to be opened when none is", async () => {
      tabsQuery.mockResolvedValue([{ id: 5 }]);

      expect(await backUpNow()).toEqual({
        success: false,
        error: "Open ChatGPT, Claude or another chat site in a tab, then try again.",
      });
    });

    it("leaves a site alone until it's due again", async () => {
      localStorageItems.autoBackupStatus = {
        target: "downloads:md",
        sites: { chatgpt: { at: Date.now() - 60_000 } },
      };

      for (const listener of onAlarmListeners) {
        listener({ name: "auto-backup", scheduledTime: Date.now() } as chrome.alarms.Alarm);
      }

      // Asked during the alarm's backup, this gets that one's outcome.
      await backUpNow();

      expect(tabsSendMessage).toHaveBeenCalledWith(7, { type: "AIEXPORTER_PING" });
      expect(tabsSendMessage).not.toHaveBeenCalledWith(
        7,
        expect.objectContaining({ type: "LIST_CONVERSATIONS_PAGE" }),
      );
    });

    it("looks soon after a chat site's page opens", async () => {
      for (const listener of onMessageListeners) {
        listener(
          { type: "AIEXPORTER_PAGE_OPENED" },
          { id: runtimeId, tab: { id: 7 } } as chrome.runtime.MessageSender,
          vi.fn(),
        );
      }

      await vi.waitFor(() =>
        expect(alarmsCreate).toHaveBeenCalledWith("auto-backup", {
          delayInMinutes: 0.5,
          periodInMinutes: 30,
        }),
      );
    });

    it("says to choose a repository before saving into GitHub", async () => {
      localStorageItems.autoBackup = {
        ...(localStorageItems.autoBackup as object),
        target: "github",
      };

      const response = await backUpNow();

      expect(response.data.error).toBe("Choose a GitHub repository for the backup.");
      expect(tabsQuery).not.toHaveBeenCalled();
    });
  });
});
