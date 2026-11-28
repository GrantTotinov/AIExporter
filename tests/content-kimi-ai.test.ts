// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://www.kimi.ai/chat/d1k2a3b4c5e6f7g8h9i0"}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, loadContentScript, type ContentScript } from "./content-harness";

/*
 * Kimi's international address. The web app and its API are the
 * same as on www.kimi.com (content-kimi.test.ts), so this only
 * checks that the content script takes the page for Kimi and
 * keeps the requests and chat links on www.kimi.ai.
 */
const MESSAGES = "/apiv2/kimi.gateway.chat.v1.ChatService/ListMessages";

let page: ContentScript;

describe("content.ts on www.kimi.ai", () => {
  beforeEach(async () => {
    window.localStorage.setItem("access_token", "kimi-token");
    page = await loadContentScript();
  });

  afterEach(() => {
    window.localStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("isn't taken for ChatGPT: no page bridge", async () => {
    expect(await page.send({ type: "AIEXPORTER_PING" })).toEqual({ ok: true, host: "www.kimi.ai" });
    expect(page.getURL).not.toHaveBeenCalled();
  });

  it("loads the conversation from www.kimi.ai's own API", async () => {
    page.fetchMock.mockResolvedValueOnce(
      jsonResponse({
        messages: [
          { id: "u1", role: "user", blocks: [{ text: { content: "Rice?" } }] },
          { id: "a1", role: "assistant", blocks: [{ text: { content: "Rinse it." } }] },
        ],
        nextPageToken: "",
      }),
    );

    const response = await page.send({ type: "LOAD_CONVERSATION", downloadImagesLocally: false });

    expect(String(page.fetchMock.mock.calls[0][0])).toBe(`https://www.kimi.ai${MESSAGES}`);
    expect(page.requests()[0].init).toMatchObject({
      headers: { Authorization: "Bearer kimi-token" },
    });
    expect(response.data.messages.map((message: { content: string }) => message.content)).toEqual([
      "Rice?",
      "Rinse it.",
    ]);
  });

  it("links the listed chats to www.kimi.ai", async () => {
    page.fetchMock.mockResolvedValueOnce(
      jsonResponse({ items: [{ chat: { id: "c1abcdefgh", name: "Rice" } }], nextPageToken: "" }),
    );

    const response = await page.send({ type: "LIST_CONVERSATIONS_PAGE", cursor: null });

    expect(response.data.conversations[0].url).toBe("https://www.kimi.ai/chat/c1abcdefgh");
  });
});
