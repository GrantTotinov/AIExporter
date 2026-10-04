// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BULK_HTML from "../public/bulk.html?raw";
import en from "../src/locales/en.json";

/*
 * ---------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------
 *
 * Opens the real "Save many chats" page the way the popup does
 * (bulk.html?tab=<id>&site=<site>) and checks how it reaches the
 * chat site's tab: which sites it takes, and how it puts the
 * content script back into a DeepSeek, Grok or Perplexity tab
 * that was reloaded - those tabs only have it from the popup (see
 * chat-sites.ts). bulk-export.test.ts covers the file naming and
 * filtering it uses.
 */

const BULK_BODY = BULK_HTML.slice(
  BULK_HTML.indexOf("<body>") + "<body>".length,
  BULK_HTML.indexOf("</body>"),
);

const NO_RECEIVER = "Could not establish connection. Receiving end does not exist.";

const PAGE = {
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

/* Whether the chat tab has a content script to answer */
let contentScriptReady: boolean;
/* What the chat tab shows by now */
let tabUrl: string;

const tabsSendMessage = vi.fn(async (_tabId: number, message: { type: string }) => {
  if (!contentScriptReady) {
    throw new Error(NO_RECEIVER);
  }

  return message.type === "LIST_CONVERSATIONS_PAGE"
    ? { success: true, data: PAGE }
    : { success: false, error: "unexpected message" };
});

const tabsGet = vi.fn(async (tabId: number) => ({ id: tabId, url: tabUrl }));

const executeScript = vi.fn(async () => {
  contentScriptReady = true;
  return [{ documentId: "doc", frameId: 0, result: undefined }];
});

function byId<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function listedTitles(): string[] {
  return Array.from(document.querySelectorAll(".chat-row-title")).map(
    (title) => title.textContent ?? "",
  );
}

async function openBulkPage(search: string): Promise<void> {
  window.history.replaceState(null, "", `/bulk.html${search}`);

  vi.stubGlobal("chrome", {
    storage: {
      sync: {
        get: vi.fn(async (defaults: Record<string, unknown>) => ({ ...defaults })),
      },
      local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) },
      onChanged: { addListener: vi.fn() },
    },
    runtime: {
      getURL: (path: string) => `chrome-extension://test-id/${path}`,
      sendMessage: vi.fn(async () => ({ success: true })),
      onMessage: { addListener: vi.fn() },
    },
    tabs: { sendMessage: tabsSendMessage, get: tabsGet },
    scripting: { executeScript },
    downloads: {
      download: vi.fn(),
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    i18n: { getUILanguage: () => "en-US" },
  });

  document.body.innerHTML = BULK_BODY;

  vi.resetModules();
  await import("../src/bulk.ts");

  await vi.waitFor(() => {
    expect(byId("state-loading").hidden).toBe(true);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  contentScriptReady = true;
  tabUrl = "https://chat.deepseek.com/a/chat/s/abc123";
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Save many chats: the chat site's tab", () => {
  it("lists a DeepSeek tab's chats", async () => {
    await openBulkPage("?tab=9&site=deepseek");

    expect(byId("page-subtitle").textContent).toContain("DeepSeek");
    expect(listedTitles()).toEqual(["Rice"]);
    expect(tabsSendMessage).toHaveBeenCalledWith(9, {
      type: "LIST_CONVERSATIONS_PAGE",
      cursor: null,
    });
    expect(executeScript).not.toHaveBeenCalled();
  });

  it("puts the content script back into a reloaded Grok or Perplexity tab", async () => {
    contentScriptReady = false;
    tabUrl = "https://www.perplexity.ai/search/rice-abc";

    await openBulkPage("?tab=9&site=perplexity");

    expect(executeScript).toHaveBeenCalledWith({
      target: { tabId: 9 },
      files: ["content.js"],
    });
    expect(listedTitles()).toEqual(["Rice"]);
  });

  it("leaves a tab that has moved on to another site alone", async () => {
    contentScriptReady = false;
    tabUrl = "https://example.com/";

    await openBulkPage("?tab=9&site=grok");

    expect(executeScript).not.toHaveBeenCalled();
    expect(byId("error-text").textContent).toBe(
      en["bulk.error.tabGone"].replaceAll("{{site}}", "Grok"),
    );
  });

  it("never puts the script into a ChatGPT, Claude or Gemini tab, whose manifest does", async () => {
    contentScriptReady = false;
    tabUrl = "https://claude.ai/chat/0b2f7a52-1c3d-4e5f-8a9b-0c1d2e3f4a5b";

    await openBulkPage("?tab=9&site=claude");

    expect(tabsGet).not.toHaveBeenCalled();
    expect(executeScript).not.toHaveBeenCalled();
    expect(byId("state-error").hidden).toBe(false);
  });

  it("doesn't talk to a tab of a site it doesn't know", async () => {
    await openBulkPage("?tab=9&site=bing");

    expect(tabsSendMessage).not.toHaveBeenCalled();
    expect(byId("state-error").hidden).toBe(false);
  });
});
