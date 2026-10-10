/*
 * =========================================================
 * AI Exporter - chat-archive.ts
 * =========================================================
 *
 * Reads the data export ChatGPT and Claude email on request
 * (Settings -> Data controls -> Export data): a ZIP whose
 * conversations.json holds every chat the account ever had -
 * including ones deleted from the sidebar since, or from an account
 * that's been closed. The archive page (archive.ts) lists them,
 * searches them and saves them in any of AI Exporter's formats, all
 * in the browser: the file never leaves the computer.
 *
 *   ChatGPT   [{ title, create_time, update_time, current_node,
 *               mapping: { id: { message, parent, children } } }]
 *             - every branch of a chat, current_node ending the one
 *             shown; a message's content has a content_type ("text",
 *             "multimodal_text", "code", "thoughts"...) and parts.
 *   Claude    [{ uuid, name, created_at, updated_at,
 *               chat_messages: [{ sender, text, content, created_at }] }]
 *
 * An export of years of chats with pictures can be gigabytes, so
 * the ZIP is never read whole: only its directory and the one
 * entry needed are sliced out of the file (ZIP64 included), and
 * inflated with the browser's DecompressionStream.
 */
import type { Message } from "./export-builders.ts";
import { convertChatGptComponents } from "./chatgpt-components.ts";

export type ArchiveSource = "chatgpt" | "claude";

export interface ArchivedConversation {
  id: string;
  title: string;
  /* The chat's page on its site */
  url: string;
  createdAt: number | null;
  updatedAt: number | null;
  source: ArchiveSource;
  messages: Message[];
  /* Its title and text, lowercased, for searching */
  searchText: string;
}

/*
 * ---------------------------------------------------------
 * ZIP
 * ---------------------------------------------------------
 */
export interface ZipDirectoryEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  headerOffset: number;
}

async function bytesAt(file: Blob, start: number, end: number): Promise<DataView> {
  return new DataView(await file.slice(start, end).arrayBuffer());
}

function uint64(view: DataView, offset: number): number {
  return view.getUint32(offset, true) + view.getUint32(offset + 4, true) * 2 ** 32;
}

/* The ZIP's directory: every file in it, where its data starts and how it's packed */
export async function readZipDirectory(file: Blob): Promise<ZipDirectoryEntry[]> {
  const tailStart = Math.max(0, file.size - 65_557);
  const tail = await bytesAt(file, tailStart, file.size);
  let end = -1;

  for (let offset = tail.byteLength - 22; offset >= 0; offset--) {
    if (tail.getUint32(offset, true) === 0x06054b50) {
      end = offset;
      break;
    }
  }

  if (end < 0) {
    throw new Error("This file isn't a ZIP archive.");
  }

  let count = tail.getUint16(end + 10, true);
  let directorySize = tail.getUint32(end + 12, true);
  let directoryOffset = tail.getUint32(end + 16, true);

  // ZIP64: the real numbers are in the record before the locator
  if (directoryOffset === 0xffffffff || count === 0xffff || directorySize === 0xffffffff) {
    const locator = end - 20;

    if (locator < 0 || tail.getUint32(locator, true) !== 0x07064b50) {
      throw new Error("This ZIP archive can't be read.");
    }

    const recordOffset = uint64(tail, locator + 8);
    const record = await bytesAt(file, recordOffset, recordOffset + 56);

    if (record.getUint32(0, true) !== 0x06064b50) {
      throw new Error("This ZIP archive can't be read.");
    }

    count = uint64(record, 32);
    directorySize = uint64(record, 40);
    directoryOffset = uint64(record, 48);
  }

  const directory = await bytesAt(file, directoryOffset, directoryOffset + directorySize);
  const decoder = new TextDecoder();
  const entries: ZipDirectoryEntry[] = [];
  let offset = 0;

  for (let index = 0; index < count && offset + 46 <= directory.byteLength; index++) {
    if (directory.getUint32(offset, true) !== 0x02014b50) {
      break;
    }

    const nameLength = directory.getUint16(offset + 28, true);
    const extraLength = directory.getUint16(offset + 30, true);
    const commentLength = directory.getUint16(offset + 32, true);
    const name = decoder.decode(
      new Uint8Array(directory.buffer, directory.byteOffset + offset + 46, nameLength),
    );
    let compressedSize = directory.getUint32(offset + 20, true);
    let size = directory.getUint32(offset + 24, true);
    let headerOffset = directory.getUint32(offset + 42, true);
    let extra = offset + 46 + nameLength;
    const extraEnd = extra + extraLength;

    // The ZIP64 extra field holds whichever of the three overflowed
    while (extra + 4 <= extraEnd) {
      const id = directory.getUint16(extra, true);
      const length = directory.getUint16(extra + 2, true);

      if (id === 0x0001) {
        let field = extra + 4;

        if (size === 0xffffffff) {
          size = uint64(directory, field);
          field += 8;
        }

        if (compressedSize === 0xffffffff) {
          compressedSize = uint64(directory, field);
          field += 8;
        }

        if (headerOffset === 0xffffffff) {
          headerOffset = uint64(directory, field);
        }
      }

      extra += 4 + length;
    }

    entries.push({
      name,
      method: directory.getUint16(offset + 10, true),
      compressedSize,
      size,
      headerOffset,
    });
    offset = extraEnd + commentLength;
  }

  return entries;
}

/* One file of the ZIP, unpacked */
export async function readZipEntry(file: Blob, entry: ZipDirectoryEntry): Promise<Blob> {
  const header = await bytesAt(file, entry.headerOffset, entry.headerOffset + 30);

  if (header.getUint32(0, true) !== 0x04034b50) {
    throw new Error("This ZIP archive can't be read.");
  }

  const start =
    entry.headerOffset + 30 + header.getUint16(26, true) + header.getUint16(28, true);
  const packed = file.slice(start, start + entry.compressedSize);

  if (entry.method === 0) {
    return packed;
  }

  if (entry.method !== 8) {
    throw new Error("This ZIP archive is packed in a way that can't be read.");
  }

  return new Response(
    packed.stream().pipeThrough(new DecompressionStream("deflate-raw")),
  ).blob();
}

/*
 * The conversations.json of a data export: picked as it is, or
 * found in its ZIP.
 */
export async function readConversationsJson(file: File): Promise<string> {
  if (/\.json$/i.test(file.name) || file.type === "application/json") {
    return file.text();
  }

  const entries = await readZipDirectory(file);
  const entry =
    entries.find((item) => item.name === "conversations.json") ??
    entries.find((item) => /(?:^|\/)conversations\.json$/.test(item.name));

  if (!entry) {
    throw new Error(
      "This ZIP has no conversations.json. Pick the data export ChatGPT or Claude emailed you.",
    );
  }

  return (await readZipEntry(file, entry)).text();
}

/*
 * ---------------------------------------------------------
 * CONVERSATIONS
 * ---------------------------------------------------------
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function seconds(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value * 1000)
    : null;
}

function isoTime(value: unknown): number | null {
  const time = typeof value === "string" ? Date.parse(value) : NaN;

  return Number.isFinite(time) ? time : null;
}

/* ChatGPT's private-use citation markers ("citeturn0search1") */
const CHATGPT_MARKERS = /[^]*/g;

function chatGptText(content: Record<string, unknown>): { text: string; thinking: string } {
  const type = text(content.content_type);
  const parts = Array.isArray(content.parts) ? content.parts : [];

  if (type === "text" || type === "multimodal_text") {
    return {
      text: parts
        .filter((part): part is string => typeof part === "string")
        .join("\n\n")
        .replace(CHATGPT_MARKERS, ""),
      thinking: "",
    };
  }

  if (type === "code" && text(content.text)) {
    const language = text(content.language).replace(/[^\w+#.-]/g, "");

    return { text: `\`\`\`${language === "unknown" ? "" : language}\n${text(content.text)}\n\`\`\``, thinking: "" };
  }

  if (type === "thoughts" && Array.isArray(content.thoughts)) {
    return {
      text: "",
      thinking: content.thoughts
        .map((thought) => text(record(thought).content))
        .filter(Boolean)
        .join("\n\n"),
    };
  }

  return { text: "", thinking: "" };
}

function chatGptConversation(item: Record<string, unknown>): ArchivedConversation | null {
  const mapping = record(item.mapping);
  const id = text(item.conversation_id) || text(item.id);
  const branch: Record<string, unknown>[] = [];
  const visited = new Set<string>();
  let current = text(item.current_node);

  while (current && !visited.has(current) && isRecord(mapping[current])) {
    visited.add(current);
    branch.push(record(mapping[current]));
    current = text(record(mapping[current]).parent);
  }

  const messages: Message[] = [];
  let thinking = "";

  for (const node of branch.reverse()) {
    const message = record(node.message);
    const role = text(record(message.author).role);
    const metadata = record(message.metadata);

    if ((role !== "user" && role !== "assistant") || metadata.is_visually_hidden_from_conversation) {
      continue;
    }

    const content = chatGptText(record(message.content));

    if (content.thinking) {
      thinking = [thinking, content.thinking].filter(Boolean).join("\n\n");
    }

    if (!content.text.trim()) {
      continue;
    }

    const last = messages[messages.length - 1];

    // ChatGPT splits a reply around its tool calls; the export joins it.
    if (last && last.role === role) {
      last.content = `${last.content}\n\n${content.text.trim()}`;
      continue;
    }

    const time = seconds(message.create_time);
    const model = text(metadata.model_slug);

    messages.push({
      id: text(message.id) || `${id}-${messages.length}`,
      role,
      order: messages.length,
      content: content.text.trim(),
      ...(time !== null ? { time } : {}),
      ...(role === "assistant" && model ? { model } : {}),
      ...(role === "assistant" && thinking ? { thinking } : {}),
    });

    if (role === "assistant") {
      thinking = "";
    }
  }

  if (!id || messages.length === 0) {
    return null;
  }

  // Its UI components (<CodeBlock>, <Cite/>...) as Markdown
  for (const message of messages) {
    if (message.role === "assistant") {
      message.content = convertChatGptComponents(message.content);
    }
  }

  return finish({
    id,
    title: text(item.title).trim(),
    url: `https://chatgpt.com/c/${id}`,
    createdAt: seconds(item.create_time),
    updatedAt: seconds(item.update_time) ?? seconds(item.create_time),
    source: "chatgpt",
    messages,
  });
}

function claudeConversation(item: Record<string, unknown>): ArchivedConversation | null {
  const id = text(item.uuid);
  const messages: Message[] = [];

  for (const raw of Array.isArray(item.chat_messages) ? item.chat_messages : []) {
    const message = record(raw);
    const role = message.sender === "human" ? "user" : message.sender === "assistant" ? "assistant" : null;

    if (!role) {
      continue;
    }

    const parts = (Array.isArray(message.content) ? message.content : []).map(record);
    const body =
      parts
        .filter((part) => part.type === "text")
        .map((part) => text(part.text))
        .join("\n\n")
        .trim() || text(message.text).trim();
    const thinking = parts
      .filter((part) => part.type === "thinking")
      .map((part) => text(part.thinking))
      .join("\n\n")
      .trim();

    if (!body) {
      continue;
    }

    const time = isoTime(message.created_at);

    messages.push({
      id: text(message.uuid) || `${id}-${messages.length}`,
      role,
      order: messages.length,
      content: body,
      ...(time !== null ? { time } : {}),
      ...(role === "assistant" && thinking ? { thinking } : {}),
    });
  }

  if (!id || messages.length === 0) {
    return null;
  }

  return finish({
    id,
    title: text(item.name).trim(),
    url: `https://claude.ai/chat/${id}`,
    createdAt: isoTime(item.created_at),
    updatedAt: isoTime(item.updated_at) ?? isoTime(item.created_at),
    source: "claude",
    messages,
  });
}

function finish(conversation: Omit<ArchivedConversation, "searchText">): ArchivedConversation {
  return {
    ...conversation,
    searchText: [conversation.title, ...conversation.messages.map((message) => message.content)]
      .join("\n")
      .toLowerCase(),
  };
}

/* Every chat in a conversations.json, newest first */
export function parseConversationsJson(json: string): ArchivedConversation[] {
  let data: unknown;

  try {
    data = JSON.parse(json);
  } catch {
    throw new Error("conversations.json couldn't be read.");
  }

  if (!Array.isArray(data)) {
    throw new Error("This isn't a ChatGPT or Claude data export.");
  }

  const conversations = data
    .filter(isRecord)
    .map((item) =>
      isRecord(item.mapping)
        ? chatGptConversation(item)
        : Array.isArray(item.chat_messages)
          ? claudeConversation(item)
          : null,
    )
    .filter((item): item is ArchivedConversation => item !== null);

  if (data.length > 0 && conversations.length === 0) {
    throw new Error("This isn't a ChatGPT or Claude data export.");
  }

  return conversations.sort(
    (a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0),
  );
}

/* The chats whose title or text has every word of the query */
export function searchConversations(
  conversations: ArchivedConversation[],
  query: string,
): ArchivedConversation[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);

  return words.length === 0
    ? conversations
    : conversations.filter((conversation) =>
        words.every((word) => conversation.searchText.includes(word)),
      );
}
