// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://grok.com/c/0b2f7a52-1c3d-4e5f-8a9b-0c1d2e3f4a5b?rid=r2"}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PNG_BASE64,
  jsonResponse,
  loadContentScript,
  pngResponse,
  type ContentScript,
} from "./content-harness";

/*
 * Loads the real content script on a grok.com conversation - put
 * there by the popup, not the manifest (see chat-sites.ts) - and
 * drives it the way popup.ts and bulk.ts do, with fetch standing
 * in for Grok's API. The parsing itself is covered by
 * grok-conversation.test.ts.
 */

const UUID = "0b2f7a52-1c3d-4e5f-8a9b-0c1d2e3f4a5b";
const OTHER_UUID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const NODES_PATH = (id: string) =>
  `/rest/app-chat/conversations/${id}/response-node?includeThreads=true`;
const LOAD_PATH = (id: string) => `/rest/app-chat/conversations/${id}/load-responses`;
const IMAGE_ADDRESS = "https://assets.grok.com/users/u1/generated/cat.png";

/* A question answered twice; the address names the first reply (?rid=r2) */
const RESPONSES = [
  {
    responseId: "r1",
    sender: "human",
    createTime: "2026-10-01T10:00:00.000Z",
    message: "Draw me a cat",
  },
  {
    responseId: "r2",
    sender: "assistant",
    parentResponseId: "r1",
    createTime: "2026-10-01T10:00:05.000Z",
    message: "Here's a cat.",
    generatedImageUrls: ["users/u1/generated/cat.png"],
  },
  {
    responseId: "r3",
    sender: "assistant",
    parentResponseId: "r1",
    createTime: "2026-10-01T10:01:00.000Z",
    message: "Here's another cat.",
  },
];

let page: ContentScript;

/*
 * Answers the way grok.com does: the tree of a conversation, and
 * load-responses with the responses it was asked for.
 */
function serve(responses: Record<string, unknown>[], conversationId = UUID): void {
  page.fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));

    if (url.href === IMAGE_ADDRESS) {
      return pngResponse();
    }

    if (url.origin !== "https://grok.com") {
      throw new Error(`unexpected request to ${url.href}`);
    }

    const address = url.pathname + url.search;

    if (address === NODES_PATH(conversationId)) {
      return jsonResponse({
        responseNodes: responses.map(({ responseId, sender, parentResponseId }) => ({
          responseId,
          sender,
          parentResponseId,
        })),
      });
    }

    if (address === LOAD_PATH(conversationId) && init?.method === "POST") {
      const { responseIds } = JSON.parse(String(init.body)) as { responseIds: string[] };

      return jsonResponse({
        responses: responses.filter((response) =>
          responseIds.includes(String(response.responseId)),
        ),
      });
    }

    return jsonResponse({ error: "not found" }, 404);
  });
}

describe("content.ts on grok.com", () => {
  beforeEach(async () => {
    page = await loadContentScript();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("answers the ping with its site and leaves ChatGPT's page bridge out", async () => {
    expect(await page.send({ type: "AIEXPORTER_PING" })).toEqual({
      ok: true,
      host: "grok.com",
    });
    expect(page.getURL).not.toHaveBeenCalled();
  });

  it("loads every response and follows the reply the address names", async () => {
    serve(RESPONSES);

    const response = await page.send({
      type: "LOAD_CONVERSATION",
      downloadImagesLocally: false,
    });

    expect(page.requests().map((request) => request.address)).toEqual([
      NODES_PATH(UUID),
      LOAD_PATH(UUID),
    ]);
    expect(page.requests()[0].init).toMatchObject({
      method: "GET",
      credentials: "include",
    });
    expect(page.requests()[1].init).toMatchObject({
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
    });
    expect(JSON.parse(String(page.requests()[1].init?.body))).toEqual({
      responseIds: ["r1", "r2", "r3"],
    });
    expect(response).toEqual({
      success: true,
      data: {
        messages: [
          { id: "r1", role: "user", content: "Draw me a cat", imagePaths: [], order: 0 },
          { id: "r2", role: "assistant", content: "Here's a cat.", imagePaths: [], order: 1 },
        ],
        images: [],
      },
    });
  });

  it("downloads generated pictures from Grok's asset server without the session", async () => {
    serve(RESPONSES);

    const response = await page.send({
      type: "LOAD_CONVERSATION",
      downloadImagesLocally: true,
    });

    expect(
      page.requests().find((request) => request.address === IMAGE_ADDRESS)?.init,
    ).toMatchObject({ credentials: "omit" });
    expect(response.data.messages[1]).toMatchObject({
      content: "Here's a cat.\n\n![Image 1](images/image-001.png)",
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

  it("asks for a long conversation's responses fifty at a time", async () => {
    const chain = Array.from({ length: 120 }, (_, index) => ({
      responseId: `r${index + 1}`,
      sender: index % 2 === 0 ? "human" : "assistant",
      parentResponseId: index === 0 ? undefined : `r${index}`,
      createTime: new Date(Date.UTC(2026, 9, 1, 10, index)).toISOString(),
      message: `Message ${index + 1}`,
    }));

    serve(chain);

    const response = await page.send({
      type: "LOAD_CONVERSATION",
      downloadImagesLocally: false,
      conversationId: UUID,
    });

    const batches = page
      .requests()
      .filter((request) => request.init?.method === "POST")
      .map((request) => JSON.parse(String(request.init?.body)).responseIds.length);

    expect(batches).toEqual([50, 50, 20]);
    expect(response.data.messages).toHaveLength(120);
    expect(page.runtimeSendMessage).toHaveBeenCalledWith({
      type: "EXPORT_PROGRESS",
      collected: 120,
    });
  });

  it("exports a chat from the list as it was last shown, whatever this page's address names", async () => {
    serve(RESPONSES, OTHER_UUID);

    const response = await page.send({
      type: "LOAD_CONVERSATION",
      downloadImagesLocally: false,
      conversationId: OTHER_UUID,
    });

    expect(page.requests()[0].address).toBe(NODES_PATH(OTHER_UUID));
    expect(response.data.messages.map((message: { id: string }) => message.id)).toEqual([
      "r1",
      "r3",
    ]);
  });

  it("asks the person to sign in when Grok turns the session down", async () => {
    page.fetchMock.mockResolvedValue(jsonResponse({ error: "unauthenticated" }, 401));

    expect(
      await page.send({ type: "LOAD_CONVERSATION", downloadImagesLocally: false }),
    ).toEqual({
      success: false,
      error: "Sign in to Grok to export this conversation.",
    });
  });

  it("lists the chats a page at a time for Save many chats", async () => {
    page.fetchMock.mockImplementation(async (input: unknown) => {
      const url = new URL(String(input));

      return url.searchParams.get("pageToken") === "next"
        ? jsonResponse({ conversations: [] })
        : jsonResponse({
            conversations: [
              {
                conversationId: OTHER_UUID,
                title: "Cats",
                createTime: "2026-10-01T10:00:00.000Z",
                modifyTime: "2026-10-02T10:00:00.000Z",
              },
            ],
            nextPageToken: "next",
          });
    });

    expect(await page.send({ type: "LIST_CONVERSATIONS_PAGE", cursor: null })).toEqual({
      success: true,
      data: {
        conversations: [
          {
            id: OTHER_UUID,
            title: "Cats",
            createdAt: Date.parse("2026-10-01T10:00:00.000Z"),
            updatedAt: Date.parse("2026-10-02T10:00:00.000Z"),
            url: `https://grok.com/c/${OTHER_UUID}`,
          },
        ],
        nextCursor: "next",
      },
    });
    expect(await page.send({ type: "LIST_CONVERSATIONS_PAGE", cursor: "next" })).toEqual({
      success: true,
      data: { conversations: [], nextCursor: null },
    });
    expect(page.requests().map((request) => request.address)).toEqual([
      "/rest/app-chat/conversations?pageSize=60",
      "/rest/app-chat/conversations?pageSize=60&pageToken=next",
    ]);
  });
});
