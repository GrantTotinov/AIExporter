// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://yuanbao.tencent.com/chat/naQivTmsDa/3f2a1b0c-aaaa-bbbb-cccc-0123456789ab"}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, loadContentScript, type ContentScript } from "./content-harness";

let page: ContentScript;

describe("content.ts on yuanbao.tencent.com", () => {
  beforeEach(async () => {
    page = await loadContentScript();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("loads the conversation of the agent in the address", async () => {
    page.fetchMock.mockResolvedValueOnce(
      jsonResponse({
        code: 0,
        hasMore: false,
        convs: [
          { id: "c1", index: 1, speaker: "human", speechesV2: [{ content: [{ type: "text", msg: "你好" }] }] },
          { id: "c2", index: 2, speaker: "ai", speechesV2: [{ content: [{ type: "text", msg: "你好！" }] }] },
        ],
      }),
    );

    const response = await page.send({ type: "LOAD_CONVERSATION", downloadImagesLocally: false });

    expect(page.requests()[0].address).toBe("/api/user/agent/conversation/v1/detail");
    expect(JSON.parse(String(page.requests()[0].init?.body))).toEqual({
      conversationId: "3f2a1b0c-aaaa-bbbb-cccc-0123456789ab",
      offset: 0,
      limit: 50,
      agentId: "naQivTmsDa",
    });
    expect(response.data.messages.map((message: { content: string }) => message.content)).toEqual([
      "你好",
      "你好！",
    ]);
  });

  it("links the listed chats under the same agent", async () => {
    page.fetchMock.mockResolvedValueOnce(
      jsonResponse({ code: 0, conversations: [{ id: "c9abcdefgh", title: "饭" }], pagination: { totalResults: 1 } }),
    );

    const response = await page.send({ type: "LIST_CONVERSATIONS_PAGE", cursor: null });

    expect(response.data.conversations[0].url).toBe(
      "https://yuanbao.tencent.com/chat/naQivTmsDa/c9abcdefgh",
    );
    expect(response.data.nextCursor).toBeNull();
  });
});
