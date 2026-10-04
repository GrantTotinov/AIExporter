import { describe, expect, it } from "vitest";
import {
  buildDeepSeekHistoryPath,
  buildDeepSeekListPath,
  convertDeepSeekConversation,
  deepSeekHeaders,
  getDeepSeekConversationId,
  parseDeepSeekSessionList,
  readDeepSeekToken,
  unwrapDeepSeekResponse,
} from "../src/deepseek-conversation";
import { NOTE_CLOSE, NOTE_OPEN } from "../src/source-notes";

/*
 * The fixtures follow the shape chat.deepseek.com's web app gets
 * from /api/v0/chat/history_messages, as open-source exporters
 * read it; DeepSeek doesn't document its API.
 */

const note = (numbers: string): string => `${NOTE_OPEN}${numbers}${NOTE_CLOSE}`;

const RICE_GUIDE = { title: "Rice guide", url: "https://example.com/rice" };
const WATER_RATIO = { title: "Water ratio", url: "https://example.org/water" };

/* A question answered twice: a first reply, then a regenerated one with DeepThink and search */
function conversation(currentMessageId: unknown = 4) {
  return {
    chat_session: { id: "abc123", title: "Rice", current_message_id: currentMessageId },
    chat_messages: [
      {
        message_id: 1,
        parent_id: null,
        role: "USER",
        inserted_at: 1759400000,
        fragments: [{ type: "REQUEST", content: "How do I cook rice?" }],
      },
      {
        message_id: 2,
        parent_id: 1,
        role: "ASSISTANT",
        inserted_at: 1759400010,
        fragments: [{ type: "RESPONSE", content: "A first answer." }],
      },
      {
        message_id: 3,
        parent_id: 1,
        role: "ASSISTANT",
        inserted_at: 1759400020,
        fragments: [
          { type: "THINK", content: "\nThe person wants plain rice.\n" },
          {
            type: "SEARCH",
            results: [
              { ...RICE_GUIDE, cite_index: 1, snippet: "Rinse first" },
              { ...WATER_RATIO, cite_index: 2 },
            ],
          },
          {
            type: "RESPONSE",
            content:
              "Rinse it first [citation:1]. Use two cups of water [citation:2][citation:1].",
          },
        ],
      },
      {
        message_id: 4,
        parent_id: 3,
        role: "USER",
        inserted_at: 1759400030,
        fragments: [{ type: "REQUEST", content: "Thanks!" }],
      },
    ],
  };
}

describe("getDeepSeekConversationId", () => {
  it("reads the id from a conversation's address", () => {
    expect(
      getDeepSeekConversationId("/a/chat/s/7f3e2b1a-0c4d-4e5f-8a9b-1c2d3e4f5a6b"),
    ).toBe("7f3e2b1a-0c4d-4e5f-8a9b-1c2d3e4f5a6b");
    expect(getDeepSeekConversationId("/a/chat/s/abc_DEF-123/")).toBe(
      "abc_DEF-123",
    );
  });

  it("returns null on the other pages", () => {
    expect(getDeepSeekConversationId("/")).toBeNull();
    expect(getDeepSeekConversationId("/a/chat/s/")).toBeNull();
    expect(getDeepSeekConversationId("/a/chat/s/a.b")).toBeNull();
    expect(getDeepSeekConversationId("/sign_in")).toBeNull();
  });
});

describe("readDeepSeekToken", () => {
  it("reads the token however the web app stored it", () => {
    expect(readDeepSeekToken("tok-123")).toBe("tok-123");
    expect(readDeepSeekToken('"tok-123"')).toBe("tok-123");
    expect(readDeepSeekToken('{"value":"tok-123","__version":"0"}')).toBe(
      "tok-123",
    );
    expect(readDeepSeekToken('{"value":{"token":"tok-123"}}')).toBe("tok-123");
  });

  it("finds none when the person is signed out", () => {
    expect(readDeepSeekToken(null)).toBeNull();
    expect(readDeepSeekToken("")).toBeNull();
    expect(readDeepSeekToken("{}")).toBeNull();
    expect(readDeepSeekToken('{"value":""}')).toBeNull();
  });
});

describe("DeepSeek requests", () => {
  it("sends the headers the web app sends", () => {
    expect(deepSeekHeaders("tok-123", "en-US", -120)).toEqual({
      Accept: "application/json",
      Authorization: "Bearer tok-123",
      "x-client-bundle-id": "com.deepseek.chat",
      "x-client-platform": "web",
      "x-client-version": "2.3.0",
      "x-client-locale": "en_US",
      "x-client-timezone-offset": "7200",
    });
  });

  it("asks for a conversation's messages", () => {
    expect(buildDeepSeekHistoryPath("abc123")).toBe(
      "/api/v0/chat/history_messages?chat_session_id=abc123",
    );
  });

  it("pages through the chat list from the last chat it got", () => {
    expect(buildDeepSeekListPath(50, null)).toBe(
      "/api/v0/chat_session/fetch_page?count=50",
    );
    expect(buildDeepSeekListPath(50, { pinned: 0, updatedAt: 1759500000.25 })).toBe(
      "/api/v0/chat_session/fetch_page?count=50&lte_cursor.pinned=0&lte_cursor.updated_at=1759500000.25",
    );
  });
});

describe("unwrapDeepSeekResponse", () => {
  it("returns the answer's biz_data", () => {
    expect(
      unwrapDeepSeekResponse({
        code: 0,
        msg: "",
        data: { biz_code: 0, biz_msg: "", biz_data: { chat_messages: [] } },
      }),
    ).toEqual({ chat_messages: [] });
  });

  it("reports DeepSeek's own message when it refuses", () => {
    expect(() =>
      unwrapDeepSeekResponse({
        code: 40003,
        msg: "Authorization Failed (invalid token)",
        data: null,
      }),
    ).toThrow("Authorization Failed (invalid token)");
    expect(() =>
      unwrapDeepSeekResponse({
        code: 0,
        data: { biz_code: 4, biz_msg: "Chat session not found", biz_data: null },
      }),
    ).toThrow("Chat session not found");
  });

  it("rejects an answer it can't read", () => {
    expect(() => unwrapDeepSeekResponse("<html>")).toThrow(
      "DeepSeek returned an unexpected conversation format.",
    );
  });
});

describe("parseDeepSeekSessionList", () => {
  it("lists the chats and where the next page starts", () => {
    const page = parseDeepSeekSessionList({
      chat_sessions: [
        {
          id: "s1",
          title: " Trip ideas ",
          pinned: true,
          updated_at: 1759500000.123,
          inserted_at: 1759400000,
        },
        {
          id: "s2",
          title: "Rice",
          pinned: false,
          updated_at: 1759300000,
          inserted_at: 1759200000,
        },
        { title: "No id" },
      ],
      has_more: true,
    });

    expect(page.conversations).toEqual([
      {
        id: "s1",
        title: "Trip ideas",
        createdAt: 1759400000000,
        updatedAt: 1759500000123,
      },
      {
        id: "s2",
        title: "Rice",
        createdAt: 1759200000000,
        updatedAt: 1759300000000,
      },
    ]);
    expect(page.nextCursor).toEqual({ pinned: 0, updatedAt: 1759300000 });
  });

  it("stops after the last page", () => {
    expect(
      parseDeepSeekSessionList({
        chat_sessions: [{ id: "s1", title: "Rice", updated_at: 1759300000 }],
        has_more: false,
      }).nextCursor,
    ).toBeNull();
  });

  it("rejects a list it can't read", () => {
    expect(() => parseDeepSeekSessionList({})).toThrow(
      "DeepSeek returned an unexpected chat list format.",
    );
  });
});

describe("convertDeepSeekConversation", () => {
  it("follows the branch on screen, with DeepThink and the cited pages", () => {
    expect(convertDeepSeekConversation(conversation())).toEqual([
      {
        id: "1",
        role: "user",
        parts: [{ kind: "text", text: "How do I cook rice?" }],
      },
      {
        id: "3",
        role: "assistant",
        parts: [
          {
            kind: "text",
            text: `Rinse it first${note("1")}. Use two cups of water${note("2,1")}.`,
          },
        ],
        thinking: "The person wants plain rice.",
        sources: [RICE_GUIDE, WATER_RATIO],
      },
      { id: "4", role: "user", parts: [{ kind: "text", text: "Thanks!" }] },
    ]);
  });

  it("follows the other branch when it's the one on screen", () => {
    expect(
      convertDeepSeekConversation(conversation(2)).map((message) => message.parts),
    ).toEqual([
      [{ kind: "text", text: "How do I cook rice?" }],
      [{ kind: "text", text: "A first answer." }],
    ]);
  });

  it("ends with the newest message when the current one is unknown", () => {
    expect(
      convertDeepSeekConversation(conversation(null)).map((message) => message.id),
    ).toEqual(["1", "3", "4"]);
  });

  it("reads older messages, whose search results are cited by their place", () => {
    const messages = convertDeepSeekConversation({
      chat_session: { current_message_id: 2 },
      chat_messages: [
        { message_id: 1, parent_id: null, role: "USER", content: "Weather?" },
        {
          message_id: 2,
          parent_id: 1,
          role: "ASSISTANT",
          content: "Sunny [citation:2], warm [citation:1] and [citation:7] dry.",
          thinking_content: "Check the forecast.",
          search_results: [
            { url: "https://weather.example/today", title: "Today" },
            { url: "https://weather.example/week", title: "This week" },
          ],
        },
      ],
    });

    expect(messages[1]).toEqual({
      id: "2",
      role: "assistant",
      parts: [{ kind: "text", text: `Sunny${note("1")}, warm${note("2")} and dry.` }],
      thinking: "Check the forecast.",
      sources: [
        { title: "This week", url: "https://weather.example/week" },
        { title: "Today", url: "https://weather.example/today" },
      ],
    });
  });

  it("puts uploaded pictures before the question and lists other files by name", () => {
    const [question] = convertDeepSeekConversation({
      chat_session: { current_message_id: 1 },
      chat_messages: [
        {
          message_id: 1,
          parent_id: null,
          role: "USER",
          files: [
            { file_name: "pot.png", signed_path: "/file?id=f1" },
            { file_name: "recipe.pdf", signed_path: "/file?id=f2" },
          ],
          fragments: [{ type: "REQUEST", content: "What's this?" }],
        },
      ],
    });

    expect(question.parts).toEqual([
      {
        kind: "image",
        image: {
          url: "https://files.deepseeksvc.com/api/file?id=f1&ty=p",
          fileName: "pot.png",
        },
      },
      { kind: "text", text: "[Attachment: recipe.pdf]" },
      { kind: "text", text: "What's this?" },
    ]);
  });

  it("leaves out a citation of a page it wasn't given, and a source that isn't a web page", () => {
    const [, reply] = convertDeepSeekConversation({
      chat_session: { current_message_id: 2 },
      chat_messages: [
        { message_id: 1, parent_id: null, role: "USER", content: "Hi" },
        {
          message_id: 2,
          parent_id: 1,
          role: "ASSISTANT",
          fragments: [
            {
              type: "SEARCH",
              results: [{ url: "javascript:alert(1)", cite_index: 1 }],
            },
            { type: "RESPONSE", content: "Hello [citation:1] there [citation:5]." },
          ],
        },
      ],
    });

    expect(reply).toEqual({
      id: "2",
      role: "assistant",
      parts: [{ kind: "text", text: "Hello there." }],
    });
  });

  it("rejects a conversation it can't read", () => {
    expect(() => convertDeepSeekConversation({ chat_session: {} })).toThrow(
      "DeepSeek returned an unexpected conversation format.",
    );
  });
});
