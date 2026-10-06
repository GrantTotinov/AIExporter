import { describe, expect, it } from "vitest";
import {
  conversationFileBase,
  filterConversations,
  filterRange,
  needsSaving,
  savedChats,
  uniqueName,
  withSavedChats,
} from "../src/bulk-export";
import {
  parseChatGptConversationList,
  parseChatGptTime,
  type ConversationSummary,
} from "../src/conversation-list";
import {
  buildClaudeConversationListPath,
  parseClaudeConversationList,
} from "../src/claude-conversation";
import {
  buildGeminiListRequest,
  parseGeminiConversationList,
} from "../src/gemini-conversation";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 9, 3, 12).getTime();

const chat = (
  id: string,
  title: string,
  daysAgo: number | null,
): ConversationSummary => ({
  id,
  title,
  url: `https://chatgpt.com/c/${id}`,
  createdAt: null,
  updatedAt: daysAgo === null ? null : NOW - daysAgo * DAY,
});

const CHATS = [
  chat("a", "Résumé tips for Ana", 1),
  chat("b", "Python script", 10),
  chat("c", "Рецепта за баница", 40),
  chat("d", "Old python notes", 400),
  chat("e", "Scraped from sidebar", null),
];

const ids = (list: ConversationSummary[]) => list.map((item) => item.id);

describe("filterConversations", () => {
  const all = { query: "", preset: "all" as const, from: "", to: "" };

  it("searches titles ignoring case and accents, every word", () => {
    expect(ids(filterConversations(CHATS, { ...all, query: "resume" }, NOW))).toEqual(["a"]);
    expect(ids(filterConversations(CHATS, { ...all, query: "PYTHON" }, NOW))).toEqual(["b", "d"]);
    expect(ids(filterConversations(CHATS, { ...all, query: "notes python" }, NOW))).toEqual(["d"]);
    expect(ids(filterConversations(CHATS, { ...all, query: "баница" }, NOW))).toEqual(["c"]);
  });

  it("filters by preset ranges and keeps undated chats", () => {
    expect(ids(filterConversations(CHATS, { ...all, preset: "7d" }, NOW))).toEqual(["a", "e"]);
    expect(ids(filterConversations(CHATS, { ...all, preset: "30d" }, NOW))).toEqual(["a", "b", "e"]);
    expect(ids(filterConversations(CHATS, { ...all, preset: "365d" }, NOW))).toEqual(["a", "b", "c", "e"]);
  });

  it("includes the whole 'to' day of a custom range", () => {
    const tenDaysAgo = new Date(NOW - 10 * DAY);
    const day = `${tenDaysAgo.getFullYear()}-${String(tenDaysAgo.getMonth() + 1).padStart(2, "0")}-${String(tenDaysAgo.getDate()).padStart(2, "0")}`;
    const filter = { ...all, preset: "custom" as const, from: day, to: day };

    expect(ids(filterConversations(CHATS, filter, NOW))).toEqual(["b", "e"]);
    expect(filterRange({ preset: "custom", from: "", to: "" }, NOW)).toEqual({
      start: null,
      end: null,
    });
  });
});

describe("chats saved before", () => {
  const all = { query: "", preset: "all" as const, from: "", to: "" };

  it("shows the chats not saved yet or used again since", () => {
    const saved = {
      a: NOW - 1 * DAY, // saved as it is now
      b: NOW - 20 * DAY, // used again after it was saved
      e: 0, // undated, saved once
    };

    expect(
      ids(filterConversations(CHATS, { ...all, preset: "unsaved", saved }, NOW)),
    ).toEqual(["b", "c", "d"]);
    expect(
      ids(filterConversations(CHATS, { ...all, preset: "unsaved", saved, query: "python" }, NOW)),
    ).toEqual(["b", "d"]);
    expect(ids(filterConversations(CHATS, { ...all, preset: "unsaved" }, NOW))).toEqual(
      ids(CHATS),
    );
  });

  it("tells a saved chat from one to save", () => {
    expect(needsSaving(chat("a", "x", 1), { a: NOW - DAY })).toBe(false);
    expect(needsSaving(chat("a", "x", 1), { a: NOW - 2 * DAY })).toBe(true);
    expect(needsSaving(chat("a", "x", 1), {})).toBe(true);
    expect(needsSaving(chat("e", "x", null), { e: 0 })).toBe(false);
  });

  it("keeps each site's saved chats apart in what's stored", () => {
    const stored = {
      claude: { old: 5 },
      chatgpt: { a: 1, broken: "yesterday" },
    };
    const updated = withSavedChats(stored, "chatgpt", [chat("b", "x", 10), chat("e", "x", null)]);

    expect(updated).toEqual({
      claude: { old: 5 },
      chatgpt: { a: 1, b: NOW - 10 * DAY, e: 0 },
    });
    expect(savedChats(updated, "claude")).toEqual({ old: 5 });
    expect(savedChats(updated, "gemini")).toEqual({});
    expect(savedChats("nonsense", "chatgpt")).toEqual({});
    expect(savedChats(updated, null)).toEqual({});
  });
});

describe("file names", () => {
  it("starts with the date and keeps letters of any script", () => {
    const base = conversationFileBase(chat("c", "Рецепта за баница!", 0));
    expect(base).toMatch(/^2026-10-03-рецепта-за-баница$/);
    expect(conversationFileBase(chat("x", "", null))).toBe("chat");
    expect(conversationFileBase(chat("x", "a".repeat(100), null))).toHaveLength(60);
  });

  it("numbers repeated names", () => {
    const used = new Set<string>();
    expect(uniqueName("new-chat", used)).toBe("new-chat");
    expect(uniqueName("New-Chat", used)).toBe("New-Chat-2");
    expect(uniqueName("new-chat", used)).toBe("new-chat-3");
  });

  it("numbers repeated names written with spaces in brackets", () => {
    const used = new Set<string>();
    expect(uniqueName("New chat", used)).toBe("New chat");
    expect(uniqueName("New chat", used)).toBe("New chat (2)");
  });

  it("follows the person's own pattern, dated by the chat's last use", () => {
    const tenDaysAgo = new Date(NOW - 10 * DAY);
    const day = `${tenDaysAgo.getFullYear()}-${String(tenDaysAgo.getMonth() + 1).padStart(2, "0")}-${String(tenDaysAgo.getDate()).padStart(2, "0")}`;

    expect(
      conversationFileBase(chat("b", "Python: script", 10), "{date} {title}", "chatgpt"),
    ).toBe(`${day} Python - script`);
    expect(
      conversationFileBase(chat("b", "Python script", 10), "{site} - {title}", "claude"),
    ).toBe("Claude - Python script");
  });
});

describe("conversation lists", () => {
  it("reads ChatGPT's list with either time format", () => {
    expect(parseChatGptTime(1727000000.5)).toBe(1727000000500);
    expect(parseChatGptTime("2024-09-22T10:13:20Z")).toBe(Date.UTC(2024, 8, 22, 10, 13, 20));
    expect(
      parseChatGptConversationList({
        items: [
          { id: "1", title: " Hi ", create_time: 1700000000, update_time: "2024-01-01T00:00:00Z" },
          { id: "", title: "skipped" },
          { id: "2", title: null, create_time: 1700000000 },
        ],
        total: 2,
      }),
    ).toEqual({
      conversations: [
        { id: "1", title: "Hi", createdAt: 1700000000000, updatedAt: Date.UTC(2024, 0, 1) },
        { id: "2", title: "", createdAt: 1700000000000, updatedAt: 1700000000000 },
      ],
      total: 2,
    });
    expect(() => parseChatGptConversationList({ detail: "nope" })).toThrow();
  });

  it("reads Claude's list", () => {
    const uuid = "0f8fad5b-d9cb-469f-a165-70867728950e";

    expect(buildClaudeConversationListPath("org", 100, 200)).toBe(
      "/api/organizations/org/chat_conversations?limit=100&offset=200",
    );
    expect(
      parseClaudeConversationList([
        { uuid, name: "Plan", created_at: "2024-01-01T00:00:00Z", updated_at: "2024-02-01T00:00:00Z" },
        { uuid: "not-a-uuid", name: "skip" },
      ]),
    ).toEqual([
      { id: uuid, title: "Plan", createdAt: Date.UTC(2024, 0, 1), updatedAt: Date.UTC(2024, 1, 1) },
    ]);
    expect(parseClaudeConversationList({ data: [] })).toEqual([]);
  });

  it("builds and reads Gemini's MaZiqc list", () => {
    const request = buildGeminiListRequest({
      tokens: { at: "tok", buildLabel: null, sessionId: null, language: null },
      accountPrefix: "/u/1",
      sourcePath: "/u/1/app",
      requestId: 12345,
      pinned: false,
      pageSize: 50,
      cursor: null,
    });

    expect(request.path).toMatch(/^\/u\/1\/_\/BardChatUi\/data\/batchexecute\?rpcids=MaZiqc&/);
    expect(new URLSearchParams(request.body).get("f.req")).toBe(
      JSON.stringify([[["MaZiqc", "[50,null,[0,null,1]]", null, "generic"]]]),
    );

    const result = JSON.stringify([
      null,
      "next-page",
      [
        ["c_abc123", "Trip plan", null, null, null, [1727000000, 500000000]],
        ["c_def456", "No date"],
        [null, "skipped"],
      ],
    ]);
    const response = `)]}'\n\n123\n${JSON.stringify([["wrb.fr", "MaZiqc", result, null, null, null, "generic"]])}\n`;

    expect(parseGeminiConversationList(response)).toEqual({
      conversations: [
        { id: "abc123", title: "Trip plan", updatedAt: 1727000000500 },
        { id: "def456", title: "No date", updatedAt: null },
      ],
      nextCursor: "next-page",
    });
  });
});
