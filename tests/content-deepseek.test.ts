// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://chat.deepseek.com/a/chat/s/abc123"}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PNG_BASE64,
  jsonResponse,
  loadContentScript,
  pngResponse,
  type ContentScript,
} from "./content-harness";
import { NOTE_CLOSE, NOTE_OPEN } from "../src/source-notes";

/*
 * Loads the real content script on a chat.deepseek.com
 * conversation - put there by the popup, not the manifest (see
 * chat-sites.ts) - and drives it the way popup.ts and bulk.ts do,
 * with fetch standing in for DeepSeek's API. The parsing itself is
 * covered by deepseek-conversation.test.ts.
 */

const HISTORY_PATH = "/api/v0/chat/history_messages?chat_session_id=abc123";

function wrap(bizData: unknown) {
  return { code: 0, msg: "", data: { biz_code: 0, biz_msg: "", biz_data: bizData } };
}

const HISTORY = wrap({
  chat_session: { id: "abc123", title: "Rice", current_message_id: 2 },
  chat_messages: [
    {
      message_id: 1,
      parent_id: null,
      role: "USER",
      files: [{ file_name: "pot.png", signed_path: "/file?id=f1" }],
      fragments: [{ type: "REQUEST", content: "How do I cook rice?" }],
    },
    {
      message_id: 2,
      parent_id: 1,
      role: "ASSISTANT",
      fragments: [
        { type: "THINK", content: "Plain white rice." },
        {
          type: "SEARCH",
          results: [{ url: "https://example.com/rice", title: "Rice guide", cite_index: 1 }],
        },
        { type: "RESPONSE", content: "Rinse it first [citation:1]." },
      ],
    },
  ],
});

let page: ContentScript;

function serve(routes: Record<string, () => Response>): void {
  page.fetchMock.mockImplementation(async (input: unknown) => {
    const url = new URL(String(input));
    const address =
      url.origin === "https://chat.deepseek.com" ? url.pathname + url.search : url.href;
    const route = routes[address];

    if (!route) {
      throw new Error(`unexpected request to ${url.href}`);
    }

    return route();
  });
}

describe("content.ts on chat.deepseek.com", () => {
  beforeEach(async () => {
    window.localStorage.setItem(
      "userToken",
      JSON.stringify({ value: "tok-123", __version: "0" }),
    );
    page = await loadContentScript();
  });

  afterEach(() => {
    window.localStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("answers the popup's ping and leaves ChatGPT's page bridge out", async () => {
    expect(await page.send({ type: "AIEXPORTER_PING" })).toEqual({ ok: true });
    expect(page.getURL).not.toHaveBeenCalled();
  });

  it("loads the conversation with the token DeepSeek's web app keeps", async () => {
    serve({ [HISTORY_PATH]: () => jsonResponse(HISTORY) });

    const response = await page.send({
      type: "LOAD_CONVERSATION",
      downloadImagesLocally: false,
    });

    expect(page.requests().map((request) => request.address)).toEqual([HISTORY_PATH]);
    expect(page.requests()[0].init).toMatchObject({
      method: "GET",
      credentials: "include",
      headers: {
        Authorization: "Bearer tok-123",
        "x-client-platform": "web",
      },
    });
    expect(response).toEqual({
      success: true,
      data: {
        messages: [
          {
            id: "1",
            role: "user",
            content: "How do I cook rice?",
            imagePaths: [],
            order: 0,
          },
          {
            id: "2",
            role: "assistant",
            content: `Rinse it first${NOTE_OPEN}1${NOTE_CLOSE}.`,
            imagePaths: [],
            order: 1,
            thinking: "Plain white rice.",
            sources: [{ title: "Rice guide", url: "https://example.com/rice" }],
          },
        ],
        images: [],
      },
    });
  });

  it("downloads uploaded pictures from DeepSeek's file service without the session", async () => {
    const imageAddress = "https://files.deepseeksvc.com/api/file?id=f1&ty=p";

    serve({
      [HISTORY_PATH]: () => jsonResponse(HISTORY),
      [imageAddress]: pngResponse,
    });

    const response = await page.send({
      type: "LOAD_CONVERSATION",
      downloadImagesLocally: true,
    });

    expect(
      page.requests().find((request) => request.address === imageAddress)?.init,
    ).toMatchObject({ credentials: "omit" });
    expect(response.data.messages[0]).toMatchObject({
      content: "![Image 1](images/image-001.png)\n\nHow do I cook rice?",
      imagePaths: ["images/image-001.png"],
    });
    expect(response.data.images).toEqual([
      {
        path: "images/image-001.png",
        mimeType: "image/png",
        base64: PNG_BASE64,
        sizeBytes: 12,
      },
    ]);
  });

  it("asks the person to sign in when DeepSeek has no token for them", async () => {
    window.localStorage.removeItem("userToken");

    expect(
      await page.send({ type: "LOAD_CONVERSATION", downloadImagesLocally: false }),
    ).toEqual({
      success: false,
      error: "Sign in to DeepSeek to export this conversation.",
    });
    expect(page.fetchMock).not.toHaveBeenCalled();
  });

  it("passes on DeepSeek's own reason for refusing", async () => {
    serve({
      [HISTORY_PATH]: () =>
        jsonResponse({ code: 40003, msg: "Authorization Failed (invalid token)", data: null }),
    });

    expect(
      await page.send({ type: "LOAD_CONVERSATION", downloadImagesLocally: false }),
    ).toEqual({ success: false, error: "Authorization Failed (invalid token)" });
  });

  it("lists the chats a page at a time for Save many chats", async () => {
    const firstPage = "/api/v0/chat_session/fetch_page?count=50";
    const secondPage =
      "/api/v0/chat_session/fetch_page?count=50&lte_cursor.pinned=0&lte_cursor.updated_at=1759300000";

    serve({
      [firstPage]: () =>
        jsonResponse(
          wrap({
            chat_sessions: [
              { id: "s1", title: "Rice", pinned: false, updated_at: 1759300000, inserted_at: 1759200000 },
            ],
            has_more: true,
          }),
        ),
      [secondPage]: () => jsonResponse(wrap({ chat_sessions: [], has_more: false })),
    });

    const first = await page.send({ type: "LIST_CONVERSATIONS_PAGE", cursor: null });

    expect(first).toEqual({
      success: true,
      data: {
        conversations: [
          {
            id: "s1",
            title: "Rice",
            createdAt: 1759200000000,
            updatedAt: 1759300000000,
            url: "https://chat.deepseek.com/a/chat/s/s1",
          },
        ],
        nextCursor: JSON.stringify({ pinned: 0, updatedAt: 1759300000 }),
      },
    });

    const second = await page.send({
      type: "LIST_CONVERSATIONS_PAGE",
      cursor: first.data.nextCursor,
    });

    expect(second).toEqual({
      success: true,
      data: { conversations: [], nextCursor: null },
    });
    expect(page.requests()[1].init).toMatchObject({
      headers: { Authorization: "Bearer tok-123" },
    });
  });

  it("loads a chat from the list by its id", async () => {
    serve({
      "/api/v0/chat/history_messages?chat_session_id=s1": () => jsonResponse(HISTORY),
    });

    const response = await page.send({
      type: "LOAD_CONVERSATION",
      downloadImagesLocally: false,
      conversationId: "s1",
    });

    expect(response.success).toBe(true);
  });
});
