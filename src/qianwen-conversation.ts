/*
 * =========================================================
 * AI Exporter - qianwen-conversation.ts
 * =========================================================
 *
 * Turns a Qianwen (千问, www.qianwen.com - Alibaba's Qwen app in
 * China) conversation, as the web app's own API returns it, into
 * the messages content.ts hands to popup.ts. The API lives on its
 * own host, which the page's session cookie is sent to as well:
 *
 *   GET  https://chat2-api.qianwen.com/api/v1/session/msg/list
 *        ?session_id&page&page_size&pos&...   the turns, a page at a time
 *   POST https://chat2-api.qianwen.com/api/v2/session/page/list
 *        { limit, next_token, ... }          the conversation list
 *
 * Every request carries the web app's common parameters (its
 * device id, version, language and time zone) and its XSRF token
 * as a header. Answers are { success, code, data }.
 *
 * A turn is one question and its answer: request_messages hold the
 * question, response_messages the answer (its deep_think loader
 * the reasoning) - or, in newer turns, qwen_response_messages. An
 * answer cites its web sources as [[source_group_web_1]].
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

export const QIANWEN_API = "https://chat2-api.qianwen.com";

/* Conversations live at /chat/{id} */
export function getQianwenConversationId(pathname: string): string | null {
  return pathname.match(/^\/chat\/([A-Za-z0-9_-]{8,128})\/?$/)?.[1] ?? null;
}

export interface QianwenClient {
  deviceId: string;
  /* The web app's version, as its script addresses name it */
  version: string;
  language: string;
  timeZone: string;
  xsrfToken: string;
}

/* The web app's version from the addresses of the scripts it loaded */
export function qianwenVersion(requestedUrls: string[]): string {
  for (const url of requestedUrls) {
    const version = url.match(/\/qianwen-web\/(\d+\.\d+\.\d+)\//)?.[1];

    if (version) {
      return version;
    }
  }

  return "4.0.7";
}

export function qianwenUrl(
  client: QianwenClient,
  path: string,
  query: Record<string, string> = {},
): string {
  const params = new URLSearchParams({
    biz_id: "ai_qwen",
    chat_client: "h5",
    device: "pc",
    fr: "pc",
    pr: "qwen",
    ut: client.deviceId,
    la: client.language,
    tz: client.timeZone,
    wv: client.version,
    ve: client.version,
    ...query,
  });

  return `${QIANWEN_API}${path}?${params.toString()}`;
}

export function qianwenHeaders(client: QianwenClient): Record<string, string> {
  return {
    "x-platform": "pc_tongyi",
    ...(client.xsrfToken ? { "x-xsrf-token": client.xsrfToken } : {}),
    ...(client.deviceId ? { "x-deviceid": client.deviceId } : {}),
  };
}

/* The answer's data - or Qianwen's error */
export function unwrapQianwen(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload)) {
    throw unexpectedFormat("Qianwen");
  }

  if (payload.success === false || (payload.code !== undefined && Number(payload.code) !== 0)) {
    throw new Error(
      stringValue(payload.msg) || stringValue(payload.errorMsg) || "Qianwen refused the request.",
    );
  }

  return record(payload.data);
}

export function qianwenTurnsQuery(sessionId: string, page: number, pos: string): Record<string, string> {
  return {
    session_id: sessionId,
    page_size: "100",
    page: String(page),
    return_response_messages: "true",
    event_filter: "all",
    ...(pos ? { pos } : {}),
  };
}

export function parseQianwenTurnsPage(data: Record<string, unknown>): {
  turns: Record<string, unknown>[];
  nextPos: string | null;
} {
  const turns = records(data.list);
  const more = data.has_next_page ?? data.have_next_page ?? data.have_more_record;
  const next = stringValue(data.next_page_pos) || idValue(turns[turns.length - 1]?.pos);

  return { turns, nextPos: more === true && next ? next : null };
}

function plainText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (!isRecord(value)) {
    return "";
  }

  if (typeof value.content === "string") {
    return value.content;
  }

  return Array.isArray(value.content) ? value.content.map(plainText).join("") : "";
}

function answerText(turn: Record<string, unknown>): string {
  const texts = records(turn.response_messages)
    .filter((message) => !/^(?:signal|bar|paa)\//.test(stringValue(message.mime_type)))
    .map(plainText);

  if (joinTexts(texts)) {
    return joinTexts(texts);
  }

  return joinTexts(
    records(turn.qwen_response_messages)
      .filter((message) => stringValue(message.role).toLowerCase() === "assistant")
      .filter((message) =>
        ["", "text", "markdown", "multi_load/text"].includes(
          stringValue(message.contentType ?? message.content_type ?? message.mimeType).toLowerCase(),
        ),
      )
      .map((message) => stringValue(message.content)),
  );
}

function reasoning(turn: Record<string, unknown>): string {
  return joinTexts(
    records(turn.response_messages).flatMap((message) =>
      records(record(message.meta_data).multi_load)
        .filter((item) => item.type === "deep_think")
        .map((item) => stringValue(record(item.content).think_content)),
    ),
  );
}

/* The web pages an answer's [[source_group_web_N]] stand for */
function sourceGroups(value: unknown, found: Map<string, { title: string; url: string }>): void {
  if (Array.isArray(value)) {
    value.forEach((item) => sourceGroups(item, found));
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  const sequence = stringValue(value.source_seq);

  if (/^source_group_web_\d+$/.test(sequence) && !found.has(sequence)) {
    const page = firstPage(value);

    if (page) {
      found.set(sequence, page);
    }
  }

  for (const key of ["sources", "multi_load", "list", "content"]) {
    sourceGroups(value[key], found);
  }
}

function firstPage(value: unknown): { title: string; url: string } | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const page = firstPage(item);

      if (page) {
        return page;
      }
    }

    return null;
  }

  if (!isRecord(value)) {
    return null;
  }

  const url = stringValue(value.url) || stringValue(value.raw_url);

  if (url) {
    return { title: stringValue(value.title) || stringValue(value.name), url };
  }

  for (const key of ["sources", "multi_load", "list", "content"]) {
    const page = firstPage(value[key]);

    if (page) {
      return page;
    }
  }

  return null;
}

export function convertQianwenTurns(rawTurns: Record<string, unknown>[]): SiteMessage[] {
  const seen = new Set<string>();

  return rawTurns
    .filter((turn) => {
      const key = idValue(turn.req_id) || idValue(turn.pos);

      if (!key || seen.has(key)) {
        return !key;
      }

      seen.add(key);

      return true;
    })
    .sort(
      (a, b) =>
        Number(a.request_timestamp ?? a.created_at ?? 0) -
        Number(b.request_timestamp ?? b.created_at ?? 0),
    )
    .flatMap((turn, index) => {
      const key = idValue(turn.req_id) || idValue(turn.pos) || String(index);
      const time = anyTime(turn.request_timestamp ?? turn.created_at) ?? undefined;
      const question = textMessage(
        `${key}-q`,
        "user",
        joinTexts(records(turn.request_messages).map(plainText)),
        messageMetadata(time),
      );
      const groups = new Map<string, { title: string; url: string }>();

      for (const message of records(turn.response_messages)) {
        sourceGroups(message.meta_data, groups);
      }

      const sources = new ReplySources();
      const answer = answerText(turn)
        .replace(/\[\((?:deep_think|doc_common_card)[^)]*\)\]/g, "")
        .replace(/\[\[(source_group_web_\d+)\]\]/g, (_, sequence: string) => {
          const page = groups.get(sequence);

          return page ? sources.note([sources.add(page.url, page.title)]) : "";
        })
        .replace(/\[\[[^\]]+\]\]/g, "");
      const reply = textMessage(`${key}-a`, "assistant", answer, {
        ...replyExtras(reasoning(turn), sources),
        ...messageMetadata(undefined, modelName(turn.model_name)),
      });

      return [question, reply].filter((message): message is SiteMessage => message !== null);
    });
}

/*
 * ---------------------------------------------------------
 * CONVERSATION LIST
 * ---------------------------------------------------------
 */
export function qianwenListBody(cursor: string | null): string {
  return JSON.stringify({
    limit: 50,
    next_token: cursor ?? "",
    sort_field: "modifiedTime",
    need_filter_tag: true,
  });
}

export function parseQianwenConversationList(data: Record<string, unknown>): SiteConversationPage {
  const sessions = records(data.list);
  const conversations = sessions.flatMap((session) => {
    const id = safeId(session.session_id ?? session.sessionId);

    return id
      ? [
          {
            id,
            title: (stringValue(session.title) || stringValue(session.summary)).trim(),
            createdAt: anyTime(session.created_at ?? session.createTime),
            updatedAt: anyTime(session.updated_at ?? session.modifiedTime),
          },
        ]
      : [];
  });
  const next = stringValue(data.next_token);

  return {
    conversations,
    nextCursor: data.have_next_page === true && next && sessions.length > 0 ? next : null,
  };
}
