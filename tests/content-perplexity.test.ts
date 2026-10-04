// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://www.perplexity.ai/search/rice-abc"}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  jsonResponse,
  loadContentScript,
  type ContentScript,
} from "./content-harness";
import { NOTE_CLOSE, NOTE_OPEN } from "../src/source-notes";

/*
 * Loads the real content script on a www.perplexity.ai thread -
 * put there by the popup, not the manifest (see chat-sites.ts) -
 * and drives it the way popup.ts and bulk.ts do, with fetch
 * standing in for Perplexity's API. The parsing itself is covered
 * by perplexity-conversation.test.ts.
 */

const THREAD_UUID = "2b9e4c1a-7d3f-4e8b-9a6c-5d1e0f2a3b4c";

const threadPath = (thread: string, offset: number): string =>
  `/rest/thread/${thread}?with_parent_info=true&with_schematized_response=true` +
  `&version=2.18&source=default&limit=50&offset=${offset}&from_first=true`;

function entry(index: number) {
  return {
    backend_uuid: `e${index}`,
    query_str: `Question ${index}`,
    blocks: [
      {
        intended_usage: "web_results",
        web_result_block: {
          web_results: [{ name: "Rice guide", url: "https://example.com/rice" }],
        },
      },
      {
        intended_usage: "ask_text_0_markdown",
        markdown_block: { answer: `Answer ${index} [1].` },
      },
    ],
  };
}

let page: ContentScript;

describe("content.ts on www.perplexity.ai", () => {
  beforeEach(async () => {
    page = await loadContentScript();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("answers the popup's ping and leaves ChatGPT's page bridge out", async () => {
    expect(await page.send({ type: "AIEXPORTER_PING" })).toEqual({ ok: true });
    expect(page.getURL).not.toHaveBeenCalled();
  });

  it("loads the thread with the headers Perplexity's web app sends", async () => {
    page.fetchMock.mockResolvedValue(
      jsonResponse({ status: "success", entries: [entry(1)], has_next_page: false }),
    );

    const response = await page.send({
      type: "LOAD_CONVERSATION",
      downloadImagesLocally: false,
    });

    expect(page.requests().map((request) => request.address)).toEqual([
      threadPath("rice-abc", 0),
    ]);
    expect(page.requests()[0].init).toMatchObject({
      method: "GET",
      credentials: "include",
      headers: { "x-app-apiclient": "default", "x-app-apiversion": "2.18" },
    });
    expect(response).toEqual({
      success: true,
      data: {
        messages: [
          {
            id: "e1-question",
            role: "user",
            content: "Question 1",
            imagePaths: [],
            order: 0,
          },
          {
            id: "e1",
            role: "assistant",
            content: `Answer 1${NOTE_OPEN}1${NOTE_CLOSE}.`,
            imagePaths: [],
            order: 1,
            sources: [{ title: "Rice guide", url: "https://example.com/rice" }],
          },
        ],
        images: [],
      },
    });
  });

  it("pages through a long thread fifty questions at a time", async () => {
    page.fetchMock.mockImplementation(async (input: unknown) => {
      const offset = Number(new URL(String(input)).searchParams.get("offset"));
      const count = offset === 0 ? 50 : 3;

      return jsonResponse({
        status: "success",
        entries: Array.from({ length: count }, (_, index) => entry(offset + index + 1)),
        has_next_page: offset === 0,
      });
    });

    const response = await page.send({
      type: "LOAD_CONVERSATION",
      downloadImagesLocally: false,
    });

    expect(page.requests().map((request) => request.address)).toEqual([
      threadPath("rice-abc", 0),
      threadPath("rice-abc", 50),
    ]);
    expect(response.data.messages).toHaveLength(106);
    expect(response.data.messages.at(-1).content).toBe(
      `Answer 53${NOTE_OPEN}1${NOTE_CLOSE}.`,
    );
  });

  it("asks the person to sign in when Perplexity turns the session down", async () => {
    page.fetchMock.mockResolvedValue(jsonResponse({ detail: "forbidden" }, 403));

    expect(
      await page.send({ type: "LOAD_CONVERSATION", downloadImagesLocally: false }),
    ).toEqual({
      success: false,
      error: "Sign in to Perplexity to export this conversation.",
    });
  });

  it("lists the library for Save many chats and loads a thread by its uuid", async () => {
    page.fetchMock.mockImplementation(async (input: unknown) => {
      const url = new URL(String(input));

      return url.pathname === "/rest/thread/list_ask_threads"
        ? jsonResponse([
            {
              uuid: THREAD_UUID,
              slug: "rice-abc",
              title: "Rice",
              last_query_datetime: "2026-10-02T08:00:00.000Z",
            },
          ])
        : jsonResponse({ status: "success", entries: [entry(1)], has_next_page: false });
    });

    expect(await page.send({ type: "LIST_CONVERSATIONS_PAGE", cursor: null })).toEqual({
      success: true,
      data: {
        conversations: [
          {
            id: THREAD_UUID,
            title: "Rice",
            url: "https://www.perplexity.ai/search/rice-abc",
            createdAt: null,
            updatedAt: Date.parse("2026-10-02T08:00:00.000Z"),
          },
        ],
        // Fewer than a full page: that was all
        nextCursor: null,
      },
    });
    expect(page.requests()[0]).toMatchObject({
      address: "/rest/thread/list_ask_threads?version=2.18&source=default",
      init: { method: "POST" },
    });
    expect(JSON.parse(String(page.requests()[0].init?.body))).toEqual({
      limit: 50,
      offset: 0,
      ascending: false,
      search_term: "",
    });

    const response = await page.send({
      type: "LOAD_CONVERSATION",
      downloadImagesLocally: false,
      conversationId: THREAD_UUID,
    });

    expect(response.success).toBe(true);
    expect(page.requests()[1].address).toBe(threadPath(THREAD_UUID, 0));
  });

  it("asks for the next page of the library after a full one", async () => {
    page.fetchMock.mockResolvedValue(
      jsonResponse(
        Array.from({ length: 50 }, (_, index) => ({
          uuid: `thread-${index}`,
          slug: `question-${index}`,
          title: `Question ${index}`,
        })),
      ),
    );

    const first = await page.send({ type: "LIST_CONVERSATIONS_PAGE", cursor: null });

    expect(first.data.conversations).toHaveLength(50);
    expect(first.data.nextCursor).toBe("50");
  });
});
