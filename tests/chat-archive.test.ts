import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  parseConversationsJson,
  readConversationsJson,
  readZipDirectory,
  searchConversations,
} from "../src/chat-archive";
import { createZipBlob } from "../src/zip";

const CHATGPT_EXPORT = [
  {
    title: "Rice",
    create_time: 1790000000,
    update_time: 1790000100,
    conversation_id: "c-rice",
    current_node: "a2",
    mapping: {
      root: { message: null, parent: null, children: ["sys"] },
      sys: {
        parent: "root",
        message: {
          id: "sys",
          author: { role: "system" },
          content: { content_type: "text", parts: ["You are ChatGPT"] },
          metadata: { is_visually_hidden_from_conversation: true },
        },
      },
      u1: {
        parent: "sys",
        message: {
          id: "u1",
          author: { role: "user" },
          create_time: 1790000000,
          content: { content_type: "text", parts: ["How do I cook rice?"] },
          metadata: {},
        },
      },
      old: {
        parent: "u1",
        message: {
          id: "old",
          author: { role: "assistant" },
          content: { content_type: "text", parts: ["An answer from another branch"] },
          metadata: {},
        },
      },
      t1: {
        parent: "u1",
        message: {
          id: "t1",
          author: { role: "assistant" },
          content: { content_type: "thoughts", thoughts: [{ content: "Think about water." }] },
          metadata: {},
        },
      },
      a1: {
        parent: "t1",
        message: {
          id: "a1",
          author: { role: "assistant" },
          create_time: 1790000050,
          content: {
            content_type: "text",
            parts: ["Rinse itciteturn0search1 first."],
          },
          metadata: { model_slug: "gpt-4o" },
        },
      },
      a2: {
        parent: "a1",
        message: {
          id: "a2",
          author: { role: "assistant" },
          content: { content_type: "code", language: "python", text: "print('rice')" },
          metadata: {},
        },
      },
    },
  },
];

const CLAUDE_EXPORT = [
  {
    uuid: "11111111-2222-3333-4444-555555555555",
    name: "Bread",
    created_at: "2026-09-01T10:00:00Z",
    updated_at: "2026-09-02T10:00:00Z",
    chat_messages: [
      {
        uuid: "m1",
        sender: "human",
        text: "How do I bake bread?",
        content: [{ type: "text", text: "How do I bake bread?" }],
        created_at: "2026-09-01T10:00:00Z",
      },
      {
        uuid: "m2",
        sender: "assistant",
        text: "",
        content: [
          { type: "thinking", thinking: "Flour, water, salt, yeast." },
          { type: "text", text: "Knead the **dough**." },
        ],
        created_at: "2026-09-01T10:00:05Z",
      },
    ],
  },
];

describe("a ChatGPT data export", () => {
  it("gives the branch on screen, its thinking, code and model - newest chat first", () => {
    const [chat] = parseConversationsJson(JSON.stringify(CHATGPT_EXPORT));

    expect(chat).toMatchObject({
      id: "c-rice",
      title: "Rice",
      url: "https://chatgpt.com/c/c-rice",
      source: "chatgpt",
      createdAt: 1790000000000,
      updatedAt: 1790000100000,
    });
    expect(chat.messages).toEqual([
      { id: "u1", role: "user", order: 0, content: "How do I cook rice?", time: 1790000000000 },
      {
        id: "a1",
        role: "assistant",
        order: 1,
        content: "Rinse it first.\n\n```python\nprint('rice')\n```",
        time: 1790000050000,
        model: "gpt-4o",
        thinking: "Think about water.",
      },
    ]);
  });
});

describe("a Claude data export", () => {
  it("gives its messages, with the thinking apart", () => {
    const [chat] = parseConversationsJson(JSON.stringify(CLAUDE_EXPORT));

    expect(chat).toMatchObject({
      title: "Bread",
      url: "https://claude.ai/chat/11111111-2222-3333-4444-555555555555",
      source: "claude",
    });
    expect(chat.messages.map((message) => [message.role, message.content, message.thinking])).toEqual([
      ["user", "How do I bake bread?", undefined],
      ["assistant", "Knead the **dough**.", "Flour, water, salt, yeast."],
    ]);
  });

  it("is searched word by word, in titles and messages", () => {
    const chats = parseConversationsJson(JSON.stringify([...CHATGPT_EXPORT, ...CLAUDE_EXPORT]));

    expect(chats.map((chat) => chat.title)).toEqual(["Rice", "Bread"]);
    expect(searchConversations(chats, "knead DOUGH").map((chat) => chat.title)).toEqual(["Bread"]);
    expect(searchConversations(chats, "rice python").map((chat) => chat.title)).toEqual(["Rice"]);
    expect(searchConversations(chats, "rice dough")).toEqual([]);
    expect(searchConversations(chats, "  ")).toHaveLength(2);
  });

  it("isn't mistaken for anything else", () => {
    expect(() => parseConversationsJson("{")).toThrow("couldn't be read");
    expect(() => parseConversationsJson('{"a":1}')).toThrow("isn't a ChatGPT or Claude data export");
    expect(() => parseConversationsJson('[{"a":1}]')).toThrow("isn't a ChatGPT or Claude data export");
  });
});

/* A ZIP with its entries deflated, as ChatGPT's and Claude's are */
function deflatedZip(files: Record<string, string>): Uint8Array<ArrayBuffer> {
  const parts: Uint8Array[] = [];
  const directory: Uint8Array[] = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const nameBytes = new TextEncoder().encode(name);
    const raw = new TextEncoder().encode(content);
    const packed = deflateRawSync(raw);
    const local = new DataView(new ArrayBuffer(30));

    local.setUint32(0, 0x04034b50, true);
    local.setUint16(8, 8, true);
    local.setUint32(18, packed.length, true);
    local.setUint32(22, raw.length, true);
    local.setUint16(26, nameBytes.length, true);

    const central = new DataView(new ArrayBuffer(46));

    central.setUint32(0, 0x02014b50, true);
    central.setUint16(10, 8, true);
    central.setUint32(20, packed.length, true);
    central.setUint32(24, raw.length, true);
    central.setUint16(28, nameBytes.length, true);
    central.setUint32(42, offset, true);

    parts.push(new Uint8Array(local.buffer), nameBytes, packed);
    directory.push(new Uint8Array(central.buffer), nameBytes);
    offset += 30 + nameBytes.length + packed.length;
  }

  const directorySize = directory.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));

  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, Object.keys(files).length, true);
  end.setUint16(10, Object.keys(files).length, true);
  end.setUint32(12, directorySize, true);
  end.setUint32(16, offset, true);

  return new Uint8Array(Buffer.concat([...parts, ...directory, new Uint8Array(end.buffer)]));
}

describe("reading the export file", () => {
  it("finds conversations.json in a deflated ZIP", async () => {
    const zip = deflatedZip({
      "user.json": "{}",
      "conversations.json": JSON.stringify(CLAUDE_EXPORT),
    });
    const file = new File([zip], "data-2026-10-05.zip", { type: "application/zip" });

    expect((await readZipDirectory(file)).map((entry) => entry.name)).toEqual([
      "user.json",
      "conversations.json",
    ]);
    expect(parseConversationsJson(await readConversationsJson(file))[0].title).toBe("Bread");
  });

  it("reads a stored ZIP and a conversations.json on its own", async () => {
    const stored = createZipBlob([
      { path: "conversations.json", bytes: new TextEncoder().encode(JSON.stringify(CHATGPT_EXPORT)) },
    ]);

    expect(
      parseConversationsJson(await readConversationsJson(new File([stored], "export.zip")))[0].title,
    ).toBe("Rice");
    expect(
      await readConversationsJson(new File(["[]"], "conversations.json", { type: "application/json" })),
    ).toBe("[]");
  });

  it("says what's wrong with another file", async () => {
    await expect(readConversationsJson(new File(["hello"], "notes.zip"))).rejects.toThrow(
      "isn't a ZIP archive",
    );

    const other = createZipBlob([{ path: "photo.jpg", bytes: new Uint8Array([1, 2]) }]);

    await expect(readConversationsJson(new File([other], "photos.zip"))).rejects.toThrow(
      "has no conversations.json",
    );
  });
});
