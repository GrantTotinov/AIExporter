// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://chatgpt.com/c/0b2f7a52-1c3d-4e5f-8a9b-0c1d2e3f4a5b"}
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * page-bridge.ts runs in ChatGPT's MAIN world: it borrows the
 * auth headers from ChatGPT's own conversation request, then
 * fetches conversation pages for content.ts. These check the
 * page requests it makes - in particular the page size, since
 * every page is another sequential round trip.
 *
 * The bridge patches window.fetch when it loads, so it's loaded
 * once for the whole file; each test only swaps what the
 * captured "original" fetch answers.
 */

const CONVERSATION_ID = "0b2f7a52-1c3d-4e5f-8a9b-0c1d2e3f4a5b";
const fetchMock = vi.fn();
const posted: any[] = [];

function sendToBridge(data: Record<string, unknown>): void {
  const event = new Event("message");

  Object.defineProperties(event, {
    data: { value: { source: "AIExporter", ...data } },
    source: { value: window },
  });
  window.dispatchEvent(event);
}

async function bridgeReply(requestId: string): Promise<any> {
  await vi.waitFor(() =>
    expect(posted.some((message) => message.requestId === requestId)).toBe(
      true,
    ),
  );

  return posted.find((message) => message.requestId === requestId);
}

function requested(call: number): { url: URL; headers: Headers } {
  const [input, init] = fetchMock.mock.calls[call];

  return {
    url: new URL(String(input), "https://chatgpt.com"),
    headers: new Headers(init?.headers),
  };
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("page-bridge.ts conversation pages", () => {
  beforeAll(async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(window, "postMessage").mockImplementation((message: unknown) => {
      posted.push(message);
    });
    vi.stubGlobal("fetch", fetchMock);

    await import("../src/page-bridge");

    // ChatGPT's own request - the bridge borrows its headers.
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    await window.fetch(
      `/backend-api/conversations/${CONVERSATION_ID}?include_has_versions=true&num_turns=10`,
      { headers: { authorization: "Bearer page-token" } },
    );
  });

  beforeEach(() => {
    fetchMock.mockReset();
    posted.length = 0;
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("asks for 100 turns a page, with ChatGPT's own auth headers", async () => {
    const page = { messages: [], page_info: { has_previous_page: false } };
    fetchMock.mockResolvedValue(jsonResponse(page));

    sendToBridge({
      type: "AIExporter_API_REQUEST",
      requestId: "first-page",
      conversationId: CONVERSATION_ID,
      cursor: null,
    });

    expect(await bridgeReply("first-page")).toMatchObject({
      type: "AIExporter_API_RESPONSE",
      data: page,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const { url, headers } = requested(0);

    expect(url.pathname).toBe(`/backend-api/conversations/${CONVERSATION_ID}`);
    expect(url.searchParams.get("num_turns")).toBe("100");
    expect(url.searchParams.get("include_has_versions")).toBe("true");
    expect(headers.get("authorization")).toBe("Bearer page-token");
  });

  it("asks for older pages before the cursor, 100 turns at a time", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ messages: [] }));

    sendToBridge({
      type: "AIExporter_API_REQUEST",
      requestId: "older-page",
      conversationId: CONVERSATION_ID,
      cursor: "cursor-123",
    });

    await bridgeReply("older-page");

    const { url } = requested(0);

    expect(url.pathname).toBe(
      `/backend-api/conversations/${CONVERSATION_ID}/messages`,
    );
    expect(url.searchParams.get("before")).toBe("cursor-123");
    expect(url.searchParams.get("num_turns")).toBe("100");
  });

  it("falls back to the web app's 10 turns if the larger page is rejected", async () => {
    const page = { messages: [{ id: "a" }] };
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ detail: "num_turns too large" }, 422))
      .mockResolvedValueOnce(jsonResponse(page));

    sendToBridge({
      type: "AIExporter_API_REQUEST",
      requestId: "fallback",
      conversationId: CONVERSATION_ID,
      cursor: null,
    });

    expect(await bridgeReply("fallback")).toMatchObject({
      type: "AIExporter_API_RESPONSE",
      data: page,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requested(0).url.searchParams.get("num_turns")).toBe("100");
    expect(requested(1).url.searchParams.get("num_turns")).toBe("10");
  });

  it("doesn't retry other failures", async () => {
    fetchMock.mockResolvedValue(
      new Response("rate limited", { status: 429, statusText: "Too Many Requests" }),
    );

    sendToBridge({
      type: "AIExporter_API_REQUEST",
      requestId: "rate-limited",
      conversationId: CONVERSATION_ID,
      cursor: null,
    });

    expect(await bridgeReply("rate-limited")).toMatchObject({
      type: "AIExporter_API_ERROR",
      error: "ChatGPT API request failed: 429 Too Many Requests",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
