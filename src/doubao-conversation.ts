/*
 * =========================================================
 * AI Exporter - doubao-conversation.ts
 * =========================================================
 *
 * Turns a Doubao (豆包, www.doubao.com) conversation, as the web
 * app's own API returns it, into the messages content.ts hands to
 * popup.ts. Doubao's web app talks to an instant-messaging API:
 * every request is a POST of { cmd, uplink_body, sequence_id,
 * channel, version }, answered with { status_code, downlink_body }.
 *
 *   POST /im/chain/single       cmd 3100  a conversation's messages,
 *                                         newest first, 50 at a time
 *   POST /im/chain/recent_conv  cmd 3200  the conversation list
 *
 * Both need the query parameters the web app sends (its app id,
 * version, device id...), which content.ts copies from a request
 * the page already made (see doubaoQuery), and the session cookie.
 *
 * A message's user_type is 1 for the person, 2 for Doubao, and its
 * content_block holds text_block { text } parts; a reply that
 * thought first has a thinking block, its text blocks before the
 * last one being the reasoning. Web search results come as
 * search_query_result_block { results: [{ text_card }] }.
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

export const DOUBAO_MESSAGES_PATH = "/im/chain/single";
export const DOUBAO_LIST_PATH = "/im/chain/recent_conv";

/* Conversations live at /chat/{number} */
export function getDoubaoConversationId(pathname: string): string | null {
  return pathname.match(/^\/chat\/(\d{4,32})\/?$/)?.[1] ?? null;
}

/*
 * The query string the web app's IM requests carry, taken from one
 * the page already made (the browser lists them in its resource
 * timing) - or, before it made any, the parameters it's known to
 * send, with its device id from localStorage.
 */
export function doubaoQuery(
  requestedUrls: string[],
  storedDeviceId: string | null,
  storedWebId: string | null,
  language: string,
): string {
  const made = [...requestedUrls]
    .reverse()
    .find((url) => /\/im\/(?:chain|conversation)\//.test(url) && url.includes("?"));

  if (made) {
    return new URL(made).search;
  }

  const params = new URLSearchParams({
    version_code: "20800",
    language: language.split("-")[0] || "zh",
    device_platform: "web",
    aid: "497858",
    real_aid: "497858",
    pkg_type: "release_version",
    samantha_web: "1",
    web_platform: "browser",
    "use-olympus-account": "1",
  });

  if (storedDeviceId) {
    params.set("device_id", storedDeviceId);
  }

  if (storedWebId) {
    params.set("web_id", storedWebId);
    params.set("tea_uuid", storedWebId);
  }

  return `?${params.toString()}`;
}

export const DOUBAO_HEADERS: Record<string, string> = {
  "agw-js-conv": "str",
};

function request(cmd: number, body: Record<string, unknown>, sequenceId: string): string {
  return JSON.stringify({
    cmd,
    uplink_body: body,
    sequence_id: sequenceId,
    channel: 2,
    version: "1",
  });
}

/*
 * The messages before anchorIndex (the first request asks from
 * the end, with the largest index there is).
 */
export function doubaoMessagesBody(
  conversationId: string,
  anchorIndex: number,
  sequenceId: string,
): string {
  return request(
    3100,
    {
      pull_singe_chain_uplink_body: {
        conversation_id: conversationId,
        anchor_index: anchorIndex,
        conversation_type: 3,
        direction: 1,
        limit: 50,
        ext: {},
        filter: { index_list: [] },
      },
    },
    sequenceId,
  );
}

/* The answer's downlink body - or Doubao's error */
function downlink(data: unknown, key: string): Record<string, unknown> {
  if (!isRecord(data)) {
    throw unexpectedFormat("Doubao");
  }

  const status = Number(data.status_code ?? 0);

  if (status !== 0) {
    throw new Error(
      stringValue(data.status_desc) || `Doubao refused the request (${status}).`,
    );
  }

  return record(record(data.downlink_body)[key]);
}

export function parseDoubaoMessagesPage(data: unknown): {
  messages: Record<string, unknown>[];
  hasMore: boolean;
  /* Where the next (older) page starts; null at the first message */
  nextAnchor: number | null;
} {
  const body = downlink(data, "pull_singe_chain_downlink_body");
  const messages = records(body.messages);
  const indexes = messages
    .map((message) => Number(message.index_in_conv))
    .filter(Number.isFinite);
  const lowest = indexes.length > 0 ? Math.min(...indexes) : NaN;

  return {
    messages,
    hasMore: body.has_more === true,
    nextAnchor: Number.isFinite(lowest) && lowest > 1 ? lowest - 1 : null,
  };
}

function blockText(block: Record<string, unknown>): string {
  return stringValue(record(record(block.content).text_block).text);
}

/* Older messages keep their text as JSON in `content` */
function legacyText(message: Record<string, unknown>): string {
  const content = stringValue(message.content);

  try {
    const parsed: unknown = JSON.parse(content);

    return isRecord(parsed) ? stringValue(parsed.text) : content;
  } catch {
    return content;
  }
}

function addSearchResults(blocks: Record<string, unknown>[], sources: ReplySources): void {
  for (const block of blocks) {
    const results = records(record(record(block.content).search_query_result_block).results);

    for (const result of results) {
      const card = record(result.text_card ?? result.image_card ?? result.video_card);

      sources.add(card.url, card.title);
    }
  }
}

export function convertDoubaoMessages(
  rawMessages: Record<string, unknown>[],
  model?: unknown,
): SiteMessage[] {
  const seen = new Set<string>();

  return rawMessages
    .filter((message) => {
      const id = idValue(message.message_id);

      if (!id || seen.has(id)) {
        return false;
      }

      seen.add(id);

      return true;
    })
    .sort((a, b) => Number(a.index_in_conv ?? 0) - Number(b.index_in_conv ?? 0))
    .flatMap((message) => {
      const userType = String(message.user_type ?? "");

      if (userType !== "1" && userType !== "2") {
        return [];
      }

      const role = userType === "1" ? "user" : "assistant";
      const blocks = records(message.content_block);
      const texts = blocks
        .filter((block) => isRecord(record(block.content).text_block))
        .map(blockText);
      const thought =
        role === "assistant" &&
        texts.length > 1 &&
        blocks.some(
          (block) =>
            isRecord(record(block.content).thinking_block) ||
            Number(block.block_type) === 10040,
        );
      const sources = new ReplySources();

      addSearchResults(blocks, sources);

      const answer = thought
        ? texts[texts.length - 1]
        : joinTexts(texts.length > 0 ? texts : [legacyText(message)]);
      const metadata = messageMetadata(
        anyTime(message.create_time) ?? undefined,
        role === "assistant" ? modelName(model) : undefined,
      );

      return (
        textMessage(idValue(message.message_id), role, answer, {
          ...(role === "assistant"
            ? replyExtras(thought ? joinTexts(texts.slice(0, -1)) : "", sources)
            : {}),
          ...metadata,
        }) ?? []
      );
    });
}

/*
 * ---------------------------------------------------------
 * CONVERSATION LIST
 * ---------------------------------------------------------
 *
 * The cursor is the list's conv_version: 0 for the newest page.
 */
export function doubaoListBody(cursor: string | null, sequenceId: string): string {
  const version = Number(cursor) || 0;
  const first = version === 0;

  return request(
    3200,
    {
      pull_recent_conv_chain_uplink_body: {
        limit: 20,
        message_count_per_conv: 10,
        api_version: 1,
        conv_version: version,
        direction: first ? 3 : 1,
        option: {
          not_need_message: true,
          need_complete_conversation: true,
          need_coco_conversation: first,
          need_coco_bot: first,
          need_pc_pin_chain: true,
          pc_pin_query_type: 0,
        },
      },
    },
    sequenceId,
  );
}

export function parseDoubaoConversationList(data: unknown): SiteConversationPage {
  const body = downlink(data, "pull_recent_conv_chain_downlink_body");
  const cells = records(body.cells);
  const conversations = cells.flatMap((cell) => {
    const conversation = record(cell.conversation);
    const id = safeId(conversation.conversation_id ?? cell.id);

    return id
      ? [
          {
            id,
            title: stringValue(conversation.name).trim(),
            createdAt: anyTime(conversation.create_time),
            updatedAt:
              anyTime(conversation.update_time) ?? anyTime(conversation.create_time),
          },
        ]
      : [];
  });
  const next = idValue(body.next_conv_version);

  return {
    conversations,
    nextCursor: body.has_more === true && next && next !== "0" && cells.length > 0 ? next : null,
  };
}
