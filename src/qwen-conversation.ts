/*
 * =========================================================
 * AI Exporter - qwen-conversation.ts
 * =========================================================
 *
 * Turns conversations from Qwen Chat (chat.qwen.ai) and Z.ai
 * (chat.z.ai, Zhipu's GLM) into the messages content.ts hands to
 * popup.ts. Both web apps grew out of Open WebUI and keep a chat
 * the same way: every message, branches included, in
 * chat.history.messages (each pointing at its parentId), with
 * chat.history.currentId ending the branch on screen.
 *
 * Qwen Chat - session cookie, and a "source: web" header:
 *   GET /api/v2/chats/{id}             { data: { chat, created_at } }
 *   GET /api/v2/chats/?page={n}&exclude_project=true   the list
 * A reply's content_list holds its phases: "think" (reasoning),
 * "thinking_summary" and "answer".
 *
 * Z.ai - the token the web app keeps in localStorage ("token"):
 *   GET  /api/v1/chats/{id}                   the message tree
 *   POST /api/v1/chats/{id}/messages/batch    { ids } -> contents
 *   GET  /api/v1/chats/?page={n}&type=default the list
 * A message's content_blocks are "text", "reasoning" and
 * "tool_calls"; a reply cites a search result as 【turn0search1】,
 * which the tool call's result names "[ref_id=turn0search1†title†url]".
 *
 * Field names follow the web apps' APIs as open-source exporters
 * read them; everything is read defensively, since the APIs are
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
  type SiteConversationSummary,
  type SiteMessage,
} from "./site-json.ts";

/* Both sites keep conversations at /c/{id} */
export function getQwenConversationId(pathname: string): string | null {
  return pathname.match(/^\/c\/([A-Za-z0-9_-]{8,128})\/?$/)?.[1] ?? null;
}

export const QWEN_HEADERS: Record<string, string> = { source: "web" };

export function buildQwenChatPath(id: string): string {
  return `/api/v2/chats/${encodeURIComponent(id)}`;
}

export function buildZaiChatPath(id: string): string {
  return `/api/v1/chats/${encodeURIComponent(id)}`;
}

export function buildZaiBatchPath(id: string): string {
  return `/api/v1/chats/${encodeURIComponent(id)}/messages/batch`;
}

/*
 * ---------------------------------------------------------
 * ACTIVE BRANCH
 * ---------------------------------------------------------
 *
 * The messages from the first to history.currentId - or, without
 * a usable tree, chat.messages in their order.
 */
export function activeChain(chat: Record<string, unknown>): Record<string, unknown>[] {
  const history = record(chat.history);
  const tree = record(history.messages);
  const chain: Record<string, unknown>[] = [];
  const visited = new Set<string>();
  let current = idValue(history.currentId);

  while (current && !visited.has(current) && isRecord(tree[current])) {
    visited.add(current);

    const message: Record<string, unknown> = {
      id: current,
      ...(tree[current] as Record<string, unknown>),
    };

    chain.push(message);
    current = idValue(message.parentId);
  }

  if (chain.length > 0) {
    return chain.reverse();
  }

  return records(chat.messages);
}

/*
 * ---------------------------------------------------------
 * QWEN CHAT
 * ---------------------------------------------------------
 */
function qwenReply(message: Record<string, unknown>): { thinking: string; answer: string } {
  const thoughts: string[] = [stringValue(message.reasoning_content)];
  const answers: string[] = [];
  const list = records(message.content_list);

  for (const item of list) {
    const phase = stringValue(item.phase).toLowerCase();

    if (phase === "think") {
      thoughts.push(stringValue(item.content));
    } else if (phase === "thinking_summary") {
      const extra = record(item.extra);
      const title = record(extra.summary_title).content;
      const lines = record(extra.summary_thought).content;

      thoughts.push(
        [
          ...(Array.isArray(title) && title.length > 0 ? [`**${title.join(" ")}**`] : []),
          ...(Array.isArray(lines) ? lines.map((line) => `- ${String(line)}`) : []),
        ].join("\n"),
      );
    } else if (phase === "answer") {
      answers.push(stringValue(item.content));
    }
  }

  if (list.length === 0) {
    answers.push(stringValue(message.content));
  }

  return {
    thinking: joinTexts([...new Set(thoughts.map((text) => text.trim()))]),
    answer: joinTexts([...new Set(answers.map((text) => text.trim()))]),
  };
}

function messageModel(message: Record<string, unknown>): string | undefined {
  const models = message.models;

  return modelName(
    stringValue(message.modelName) ||
      stringValue(message.model) ||
      (Array.isArray(models) ? models[0] : undefined),
  );
}

export function convertQwenChat(data: unknown): SiteMessage[] {
  const payload = record(isRecord(data) && "data" in data ? data.data : data);
  const chat = record(payload.chat);

  if (!isRecord(payload.chat)) {
    throw unexpectedFormat("Qwen");
  }

  return activeChain(chat).flatMap((message) => {
    const role = stringValue(message.role);
    const id = idValue(message.id);
    const time = anyTime(message.timestamp) ?? undefined;

    if (role === "user") {
      return textMessage(id, "user", stringValue(message.content), messageMetadata(time)) ?? [];
    }

    if (role !== "assistant") {
      return [];
    }

    const { thinking, answer } = qwenReply(message);

    return (
      textMessage(id, "assistant", answer, {
        ...replyExtras(thinking, new ReplySources()),
        ...messageMetadata(time, messageModel(message)),
      }) ?? []
    );
  });
}

function listPage(
  items: Record<string, unknown>[],
  page: number,
): SiteConversationPage {
  const conversations: SiteConversationSummary[] = items.flatMap((chat) => {
    const id = safeId(chat.id);

    return id
      ? [
          {
            id,
            title: stringValue(chat.title).trim(),
            createdAt: anyTime(chat.created_at),
            updatedAt: anyTime(chat.updated_at) ?? anyTime(chat.created_at),
          },
        ]
      : [];
  });

  return {
    conversations,
    nextCursor: items.length > 0 ? String(page + 1) : null,
  };
}

/* The cursor is the page number, from 1 */
export function listPageNumber(cursor: string | null): number {
  const page = Number(cursor);

  return Number.isInteger(page) && page > 0 ? page : 1;
}

export function buildQwenListPath(cursor: string | null): string {
  return `/api/v2/chats/?page=${listPageNumber(cursor)}&exclude_project=true`;
}

export function parseQwenConversationList(data: unknown, cursor: string | null): SiteConversationPage {
  const items = isRecord(data) ? data.data : data;

  if (!Array.isArray(items)) {
    throw new Error("Qwen returned an unexpected chat list format.");
  }

  return listPage(records(items), listPageNumber(cursor));
}

/*
 * ---------------------------------------------------------
 * Z.AI
 * ---------------------------------------------------------
 */

/* The ids of the active branch, whose contents the batch request gets */
export function zaiMessageIds(data: unknown): string[] {
  const chat = record(record(data).chat);

  if (!isRecord(record(data).chat)) {
    throw unexpectedFormat("Z.ai");
  }

  return activeChain(chat).map((message) => idValue(message.id)).filter(Boolean);
}

const ZAI_CITATION = /【(turn\d+search\d+)】/g;
const ZAI_REFERENCE = /\[ref_id=(turn\d+search\d+)†([^†]*)†([^\]\s]+)\]/g;

function zaiBlocks(message: Record<string, unknown>, type: string): string {
  return joinTexts(
    records(message.content_blocks)
      .filter((block) => block.type === type)
      .map((block) => stringValue(block.content)),
  );
}

/* What each 【turn0search1】 stands for, from the search tool's results */
function zaiReferences(message: Record<string, unknown>): Map<string, { title: string; url: string }> {
  const references = new Map<string, { title: string; url: string }>();

  for (const block of records(message.content_blocks)) {
    if (block.type !== "tool_calls") {
      continue;
    }

    for (const result of records(block.results)) {
      for (const [, key, title, url] of stringValue(result.content).matchAll(ZAI_REFERENCE)) {
        references.set(key, { title: title.trim(), url: url.trim() });
      }
    }
  }

  return references;
}

/*
 * The conversation: the tree from GET /api/v1/chats/{id}, with the
 * contents the batch request returned by message id.
 */
export function convertZaiChat(data: unknown, contents: unknown): SiteMessage[] {
  const payload = record(data);
  const chat = record(payload.chat);
  const byId = record(isRecord(contents) && "data" in contents ? contents.data : contents);
  const models = chat.models;
  const model = modelName(Array.isArray(models) ? models[0] : undefined);

  return activeChain(chat).flatMap((node) => {
    const id = idValue(node.id);
    const message = { ...node, ...record(byId[id]) };
    const role = stringValue(message.role);
    const time = anyTime(message.timestamp) ?? undefined;

    if (role === "user") {
      return textMessage(id, "user", stringValue(message.content), messageMetadata(time)) ?? [];
    }

    if (role !== "assistant") {
      return [];
    }

    const references = zaiReferences(message);
    const sources = new ReplySources();
    const cite = (_: string, key: string) => {
      const page = references.get(key);

      return page ? sources.note([sources.add(page.url, page.title)]) : "";
    };
    const answer =
      zaiBlocks(message, "text") || stringValue(message.content);

    return (
      textMessage(id, "assistant", answer.replace(ZAI_CITATION, cite), {
        ...replyExtras(zaiBlocks(message, "reasoning").replace(ZAI_CITATION, cite), sources),
        ...messageMetadata(time, model),
      }) ?? []
    );
  });
}

export function buildZaiListPath(cursor: string | null): string {
  return `/api/v1/chats/?page=${listPageNumber(cursor)}&type=default`;
}

export function parseZaiConversationList(data: unknown, cursor: string | null): SiteConversationPage {
  if (!Array.isArray(data)) {
    throw new Error("Z.ai returned an unexpected chat list format.");
  }

  return listPage(records(data), listPageNumber(cursor));
}
