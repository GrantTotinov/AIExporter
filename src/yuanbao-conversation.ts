/*
 * =========================================================
 * AI Exporter - yuanbao-conversation.ts
 * =========================================================
 *
 * Turns a Tencent Yuanbao (腾讯元宝, yuanbao.tencent.com)
 * conversation, as the web app's own API returns it, into the
 * messages content.ts hands to popup.ts. Conversations live at
 * /chat/{agentId}/{conversationId} - the agent is the assistant
 * the chat was with, Yuanbao's own by default - and the API takes
 * the session cookie:
 *
 *   POST /api/user/agent/conversation/v1/detail
 *        { conversationId, agentId, offset, limit }
 *   POST /api/user/agent/conversation/list
 *        { agentId, offset, limit, filterGoodQuestion: true }
 *
 * Answers are { code, ... }, code 0 on success. A conversation's
 * convs are its messages, speaker "human" or "ai", each with
 * speechesV2 whose content items are text ({ msg }), a web search
 * (searchGuid, its docs the pages found) or a deep search
 * (deepSearch, whose texts are the reasoning). An answer cites a
 * page as [citation:N], N being the doc's index.
 *
 * Field names follow the web app's API as open-source exporters
 * read it; everything is read defensively, since the API is
 * undocumented.
 *
 * Imported only by content.ts, so Rollup inlines it into
 * content.js - see the top of claude-conversation.ts.
 */
import { ReplySources, replyExtras } from "./reply-sources.ts";
import { messageMetadata, modelName } from "./message-metadata.ts";
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

/* Yuanbao's own assistant, which /chat without an agent opens */
export const YUANBAO_DEFAULT_AGENT = "naQivTmsDa";

export const YUANBAO_DETAIL_PATH = "/api/user/agent/conversation/v1/detail";
export const YUANBAO_LIST_PATH = "/api/user/agent/conversation/list";

export function getYuanbaoConversation(
  pathname: string,
): { agentId: string; conversationId: string } | null {
  const match = pathname.match(/^\/chat\/([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9_-]{8,128})\/?$/);

  return match ? { agentId: match[1], conversationId: match[2] } : null;
}

export function getYuanbaoConversationId(pathname: string): string | null {
  return getYuanbaoConversation(pathname)?.conversationId ?? null;
}

/* The agent the page is on, for the list and other conversations */
export function getYuanbaoAgentId(pathname: string): string {
  return pathname.match(/^\/chat\/([A-Za-z0-9_-]{1,64})(?:\/|$)/)?.[1] ?? YUANBAO_DEFAULT_AGENT;
}

/* The answer - or Yuanbao's error */
export function unwrapYuanbao(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload)) {
    throw unexpectedFormat("Yuanbao");
  }

  const code = payload.code ?? record(payload.error).code;

  if (code !== undefined && code !== null && String(code) !== "0") {
    throw new Error(
      stringValue(payload.message) ||
        stringValue(payload.msg) ||
        stringValue(record(payload.error).message) ||
        "Yuanbao refused the request.",
    );
  }

  return payload;
}

export function yuanbaoDetailBody(
  agentId: string,
  conversationId: string,
  offset: number,
): string {
  return JSON.stringify({ conversationId, offset, limit: 50, agentId });
}

export function parseYuanbaoDetailPage(
  data: Record<string, unknown>,
  offset: number,
): { convs: Record<string, unknown>[]; nextOffset: number | null } {
  const convs = records(data.convs);
  const indexes = convs.map((conv) => Number(conv.index)).filter(Number.isFinite);
  const lowest = indexes.length > 0 ? Math.min(...indexes) : NaN;

  return {
    convs,
    nextOffset:
      data.hasMore === true && Number.isFinite(lowest) && lowest !== offset ? lowest : null,
  };
}

interface Speech {
  text: string;
  thought: string;
  docs: { index: number; title: string; url: string }[];
}

function docsOf(value: unknown, into: Speech["docs"]): void {
  for (const doc of records(value)) {
    const url = stringValue(doc.url) || stringValue(doc.link);
    const index = Number(doc.index ?? doc.idx ?? into.length + 1);

    if (url) {
      into.push({
        index: Number.isFinite(index) && index > 0 ? index : into.length + 1,
        title: stringValue(doc.title) || stringValue(doc.name),
        url,
      });
    }
  }
}

function speechOf(conv: Record<string, unknown>): Speech {
  const texts: string[] = [];
  const thoughts: string[] = [];
  const docs: Speech["docs"] = [];

  for (const speech of records(conv.speechesV2)) {
    const before = texts.length;

    for (const item of records(speech.content)) {
      const type = stringValue(item.type);

      if (type === "deepSearch") {
        for (const sub of records(item.contents)) {
          if (sub.type === "text") {
            thoughts.push(stringValue(sub.msg));
          }

          docsOf(sub.docs, docs);
        }
      } else if (type === "searchGuid") {
        docsOf(item.docs, docs);
      } else if (type === "text" || type === "") {
        texts.push(stringValue(item.msg) || stringValue(item.text) || stringValue(item.content));
      }
    }

    if (texts.length === before && typeof speech.newPrompt === "string") {
      texts.push(speech.newPrompt);
    }
  }

  return { text: joinTexts(texts), thought: joinTexts(thoughts), docs };
}

export function convertYuanbaoConversation(convs: Record<string, unknown>[]): SiteMessage[] {
  const seen = new Set<string>();

  return convs
    .filter((conv) => {
      const key = idValue(conv.id) || `${stringValue(conv.speaker)}:${idValue(conv.index)}`;

      if (seen.has(key)) {
        return false;
      }

      seen.add(key);

      return Array.isArray(conv.speechesV2);
    })
    .sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0))
    .flatMap((conv) => {
      const role = stringValue(conv.speaker).toLowerCase() === "human" ? "user" : "assistant";
      const speech = speechOf(conv);
      const id = idValue(conv.id) || `${role}-${idValue(conv.index)}`;
      const time = anyTime(conv.createTime) ?? undefined;

      if (role === "user") {
        return textMessage(id, "user", speech.text, messageMetadata(time)) ?? [];
      }

      const sources = new ReplySources();
      const numbers = new Map<number, number | null>();

      for (const doc of speech.docs) {
        if (!numbers.has(doc.index)) {
          numbers.set(doc.index, sources.add(doc.url, doc.title));
        }
      }

      const cite = (_: string, index: string) => sources.note([numbers.get(Number(index))]);
      const firstSpeech = record(records(conv.speechesV2)[0]);

      return (
        textMessage(id, "assistant", speech.text.replace(/\[citation:(\d+)\]/g, cite), {
          ...replyExtras(speech.thought.replace(/\[citation:(\d+)\]/g, cite), sources),
          ...messageMetadata(time, modelName(firstSpeech.chatModelId)),
        }) ?? []
      );
    });
}

/*
 * ---------------------------------------------------------
 * CONVERSATION LIST
 * ---------------------------------------------------------
 *
 * The cursor is the offset into the list.
 */
export function yuanbaoListBody(agentId: string, cursor: string | null): string {
  return JSON.stringify({
    agentId,
    offset: Number(cursor) || 0,
    limit: 40,
    filterGoodQuestion: true,
  });
}

export function parseYuanbaoConversationList(
  data: Record<string, unknown>,
  cursor: string | null,
): SiteConversationPage {
  const items = records(data.conversations);
  const offset = (Number(cursor) || 0) + items.length;
  const total = Number(record(data.pagination).totalResults);
  const conversations = items.flatMap((item) => {
    const id = safeId(item.id);

    return id
      ? [
          {
            id,
            title: (stringValue(item.title) || stringValue(item.sessionTitle)).trim(),
            createdAt: anyTime(item.firstRepliedAt ?? item.createTime),
            updatedAt: anyTime(item.lastRepliedAt ?? item.lastRepliedDatetime),
          },
        ]
      : [];
  });

  return {
    conversations,
    nextCursor:
      items.length > 0 && (!Number.isFinite(total) || offset < total) ? String(offset) : null,
  };
}
