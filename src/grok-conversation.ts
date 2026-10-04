/*
 * =========================================================
 * AI Exporter - grok-conversation.ts
 * =========================================================
 *
 * Turns a grok.com conversation, as the web app's own API returns
 * it, into the messages content.ts hands to popup.ts. Requests are
 * authenticated by the session cookies alone:
 *
 *   GET  /rest/app-chat/conversations/{id}/response-node
 *        ?includeThreads=true
 *        -> { responseNodes: [{ responseId, sender,
 *             parentResponseId }] }
 *   POST /rest/app-chat/conversations/{id}/load-responses
 *        { responseIds: [...] }
 *        -> { responses: [{ responseId, message, sender,
 *             createTime, parentResponseId, webSearchResults,
 *             cardAttachmentsJson, steps, thinkingTrace, ... }] }
 *   GET  /rest/app-chat/conversations?pageSize=60[&pageToken=...]
 *        -> { conversations: [{ conversationId, title,
 *             createTime, modifyTime }], nextPageToken }
 *
 * Every branch - a regenerated reply, an edited prompt - is in the
 * list, each response pointing at its parent. The page's address
 * names the reply on screen when it isn't the newest (?rid=...);
 * otherwise the newest leaf ends the branch.
 *
 * A reply's text carries Grok's own markup. An inline citation is
 * <grok:render card_id="..." type="render_inline_citation">...
 * </grok:render>, its card_id naming an entry of
 * cardAttachmentsJson - JSON strings with the cited url. Titles
 * come from the web search results of the reply (webSearchResults)
 * and of its search steps (steps[].toolUsageResults). Tool cards
 * (<xai:tool_usage_card>) are left out.
 *
 * Field names follow captured responses and open-source exporters;
 * everything is read defensively, since the API is undocumented.
 * Imported only by content.ts, so Rollup inlines it into
 * content.js - see the top of claude-conversation.ts.
 */
import {
  ReplySources,
  isWebAddress,
  replyExtras,
  type ReplySource,
} from "./reply-sources.ts";

export interface GrokImage {
  url: string | null;
  fileName: string;
}

export type GrokMessagePart =
  | { kind: "text"; text: string }
  | { kind: "image"; image: GrokImage };

export interface GrokExportMessage {
  id: string;
  role: "user" | "assistant";
  parts: GrokMessagePart[];
  thinking?: string;
  sources?: ReplySource[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* Where uploads and generated images are kept */
const ASSETS_ORIGIN = "https://assets.grok.com";

/*
 * ---------------------------------------------------------
 * IDS AND REQUESTS
 * ---------------------------------------------------------
 *
 * Conversations live at /c/{id} (older links: /chat/{id}), with a
 * language in front on some pages (/en/c/{id}).
 */
const CONVERSATION_PATH_PATTERN =
  /^(?:\/[a-z]{2}(?:-[A-Za-z]{2,4})?)?\/(?:c|chat)\/([0-9a-f-]{36})\/?$/i;

export function getGrokConversationId(pathname: string): string | null {
  const id = pathname.match(CONVERSATION_PATH_PATTERN)?.[1];

  return id && UUID_PATTERN.test(id) ? id : null;
}

/* The reply on screen, when the address names one (?rid=...) */
export function getGrokActiveResponseId(search: string): string | null {
  const id = new URLSearchParams(search).get("rid");

  return id && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : null;
}

export function buildGrokNodesPath(conversationId: string): string {
  return `/rest/app-chat/conversations/${encodeURIComponent(conversationId)}/response-node?includeThreads=true`;
}

export function buildGrokLoadPath(conversationId: string): string {
  return `/rest/app-chat/conversations/${encodeURIComponent(conversationId)}/load-responses`;
}

export function buildGrokListPath(pageSize: number, pageToken: string | null): string {
  const params = new URLSearchParams({ pageSize: String(pageSize) });

  if (pageToken) {
    params.set("pageToken", pageToken);
  }

  return `/rest/app-chat/conversations?${params.toString()}`;
}

/* Every response's id, every branch included */
export function parseGrokResponseNodes(data: unknown): string[] {
  if (!isRecord(data) || !Array.isArray(data.responseNodes)) {
    throw new Error("Grok returned an unexpected conversation format.");
  }

  return [
    ...new Set(
      records(data.responseNodes)
        .map((node) => stringValue(node.responseId))
        .filter(Boolean),
    ),
  ];
}

export function parseGrokResponses(data: unknown): unknown[] {
  if (!isRecord(data) || !Array.isArray(data.responses)) {
    throw new Error("Grok returned an unexpected conversation format.");
  }

  return data.responses;
}

/*
 * ---------------------------------------------------------
 * CONVERSATION LIST
 * ---------------------------------------------------------
 */
export interface GrokConversationSummary {
  id: string;
  title: string;
  createdAt: number | null;
  updatedAt: number | null;
}

function time(value: unknown): number | null {
  const parsed = Date.parse(stringValue(value));

  return Number.isNaN(parsed) ? null : parsed;
}

export function parseGrokConversationList(data: unknown): {
  conversations: GrokConversationSummary[];
  nextCursor: string | null;
} {
  if (!isRecord(data) || !Array.isArray(data.conversations)) {
    throw new Error("Grok returned an unexpected chat list format.");
  }

  return {
    conversations: records(data.conversations)
      .filter((conversation) => stringValue(conversation.conversationId))
      .map((conversation) => {
        const createdAt = time(conversation.createTime);

        return {
          id: stringValue(conversation.conversationId),
          title: stringValue(conversation.title).trim(),
          createdAt,
          updatedAt: time(conversation.modifyTime) ?? createdAt,
        };
      }),
    nextCursor: stringValue(data.nextPageToken) || null,
  };
}

/*
 * ---------------------------------------------------------
 * ACTIVE BRANCH
 * ---------------------------------------------------------
 */
function activeBranch(
  responses: Record<string, unknown>[],
  activeResponseId: string | null,
): Record<string, unknown>[] {
  const byId = new Map(
    responses.map((response) => [stringValue(response.responseId), response]),
  );
  let currentId = activeResponseId && byId.has(activeResponseId) ? activeResponseId : "";

  if (!currentId) {
    const parents = new Set(
      responses.map((response) => stringValue(response.parentResponseId)),
    );
    const leaves = responses.filter(
      (response) => !parents.has(stringValue(response.responseId)),
    );

    currentId = stringValue(
      [...(leaves.length > 0 ? leaves : responses)]
        .sort((a, b) => (time(a.createTime) ?? 0) - (time(b.createTime) ?? 0))
        .at(-1)?.responseId,
    );
  }

  const branch: Record<string, unknown>[] = [];
  const visited = new Set<string>();

  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);

    const response = byId.get(currentId);

    if (!response) {
      break;
    }

    branch.push(response);
    currentId = stringValue(response.parentResponseId);
  }

  return branch.reverse();
}

/*
 * ---------------------------------------------------------
 * REPLIES
 * ---------------------------------------------------------
 */

/* The web pages a reply's searches found, by link */
function searchResultTitles(response: Record<string, unknown>): Map<string, string> {
  const titles = new Map<string, string>();

  const add = (results: unknown): void => {
    for (const result of records(results)) {
      const title = stringValue(result.title).trim();

      if (isWebAddress(result.url) && title && !titles.has(result.url)) {
        titles.set(result.url, title);
      }
    }
  };

  add(response.webSearchResults);
  add(response.citedWebSearchResults);

  for (const step of records(response.steps)) {
    add(step.webSearchResults);

    for (const usage of records(step.toolUsageResults)) {
      const results = isRecord(usage.webSearchResults)
        ? usage.webSearchResults.results
        : usage.webSearchResults;

      add(results);
    }
  }

  return titles;
}

/* The cited pages, by citation card id */
function citationCards(response: Record<string, unknown>): Map<string, string> {
  const cards = new Map<string, string>();

  for (const entry of Array.isArray(response.cardAttachmentsJson)
    ? response.cardAttachmentsJson
    : []) {
    try {
      const card: unknown = typeof entry === "string" ? JSON.parse(entry) : entry;

      if (isRecord(card) && stringValue(card.id) && isWebAddress(card.url)) {
        cards.set(stringValue(card.id), card.url);
      }
    } catch {
      /* A card that isn't JSON */
    }
  }

  return cards;
}

const GROK_RENDER_RE = /[ \t]*<grok:render\b([^>]*)>([\s\S]*?)<\/grok:render>/g;
const XAI_TAG_RE = /<xai:([\w-]+)\b[^>]*>[\s\S]*?<\/xai:\1>|<\/?xai:[\w-]+[^>]*>/g;

function attribute(attributes: string, name: string): string {
  return attributes.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? "";
}

/*
 * The reply's text with its citations as notes and Grok's other
 * markup taken out.
 */
function replyText(
  response: Record<string, unknown>,
  sources: ReplySources,
): string {
  const cards = citationCards(response);
  const titles = searchResultTitles(response);

  return stringValue(response.message)
    .replace(GROK_RENDER_RE, (_match, attributes: string) => {
      if (attribute(attributes, "type") !== "render_inline_citation") {
        return "";
      }

      const url = cards.get(attribute(attributes, "card_id"));

      return url ? sources.note([sources.add(url, titles.get(url))]) : "";
    })
    .replace(XAI_TAG_RE, "")
    .replace(/^(?:[ \t]*\n)+/, "")
    .trimEnd();
}

/*
 * The reasoning: the trace a thinking model wrote, or else the
 * text of its steps that aren't tool calls.
 */
function replyThinking(response: Record<string, unknown>): string {
  const trace = stringValue(response.thinkingTrace).trim();

  if (trace) {
    return trace;
  }

  return records(response.steps)
    .filter((step) => {
      const tags = Array.isArray(step.tags) ? step.tags : [];
      return !tags.some((tag) => tag === "tool_usage_card" || tag === "raw_function_result");
    })
    .flatMap((step) => (Array.isArray(step.text) ? step.text : [step.text]))
    .map((text) => stringValue(text).replace(XAI_TAG_RE, "").trim())
    .filter(Boolean)
    .join("\n\n");
}

function assetUrl(path: unknown): string | null {
  const value = stringValue(path);

  if (!value) {
    return null;
  }

  try {
    const url = new URL(value.replace(/^\/+/, ""), `${ASSETS_ORIGIN}/`);

    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/* Uploads: pictures to download, other files by name */
function attachmentParts(response: Record<string, unknown>): GrokMessagePart[] {
  const parts: GrokMessagePart[] = [];

  for (const file of records(response.fileAttachmentsMetadata)) {
    const fileName = stringValue(file.fileName).trim() || "file";

    parts.push(
      stringValue(file.fileMimeType).startsWith("image/")
        ? { kind: "image", image: { url: assetUrl(file.fileUri), fileName } }
        : { kind: "text", text: `[Attachment: ${fileName}]` },
    );
  }

  for (const image of Array.isArray(response.imageAttachments) ? response.imageAttachments : []) {
    const url = isRecord(image) ? assetUrl(image.url ?? image.fileUri) : assetUrl(image);

    if (url) {
      parts.push({ kind: "image", image: { url, fileName: "image" } });
    }
  }

  return parts;
}

/*
 * Takes load-responses' responses, every branch included, and
 * returns the conversation on screen, oldest first.
 */
export function convertGrokResponses(
  responses: unknown[],
  activeResponseId: string | null,
): GrokExportMessage[] {
  const messages: GrokExportMessage[] = [];

  for (const response of activeBranch(records(responses), activeResponseId)) {
    const id = stringValue(response.responseId);
    const isUser = stringValue(response.sender).toLowerCase() === "human";

    if (isUser) {
      const text = stringValue(response.message).replace(/^(?:[ \t]*\n)+/, "").trimEnd();
      const parts: GrokMessagePart[] = [
        ...attachmentParts(response),
        ...(text ? [{ kind: "text" as const, text }] : []),
      ];

      if (parts.length > 0) {
        messages.push({ id, role: "user", parts });
      }

      continue;
    }

    const sources = new ReplySources();
    const text = replyText(response, sources);

    // Pages the reply was given but didn't cite come after the cited ones.
    for (const result of records(response.webSearchResults)) {
      sources.add(result.url, result.title);
    }

    const parts: GrokMessagePart[] = [
      ...(text ? [{ kind: "text" as const, text }] : []),
      ...(Array.isArray(response.generatedImageUrls) ? response.generatedImageUrls : [])
        .map((path) => assetUrl(path))
        .filter((url): url is string => url !== null)
        .map((url): GrokMessagePart => ({ kind: "image", image: { url, fileName: "image" } })),
    ];

    if (parts.length > 0) {
      messages.push({
        id,
        role: "assistant",
        parts,
        ...replyExtras(replyThinking(response), sources),
      });
    }
  }

  return messages;
}
