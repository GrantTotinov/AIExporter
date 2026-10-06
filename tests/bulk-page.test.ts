// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BULK_HTML from "../public/bulk.html?raw";
import en from "../src/locales/en.json";
import type { ConversationListPage } from "../src/conversation-list";

/*
 * ---------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------
 *
 * Opens the real "Save many chats" page the way the popup does
 * (bulk.html?tab=<id>&site=<site>) and checks how it reaches the
 * chat site's tab: which sites it takes, how it waits for a tab
 * that is reloading, and how it reloads one that was open before
 * AI Exporter was installed - Chrome only gives the content script
 * to pages loaded afterwards. bulk-export.test.ts covers the file
 * naming and filtering it uses.
 */

const BULK_BODY = BULK_HTML.slice(
  BULK_HTML.indexOf("<body>") + "<body>".length,
  BULK_HTML.indexOf("</body>"),
);

const NO_RECEIVER = "Could not establish connection. Receiving end does not exist.";

const PAGE: ConversationListPage = {
  conversations: [
    {
      id: "s1",
      title: "Rice",
      url: "https://chat.deepseek.com/a/chat/s/s1",
      createdAt: null,
      updatedAt: null,
    },
  ],
  nextCursor: null,
};

/* How long a reloaded page takes to load again */
const RELOAD_MS = 1000;

/*
 * The chat tab as the page sees it. `url` is undefined when the
 * browser doesn't show the address (no activeTab loan).
 */
let tab: {
  url: string | undefined;
  status: "loading" | "complete";
  host: string;
  hasContentScript: boolean;
};
/* The chats the tab lists */
let listPage: ConversationListPage;
/* chrome.storage.local */
let localStore: Record<string, unknown>;
let downloadListeners: ((delta: chrome.downloads.DownloadDelta) => void)[];

const tabsSendMessage = vi.fn(async (_tabId: number, message: { type: string }) => {
  if (!tab.hasContentScript) {
    throw new Error(NO_RECEIVER);
  }

  switch (message.type) {
    case "AIEXPORTER_PING":
      return { ok: true, host: tab.host };
    case "LIST_CONVERSATIONS_PAGE":
      return { success: true, data: listPage };
    case "LOAD_CONVERSATION":
      return {
        success: true,
        data: {
          messages: [{ id: "m1", role: "user", content: "Hello", order: 0 }],
          images: [],
        },
      };
    default:
      return { success: false, error: "unexpected message" };
  }
});

const downloadsDownload = vi.fn(async () => 1);

const tabsGet = vi.fn(async (tabId: number) => ({
  id: tabId,
  url: tab.url,
  status: tab.status,
}));

const tabsReload = vi.fn(async () => {
  tab.status = "loading";
  tab.hasContentScript = false;

  setTimeout(() => {
    tab.status = "complete";
    tab.hasContentScript = true;
  }, RELOAD_MS);
});

/* The page loads in a moment, with its content script. */
function loadPageIn(ms: number, host = tab.host): void {
  tab.status = "loading";
  tab.hasContentScript = false;

  setTimeout(() => {
    tab.status = "complete";
    tab.host = host;
    tab.hasContentScript = true;
  }, ms);
}

function byId<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function listedTitles(): string[] {
  return Array.from(document.querySelectorAll(".chat-row-title")).map(
    (title) => title.textContent ?? "",
  );
}

function sentTypes(): string[] {
  return tabsSendMessage.mock.calls.map(([, message]) => message.type);
}

async function openBulkPage(search: string): Promise<void> {
  window.history.replaceState(null, "", `/bulk.html${search}`);

  vi.stubGlobal("chrome", {
    storage: {
      sync: {
        get: vi.fn(async (defaults: Record<string, unknown>) => ({ ...defaults })),
      },
      local: {
        get: vi.fn(async (key: string) =>
          key in localStore ? { [key]: structuredClone(localStore[key]) } : {},
        ),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(localStore, structuredClone(items));
        }),
      },
      onChanged: { addListener: vi.fn() },
    },
    runtime: {
      getURL: (path: string) => `chrome-extension://test-id/${path}`,
      sendMessage: vi.fn(async () => ({ success: true })),
      onMessage: { addListener: vi.fn() },
    },
    tabs: { sendMessage: tabsSendMessage, get: tabsGet, reload: tabsReload },
    downloads: {
      download: downloadsDownload,
      onChanged: {
        addListener: (listener: (typeof downloadListeners)[number]) => {
          downloadListeners.push(listener);
        },
        removeListener: (listener: (typeof downloadListeners)[number]) => {
          downloadListeners = downloadListeners.filter((item) => item !== listener);
        },
      },
    },
    i18n: { getUILanguage: () => "en-US" },
  });

  document.body.innerHTML = BULK_BODY;

  vi.resetModules();
  await import("../src/bulk.ts");
}

/* Runs the page's waits for the tab until it gives up, at the latest. */
async function settle(ms = 20_000): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

function tabGoneText(site: string): string {
  return en["bulk.error.tabGone"].replaceAll("{{site}}", site);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  tab = {
    url: "https://chat.deepseek.com/a/chat/s/abc123",
    status: "complete",
    host: "chat.deepseek.com",
    hasContentScript: true,
  };
  listPage = PAGE;
  localStore = {};
  downloadListeners = [];
  URL.createObjectURL = vi.fn(() => "blob:zip") as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn();
  // jsdom lays nothing out, so it has no scrolling into view.
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Save many chats: the chat site's tab", () => {
  it("lists a DeepSeek tab's chats", async () => {
    await openBulkPage("?tab=9&site=deepseek");
    await settle();

    expect(byId("page-subtitle").textContent).toContain("DeepSeek");
    expect(listedTitles()).toEqual(["Rice"]);
    expect(tabsSendMessage).toHaveBeenCalledWith(9, {
      type: "LIST_CONVERSATIONS_PAGE",
      cursor: null,
    });
    expect(tabsGet).not.toHaveBeenCalled();
    expect(tabsReload).not.toHaveBeenCalled();
  });

  it.each([
    ["chatgpt", "https://chatgpt.com/c/0b2f7a52-1c3d-4e5f-8a9b-0c1d2e3f4a5b", "chatgpt.com"],
    ["claude", "https://claude.ai/chat/0b2f7a52-1c3d-4e5f-8a9b-0c1d2e3f4a5b", "claude.ai"],
    ["gemini", "https://gemini.google.com/app/abc123", "gemini.google.com"],
    ["deepseek", "https://chat.deepseek.com/a/chat/s/abc123", "chat.deepseek.com"],
    ["grok", "https://grok.com/c/0b2f7a52-1c3d-4e5f-8a9b-0c1d2e3f4a5b", "grok.com"],
    ["perplexity", "https://www.perplexity.ai/search/rice-abc", "www.perplexity.ai"],
  ])(
    "reloads a %s tab that was open before AI Exporter was installed",
    async (site, url, host) => {
      tab = { url, status: "complete", host, hasContentScript: false };

      await openBulkPage(`?tab=9&site=${site}`);
      await settle();

      expect(tabsReload).toHaveBeenCalledTimes(1);
      expect(tabsReload).toHaveBeenCalledWith(9);
      expect(listedTitles()).toEqual(["Rice"]);
    },
  );

  it("waits for a tab that is reloading, without reloading it again", async () => {
    loadPageIn(800);

    await openBulkPage("?tab=9&site=deepseek");
    await settle();

    expect(tabsReload).not.toHaveBeenCalled();
    expect(listedTitles()).toEqual(["Rice"]);
  });

  it("takes back a tab whose address it can't see once the same site answers", async () => {
    tab.url = undefined;
    loadPageIn(800);

    await openBulkPage("?tab=9&site=deepseek");
    await settle();

    expect(tabsReload).not.toHaveBeenCalled();
    expect(listedTitles()).toEqual(["Rice"]);
  });

  it("never reloads a tab whose address it can't see", async () => {
    tab.url = undefined;
    tab.hasContentScript = false;

    await openBulkPage("?tab=9&site=grok");
    await settle();

    expect(tabsReload).not.toHaveBeenCalled();
    expect(byId("error-text").textContent).toBe(tabGoneText("Grok"));
  });

  it("leaves a tab that has moved on to another site alone, at once", async () => {
    tab.url = "https://example.com/";
    tab.hasContentScript = false;

    await openBulkPage("?tab=9&site=grok");
    await settle(100);

    expect(tabsReload).not.toHaveBeenCalled();
    expect(byId("error-text").textContent).toBe(tabGoneText("Grok"));
  });

  it("doesn't send this site's requests to a tab now showing another chat site", async () => {
    tab.url = undefined;
    loadPageIn(800, "grok.com");

    await openBulkPage("?tab=9&site=deepseek");
    await settle();

    expect(sentTypes().filter((type) => type === "LIST_CONVERSATIONS_PAGE")).toHaveLength(1);
    expect(byId("error-text").textContent).toBe(tabGoneText("DeepSeek"));
  });

  it("gives up when the tab is closed", async () => {
    tab.hasContentScript = false;
    tabsGet.mockRejectedValueOnce(new Error("No tab with id: 9."));

    await openBulkPage("?tab=9&site=deepseek");
    await settle(100);

    expect(tabsReload).not.toHaveBeenCalled();
    expect(byId("error-text").textContent).toBe(tabGoneText("DeepSeek"));
  });

  it("doesn't talk to a tab of a site it doesn't know", async () => {
    await openBulkPage("?tab=9&site=bing");
    await settle();

    expect(tabsSendMessage).not.toHaveBeenCalled();
    expect(byId("state-error").hidden).toBe(false);
  });
});

describe("Save many chats: chats saved before", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = Date.now();
  const chat = (id: string, title: string, daysAgo: number) => ({
    id,
    title,
    url: `https://chat.deepseek.com/a/chat/s/${id}`,
    createdAt: null,
    updatedAt: NOW - daysAgo * DAY,
  });

  beforeEach(() => {
    listPage = {
      conversations: [chat("s1", "Rice", 1), chat("s2", "Bread", 5), chat("s3", "Soup", 9)],
      nextCursor: null,
    };
    localStore = {
      popupExportFormat: "md",
      bulkSavedChats: {
        // Rice as it is now, and Bread before it was used again
        deepseek: { s1: NOW - 1 * DAY, s2: NOW - 6 * DAY },
        grok: { s3: NOW },
      },
    };
  });

  function choosePreset(value: string): void {
    const select = byId<HTMLSelectElement>("date-preset");

    select.value = value;
    select.dispatchEvent(new Event("change"));
  }

  it("marks the chats saved before and unchanged since", async () => {
    await openBulkPage("?tab=9&site=deepseek");
    await settle();

    const badges = [...document.querySelectorAll(".chat-row")].map(
      (row) => row.querySelector(".chat-row-saved")?.textContent ?? "",
    );

    expect(badges).toEqual([en["bulk.saved"], "", ""]);
  });

  it("can show just the chats not saved yet or changed since", async () => {
    await openBulkPage("?tab=9&site=deepseek");
    await settle();

    choosePreset("unsaved");

    expect(listedTitles()).toEqual(["Bread", "Soup"]);
  });

  it("remembers the chats a ZIP held once it's on disk", async () => {
    await openBulkPage("?tab=9&site=deepseek");
    await settle();

    choosePreset("unsaved");
    byId<HTMLInputElement>("select-all").click();
    byId<HTMLButtonElement>("export").click();
    await settle();

    expect(downloadsDownload).toHaveBeenCalled();
    // Not yet: "Save as" can still be cancelled.
    expect(
      (localStore.bulkSavedChats as Record<string, Record<string, number>>).deepseek,
    ).not.toHaveProperty("s3");

    for (const listener of downloadListeners) {
      listener({ id: 1, state: { previous: "in_progress", current: "complete" } });
    }

    await vi.waitFor(() =>
      expect(localStore.bulkSavedChats).toEqual({
        deepseek: { s1: NOW - 1 * DAY, s2: NOW - 5 * DAY, s3: NOW - 9 * DAY },
        grok: { s3: NOW },
      }),
    );
  });
});
