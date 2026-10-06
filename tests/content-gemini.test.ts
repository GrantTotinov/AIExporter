// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://gemini.google.com/app/e87b6c6ac16404a5"}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * ---------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------
 *
 * Loads the real content script on a gemini.google.com
 * conversation URL and drives it the way popup.ts does (a
 * LOAD_CONVERSATION message), with fetch standing in for
 * Gemini's batchexecute endpoint. This covers what the pure
 * tests in gemini-conversation.test.ts can't: the tokens read
 * from the page, the exact requests made, pagination, image
 * downloads, and the response shape popup.ts reads.
 */

const CONVERSATION_ID = "e87b6c6ac16404a5";
const RPC_CONVERSATION_ID = `c_${CONVERSATION_ID}`;
const AT_TOKEN = "AKRzLkFp3w:1790000000000";
/* When every turn below was sent, as Gemini writes it: [1790000000, 0] */
const TURN_TIME = 1790000000 * 1000;
const FRESH_AT_TOKEN = "AKRzFresh:1790000099999";
const BUILD_LABEL = "boq_gemini-web-uiserver_20261001.12_p0";
const SESSION_ID = "-351644736144307804";
const BATCH_PATH = "/_/BardChatUi/data/batchexecute";
const UPLOAD_URL = "https://lh3.googleusercontent.com/gg/uploaded-photo";
const GENERATED_URL = "https://lh3.googleusercontent.com/gg/generated-star=s0";
const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3]);

type Listener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response?: unknown) => void,
) => boolean | void;

const onMessageListeners: Listener[] = [];
const getURL = vi.fn((path: string) => `chrome-extension://test-id/${path}`);
const sendMessage = vi.fn();
const fetchMock = vi.fn();

function wizGlobalData(token: string): string {
  return `window.WIZ_global_data = {"AEJOSc":false,"FdrFJe":"${SESSION_ID}","Im6cmf":"/_/BardChatUi","SNlM0e":"${token}","TuX5cc":"en-US","cfb2h":"${BUILD_LABEL}"};`;
}

function setPageTokens(token: string | null): void {
  document.head.innerHTML = token
    ? `<script data-id="_gd">${wizGlobalData(token)}</script>`
    : "";
}

function fillTo(length: number, fields: Record<number, unknown>): unknown[] {
  const value: unknown[] = Array.from({ length }, () => null);

  for (const [index, field] of Object.entries(fields)) {
    value[Number(index)] = field;
  }

  return value;
}

function imageFile(name: string, url: string): unknown[] {
  return fillTo(16, { 1: 1, 2: name, 3: url, 11: "image/png" });
}

function turn(
  id: string,
  text: string,
  replyText: string,
  options: { attachments?: unknown[]; generated?: unknown[] } = {},
): unknown[] {
  const attachments = options.attachments ?? [];

  return [
    [RPC_CONVERSATION_ID, id],
    null,
    [
      [
        text,
        null,
        null,
        null,
        attachments.length > 0
          ? [[null, null, null, attachments], attachments]
          : [[]],
      ],
      2,
      null,
      1,
      "56fdd199312815e2",
    ],
    fillTo(26, {
      0: [
        fillTo(29, {
          0: `rc_${id.slice(2)}`,
          1: [replyText],
          8: [2],
          12: fillTo(8, {
            7: (options.generated ?? []).map((image) => [
              fillTo(4, { 3: image }),
            ]),
          }),
        }),
      ],
      3: `rc_${id.slice(2)}`,
      21: "3.8 Flash",
    }),
    [1790000000, 0],
  ];
}

const NEWEST_PAGE = [
  turn(
    "r_3",
    "Draw a sea star",
    "Here it is.\nhttp://googleusercontent.com/image_generation_content/0",
    {
      generated: [imageFile("star.png", GENERATED_URL)],
    },
  ),
  turn("r_2", "What's in this photo?", "A tide pool [cite: 1].", {
    attachments: [imageFile("photo.png", UPLOAD_URL)],
  }),
];
const OLDEST_PAGE = [turn("r_1", "Hello Gemini", "Hi! How can I help?")];

function batchResponse(result: unknown): Response {
  const envelope = JSON.stringify([
    ["wrb.fr", "hNvQHb", JSON.stringify(result), null, null, null, "generic"],
  ]);
  const end = JSON.stringify([["e", 4, null, null, 39853]]);

  return new Response(
    `)]}'\n\n${envelope.length + 2}\n${envelope}\n${end.length + 2}\n${end}\n`,
    { headers: { "content-type": "application/json; charset=utf-8" } },
  );
}

function errorResponse(code: number): Response {
  return new Response(
    `)]}'\n\n${JSON.stringify([["wrb.fr", "hNvQHb", null, null, null, [code], "generic"]])}\n`,
  );
}

interface BatchRequest {
  url: URL;
  init: RequestInit;
  args: unknown[];
  at: string | null;
}

function batchRequests(): BatchRequest[] {
  return fetchMock.mock.calls.flatMap(([input, init]) => {
    const url = new URL(String(input));

    if (!url.pathname.endsWith(BATCH_PATH)) {
      return [];
    }

    const form = new URLSearchParams(String((init as RequestInit).body));
    const envelope = JSON.parse(form.get("f.req") ?? "null");

    return [
      {
        url,
        init: init as RequestInit,
        args: JSON.parse(envelope[0][0][1]),
        at: form.get("at"),
      },
    ];
  });
}

/*
 * Answers the way gemini.google.com would: two pages of turns,
 * newest first, chained by a cursor; images from Google's image
 * host. Overrides replace the answer to a URL (or a page cursor).
 */
function serveGemini(
  overrides: {
    page?: (cursor: string | null, attempt: number) => Response | undefined;
    image?: (url: string, init: RequestInit) => Response | undefined;
    appPage?: () => Response;
  } = {},
): void {
  let batchAttempts = 0;

  fetchMock.mockImplementation(
    async (input: unknown, init: RequestInit = {}) => {
      const url = new URL(String(input));

      if (url.origin === "https://lh3.googleusercontent.com") {
        return (
          overrides.image?.(url.href, init) ??
          new Response(PNG_BYTES, { headers: { "content-type": "image/png" } })
        );
      }

      if (url.origin !== "https://gemini.google.com") {
        throw new Error(`unexpected request to ${url.href}`);
      }

      if (url.pathname.endsWith("/app") && (init.method ?? "GET") === "GET") {
        return (
          overrides.appPage?.() ??
          new Response(
            `<html><script>${wizGlobalData(FRESH_AT_TOKEN)}</script></html>`,
          )
        );
      }

      if (url.pathname.endsWith(BATCH_PATH)) {
        const form = new URLSearchParams(String(init.body));
        const cursor = JSON.parse(
          JSON.parse(form.get("f.req") ?? "")[0][0][1],
        )[2];
        const override = overrides.page?.(cursor, batchAttempts++);

        if (override) {
          return override;
        }

        return cursor === null
          ? batchResponse([NEWEST_PAGE, "older-page-cursor", null, []])
          : batchResponse([OLDEST_PAGE, null, null, []]);
      }

      return new Response("not found", { status: 404 });
    },
  );
}

function loadConversation(downloadImagesLocally: boolean): Promise<any> {
  return new Promise((resolve) => {
    for (const listener of onMessageListeners) {
      if (
        listener(
          { type: "LOAD_CONVERSATION", downloadImagesLocally },
          {},
          resolve,
        ) === true
      ) {
        return;
      }
    }

    throw new Error("No LOAD_CONVERSATION listener registered");
  });
}

describe("content.ts on gemini.google.com", () => {
  beforeEach(async () => {
    vi.resetModules();
    fetchMock.mockReset();
    sendMessage.mockReset();
    getURL.mockClear();
    onMessageListeners.length = 0;

    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("chrome", {
      runtime: {
        getURL,
        sendMessage,
        onMessage: {
          addListener: (listener: Listener) => {
            onMessageListeners.push(listener);
          },
        },
      },
      storage: {
        sync: {
          get: vi.fn((defaults: Record<string, unknown>) =>
            Promise.resolve(defaults),
          ),
        },
        onChanged: { addListener: vi.fn() },
      },
      i18n: { getUILanguage: () => "en-US" },
    });

    window.history.replaceState(null, "", `/app/${CONVERSATION_ID}`);
    setPageTokens(AT_TOKEN);

    await import("../src/content");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("doesn't inject the ChatGPT page bridge", () => {
    expect(getURL).not.toHaveBeenCalled();
    expect(
      document.querySelector('script[data-ai-exporter="page-bridge"]'),
    ).toBeNull();
  });

  it("loads every page and exports the conversation oldest turn first", async () => {
    serveGemini();

    const response = await loadConversation(false);

    expect(response).toEqual({
      success: true,
      data: {
        messages: [
          {
            id: "r_1",
            role: "user",
            content: "Hello Gemini",
            imagePaths: [],
            order: 0,
            time: TURN_TIME,
          },
          {
            id: "rc_1",
            role: "assistant",
            content: "Hi! How can I help?",
            imagePaths: [],
            order: 1,
            time: TURN_TIME,
            model: "Gemini 3.8 Flash",
          },
          {
            id: "r_2",
            role: "user",
            content: "What's in this photo?",
            imagePaths: [],
            order: 2,
            time: TURN_TIME,
          },
          {
            id: "rc_2",
            role: "assistant",
            content: "A tide pool.",
            imagePaths: [],
            order: 3,
            time: TURN_TIME,
            model: "Gemini 3.8 Flash",
          },
          {
            id: "r_3",
            role: "user",
            content: "Draw a sea star",
            imagePaths: [],
            order: 4,
            time: TURN_TIME,
          },
          {
            id: "rc_3",
            role: "assistant",
            content: "Here it is.",
            imagePaths: [],
            order: 5,
            time: TURN_TIME,
            model: "Gemini 3.8 Flash",
          },
        ],
        images: [],
      },
    });
  });

  it("asks for each page the way the web app does, with the page's tokens", async () => {
    serveGemini();

    await loadConversation(false);

    const requests = batchRequests();

    expect(requests).toHaveLength(2);
    expect(requests.map(({ args }) => args)).toEqual([
      [RPC_CONVERSATION_ID, 10, null, 1, [1], [4], null, 1],
      [RPC_CONVERSATION_ID, 10, "older-page-cursor", 1, [1], [4], null, 1],
    ]);

    for (const { url, init, at } of requests) {
      expect(url.origin + url.pathname).toBe(
        `https://gemini.google.com${BATCH_PATH}`,
      );
      expect(url.searchParams.get("rpcids")).toBe("hNvQHb");
      expect(url.searchParams.get("source-path")).toBe(
        `/app/${CONVERSATION_ID}`,
      );
      expect(url.searchParams.get("bl")).toBe(BUILD_LABEL);
      expect(url.searchParams.get("f.sid")).toBe(SESSION_ID);
      expect(url.searchParams.get("hl")).toBe("en-US");
      expect(url.searchParams.get("rt")).toBe("c");
      expect(at).toBe(AT_TOKEN);
      expect(init).toMatchObject({
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          "X-Same-Domain": "1",
        },
      });
    }

    const [first, second] = requests.map(({ url }) =>
      Number(url.searchParams.get("_reqid")),
    );

    expect(second - first).toBe(100000);
    expect(
      fetchMock.mock.calls.some(([input]) => String(input).endsWith("/app")),
    ).toBe(false);
  });

  it("reports progress while it pages through a long conversation", async () => {
    serveGemini();

    await loadConversation(false);

    expect(sendMessage).toHaveBeenCalledWith({
      type: "EXPORT_PROGRESS",
      collected: 4,
    });
  });

  it("uses the account and the Gem in the page's path", async () => {
    window.history.replaceState(
      null,
      "",
      `/u/1/gem/coding-partner/${CONVERSATION_ID}`,
    );
    serveGemini();

    const response = await loadConversation(false);

    expect(response.success).toBe(true);

    const [first] = batchRequests();

    expect(first.url.pathname).toBe(`/u/1${BATCH_PATH}`);
    expect(first.url.searchParams.get("source-path")).toBe(
      `/u/1/gem/coding-partner/${CONVERSATION_ID}`,
    );
    expect(first.args[0]).toBe(RPC_CONVERSATION_ID);
  });

  it("gets fresh tokens and retries once when the page's have expired", async () => {
    serveGemini({
      page: (_cursor, attempt) =>
        attempt === 0 ? new Response("", { status: 400 }) : undefined,
    });

    const response = await loadConversation(false);

    expect(response.success).toBe(true);
    expect(batchRequests().map(({ at }) => at)).toEqual([
      AT_TOKEN,
      FRESH_AT_TOKEN,
      FRESH_AT_TOKEN,
    ]);
    expect(
      fetchMock.mock.calls.filter(
        ([input]) => String(input) === "https://gemini.google.com/app",
      ),
    ).toHaveLength(1);
  });

  it("doesn't retry endlessly when fresh tokens are refused too", async () => {
    serveGemini({ page: () => new Response("", { status: 400 }) });

    const response = await loadConversation(false);

    expect(response).toEqual({
      success: false,
      error: "Gemini API request failed: 400",
    });
    expect(batchRequests()).toHaveLength(2);
  });

  it("reads the tokens from the app page when this page has none", async () => {
    setPageTokens(null);
    serveGemini();

    const response = await loadConversation(false);

    expect(response.success).toBe(true);
    expect(batchRequests().map(({ at }) => at)).toEqual([
      FRESH_AT_TOKEN,
      FRESH_AT_TOKEN,
    ]);
  });

  it("asks the person to sign in when Gemini has no session for them", async () => {
    setPageTokens(null);
    serveGemini({
      appPage: () =>
        new Response(
          '<html><script>window.WIZ_global_data = {"cfb2h":"x","TuX5cc":"en"};</script></html>',
        ),
    });

    const response = await loadConversation(false);

    expect(response).toEqual({
      success: false,
      error: "Sign in to Gemini to export this conversation.",
    });
    expect(batchRequests()).toHaveLength(0);
  });

  it("downloads uploaded and generated images when image bundling is on", async () => {
    serveGemini();

    const response = await loadConversation(true);

    expect(response.success).toBe(true);
    expect(
      response.data.messages.map((message: any) => message.content),
    ).toEqual([
      "Hello Gemini",
      "Hi! How can I help?",
      "![Image 1](images/image-001.png)\n\nWhat's in this photo?",
      "A tide pool.",
      "Draw a sea star",
      "Here it is.\n\n![Image 1](images/image-002.png)",
    ]);
    expect(response.data.messages[2].imagePaths).toEqual([
      "images/image-001.png",
    ]);
    expect(response.data.messages[5].imagePaths).toEqual([
      "images/image-002.png",
    ]);
    expect(response.data.images).toEqual([
      {
        path: "images/image-001.png",
        mimeType: "image/png",
        base64: btoa(String.fromCharCode(...PNG_BYTES)),
        sizeBytes: PNG_BYTES.byteLength,
      },
      {
        path: "images/image-002.png",
        mimeType: "image/png",
        base64: btoa(String.fromCharCode(...PNG_BYTES)),
        sizeBytes: PNG_BYTES.byteLength,
      },
    ]);

    const imageCalls = fetchMock.mock.calls.filter(([input]) =>
      String(input).startsWith("https://lh3.googleusercontent.com/"),
    );

    expect(
      imageCalls.map(([input, init]) => [String(input), init.credentials]),
    ).toEqual([
      [UPLOAD_URL, "omit"],
      [GENERATED_URL, "omit"],
    ]);
  });

  it("sends the Google session only when an image isn't served without it", async () => {
    serveGemini({
      image: (_url, init) =>
        init.credentials === "omit"
          ? new Response("", { status: 403 })
          : undefined,
    });

    const response = await loadConversation(true);

    expect(response.data.images).toHaveLength(2);
    expect(
      fetchMock.mock.calls
        .filter(([input]) => String(input) === UPLOAD_URL)
        .map(([, init]) => init.credentials),
    ).toEqual(["omit", "include"]);
  });

  it("keeps the export going when an image can't be downloaded", async () => {
    serveGemini({
      image: (url) =>
        url === UPLOAD_URL ? new Response("", { status: 404 }) : undefined,
    });

    const response = await loadConversation(true);

    expect(response.success).toBe(true);
    expect(response.data.messages[2].content).toBe(
      "[Image attachment could not be downloaded]\n\nWhat's in this photo?",
    );
    expect(response.data.images.map((image: any) => image.path)).toEqual([
      "images/image-002.png",
    ]);
  });

  it("leaves images out when image bundling is off", async () => {
    serveGemini();

    await loadConversation(false);

    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).startsWith("https://lh3.googleusercontent.com/"),
      ),
    ).toBe(false);
  });

  it("reports a short, readable error for a missing conversation", async () => {
    serveGemini({ page: () => errorResponse(5) });

    expect(await loadConversation(false)).toEqual({
      success: false,
      error: "Gemini could not find this conversation.",
    });
  });

  it("reports a failed request", async () => {
    serveGemini({ page: () => new Response("", { status: 500 }) });

    expect(await loadConversation(false)).toEqual({
      success: false,
      error: "Gemini API request failed: 500",
    });
  });

  it("stops instead of looping when Gemini repeats a cursor", async () => {
    serveGemini({
      page: () => batchResponse([OLDEST_PAGE, "same-cursor", null, []]),
    });

    const response = await loadConversation(false);

    expect(response.success).toBe(false);
    expect(response.error).toMatch(/repeated pagination cursor/);
    expect(batchRequests()).toHaveLength(2);
  });

  it("says so on a page that isn't a conversation", async () => {
    window.history.replaceState(null, "", "/app");
    serveGemini();

    expect(await loadConversation(false)).toEqual({
      success: false,
      error:
        "Could not determine the Gemini conversation ID from the current URL.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
