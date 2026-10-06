// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://www.kimi.com/chat/d1k2a3b4c5e6f7g8h9i0"}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, loadContentScript, type ContentScript } from "./content-harness";

/*
 * The real content script on a Kimi conversation, with fetch
 * standing in for Kimi's API. The parsing itself is covered by
 * new-sites.test.ts.
 */
const MESSAGES = "/apiv2/kimi.gateway.chat.v1.ChatService/ListMessages";

let page: ContentScript;

describe("content.ts on www.kimi.com", () => {
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
    expect(await page.send({ type: "AIEXPORTER_PING" })).toEqual({ ok: true, host: "www.kimi.com" });
    expect(page.getURL).not.toHaveBeenCalled();
  });

  it("loads every page of messages with the web app's token", async () => {
    page.fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          messages: [
            {
              id: "a1",
              role: "assistant",
              createTime: "2026-08-01T10:00:01Z",
              blocks: [{ text: { content: "Rinse it." } }],
            },
          ],
          nextPageToken: "p2",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          messages: [
            {
              id: "u1",
              role: "user",
              createTime: "2026-08-01T10:00:00Z",
              blocks: [{ text: { content: "Rice?" } }],
            },
          ],
          nextPageToken: "",
        }),
      );

    const response = await page.send({ type: "LOAD_CONVERSATION", downloadImagesLocally: false });

    expect(page.requests().map((request) => request.address)).toEqual([MESSAGES, MESSAGES]);
    expect(page.requests()[0].init).toMatchObject({
      method: "POST",
      credentials: "include",
      headers: { Authorization: "Bearer kimi-token", "connect-protocol-version": "1" },
    });
    expect(JSON.parse(String(page.requests()[1].init?.body))).toEqual({
      chatId: "d1k2a3b4c5e6f7g8h9i0",
      pageSize: 100,
      pageToken: "p2",
    });
    expect(response.data.messages.map((message: { role: string; content: string }) => [message.role, message.content])).toEqual([
      ["user", "Rice?"],
      ["assistant", "Rinse it."],
    ]);
  });

  it("asks the person to sign in without a token", async () => {
    window.localStorage.clear();

    expect(await page.send({ type: "LOAD_CONVERSATION", downloadImagesLocally: false })).toEqual({
      success: false,
      error: "Sign in to Kimi to export this conversation.",
    });
  });

  it("lists the chats for Save many chats", async () => {
    page.fetchMock.mockResolvedValueOnce(
      jsonResponse({ items: [{ chat: { id: "c1abcdefgh", name: "Rice" } }], nextPageToken: "" }),
    );

    expect(await page.send({ type: "LIST_CONVERSATIONS_PAGE", cursor: null })).toEqual({
      success: true,
      data: {
        conversations: [
          { id: "c1abcdefgh", title: "Rice", createdAt: null, updatedAt: null, url: "https://www.kimi.com/chat/c1abcdefgh" },
        ],
        nextCursor: null,
      },
    });
  });
});
