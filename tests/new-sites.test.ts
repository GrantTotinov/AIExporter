import { describe, expect, it } from "vitest";
import { NOTE_CLOSE, NOTE_OPEN } from "../src/source-notes";
import {
  convertKimiMessages,
  getKimiConversationId,
  parseKimiConversationList,
  parseKimiMessagesPage,
  readKimiToken,
} from "../src/kimi-conversation";
import {
  convertDoubaoMessages,
  doubaoQuery,
  getDoubaoConversationId,
  parseDoubaoConversationList,
  parseDoubaoMessagesPage,
} from "../src/doubao-conversation";
import {
  convertQwenChat,
  convertZaiChat,
  getQwenConversationId,
  parseQwenConversationList,
  parseZaiConversationList,
  zaiMessageIds,
} from "../src/qwen-conversation";
import {
  convertQianwenTurns,
  parseQianwenConversationList,
  parseQianwenTurnsPage,
  qianwenUrl,
  qianwenVersion,
  unwrapQianwen,
} from "../src/qianwen-conversation";
import {
  convertYuanbaoConversation,
  getYuanbaoAgentId,
  getYuanbaoConversation,
  parseYuanbaoConversationList,
  parseYuanbaoDetailPage,
  unwrapYuanbao,
} from "../src/yuanbao-conversation";
import {
  convertCopilotHistory,
  getCopilotConversationId,
  parseCopilotConversationList,
  readCopilotToken,
} from "../src/copilot-conversation";
import type { SiteMessage } from "../src/site-json";

const note = (...numbers: number[]) => `${NOTE_OPEN}${numbers.join(",")}${NOTE_CLOSE}`;

/* Each message as [role, text, thinking?] */
function summary(messages: SiteMessage[]): (string | undefined)[][] {
  return messages.map((message) => [
    message.role,
    message.parts.map((part) => (part.kind === "text" ? part.text : "[image]")).join("\n"),
    ...(message.thinking ? [message.thinking] : []),
  ]);
}

describe("Kimi", () => {
  it("reads the conversation id and the token", () => {
    expect(getKimiConversationId("/chat/d1k2a3b4c5e6f7g8h9i0")).toBe("d1k2a3b4c5e6f7g8h9i0");
    expect(getKimiConversationId("/chat/history")).toBeNull();
    expect(getKimiConversationId("/")).toBeNull();
    expect(readKimiToken('"eyJ.token"')).toBe("eyJ.token");
    expect(readKimiToken("eyJ.plain")).toBe("eyJ.plain");
    expect(readKimiToken(null)).toBeNull();
  });

  it("puts a question before its answer, microseconds apart, and numbers the citations", () => {
    const marker = "citeturn0search1";
    const messages = convertKimiMessages(
      parseKimiMessagesPage({
        messages: [
          {
            id: "a1",
            role: "assistant",
            createTime: "2026-08-01T15:48:56.072400Z",
            blocks: [
              { think: { content: "Rice needs water." } },
              { text: { content: `Rinse it first${marker}.` } },
            ],
            references: [
              {
                matchedText: marker,
                items: [{ search: { base: { title: "Rice guide", url: "https://rice.example/" } } }],
              },
            ],
          },
          {
            id: "u1",
            role: "user",
            createTime: "2026-08-01T15:48:56.072365Z",
            blocks: [{ text: { content: "How do I cook rice?" } }],
          },
          { id: "s1", role: "system", blocks: [{ text: { content: "You are Kimi" } }] },
        ],
        nextPageToken: "",
      }).messages,
    );

    expect(summary(messages)).toEqual([
      ["user", "How do I cook rice?"],
      ["assistant", `Rinse it first${note(1)}.`, "Rice needs water."],
    ]);
    expect(messages[1].sources).toEqual([{ title: "Rice guide", url: "https://rice.example/" }]);
    expect(messages[0].time).toBe(Date.UTC(2026, 7, 1, 15, 48, 56, 72));
  });

  it("lists the chats and pages on", () => {
    expect(
      parseKimiConversationList({
        items: [{ chat: { id: "c1", name: " Rice ", createTime: "2026-08-01T10:00:00Z" } }, { other: 1 }],
        nextPageToken: "next",
      }),
    ).toEqual({
      conversations: [
        { id: "c1", title: "Rice", createdAt: Date.UTC(2026, 7, 1, 10), updatedAt: Date.UTC(2026, 7, 1, 10) },
      ],
      nextCursor: "next",
    });
    expect(() => parseKimiMessagesPage({ error: "unauthenticated" })).toThrow(/Kimi/);
  });
});

describe("Doubao", () => {
  it("reads the conversation id", () => {
    expect(getDoubaoConversationId("/chat/7356014282391")).toBe("7356014282391");
    expect(getDoubaoConversationId("/chat/")).toBeNull();
    expect(getDoubaoConversationId("/chat/local_123")).toBeNull();
  });

  it("sends the query the web app's own requests carry", () => {
    expect(
      doubaoQuery(
        [
          "https://www.doubao.com/static/app.js",
          "https://www.doubao.com/im/chain/recent_conv?aid=497858&device_id=9&version_code=20800",
        ],
        null,
        null,
        "zh-CN",
      ),
    ).toBe("?aid=497858&device_id=9&version_code=20800");

    const fallback = new URLSearchParams(doubaoQuery([], "dev-1", "web-2", "zh-CN"));

    expect(fallback.get("aid")).toBe("497858");
    expect(fallback.get("device_id")).toBe("dev-1");
    expect(fallback.get("web_id")).toBe("web-2");
    expect(fallback.get("language")).toBe("zh");
  });

  it("reads a page of messages, newest first, and where the older ones start", () => {
    const page = parseDoubaoMessagesPage({
      status_code: 0,
      downlink_body: {
        pull_singe_chain_downlink_body: {
          has_more: true,
          messages: [{ message_id: "m3", index_in_conv: 3 }, { message_id: "m2", index_in_conv: 2 }],
        },
      },
    });

    expect(page.hasMore).toBe(true);
    expect(page.nextAnchor).toBe(1);
    expect(() =>
      parseDoubaoMessagesPage({ status_code: 710012001, status_desc: "not login" }),
    ).toThrow("not login");
  });

  it("keeps a reply's thinking apart from its answer, with its search results as sources", () => {
    const messages = convertDoubaoMessages([
      {
        message_id: "m2",
        index_in_conv: 2,
        user_type: 2,
        create_time: 1790000000,
        content_block: [
          { block_type: 10040, content: { thinking_block: {} } },
          { content: { text_block: { text: "The user asks about rice." } } },
          {
            content: {
              search_query_result_block: {
                results: [{ text_card: { title: "Rice", url: "https://rice.example/" } }],
              },
            },
          },
          { content: { text_block: { text: "Rinse it, then simmer." } } },
        ],
      },
      {
        message_id: "m1",
        index_in_conv: 1,
        user_type: 1,
        content_block: [{ content: { text_block: { text: "怎么煮米饭？" } } }],
      },
      { message_id: "m0", index_in_conv: 0, user_type: 3, content: "{\"text\":\"system\"}" },
    ]);

    expect(summary(messages)).toEqual([
      ["user", "怎么煮米饭？"],
      ["assistant", "Rinse it, then simmer.", "The user asks about rice."],
    ]);
    expect(messages[1].sources).toEqual([{ title: "Rice", url: "https://rice.example/" }]);
    expect(messages[1].time).toBe(1790000000000);
  });

  it("lists the chats by conv_version", () => {
    expect(
      parseDoubaoConversationList({
        status_code: 0,
        downlink_body: {
          pull_recent_conv_chain_downlink_body: {
            has_more: true,
            next_conv_version: 1790000000123,
            cells: [{ conversation: { conversation_id: "7356", name: "米饭", update_time: 1790000000 } }],
          },
        },
      }),
    ).toEqual({
      conversations: [{ id: "7356", title: "米饭", createdAt: null, updatedAt: 1790000000000 }],
      nextCursor: "1790000000123",
    });
  });
});

describe("Qwen Chat", () => {
  it("follows the branch on screen and reads the reply's phases", () => {
    const messages = convertQwenChat({
      success: true,
      data: {
        chat: {
          history: {
            currentId: "a2",
            messages: {
              u1: { role: "user", content: "Hi", parentId: null, timestamp: 1790000000 },
              a1: { role: "assistant", content: "Old answer", parentId: "u1" },
              a2: {
                role: "assistant",
                parentId: "u1",
                modelName: "qwen3-max",
                content_list: [
                  { phase: "think", content: "Greet back." },
                  { phase: "web_search", content: "ignored" },
                  { phase: "answer", content: "Hello!" },
                ],
              },
            },
          },
        },
      },
    });

    expect(summary(messages)).toEqual([
      ["user", "Hi"],
      ["assistant", "Hello!", "Greet back."],
    ]);
    expect(messages[1].model).toBe("qwen3-max");
    expect(messages[0].time).toBe(1790000000000);
  });

  it("reads chat.messages when there's no tree, and pages the list by number", () => {
    expect(
      summary(
        convertQwenChat({
          data: { chat: { messages: [{ id: "u", role: "user", content: "Hi" }, { id: "a", role: "assistant", content: "Yo" }] } },
        }),
      ),
    ).toEqual([
      ["user", "Hi"],
      ["assistant", "Yo"],
    ]);
    expect(getQwenConversationId("/c/0b2f7a52-1c3d-4e5f-8a9b-0c1d2e3f4a5b")).toBe(
      "0b2f7a52-1c3d-4e5f-8a9b-0c1d2e3f4a5b",
    );
    expect(parseQwenConversationList({ data: [{ id: "c1", title: "Rice" }] }, "2").nextCursor).toBe("3");
    expect(parseQwenConversationList({ data: [] }, null).nextCursor).toBeNull();
    expect(() => convertQwenChat({ success: false, data: null })).toThrow(/Qwen/);
  });
});

describe("Z.ai", () => {
  const tree = {
    chat: {
      models: ["glm-4.6"],
      history: {
        currentId: "a1",
        messages: { u1: { role: "user", parentId: null }, a1: { role: "assistant", parentId: "u1" } },
      },
    },
  };

  it("asks for the contents of the branch on screen", () => {
    expect(zaiMessageIds(tree)).toEqual(["u1", "a1"]);
  });

  it("reads the contents, with reasoning and cited search results", () => {
    const messages = convertZaiChat(tree, {
      data: {
        u1: { role: "user", content: "Rice?" },
        a1: {
          role: "assistant",
          content_blocks: [
            { type: "reasoning", content: "Look it up." },
            {
              type: "tool_calls",
              results: [{ content: "[ref_id=turn0search1†Rice guide†https://rice.example/]" }],
            },
            { type: "text", content: "Rinse it【turn0search1】." },
          ],
        },
      },
    });

    expect(summary(messages)).toEqual([
      ["user", "Rice?"],
      ["assistant", `Rinse it${note(1)}.`, "Look it up."],
    ]);
    expect(messages[1].model).toBe("glm-4.6");
    expect(parseZaiConversationList([{ id: "c1", title: "Rice" }], null).nextCursor).toBe("2");
  });
});

describe("Qianwen", () => {
  const client = { deviceId: "dev", version: "4.1.0", language: "zh-CN", timeZone: "Asia/Shanghai", xsrfToken: "x" };

  it("addresses the API host with the web app's parameters", () => {
    const url = new URL(qianwenUrl(client, "/api/v1/session/msg/list", { session_id: "s1" }));

    expect(url.origin).toBe("https://chat2-api.qianwen.com");
    expect(url.searchParams.get("ut")).toBe("dev");
    expect(url.searchParams.get("wv")).toBe("4.1.0");
    expect(url.searchParams.get("session_id")).toBe("s1");
    expect(qianwenVersion(["https://g.alicdn.com/qianwen-web/4.2.3/app.js"])).toBe("4.2.3");
  });

  it("reports the API's errors", () => {
    expect(() => unwrapQianwen({ success: false, msg: "未登录" })).toThrow("未登录");
    expect(unwrapQianwen({ success: true, code: 0, data: { list: [] } })).toEqual({ list: [] });
  });

  it("turns each turn into a question and its answer, with the cited sources", () => {
    const page = parseQianwenTurnsPage({
      list: [
        {
          req_id: "r2",
          request_timestamp: 1790000100000,
          request_messages: [{ content: "第二个问题" }],
          qwen_response_messages: [{ role: "assistant", contentType: "text", content: "第二个回答" }],
        },
        {
          req_id: "r1",
          request_timestamp: 1790000000000,
          model_name: "qwen3-max",
          request_messages: [{ content: "怎么煮饭？" }],
          response_messages: [
            {
              content: "先洗米[[source_group_web_1]]。[(deep_think)]",
              meta_data: {
                multi_load: [
                  { type: "deep_think", content: { think_content: "想一想" } },
                  { source_seq: "source_group_web_1", sources: [{ title: "煮饭", url: "https://rice.example/" }] },
                ],
              },
            },
          ],
        },
      ],
      next_page_pos: "p2",
      has_next_page: false,
    });

    expect(page.nextPos).toBeNull();

    const messages = convertQianwenTurns(page.turns);

    expect(summary(messages)).toEqual([
      ["user", "怎么煮饭？"],
      ["assistant", `先洗米${note(1)}。`, "想一想"],
      ["user", "第二个问题"],
      ["assistant", "第二个回答"],
    ]);
    expect(messages[1].model).toBe("qwen3-max");
    expect(
      parseQianwenConversationList({
        list: [{ session_id: "s1", title: "饭" }],
        next_token: "t2",
        have_next_page: true,
      }).nextCursor,
    ).toBe("t2");
  });
});

describe("Yuanbao", () => {
  it("reads the agent and the conversation from the address", () => {
    expect(getYuanbaoConversation("/chat/naQivTmsDa/3f2a1b0c-aaaa-bbbb-cccc-0123456789ab")).toEqual({
      agentId: "naQivTmsDa",
      conversationId: "3f2a1b0c-aaaa-bbbb-cccc-0123456789ab",
    });
    expect(getYuanbaoConversation("/chat/naQivTmsDa")).toBeNull();
    expect(getYuanbaoAgentId("/chat/abc")).toBe("abc");
    expect(getYuanbaoAgentId("/")).toBe("naQivTmsDa");
  });

  it("reads speeches, deep search thoughts and [citation:N] notes", () => {
    const page = parseYuanbaoDetailPage(
      unwrapYuanbao({
        code: 0,
        hasMore: false,
        convs: [
          {
            id: "c2",
            index: 2,
            speaker: "ai",
            createTime: 1790000000,
            speechesV2: [
              {
                chatModelId: "hunyuan-t1",
                content: [
                  { type: "deepSearch", contents: [{ type: "text", msg: "查资料" }] },
                  { type: "searchGuid", docs: [{ index: 1, title: "煮饭", url: "https://rice.example/" }] },
                  { type: "text", msg: "先洗米[citation:1]。" },
                ],
              },
            ],
          },
          { id: "c1", index: 1, speaker: "human", speechesV2: [{ content: [{ type: "text", msg: "怎么煮饭？" }] }] },
        ],
      }),
      0,
    );

    expect(page.nextOffset).toBeNull();

    const messages = convertYuanbaoConversation(page.convs);

    expect(summary(messages)).toEqual([
      ["user", "怎么煮饭？"],
      ["assistant", `先洗米${note(1)}。`, "查资料"],
    ]);
    expect(messages[1].model).toBe("hunyuan-t1");
    expect(() => unwrapYuanbao({ code: 401, msg: "请登录" })).toThrow("请登录");
  });

  it("pages the list by offset until the total", () => {
    expect(
      parseYuanbaoConversationList(
        { conversations: [{ id: "c1", title: "饭" }], pagination: { totalResults: 40 } },
        "39",
      ).nextCursor,
    ).toBeNull();
    expect(
      parseYuanbaoConversationList(
        { conversations: [{ id: "c1", title: "饭" }], pagination: { totalResults: 99 } },
        null,
      ).nextCursor,
    ).toBe("1");
  });
});

describe("Microsoft Copilot", () => {
  it("uses the chat API's token from MSAL's cache", () => {
    expect(
      readCopilotToken([
        ["msal.token.keys", "[]"],
        ["abc-login.windows.net-accesstoken-other", JSON.stringify({ secret: "other", target: "user.read" })],
        ["abc-login.windows.net-accesstoken-chat", JSON.stringify({ secret: "chat", target: "ChatAI.ReadWrite" })],
      ]),
    ).toBe("chat");
    expect(readCopilotToken([["x-accesstoken-y", "not json"]])).toBeNull();
  });

  it("reads the history oldest first", () => {
    const messages = convertCopilotHistory({
      results: [
        { id: "2", author: { type: "ai" }, content: [{ type: "text", text: "Hello" }, { type: "image" }] },
        { id: "1", author: { type: "human" }, createdAt: "2026-10-01T10:00:00Z", content: [{ type: "text", text: "Hi" }] },
      ],
    });

    expect(summary(messages)).toEqual([
      ["user", "Hi"],
      ["assistant", "Hello"],
    ]);
    expect(messages[0].time).toBe(Date.UTC(2026, 9, 1, 10));
    expect(getCopilotConversationId("/chats/AbCdEf123456")).toBe("AbCdEf123456");
    expect(
      parseCopilotConversationList({ results: [{ id: "AbCdEf123456", title: "Hi" }], next: "n2" }).nextCursor,
    ).toBe("n2");
    expect(() => convertCopilotHistory({})).toThrow(/Copilot/);
  });
});
