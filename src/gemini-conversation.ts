/*
 * =========================================================
 * AI Exporter - gemini-conversation.ts
 * =========================================================
 *
 * Turns a gemini.google.com conversation, as returned by the
 * Gemini web app's own API, into the messages content.ts hands
 * to popup.ts.
 *
 * Gemini has no JSON API like ChatGPT's or claude.ai's. Its web
 * app loads a conversation through Google's "batchexecute" RPC
 * endpoint (RPC id hNvQHb): a form POST answered with plain
 * JSON arrays whose fields are identified by position, not by
 * name. One request returns up to ten turns - a prompt and the
 * reply shown for it - newest first, plus a cursor for the
 * next, older ten.
 *
 * The positions read here come from open-source clients of the
 * same RPC (HanaokaYuzu/Gemini-API among them) and from a
 * captured response. Google can move them without notice, so
 * everything is read defensively: a shape this doesn't know
 * yields less content rather than an exception.
 *
 * Imported only by content.ts, so Rollup inlines it into
 * content.js - see the top of claude-conversation.ts.
 */

import {
  ReplySources,
  replyExtras,
  type ReplySource,
} from "./reply-sources.ts";

/*
 * ---------------------------------------------------------
 * EXPORT TYPES
 * ---------------------------------------------------------
 *
 * The same shape claude-conversation.ts produces: a message is
 * a list of parts, so content.ts can swap each image for a
 * downloaded file (or drop it) without knowing anything about
 * Gemini's format.
 */

export interface GeminiImage {
  /* Google image-host URL of the image; null if none was given. */
  url: string | null;
  fileName: string;
}

export type GeminiMessagePart =
  { kind: "text"; text: string } | { kind: "image"; image: GeminiImage };

export interface GeminiExportMessage {
  id: string;
  role: "user" | "assistant";
  parts: GeminiMessagePart[];
  /* The reply's thoughts */
  thinking?: string;
  /* The web pages the reply cites, numbered as its notes are */
  sources?: ReplySource[];
}

/*
 * Values the page's own HTML carries in window.WIZ_global_data
 * (an inline <script data-id="_gd">), named after their keys
 * there. Every batchexecute request needs them.
 */
export interface GeminiPageTokens {
  /* SNlM0e: the XSRF token every POST must carry as `at`. */
  at: string;
  /* cfb2h: the web app's build label, sent as `bl`. */
  buildLabel: string | null;
  /* FdrFJe: the session id, sent as `f.sid`. */
  sessionId: string | null;
  /* TuX5cc: the interface language, sent as `hl`. */
  language: string | null;
}

const GEMINI_READ_CONVERSATION_RPC = "hNvQHb";

/*
 * Turns per page. Asking for more still gets ten at a time back,
 * so this asks for ten, like other clients of this RPC.
 */
const PAGE_TURNS = 10;

const UNEXPECTED_FORMAT_ERROR =
  "Gemini returned an unexpected conversation format.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function at(value: unknown, ...path: number[]): unknown {
  let current = value;

  for (const index of path) {
    if (!Array.isArray(current)) {
      return undefined;
    }

    current = current[index];
  }

  return current;
}

/*
 * ---------------------------------------------------------
 * IDS AND REQUESTS
 * ---------------------------------------------------------
 *
 * Conversations live at /app/{id}, or /gem/{gem}/{id} when
 * started from a Gem, either one under /u/{n} when the person
 * is signed in to several Google accounts and this isn't the
 * first. The RPC names the same conversation "c_{id}".
 */

const CONVERSATION_PATH_PATTERN =
  /^(?:\/u\/\d+)?\/(?:app|gem\/[^/]+)\/([A-Za-z0-9_-]{1,128})\/?$/;

export function getGeminiConversationId(pathname: string): string | null {
  return pathname.match(CONVERSATION_PATH_PATTERN)?.[1] ?? null;
}

export function getGeminiAccountPrefix(pathname: string): string {
  return pathname.match(/^\/u\/\d+(?=\/)/)?.[0] ?? "";
}

const PAGE_TOKEN_PATTERNS = {
  at: /"SNlM0e":\s*"([^"\\]{1,1024})"/,
  buildLabel: /"cfb2h":\s*"([^"\\]{1,256})"/,
  sessionId: /"FdrFJe":\s*"(-?\d{1,32})"/,
  language: /"TuX5cc":\s*"([A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{1,8}){0,3})"/,
};

/*
 * Reads the tokens out of the WIZ_global_data script, or out of
 * a whole Gemini page's HTML. SNlM0e is only there for a
 * signed-in person, so null means signed out (or a page this
 * doesn't recognize).
 */
export function readGeminiPageTokens(source: string): GeminiPageTokens | null {
  const token = source.match(PAGE_TOKEN_PATTERNS.at)?.[1];

  if (!token) {
    return null;
  }

  return {
    at: token,
    buildLabel: source.match(PAGE_TOKEN_PATTERNS.buildLabel)?.[1] ?? null,
    sessionId: source.match(PAGE_TOKEN_PATTERNS.sessionId)?.[1] ?? null,
    language: source.match(PAGE_TOKEN_PATTERNS.language)?.[1] ?? null,
  };
}

export interface GeminiReadRequest {
  /* As in the page URL, without the RPC's "c_" prefix. */
  conversationId: string;
  /* null for the newest page, else the previous page's cursor. */
  cursor: string | null;
  tokens: GeminiPageTokens;
  /* "/u/1" and so on for a secondary Google account, else "". */
  accountPrefix: string;
  /* The page's own path, sent along like the web app does. */
  sourcePath: string;
  /* batchexecute's _reqid: a counter the caller advances. */
  requestId: number;
}

/*
 * The request the web app makes to show a conversation: a form
 * POST of f.req, a JSON-in-JSON envelope naming the RPC and its
 * arguments, and the XSRF token.
 */
export function buildGeminiReadRequest(request: GeminiReadRequest): {
  path: string;
  body: string;
} {
  const rpcConversationId = request.conversationId.startsWith("c_")
    ? request.conversationId
    : `c_${request.conversationId}`;

  return buildBatchRequest(GEMINI_READ_CONVERSATION_RPC, request, [
    rpcConversationId,
    PAGE_TURNS,
    request.cursor,
    1,
    [1],
    [4],
    null,
    1,
  ]);
}

/*
 * A batchexecute call of `rpcId` with `args`, the way the web
 * app makes one.
 */
function buildBatchRequest(
  rpcId: string,
  request: Pick<
    GeminiReadRequest,
    "tokens" | "accountPrefix" | "sourcePath" | "requestId"
  >,
  args: unknown[],
): { path: string; body: string } {
  const params = new URLSearchParams({
    rpcids: rpcId,
    "source-path": request.sourcePath,
  });

  if (request.tokens.buildLabel) {
    params.set("bl", request.tokens.buildLabel);
  }

  if (request.tokens.sessionId) {
    params.set("f.sid", request.tokens.sessionId);
  }

  params.set("hl", request.tokens.language ?? "en");
  params.set("_reqid", String(request.requestId));
  params.set("rt", "c");

  const body = new URLSearchParams({
    "f.req": JSON.stringify([[[rpcId, JSON.stringify(args), null, "generic"]]]),
    at: request.tokens.at,
  });

  return {
    path: `${request.accountPrefix}/_/BardChatUi/data/batchexecute?${params.toString()}`,
    body: body.toString(),
  };
}

/*
 * ---------------------------------------------------------
 * RESPONSES
 * ---------------------------------------------------------
 *
 * batchexecute answers with an anti-JSON-hijacking prefix,
 * ")]}'", and then length-prefixed chunks, each a JSON array on
 * a line of its own. The RPC's result is the chunk entry
 * ["wrb.fr", "hNvQHb", "<the result, as a JSON string>", ...];
 * a failed call has null there and an error code at index 5.
 *
 * The result itself is [turns, cursor, ...]: up to ten turns,
 * newest first, and the cursor for the next (older) page, or
 * null on the last one.
 */

function getResponseChunks(text: string): unknown[] {
  const body = text.replace(/^\)\]\}'/, "");
  const chunks: unknown[] = [];

  for (const line of body.split("\n")) {
    const trimmed = line.trim();

    if (!trimmed.startsWith("[")) {
      continue;
    }

    try {
      chunks.push(JSON.parse(trimmed));
    } catch {
      /* A line that isn't a whole JSON chunk. */
    }
  }

  if (chunks.length === 0) {
    try {
      chunks.push(JSON.parse(body));
    } catch {
      /* Not JSON at all. */
    }
  }

  return chunks;
}

function getRpcResult(
  text: string,
  rpcId = GEMINI_READ_CONVERSATION_RPC,
): unknown {
  for (const chunk of getResponseChunks(text)) {
    if (!Array.isArray(chunk)) {
      continue;
    }

    for (const entry of chunk) {
      if (
        !Array.isArray(entry) ||
        entry[0] !== "wrb.fr" ||
        entry[1] !== rpcId
      ) {
        continue;
      }

      if (typeof entry[2] === "string") {
        try {
          return JSON.parse(entry[2]);
        } catch {
          throw new Error(UNEXPECTED_FORMAT_ERROR);
        }
      }

      const errorCode = at(entry, 5, 0);

      /*
       * 5 is what Gemini answers for a deleted or unknown
       * conversation, 7 when the session may not read it.
       */
      if (errorCode === 5) {
        throw new Error("Gemini could not find this conversation.");
      }

      if (errorCode === 7) {
        throw new Error("Gemini denied access to this conversation.");
      }

      throw new Error(UNEXPECTED_FORMAT_ERROR);
    }
  }

  throw new Error(UNEXPECTED_FORMAT_ERROR);
}

export function parseGeminiTurnsPage(text: string): {
  turns: unknown[];
  nextCursor: string | null;
} {
  const result = getRpcResult(text);

  if (!Array.isArray(result)) {
    throw new Error(UNEXPECTED_FORMAT_ERROR);
  }

  const cursor = result[1];

  return {
    turns: Array.isArray(result[0]) ? result[0] : [],
    nextCursor: typeof cursor === "string" && cursor ? cursor : null,
  };
}

/*
 * ---------------------------------------------------------
 * CONVERSATION LIST
 * ---------------------------------------------------------
 *
 * The sidebar's list of chats comes from RPC MaZiqc, called
 * with [count, cursor, [pinned, null, 1]] - once for pinned
 * chats (1) and once for the rest (0). The result has the next
 * page's cursor at [1] and the chats at [2], each one
 * [id, title, pinned, ..., [seconds, nanos] at [5]]; the id has
 * the RPC's "c_" prefix, which the page URL leaves out.
 */

const GEMINI_LIST_CONVERSATIONS_RPC = "MaZiqc";

export interface GeminiListRequest
  extends Pick<
    GeminiReadRequest,
    "tokens" | "accountPrefix" | "sourcePath" | "requestId"
  > {
  pinned: boolean;
  pageSize: number;
  cursor: string | null;
}

export function buildGeminiListRequest(request: GeminiListRequest): {
  path: string;
  body: string;
} {
  return buildBatchRequest(GEMINI_LIST_CONVERSATIONS_RPC, request, [
    request.pageSize,
    request.cursor,
    [request.pinned ? 1 : 0, null, 1],
  ]);
}

export interface GeminiConversationSummary {
  /* As in the page URL, without the "c_" prefix. */
  id: string;
  title: string;
  /* Milliseconds since the epoch, when the chat was last used. */
  updatedAt: number | null;
}

export function parseGeminiConversationList(text: string): {
  conversations: GeminiConversationSummary[];
  nextCursor: string | null;
} {
  const result = getRpcResult(text, GEMINI_LIST_CONVERSATIONS_RPC);

  if (!Array.isArray(result)) {
    throw new Error("Gemini returned an unexpected chat list format.");
  }

  const conversations: GeminiConversationSummary[] = [];

  for (const chat of Array.isArray(result[2]) ? result[2] : []) {
    const rawId = stringValue(at(chat, 0));

    if (!rawId) {
      continue;
    }

    const seconds = at(chat, 5, 0);
    const nanos = at(chat, 5, 1);

    conversations.push({
      id: rawId.replace(/^c_/, ""),
      title: stringValue(at(chat, 1))?.trim() ?? "",
      updatedAt:
        typeof seconds === "number"
          ? seconds * 1000 + (typeof nanos === "number" ? nanos / 1e6 : 0)
          : null,
    });
  }

  const cursor = result[1];

  return {
    conversations,
    nextCursor: typeof cursor === "string" && cursor ? cursor : null,
  };
}

/*
 * ---------------------------------------------------------
 * IMAGES
 * ---------------------------------------------------------
 *
 * Uploaded and generated images alike are described by an
 * array with type 1 at [1], the file name at [2] and the image's
 * URL at [3]. content.ts downloads those URLs, so only Google's
 * image hosts are accepted.
 */

export function isGeminiImageUrl(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }

  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();

    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      /^lh\d+\.(?:googleusercontent|google)\.com$/.test(hostname)
    );
  } catch {
    return false;
  }
}

function isImageDescriptor(node: unknown): node is unknown[] {
  return Array.isArray(node) && node[1] === 1 && isGeminiImageUrl(node[3]);
}

function isPngDescriptor(descriptor: unknown[]): boolean {
  return (
    descriptor[11] === "image/png" ||
    /\.png$/i.test(stringValue(descriptor[2]) ?? "")
  );
}

/*
 * Protobuf-style arrays keep high, sparsely used fields out of
 * the array itself: field n is either at index n or, keyed
 * "n+1", in an object in the array's last slot.
 */
function getSparseField(container: unknown, field: number): unknown {
  if (!Array.isArray(container)) {
    return undefined;
  }

  const value = container[field];

  if (
    value !== null &&
    value !== undefined &&
    !isRecord(value) &&
    !(Array.isArray(value) && value.length === 0)
  ) {
    return value;
  }

  const bundle = container[container.length - 1];

  return isRecord(bundle) ? bundle[String(field + 1)] : undefined;
}

/*
 * A reply's generated images sit in field 7 of its rich content
 * block ([12]). Each image comes in up to two formats (a PNG and
 * a JPEG, say) that are siblings in one array; one picture is
 * taken from each such group, the PNG if there is one.
 */
const GENERATED_IMAGES_FIELD = 7;

function getGeneratedImages(candidate: unknown[]): GeminiImage[] {
  const images: GeminiImage[] = [];
  const seenUrls = new Set<string>();

  const visit = (node: unknown, depth: number): void => {
    if (depth > 12) {
      return;
    }

    if (isRecord(node)) {
      for (const value of Object.values(node)) {
        visit(value, depth + 1);
      }

      return;
    }

    if (!Array.isArray(node)) {
      return;
    }

    const formats = node.filter(isImageDescriptor);
    const picked = formats.find(isPngDescriptor) ?? formats[0];

    if (picked && !seenUrls.has(picked[3] as string)) {
      seenUrls.add(picked[3] as string);
      images.push({
        url: picked[3] as string,
        fileName: stringValue(picked[2])?.trim() || "image",
      });
    }

    for (const child of node) {
      if (!isImageDescriptor(child)) {
        visit(child, depth + 1);
      }
    }
  };

  visit(getSparseField(candidate[12], GENERATED_IMAGES_FIELD), 0);

  return images;
}

/*
 * ---------------------------------------------------------
 * PROMPTS
 * ---------------------------------------------------------
 *
 * A turn's prompt ([2]) holds [text, ..., attachments] at [0],
 * the attachments as [[_, _, _, [file, file, ...]], [file, file,
 * ...]] - the same list twice, the first copy preferred.
 */

function getAttachments(message: unknown[]): unknown[][] {
  const wrapper = message[4];

  if (!Array.isArray(wrapper)) {
    return [];
  }

  const primary = at(wrapper, 0, 3);
  const files = Array.isArray(primary)
    ? primary
    : Array.isArray(wrapper[1])
      ? wrapper[1]
      : [];

  return files.filter(
    (file): file is unknown[] =>
      Array.isArray(file) && typeof file[2] === "string",
  );
}

/*
 * The URL an attachment is identified by: an image's own, or
 * one of the [thumbnail, download, upload] URLs other files
 * carry at [7].
 */
function getAttachmentUrl(file: unknown[]): string | undefined {
  return [file[3], at(file, 7, 1), at(file, 7, 0)]
    .map(stringValue)
    .find(Boolean);
}

function trimText(text: string): string {
  return text.replace(/^(?:[ \t]*\n)+/, "").trimEnd();
}

/*
 * Uploaded images become image parts, which content.ts
 * downloads when image bundling is on, like ChatGPT and Claude
 * uploads. Other files are listed by name. An attachment seen in
 * an earlier turn isn't listed again: a follow-up can carry the
 * files it still refers to.
 */
function getPromptParts(
  prompt: unknown,
  seenMedia: Set<string>,
): GeminiMessagePart[] {
  const message = at(prompt, 0);

  if (!Array.isArray(message)) {
    return [];
  }

  const parts: GeminiMessagePart[] = [];

  for (const file of getAttachments(message)) {
    const url = getAttachmentUrl(file);

    if (url) {
      if (seenMedia.has(url)) {
        continue;
      }

      seenMedia.add(url);
    }

    const fileName = stringValue(file[2])?.trim() || "file";
    const mimeType = stringValue(file[11]) ?? "";

    if (file[1] === 1 || mimeType.startsWith("image/")) {
      parts.push({
        kind: "image",
        image: { url: isGeminiImageUrl(file[3]) ? file[3] : null, fileName },
      });
    } else {
      parts.push({ kind: "text", text: `[Attachment: ${fileName}]` });
    }
  }

  const text = trimText(stringValue(message[0]) ?? "");

  if (text) {
    parts.push({ kind: "text", text });
  }

  return parts;
}

/*
 * ---------------------------------------------------------
 * REPLIES
 * ---------------------------------------------------------
 *
 * A turn's reply ([3]) lists its drafts ("candidates") at [0]
 * and the id of the one on screen at [3]. A candidate is
 * [id, [markdown], ...], with its generated images in [12] and
 * Canvas and Deep Research documents in [30].
 */

function getShownCandidate(reply: unknown): unknown[] | null {
  const candidates = at(reply, 0);

  if (!Array.isArray(candidates)) {
    return null;
  }

  const drafts = candidates.filter((candidate): candidate is unknown[] =>
    Array.isArray(candidate),
  );
  const shownId = stringValue(at(reply, 3));

  return (
    (shownId && drafts.find((candidate) => candidate[0] === shownId)) ||
    drafts[0] ||
    null
  );
}

/*
 * Reply text also carries markup only Gemini's own interface
 * understands:
 *
 * - "[cite_start]" and "[cite: 3, 4]" around sentences taken
 *   from an uploaded file or a web source;
 * - <FollowUp .../> suggestion chips and <Image .../> pictures
 *   from the web, as self-closing tags;
 * - links on the bare googleusercontent.com host, standing in
 *   for things the interface draws in their place - a YouTube
 *   card, a generated image, a Canvas or Deep Research document
 *   ("immersive_entry_chip"), and so on.
 *
 * All of it is left out, except that each document link is
 * replaced with that document, and a citation whose pages are
 * known becomes a note (see CITATIONS below). Code blocks are
 * left as they are: a reply can be about this very markup.
 */
const GEMINI_MARKUP_PATTERN =
  /\[cite_start\]|[ \t]*\[cite:\s*\d+(?:\s*,\s*\d+)*\s*\]|<(?:FollowUp|Image)\b(?:\s+[\w:-]+(?:="[^"]*")?)*\s*\/>|https?:\/\/googleusercontent\.com\/(?:[\w-]+\/)*[\w-]+/g;

const DOCUMENT_LINK_PATTERN = /\/immersive_entry_chip\//;

const CARD_CONTENT_PATTERN =
  /^https?:\/\/googleusercontent\.com\/card_content\/\d+/;

function getFenceOpening(line: string): string | null {
  return line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1] ?? null;
}

function closesFence(line: string, fence: string): boolean {
  const closing = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/)?.[1];

  return (
    closing !== undefined &&
    closing[0] === fence[0] &&
    closing.length >= fence.length
  );
}

/*
 * `cite` turns the numbers of a "[cite: 3, 4]" marker into a note;
 * without it, citations are just removed.
 */
function removeGeminiMarkup(
  text: string,
  documents: string[] = [],
  cite?: (numbers: number[]) => string,
): string {
  const remaining = [...documents];
  const lines: string[] = [];
  let fence: string | null = null;
  let skipBlankLine = false;

  for (const line of text.split("\n")) {
    if (fence !== null) {
      lines.push(line);

      if (closesFence(line, fence)) {
        fence = null;
      }

      continue;
    }

    /*
     * A paragraph-sized gap stays one blank line wide where a
     * markup-only line between two blank lines was taken out.
     */
    if (skipBlankLine && !line.trim()) {
      skipBlankLine = false;
      continue;
    }

    skipBlankLine = false;
    fence = getFenceOpening(line);

    if (fence !== null) {
      lines.push(line);
      continue;
    }

    const inserted: string[] = [];
    const cleaned = line.replace(GEMINI_MARKUP_PATTERN, (match) => {
      const citation = match.match(/\[cite:\s*([\d,\s]+)\]/);

      if (citation) {
        return cite ? cite((citation[1].match(/\d+/g) ?? []).map(Number)) : "";
      }

      const document = DOCUMENT_LINK_PATTERN.test(match)
        ? remaining.shift()
        : undefined;

      if (document) {
        inserted.push(document);
      }

      return "";
    });

    if (cleaned === line) {
      lines.push(line);
      continue;
    }

    /*
     * A line that held only markup goes away entirely, rather
     * than leaving a blank line behind.
     */
    if (cleaned.trim()) {
      lines.push(cleaned.trimEnd());
    } else if (inserted.length === 0) {
      skipBlankLine = lines.length > 0 && !lines[lines.length - 1].trim();
    }

    for (const document of inserted) {
      if (lines.length > 0 && lines[lines.length - 1].trim()) {
        lines.push("");
      }

      lines.push(document, "");
      skipBlankLine = true;
    }
  }

  return [lines.join("\n"), ...remaining]
    .map(trimText)
    .filter(Boolean)
    .join("\n\n");
}

/*
 * ---------------------------------------------------------
 * CITATIONS
 * ---------------------------------------------------------
 *
 * The web pages a reply's "[cite: N]" markers stand for are in
 * field 43 of its rich content block ([12]) - or, for a Deep
 * Research document, of the document's [17][1] or [5]: groups
 * that each pair a marker such as " [cite: 1, 2]" with an entry
 * per number, in order, holding [favicon, url, title] at [3][0].
 * A number's first entry wins. (As HanaokaYuzu/Gemini-API reads
 * them; most replies have none.)
 */
const CITATIONS_FIELD = 43;

interface CitedPage {
  url: string;
  title: string;
}

function getCitedPages(container: unknown): Map<number, CitedPage> {
  const pages = new Map<number, CitedPage>();
  const groups = getSparseField(container, CITATIONS_FIELD);

  if (!Array.isArray(groups)) {
    return pages;
  }

  for (const group of groups) {
    const marker = stringValue(at(group, 0, 0));
    const entries = at(group, 1);

    if (!marker || !Array.isArray(entries)) {
      continue;
    }

    const numbers =
      (marker.match(/\[cite:\s*([\d,\s]+)\]/)?.[1] ?? marker).match(/\d+/g) ??
      [];

    numbers.forEach((number, index) => {
      const url = stringValue(at(entries[index], 3, 0, 1));
      const id = Number(number);

      if (url && !pages.has(id)) {
        pages.set(id, { url, title: stringValue(at(entries[index], 3, 0, 2)) ?? "" });
      }
    });
  }

  return pages;
}

/* A "[cite: ...]" marker's note, its pages added to the sources */
function citeWith(
  pages: Map<number, CitedPage>,
  sources: ReplySources,
): (numbers: number[]) => string {
  return (numbers) =>
    sources.note(
      numbers.map((number) => {
        const page = pages.get(number);
        return page ? sources.add(page.url, page.title) : null;
      }),
    );
}

/*
 * A Canvas or Deep Research document: its Markdown at [4] (a
 * Canvas holding code comes fenced already) and its title at
 * [2], which is shown unless the document opens with a heading
 * of its own. [30] holds other cards too, such as YouTube
 * videos, but only documents have a body at [4].
 */
function getDocuments(candidate: unknown[], sources: ReplySources): string[] {
  const items = candidate[30];

  if (!Array.isArray(items)) {
    return [];
  }

  return items.flatMap((item): string[] => {
    const pages = getCitedPages(at(item, 17, 1));
    const body = removeGeminiMarkup(
      stringValue(at(item, 4)) ?? "",
      [],
      citeWith(pages.size > 0 ? pages : getCitedPages(at(item, 5)), sources),
    );

    if (!body) {
      return [];
    }

    const title = stringValue(at(item, 2))?.trim();

    return [
      title && !/^#{1,6}\s/.test(body) ? `**${title}**\n\n${body}` : body,
    ];
  });
}

/*
 * Generated images become image parts after the text, in the
 * order the reply lists them. Its citations become notes, their
 * pages added to `sources`.
 */
function getReplyParts(
  candidate: unknown[],
  seenMedia: Set<string>,
  sources: ReplySources,
): GeminiMessagePart[] {
  let text = stringValue(at(candidate, 1, 0)) ?? "";

  /*
   * A reply drawn as a card has its text at [22] instead, and
   * only a link to the card at [1].
   */
  if (CARD_CONTENT_PATTERN.test(text)) {
    text = stringValue(at(candidate, 22, 0)) ?? text;
  }

  const body = removeGeminiMarkup(
    text,
    getDocuments(candidate, sources),
    citeWith(getCitedPages(candidate[12]), sources),
  );
  const parts: GeminiMessagePart[] = body ? [{ kind: "text", text: body }] : [];

  for (const image of getGeneratedImages(candidate)) {
    if (image.url && seenMedia.has(image.url)) {
      continue;
    }

    if (image.url) {
      seenMedia.add(image.url);
    }

    parts.push({ kind: "image", image });
  }

  return parts;
}

/*
 * ---------------------------------------------------------
 * TURNS
 * ---------------------------------------------------------
 *
 * A turn is [[conversation id, turn id], [conversation id,
 * previous turn id, previous reply id], prompt, reply,
 * [seconds, nanoseconds]].
 */

/*
 * Takes the turns as hNvQHb lists them - newest first, page
 * after page - and returns the conversation oldest first, a
 * prompt and its reply per turn.
 */
export function convertGeminiTurns(turns: unknown[]): GeminiExportMessage[] {
  const seenTurnIds = new Set<string>();
  const seenMedia = new Set<string>();
  const messages: GeminiExportMessage[] = [];

  for (const [index, turn] of [...turns].reverse().entries()) {
    if (!Array.isArray(turn)) {
      continue;
    }

    const turnId = stringValue(at(turn, 0, 1)) || `turn-${index + 1}`;

    if (seenTurnIds.has(turnId)) {
      continue;
    }

    seenTurnIds.add(turnId);

    const promptParts = getPromptParts(turn[2], seenMedia);

    if (promptParts.length > 0) {
      messages.push({ id: turnId, role: "user", parts: promptParts });
    }

    const candidate = getShownCandidate(turn[3]);
    const sources = new ReplySources();
    const replyParts = candidate
      ? getReplyParts(candidate, seenMedia, sources)
      : [];

    if (candidate && replyParts.length > 0) {
      messages.push({
        id: stringValue(candidate[0]) || `${turnId}-reply`,
        role: "assistant",
        parts: replyParts,
        // The thoughts, as the app shows them above the reply
        ...replyExtras(stringValue(at(candidate, 37, 0, 0)) ?? "", sources),
      });
    }
  }

  return messages;
}
