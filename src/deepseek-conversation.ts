/*
 * =========================================================
 * AI Exporter - deepseek-conversation.ts
 * =========================================================
 *
 * Turns a chat.deepseek.com conversation, as the web app's own
 * API returns it, into the messages content.ts hands to popup.ts.
 *
 *   GET /api/v0/chat/history_messages?chat_session_id={id}
 *   GET /api/v0/chat_session/fetch_page?count=50
 *       [&lte_cursor.pinned=0|1&lte_cursor.updated_at={seconds}]
 *
 * Both answer { code, msg, data: { biz_code, biz_msg, biz_data } }
 * and want the token the web app keeps in localStorage
 * ("userToken") as a Bearer header.
 *
 * A conversation keeps every branch - a regenerated answer, an
 * edited question - in chat_messages, each message pointing at its
 * parent; chat_session.current_message_id ends the branch on
 * screen. A message is made of fragments: REQUEST (the question),
 * RESPONSE (the answer), THINK (DeepThink's reasoning), SEARCH,
 * TOOL_SEARCH and TOOL_OPEN (web search results), FILE (uploads)
 * and a few more. Older messages have `content`, `thinking_content`
 * and `search_results` instead. An answer cites a search result as
 * "[citation:3]" (or "[reference:3]"), by its cite_index.
 *
 * Field names follow the web app's API as open-source exporters
 * read it (pionxzh/deepseek-exporter among them); everything is
 * read defensively, since the API is undocumented.
 *
 * Imported only by content.ts, so Rollup inlines it into
 * content.js - see the top of claude-conversation.ts.
 */
import {
  ReplySources,
  replyExtras,
  type ReplySource,
} from "./reply-sources.ts";

export interface DeepSeekImage {
  /* The file's address; null if none was given. */
  url: string | null;
  fileName: string;
}

export type DeepSeekMessagePart =
  | { kind: "text"; text: string }
  | { kind: "image"; image: DeepSeekImage };

export interface DeepSeekExportMessage {
  id: string;
  role: "user" | "assistant";
  parts: DeepSeekMessagePart[];
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

function idValue(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : "";
}

const UNEXPECTED_FORMAT_ERROR =
  "DeepSeek returned an unexpected conversation format.";

/*
 * ---------------------------------------------------------
 * IDS, TOKEN AND REQUESTS
 * ---------------------------------------------------------
 */

/* Conversations live at /a/chat/s/{id} */
const CONVERSATION_PATH_PATTERN = /^\/a\/[A-Za-z0-9_-]+\/s\/([A-Za-z0-9_-]{1,128})\/?$/;

export function getDeepSeekConversationId(pathname: string): string | null {
  return pathname.match(CONVERSATION_PATH_PATTERN)?.[1] ?? null;
}

/*
 * The token as the web app stores it: plain, a JSON string, or
 * wrapped in { value } (sometimes twice).
 */
export function readDeepSeekToken(raw: string | null): string | null {
  if (!raw) {
    return null;
  }

  const find = (value: unknown, depth = 0): string | null => {
    if (depth > 3) {
      return null;
    }

    if (typeof value === "string") {
      return value.trim() || null;
    }

    if (!isRecord(value)) {
      return null;
    }

    return (
      find(value.value, depth + 1) ??
      find(value.token, depth + 1) ??
      find(value.access_token, depth + 1) ??
      find(value.accessToken, depth + 1)
    );
  };

  try {
    return find(JSON.parse(raw));
  } catch {
    return raw.trim() || null;
  }
}

/* The headers the web app's own requests carry */
export function deepSeekHeaders(
  token: string,
  locale: string,
  timezoneOffsetMinutes: number,
): Record<string, string> {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
    "x-client-bundle-id": "com.deepseek.chat",
    "x-client-platform": "web",
    "x-client-version": "2.3.0",
    "x-client-locale": locale.replace("-", "_"),
    "x-client-timezone-offset": String(-timezoneOffsetMinutes * 60),
  };
}

export function buildDeepSeekHistoryPath(conversationId: string): string {
  return `/api/v0/chat/history_messages?${new URLSearchParams({
    chat_session_id: conversationId,
  }).toString()}`;
}

export interface DeepSeekListCursor {
  pinned: number;
  updatedAt: number;
}

export function buildDeepSeekListPath(
  count: number,
  cursor: DeepSeekListCursor | null,
): string {
  const params = new URLSearchParams({ count: String(count) });

  if (cursor) {
    params.set("lte_cursor.pinned", String(cursor.pinned));
    params.set("lte_cursor.updated_at", String(cursor.updatedAt));
  }

  return `/api/v0/chat_session/fetch_page?${params.toString()}`;
}

/*
 * The answer's biz_data - or an error with DeepSeek's own message
 * ("Please log in", say) when it reports one.
 */
export function unwrapDeepSeekResponse(payload: unknown): unknown {
  if (!isRecord(payload)) {
    throw new Error(UNEXPECTED_FORMAT_ERROR);
  }

  const ok = (code: unknown) => code === undefined || code === null || Number(code) === 0;

  if (!ok(payload.code)) {
    throw new Error(stringValue(payload.msg) || "DeepSeek refused the request.");
  }

  const data = payload.data;

  if (isRecord(data) && "biz_code" in data) {
    if (!ok(data.biz_code)) {
      throw new Error(stringValue(data.biz_msg) || "DeepSeek refused the request.");
    }

    return data.biz_data;
  }

  return data;
}

/* DeepSeek's times are Unix seconds (sometimes milliseconds) */
function toMilliseconds(value: unknown): number | null {
  const number = typeof value === "string" ? Number(value) : value;

  if (typeof number === "number" && Number.isFinite(number) && number > 0) {
    return number > 1e11 ? Math.round(number) : Math.round(number * 1000);
  }

  if (typeof value === "string" && value) {
    const parsed = Date.parse(value);

    return Number.isNaN(parsed) ? null : parsed;
  }

  return null;
}

/*
 * ---------------------------------------------------------
 * CONVERSATION LIST
 * ---------------------------------------------------------
 *
 * A page of the sidebar: chat_sessions, newest first (pinned ones
 * on top), and has_more. The next page starts at the last
 * session's pinned flag and update time.
 */
export interface DeepSeekConversationSummary {
  id: string;
  title: string;
  createdAt: number | null;
  updatedAt: number | null;
}

export function parseDeepSeekSessionList(data: unknown): {
  conversations: DeepSeekConversationSummary[];
  nextCursor: DeepSeekListCursor | null;
} {
  if (!isRecord(data) || !Array.isArray(data.chat_sessions)) {
    throw new Error("DeepSeek returned an unexpected chat list format.");
  }

  const sessions = records(data.chat_sessions).filter((session) =>
    idValue(session.id),
  );
  const last = sessions[sessions.length - 1];
  const lastUpdated = last ? Number(last.updated_at) : NaN;

  return {
    conversations: sessions.map((session) => {
      const createdAt = toMilliseconds(session.inserted_at);

      return {
        id: idValue(session.id),
        title: stringValue(session.title).trim(),
        createdAt,
        updatedAt: toMilliseconds(session.updated_at) ?? createdAt,
      };
    }),
    nextCursor:
      data.has_more === true && last && Number.isFinite(lastUpdated)
        ? { pinned: last.pinned ? 1 : 0, updatedAt: lastUpdated }
        : null,
  };
}

/*
 * ---------------------------------------------------------
 * ACTIVE BRANCH
 * ---------------------------------------------------------
 */
function activeBranch(
  session: Record<string, unknown>,
  messages: Record<string, unknown>[],
): Record<string, unknown>[] {
  const byId = new Map(messages.map((message) => [idValue(message.message_id), message]));
  let currentId = idValue(session.current_message_id);

  // Without a (known) current message, the newest leaf ends the branch.
  if (!byId.has(currentId)) {
    const parents = new Set(messages.map((message) => idValue(message.parent_id)));
    const leaves = messages.filter(
      (message) => !parents.has(idValue(message.message_id)),
    );

    currentId = idValue(
      [...(leaves.length > 0 ? leaves : messages)].sort(
        (a, b) =>
          (toMilliseconds(a.inserted_at) ?? 0) - (toMilliseconds(b.inserted_at) ?? 0),
      ).at(-1)?.message_id,
    );
  }

  const branch: Record<string, unknown>[] = [];
  const visited = new Set<string>();

  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);

    const message = byId.get(currentId);

    if (!message) {
      break;
    }

    branch.push(message);
    currentId = idValue(message.parent_id);
  }

  return branch.reverse();
}

/*
 * ---------------------------------------------------------
 * MESSAGES
 * ---------------------------------------------------------
 */
function fragmentType(fragment: Record<string, unknown>): string {
  return stringValue(fragment.type).toUpperCase();
}

function trimText(text: string): string {
  return text.replace(/^(?:[ \t]*\n)+/, "").trimEnd();
}

/*
 * A message's files: uploads at `files`, or in FILE fragments.
 * Images become image parts; other files are listed by name.
 */
function fileParts(message: Record<string, unknown>): DeepSeekMessagePart[] {
  const files = [
    ...records(message.files),
    ...records(message.fragments)
      .filter((fragment) => fragmentType(fragment) === "FILE")
      .flatMap((fragment) => [...records(fragment.files), ...records([fragment.file])]),
  ];

  return files.map((file): DeepSeekMessagePart => {
    const fileName =
      (stringValue(file.file_name) || stringValue(file.filename) || stringValue(file.name)).trim() ||
      "file";
    const mimeType = stringValue(file.mime_type) || stringValue(file.mimetype);
    const isImage =
      file.is_image === true ||
      mimeType.startsWith("image/") ||
      /\.(?:avif|bmp|gif|jpe?g|png|webp)$/i.test(fileName);

    if (!isImage) {
      return { kind: "text", text: `[Attachment: ${fileName}]` };
    }

    return {
      kind: "image",
      image: { url: deepSeekFileUrl(file), fileName },
    };
  });
}

/*
 * An upload's address. The API gives paths like "/file?...", which
 * belong to DeepSeek's separate file service rather than the chat
 * site; images are shown in its preview ("p") size.
 */
function deepSeekFileUrl(file: Record<string, unknown>): string | null {
  const path = stringValue(file.signed_path) || stringValue(file.url);

  if (!path) {
    return null;
  }

  try {
    if (/^\/file(?:\?|$)/.test(path)) {
      const url = new URL(`https://files.deepseeksvc.com/api${path}`);

      if (!url.searchParams.has("ty")) {
        url.searchParams.set("ty", "p");
      }

      return url.href;
    }

    const url = new URL(path, "https://chat.deepseek.com");

    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/*
 * The web pages an answer's search found, by the number its
 * citations use (cite_index) - from SEARCH and TOOL fragments, or
 * an older message's search_results. A list numbered from 0 is
 * cited from 0 as well.
 */
function searchResults(message: Record<string, unknown>): Map<number, { url: unknown; title: string }> {
  const found: { index: number | null; url: unknown; title: string }[] = [];

  const collect = (node: unknown, depth: number): void => {
    if (depth > 6) {
      return;
    }

    if (Array.isArray(node)) {
      node.forEach((child) => collect(child, depth + 1));
      return;
    }

    if (!isRecord(node)) {
      return;
    }

    if (typeof node.url === "string") {
      const index =
        typeof node.cite_index === "number"
          ? node.cite_index
          : typeof node.index === "number"
            ? node.index
            : null;

      found.push({
        index,
        url: node.url,
        title: stringValue(node.title) || stringValue(node.site_name),
      });
    }

    for (const child of Object.values(node)) {
      if (typeof child === "object") {
        collect(child, depth + 1);
      }
    }
  };

  for (const fragment of records(message.fragments)) {
    if (["SEARCH", "TOOL_SEARCH", "TOOL_OPEN"].includes(fragmentType(fragment))) {
      collect(fragment, 0);
    }
  }

  collect(message.search_results, 0);

  const results = new Map<number, { url: unknown; title: string }>();
  // Without cite_index, results are cited by their place, from 1.
  const numbered = found.some((result) => result.index !== null);

  found.forEach((result, position) => {
    const index = result.index ?? (numbered ? position : position + 1);
    const known = results.get(index);

    if (!known) {
      results.set(index, { url: result.url, title: result.title });
    } else if (!known.title && result.title && known.url === result.url) {
      known.title = result.title;
    }
  });

  return results;
}

const CITATION_MARKER_RE = /\[(?:citation|reference):(\d+)\]/gi;

/*
 * The answer with its citations as notes. A list numbered from 0
 * is cited from 0 too, so the numbers are read the way the list
 * counts.
 */
function answerWithNotes(
  text: string,
  results: Map<number, { url: unknown; title: string }>,
  sources: ReplySources,
): string {
  return text.replace(
    new RegExp(`[ \\t]*(?:${CITATION_MARKER_RE.source})+`, "gi"),
    (markers) => {
      const numbers = [...markers.matchAll(CITATION_MARKER_RE)].map((match) => {
        const result = results.get(Number(match[1]));

        return result ? sources.add(result.url, result.title) : null;
      });

      return sources.note(numbers);
    },
  );
}

function messageText(
  message: Record<string, unknown>,
  accepted: readonly string[],
): string {
  const parts = records(message.fragments)
    .filter((fragment) => accepted.includes(fragmentType(fragment)))
    .map((fragment) => trimText(stringValue(fragment.content)))
    .filter(Boolean);

  return parts.length > 0 ? parts.join("\n\n") : trimText(stringValue(message.content));
}

function messageThinking(message: Record<string, unknown>): string {
  const thoughts = records(message.fragments)
    .filter((fragment) => fragmentType(fragment) === "THINK")
    .map((fragment) => trimText(stringValue(fragment.content)))
    .filter(Boolean);

  return thoughts.length > 0
    ? thoughts.join("\n\n")
    : trimText(stringValue(message.thinking_content));
}

/*
 * The conversation on screen, oldest first, from the biz_data of
 * a history_messages answer.
 */
export function convertDeepSeekConversation(data: unknown): DeepSeekExportMessage[] {
  if (!isRecord(data) || !Array.isArray(data.chat_messages)) {
    throw new Error(UNEXPECTED_FORMAT_ERROR);
  }

  const session = isRecord(data.chat_session) ? data.chat_session : {};
  const messages: DeepSeekExportMessage[] = [];

  for (const message of activeBranch(session, records(data.chat_messages))) {
    const id = idValue(message.message_id);
    const role = stringValue(message.role).toUpperCase();

    if (role === "USER") {
      const text = messageText(message, ["REQUEST"]);
      const parts: DeepSeekMessagePart[] = [
        ...fileParts(message),
        ...(text ? [{ kind: "text" as const, text }] : []),
      ];

      if (parts.length > 0) {
        messages.push({ id, role: "user", parts });
      }

      continue;
    }

    if (role !== "ASSISTANT") {
      continue;
    }

    const sources = new ReplySources();
    const text = answerWithNotes(
      messageText(message, ["RESPONSE", "TEMPLATE_RESPONSE"]),
      searchResults(message),
      sources,
    );

    if (text) {
      messages.push({
        id,
        role: "assistant",
        parts: [{ kind: "text", text }],
        ...replyExtras(messageThinking(message), sources),
      });
    }
  }

  return messages;
}
