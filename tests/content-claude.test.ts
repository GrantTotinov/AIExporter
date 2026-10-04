// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://claude.ai/chat/0b2f7a52-1c3d-4e5f-8a9b-0c1d2e3f4a5b"}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * ---------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------
 *
 * Loads the real content script on a claude.ai conversation
 * URL and drives it the way popup.ts does (a LOAD_CONVERSATION
 * message), with fetch standing in for claude.ai's API. This
 * covers what the pure tests in claude-conversation.test.ts
 * can't: picking the organization, the exact requests made,
 * image downloads, and the response shape popup.ts reads.
 */

const ORG_ID = "4f0e1c2d-3b4a-4c5d-8e6f-7a8b9c0d1e2f";
const OTHER_ORG_ID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const API_ORG_ID = "12345678-90ab-4cde-8f01-234567890abc";
const CONVERSATION_ID = "0b2f7a52-1c3d-4e5f-8a9b-0c1d2e3f4a5b";
const FILE_ID = "5d6e7f80-91a2-4b3c-8d4e-5f60718293a4";
const ROOT_PARENT = "00000000-0000-4000-8000-000000000000";
const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3]);

const conversationPath = (organizationId: string): string =>
  `/api/organizations/${organizationId}/chat_conversations/${CONVERSATION_ID}`;

type Listener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response?: unknown) => void,
) => boolean | void;

const onMessageListeners: Listener[] = [];
const getURL = vi.fn((path: string) => `chrome-extension://test-id/${path}`);
const fetchMock = vi.fn();

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function conversation(imageUrl = `/api/${ORG_ID}/files/${FILE_ID}/preview`) {
  return {
    uuid: CONVERSATION_ID,
    name: "Fibonacci help",
    current_leaf_message_uuid: "00000000-0000-4000-8000-000000000004",
    chat_messages: [
      {
        uuid: "00000000-0000-4000-8000-000000000001",
        sender: "human",
        index: 0,
        parent_message_uuid: ROOT_PARENT,
        content: [{ type: "text", text: "What's in this picture?" }],
        files_v2: [
          {
            file_kind: "image",
            file_uuid: FILE_ID,
            file_name: "diagram.png",
            preview_url: imageUrl,
          },
        ],
        attachments: [],
      },
      {
        uuid: "00000000-0000-4000-8000-000000000002",
        sender: "assistant",
        index: 1,
        parent_message_uuid: "00000000-0000-4000-8000-000000000001",
        content: [{ type: "text", text: "A discarded first reply." }],
      },
      {
        uuid: "00000000-0000-4000-8000-000000000003",
        sender: "assistant",
        index: 1,
        parent_message_uuid: "00000000-0000-4000-8000-000000000001",
        content: [
          { type: "thinking", thinking: "Looks like a recursion tree." },
          { type: "text", text: "It's a recursion tree. Here's the code:" },
          {
            type: "tool_use",
            name: "artifacts",
            input: {
              id: "fib",
              command: "create",
              type: "application/vnd.ant.code",
              language: "python",
              title: "Fibonacci",
              content: "def fib(n):\n    return n",
            },
          },
          { type: "tool_result", name: "artifacts", content: [] },
        ],
      },
      {
        uuid: "00000000-0000-4000-8000-000000000004",
        sender: "human",
        index: 2,
        parent_message_uuid: "00000000-0000-4000-8000-000000000003",
        content: [{ type: "text", text: "Thanks!" }],
      },
    ],
  };
}

/*
 * Routes requests the way claude.ai would answer them: the
 * conversation exists only in ORG_ID; every other organization
 * answers 404, like claude.ai does for a conversation that isn't
 * in it.
 */
function serveClaudeApi(
  overrides: Record<string, () => Response> = {},
  data = conversation(),
): void {
  fetchMock.mockImplementation(async (input: unknown) => {
    const url = new URL(String(input));

    if (url.origin !== "https://claude.ai") {
      throw new Error(`unexpected request to ${url.href}`);
    }

    const override = overrides[url.pathname];

    if (override) {
      return override();
    }

    if (url.pathname === conversationPath(ORG_ID)) {
      return jsonResponse(data);
    }

    if (url.pathname.startsWith("/api/organizations/")) {
      return jsonResponse({ type: "error" }, 404);
    }

    if (url.pathname === "/api/organizations") {
      return jsonResponse([
        { uuid: API_ORG_ID, capabilities: ["api"] },
        { uuid: OTHER_ORG_ID, capabilities: ["chat"] },
        { uuid: ORG_ID, capabilities: ["chat", "claude_pro"] },
      ]);
    }

    if (url.pathname === `/api/${ORG_ID}/files/${FILE_ID}/preview`) {
      return new Response(PNG_BYTES, {
        headers: { "content-type": "image/png" },
      });
    }

    return jsonResponse({ type: "error" }, 404);
  });
}

function requestedPaths(): string[] {
  return fetchMock.mock.calls.map(([input]) => {
    const url = new URL(String(input));

    return url.pathname + url.search;
  });
}

function setLastActiveOrg(organizationId: string | null): void {
  document.cookie = organizationId
    ? `lastActiveOrg=${organizationId}; path=/`
    : "lastActiveOrg=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT";
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

describe("content.ts on claude.ai", () => {
  beforeEach(async () => {
    vi.resetModules();
    fetchMock.mockReset();
    getURL.mockClear();
    onMessageListeners.length = 0;

    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("chrome", {
      runtime: {
        getURL,
        sendMessage: vi.fn(),
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

    setLastActiveOrg(ORG_ID);

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

  it("loads the branch on screen from the lastActiveOrg organization in one request", async () => {
    serveClaudeApi();

    const response = await loadConversation(false);

    expect(requestedPaths()).toEqual([
      `${conversationPath(ORG_ID)}?tree=True&rendering_mode=messages&render_all_tools=true`,
    ]);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: "GET",
      credentials: "include",
    });

    expect(response).toEqual({
      success: true,
      data: {
        messages: [
          {
            id: "00000000-0000-4000-8000-000000000001",
            role: "user",
            content: "What's in this picture?",
            imagePaths: [],
            order: 0,
          },
          {
            id: "00000000-0000-4000-8000-000000000003",
            role: "assistant",
            content:
              "It's a recursion tree. Here's the code:\n\n" +
              "**Artifact: Fibonacci**\n\n```python\ndef fib(n):\n    return n\n```",
            imagePaths: [],
            order: 1,
            // Kept apart from the reply; exported only when asked for
            thinking: "Looks like a recursion tree.",
          },
          {
            id: "00000000-0000-4000-8000-000000000004",
            role: "user",
            content: "Thanks!",
            imagePaths: [],
            order: 2,
          },
        ],
        images: [],
      },
    });
  });

  it("tries the person's other chat organizations when the conversation isn't in lastActiveOrg", async () => {
    setLastActiveOrg(OTHER_ORG_ID);
    serveClaudeApi();

    const response = await loadConversation(false);

    expect(response.success).toBe(true);
    expect(requestedPaths().map((path) => path.split("?")[0])).toEqual([
      conversationPath(OTHER_ORG_ID),
      "/api/organizations",
      conversationPath(ORG_ID),
    ]);
  });

  it("looks the organization up when there's no lastActiveOrg cookie", async () => {
    setLastActiveOrg(null);
    serveClaudeApi();

    const response = await loadConversation(false);

    expect(response.success).toBe(true);
    expect(requestedPaths().map((path) => path.split("?")[0])).toEqual([
      "/api/organizations",
      conversationPath(OTHER_ORG_ID),
      conversationPath(ORG_ID),
    ]);
  });

  it("downloads uploaded images into the export when image bundling is on", async () => {
    serveClaudeApi();

    const response = await loadConversation(true);

    expect(response.success).toBe(true);
    expect(response.data.messages[0]).toMatchObject({
      role: "user",
      content: "![Image 1](images/image-001.png)\n\nWhat's in this picture?",
      imagePaths: ["images/image-001.png"],
    });
    expect(response.data.images).toEqual([
      {
        path: "images/image-001.png",
        mimeType: "image/png",
        base64: btoa(String.fromCharCode(...PNG_BYTES)),
        sizeBytes: PNG_BYTES.byteLength,
      },
    ]);

    const imageCall = fetchMock.mock.calls.find(([input]) =>
      String(input).endsWith("/preview"),
    );
    expect(imageCall?.[1]).toMatchObject({ credentials: "include" });
  });

  it("leaves images out when image bundling is off", async () => {
    serveClaudeApi();

    await loadConversation(false);

    expect(requestedPaths().some((path) => path.includes("/files/"))).toBe(
      false,
    );
  });

  it("never sends the session to an image URL outside claude.ai's API", async () => {
    serveClaudeApi({}, conversation("https://images.example.com/diagram.png"));

    const response = await loadConversation(true);

    expect(response.data.messages[0].content).toBe(
      "[Image attachment could not be downloaded]\n\nWhat's in this picture?",
    );
    expect(response.data.images).toEqual([]);
    expect(
      fetchMock.mock.calls.every(([input]) =>
        String(input).startsWith("https://claude.ai/api/"),
      ),
    ).toBe(true);
  });

  it("keeps the export going when an image download fails", async () => {
    serveClaudeApi({
      [`/api/${ORG_ID}/files/${FILE_ID}/preview`]: () =>
        new Response("gone", { status: 410 }),
    });

    const response = await loadConversation(true);

    expect(response.success).toBe(true);
    expect(response.data.messages[0].content).toBe(
      "[Image attachment could not be downloaded]\n\nWhat's in this picture?",
    );
  });

  it("reports a short, readable error when the person isn't signed in", async () => {
    serveClaudeApi({
      [conversationPath(ORG_ID)]: () => jsonResponse({ type: "error" }, 403),
      "/api/organizations": () => jsonResponse({ type: "error" }, 403),
    });

    const response = await loadConversation(false);

    expect(response).toEqual({
      success: false,
      error: "Claude API request failed: 403",
    });
  });

  it("reports an error instead of exporting an unexpected response", async () => {
    serveClaudeApi({
      [conversationPath(ORG_ID)]: () => jsonResponse({ detail: "changed" }),
    });

    const response = await loadConversation(false);

    expect(response).toEqual({
      success: false,
      error: "Claude returned an unexpected conversation format.",
    });
  });
});
