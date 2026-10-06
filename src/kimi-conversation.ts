/*
 * =========================================================
 * AI Exporter - kimi-conversation.ts
 * =========================================================
 *
 * Turns a Kimi (www.kimi.com) conversation, as the web app's own
 * API returns it, into the messages content.ts hands to popup.ts.
 * The API is Connect RPC with JSON bodies:
 *
 *   POST /apiv2/kimi.gateway.chat.v1.ChatService/ListMessages
 *        { chatId, pageSize, pageToken }
 *   POST /apiv2/kimi.gateway.feed.v1.FeedService/ListFeeds
 *        { pageToken, pageSize, projectId: "", filterTypes: [1] }
 *
 * Both want the token the web app keeps in localStorage
 * ("access_token") as a Bearer header. A message has a role and
 * blocks: { text: { content } } for what it says and { think:
 * { content } } for the reasoning before it. A reply that searched
 * the web marks each citation in its text with a private-use
 * "cite..." token, which its references list
 * (matchedText) with the page it stands for.
 *
 * Field names follow the web app's API as open-source exporters
 * read it; everything is read defensively, since the API is
 * undocumented.
 *
 * Imported only by content.ts, so Rollup inlines it into
 * content.js - see the top of claude-conversation.ts.
 */
import { ReplySources, replyExtras } from "./reply-sources.ts";
import { messageMetadata, modelName, timeFromIso } from "./message-metadata.ts";
import {
  anyTime,
  idValue,
  isRecord,
  joinTexts,
  record,
  records,
  safeId,
  stringValue,
  textMessage,
  unexpectedFormat,
  type SiteConversationPage,
  type SiteMessage,
} from "./site-json.ts";

const SERVICE = "/apiv2/kimi.gateway";

export const KIMI_MESSAGES_PATH = `${SERVICE}.chat.v1.ChatService/ListMessages`;
export const KIMI_LIST_PATH = `${SERVICE}.feed.v1.FeedService/ListFeeds`;

/* Conversations live at /chat/{id} */
export function getKimiConversationId(pathname: string): string | null {
  const id = pathname.match(/^\/chat\/([A-Za-z0-9_-]{8,128})\/?$/)?.[1];

  return id && id !== "history" ? id : null;
}

/* The token as the web app stores it: plain, or as a JSON string */
export function readKimiToken(raw: string | null): string | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(raw);

    return typeof parsed === "string" ? parsed.trim() || null : raw.trim() || null;
  } catch {
    return raw.trim() || null;
  }
}

/* The headers the web app's own requests carry */
export function kimiHeaders(
  token: string,
  language: string,
  timeZone: string,
): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "connect-protocol-version": "1",
    "x-msh-platform": "web",
    "x-msh-version": "2.0.0",
    "x-language": language,
    "r-timezone": timeZone,
  };
}

export function kimiMessagesBody(chatId: string, pageToken: string): string {
  return JSON.stringify({ chatId, pageSize: 100, pageToken });
}

export function parseKimiMessagesPage(data: unknown): {
  messages: Record<string, unknown>[];
  nextPageToken: string;
} {
  if (!isRecord(data) || !Array.isArray(data.messages)) {
    throw unexpectedFormat("Kimi");
  }

  return {
    messages: records(data.messages),
    nextPageToken: stringValue(data.nextPageToken),
  };
}

/*
 * Kimi's times have microseconds ("2026-08-01T15:48:56.072365Z"),
 * and a question and its answer can be microseconds apart: sorted
 * by milliseconds alone, an answer could land before its question.
 */
function sortKey(value: unknown): number {
  const match = /^(.*T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/.exec(
    stringValue(value),
  );

  if (!match) {
    return 0;
  }

  const base = Date.parse(`${match[1]}${match[3] ?? "Z"}`);

  return Number.isFinite(base) ? base + Number(`0.${match[2] ?? "0"}`) * 1000 : 0;
}

function blockText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (!isRecord(value)) {
    return "";
  }

  if (typeof value.content === "string") {
    return value.content;
  }

  return Array.isArray(value.content) ? value.content.map(blockText).join("") : "";
}

function blocksOf(message: Record<string, unknown>, kind: "text" | "think"): string {
  return joinTexts(records(message.blocks).map((block) => blockText(block[kind])));
}

/* The page a citation stands for, as references list it */
function citedPage(reference: Record<string, unknown>): { title: string; url: string } {
  const item = record(records(reference.items)[0]);
  const base = record(
    record(item.search).base ?? record(item.searchResult).base ?? item.base,
  );

  return { title: stringValue(base.title), url: stringValue(base.url) };
}

const CITATION = /cite[\s\S]*?/g;

function replaceCitations(
  text: string,
  references: Record<string, unknown>[],
  sources: ReplySources,
): string {
  const byMarker = new Map(
    references.map((reference) => [stringValue(reference.matchedText), reference]),
  );

  return text.replace(CITATION, (marker) => {
    const reference = byMarker.get(marker);

    if (!reference) {
      return "";
    }

    const page = citedPage(reference);

    return sources.note([sources.add(page.url, page.title)]);
  });
}

export function convertKimiMessages(
  rawMessages: Record<string, unknown>[],
  model?: unknown,
): SiteMessage[] {
  const seen = new Set<string>();
  const ordered = rawMessages
    .filter((message) => {
      const id = idValue(message.id);

      if (!id || seen.has(id)) {
        return false;
      }

      seen.add(id);

      return true;
    })
    .sort((a, b) => sortKey(a.createTime) - sortKey(b.createTime));

  return ordered.flatMap((message) => {
    const role = stringValue(message.role).toLowerCase();

    if (role !== "user" && role !== "assistant") {
      return [];
    }

    const metadata = messageMetadata(
      timeFromIso(message.createTime) ?? anyTime(message.createTime) ?? undefined,
      role === "assistant" ? modelName(model) : undefined,
    );

    if (role === "user") {
      return textMessage(idValue(message.id), "user", blocksOf(message, "text"), metadata) ?? [];
    }

    const sources = new ReplySources();
    const text = replaceCitations(
      blocksOf(message, "text"),
      records(message.references),
      sources,
    );

    return (
      textMessage(idValue(message.id), "assistant", text, {
        ...replyExtras(blocksOf(message, "think"), sources),
        ...metadata,
      }) ?? []
    );
  });
}

/* The chat's model, as GetChat or a message names it */
export function kimiModel(chat: unknown): string | undefined {
  const value = record(record(chat).lastRequest).scenario;

  return modelName(typeof value === "string" ? value.replace(/^SCENARIO_/, "") : value);
}

/*
 * ---------------------------------------------------------
 * CONVERSATION LIST
 * ---------------------------------------------------------
 */
export function kimiListBody(pageToken: string | null): string {
  return JSON.stringify({
    pageToken: pageToken ?? "",
    pageSize: 50,
    projectId: "",
    filterTypes: [1],
    includePinned: false,
  });
}

export function parseKimiConversationList(data: unknown): SiteConversationPage {
  if (!isRecord(data)) {
    throw new Error("Kimi returned an unexpected chat list format.");
  }

  const items = records(data.items);
  const conversations = items.flatMap((item) => {
    const chat = record(item.chat ?? record(item.item).value);
    const id = safeId(chat.id);

    return id
      ? [
          {
            id,
            title: stringValue(chat.name).trim(),
            createdAt: anyTime(chat.createTime),
            updatedAt: anyTime(chat.updateTime) ?? anyTime(chat.createTime),
          },
        ]
      : [];
  });
  const next = stringValue(data.nextPageToken);

  return { conversations, nextCursor: next && items.length > 0 ? next : null };
}
