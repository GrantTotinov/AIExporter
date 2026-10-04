/*
 * =========================================================
 * AI Exporter - chatgpt-reply.ts
 * =========================================================
 *
 * What a ChatGPT reply carries besides its text: the web pages
 * it cites, and the reasoning ("thoughts") its model wrote first.
 *
 * Citations. The reply's text holds a marker wherever ChatGPT
 * shows a citation - Private Use Area characters around a payload
 * ("<U+E200>cite<U+E202>turn0search3<U+E201>") - and the
 * message's metadata.content_references say what each marker
 * (`matched_text`) cites: its `items`, with title and link. A
 * "sources_footnote" reference is the list ChatGPT shows under
 * the answer. Older browsing replies used "【11†source】" markers
 * with metadata.citations instead. Each marker becomes a note
 * (see reply-sources.ts); any marker left over is removed, so no
 * "citeturn0search3" ends up in a Markdown or text file.
 *
 * Thinking. A reasoning model's thoughts are messages of their
 * own between the question and the answer ("thoughts", with a
 * summary and a text each), along with short progress notes
 * ("thinking preambles") and activity titles ("Searching the
 * web"). They're gathered by walking from the answer up to the
 * question.
 *
 * Field names follow the ChatGPT web app's own API, as read by
 * open-source exporters (pionxzh/chatgpt-exporter among them).
 * Imported only by content.ts, so Rollup inlines it into
 * content.js (see the top of content.ts).
 */
import { ReplySources } from "./reply-sources.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/*
 * Built from character codes: raw Private Use Area characters
 * are invisible in most editors (see markdown-parse.ts).
 */
const PUA_OPEN = String.fromCharCode(0xe200);
const PUA_CLOSE = String.fromCharCode(0xe201);
const PUA_SEP = String.fromCharCode(0xe202);
const PUA_HIGHLIGHT = `${String.fromCharCode(0xe203)}${String.fromCharCode(0xe204)}`;

const PUA_URL_TOKEN_RE = new RegExp(
  `${PUA_OPEN}url${PUA_SEP}([^${PUA_SEP}${PUA_CLOSE}]*)${PUA_SEP}([^${PUA_CLOSE}]*)${PUA_CLOSE}`,
  "g",
);
const PUA_TOKEN_RE = new RegExp(`[ \\t]*${PUA_OPEN}[^${PUA_CLOSE}]*${PUA_CLOSE}`, "g");
const PUA_HIGHLIGHT_RE = new RegExp(`[${PUA_HIGHLIGHT}]`, "g");

/* "【11†source】", "【3†L45-L52】" - the older browsing citations */
const LEGACY_MARKER_RE = /【(\d+)†[^】]{0,200}】/g;

/*
 * The sources one reference cites: its items and the sites that
 * back them, then fallbacks - an uploaded file by name, the
 * reference's own link, or its bare "safe" URLs.
 */
function referenceSources(
  reference: Record<string, unknown>,
): { url: string; title: string }[] {
  const found: { url: string; title: string }[] = [];
  const add = (item: Record<string, unknown>): void => {
    found.push({
      url: stringValue(item.url),
      title: stringValue(item.title) || stringValue(item.attribution),
    });
  };

  for (const item of records(reference.items)) {
    add(item);
    records(item.supporting_websites).forEach(add);
  }

  records(reference.fallback_items).forEach(add);

  if (found.length === 0 && reference.type === "file" && stringValue(reference.name)) {
    found.push({ url: "", title: stringValue(reference.name) });
  }

  if (
    found.length === 0 &&
    (stringValue(reference.url) || stringValue(reference.title))
  ) {
    add(reference);
  }

  if (found.length === 0) {
    for (const url of Array.isArray(reference.safe_urls) ? reference.safe_urls : []) {
      found.push({ url: stringValue(url), title: "" });
    }
  }

  return found;
}

/*
 * A reference without sources keeps the text ChatGPT shows for it
 * (`alt`, Markdown) - a product's name, say - minus links that go
 * nowhere ("[Name]()").
 */
function altText(reference: Record<string, unknown>): string {
  return stringValue(reference.alt).replace(/\[([^\]]*)\]\(\)/g, "$1");
}

/* The first character of a note (see reply-sources.ts) */
const NOTE_START = String.fromCharCode(0xe310);

/*
 * A marker found in the text, and what it becomes - worked out in
 * reading order, so the sources are numbered the way the reply
 * cites them.
 */
interface MarkerHit {
  start: number;
  end: number;
  replace: () => string;
}

/*
 * Puts each hit's replacement in its place. A note hugs the text
 * before it, and a marker that comes to nothing leaves no gap, so
 * the spaces before either go.
 */
function applyHits(text: string, hits: MarkerHit[]): string {
  let output = "";
  let last = 0;

  for (const hit of [...hits].sort((a, b) => a.start - b.start)) {
    const replacement = hit.replace();
    let before = text.slice(last, hit.start);

    if (replacement === "" || replacement.startsWith(NOTE_START)) {
      before = before.replace(/[ \t]+$/, "");
    }

    output += before + replacement;
    last = hit.end;
  }

  return output + text.slice(last);
}

function overlaps(hits: MarkerHit[], start: number, end: number): boolean {
  return hits.some((hit) => start < hit.end && hit.start < end);
}

/*
 * The older "【n†...】" markers: metadata.citations gives each one's
 * position (start_ix/end_ix) and source; a marker whose position
 * doesn't line up is matched by its number instead, and one that
 * matches nothing is removed.
 */
function legacyHits(
  text: string,
  metadata: Record<string, unknown>,
  sources: ReplySources,
): MarkerHit[] {
  if (!text.includes("【")) {
    return [];
  }

  const citations = records(metadata.citations);
  const hits: MarkerHit[] = [];
  const used = new Set<Record<string, unknown>>();

  const noteFor = (citation: Record<string, unknown> | undefined) => () => {
    const details = citation && isRecord(citation.metadata) ? citation.metadata : {};

    return citation ? sources.note([sources.add(details.url, details.title)]) : "";
  };

  for (const citation of citations) {
    const start = citation.start_ix;
    const end = citation.end_ix;

    if (
      typeof start === "number" &&
      typeof end === "number" &&
      /^【[^】]*】$/.test(text.slice(start, end)) &&
      !overlaps(hits, start, end)
    ) {
      hits.push({ start, end, replace: noteFor(citation) });
      used.add(citation);
    }
  }

  for (const match of text.matchAll(LEGACY_MARKER_RE)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;

    if (overlaps(hits, start, end)) {
      continue;
    }

    const citation = citations.find((candidate) => {
      const extra =
        isRecord(candidate.metadata) && isRecord(candidate.metadata.extra)
          ? candidate.metadata.extra
          : {};

      return !used.has(candidate) && Number(extra.cited_message_idx) === Number(match[1]);
    });

    if (citation) {
      used.add(citation);
    }

    hits.push({ start, end, replace: noteFor(citation) });
  }

  return hits;
}

/*
 * The reply's text with its citations as notes, its sources added
 * to `sources` - in the order the reply cites them, then the rest
 * of ChatGPT's own source list.
 */
export function convertChatGptCitations(
  text: string,
  metadata: unknown,
  sources: ReplySources,
): string {
  const meta = isRecord(metadata) ? metadata : {};
  const references = records(meta.content_references);
  const hits: MarkerHit[] = [];

  /*
   * Longest markers are found first: a marker citing several
   * results ("...turn0search1...turn0search4") contains the text
   * of one citing only the first.
   */
  const inline = references
    .filter(
      (reference) =>
        reference.type !== "sources_footnote" &&
        stringValue(reference.matched_text).trim() !== "",
    )
    .sort(
      (a, b) =>
        stringValue(b.matched_text).length - stringValue(a.matched_text).length,
    );

  for (const reference of inline) {
    const marker = stringValue(reference.matched_text);

    // Image search results are a picture carousel in ChatGPT.
    const replace =
      reference.type === "image_group" || reference.type === "image_v2"
        ? () => ""
        : () =>
            sources.note(
              referenceSources(reference).map((source) =>
                sources.add(source.url, source.title),
              ),
            ) || altText(reference);

    for (let from = 0; ; ) {
      const start = text.indexOf(marker, from);

      if (start === -1) {
        break;
      }

      const end = start + marker.length;

      if (!overlaps(hits, start, end)) {
        hits.push({ start, end, replace });
      }

      from = end;
    }
  }

  hits.push(
    ...legacyHits(text, meta, sources).filter(
      (hit) => !overlaps(hits, hit.start, hit.end),
    ),
  );

  const output = applyHits(text, hits);

  for (const reference of references) {
    if (reference.type !== "sources_footnote") {
      continue;
    }

    const listed = [
      ...records(reference.sources),
      ...records(reference.items),
      ...records(reference.fallback_items),
    ];

    for (const item of listed) {
      sources.add(item.url, stringValue(item.title) || stringValue(item.attribution));
    }

    for (const url of Array.isArray(reference.safe_urls) ? reference.safe_urls : []) {
      sources.add(url);
    }
  }

  return output
    .replace(PUA_URL_TOKEN_RE, "[$1]($2)")
    .replace(PUA_TOKEN_RE, "")
    .replace(PUA_HIGHLIGHT_RE, "");
}

/*
 * ---------------------------------------------------------
 * THINKING
 * ---------------------------------------------------------
 */

export interface ChatGptMessageLike {
  id?: string;
  author?: { role?: string };
  content?: {
    content_type?: string;
    parts?: unknown[];
    thoughts?: unknown;
  };
  metadata?: Record<string, unknown>;
  create_time?: number | null;
}

/*
 * One reasoning message's part of the thinking: its thoughts (a
 * summary heading the text), a progress note, or an activity.
 */
function thinkingPieces(message: ChatGptMessageLike): string[] {
  const contentType = message.content?.content_type;

  if (contentType === "thoughts") {
    return records(message.content?.thoughts).flatMap((thought) => {
      const summary = stringValue(thought.summary).trim();
      const content = stringValue(thought.content).trim();

      if (summary && content && !content.startsWith(summary)) {
        return [`**${summary}**\n\n${content}`];
      }

      return content || summary ? [content || summary] : [];
    });
  }

  if (
    contentType === "text" &&
    message.metadata?.is_thinking_preamble_message === true
  ) {
    const text = (message.content?.parts ?? [])
      .filter((part): part is string => typeof part === "string")
      .join("\n")
      .trim();

    return text ? [text] : [];
  }

  const title = stringValue(message.metadata?.reasoning_title).trim();

  return title ? [`*${title}*`] : [];
}

/*
 * The thinking behind a reply: the reasoning messages between it
 * and the question before it, oldest first. `parentOf` names a
 * message's parent; when the walk up finds nothing (a page of the
 * conversation without parent links), the messages of the reply's
 * own turn (metadata.turn_exchange_id) are used instead.
 */
export function chatGptThinking(
  reply: ChatGptMessageLike,
  byId: Map<string, ChatGptMessageLike>,
  parentOf: (message: ChatGptMessageLike) => string | null,
): string {
  const pieces: string[][] = [];
  const visited = new Set<string>();
  let parentId = parentOf(reply);

  while (parentId && !visited.has(parentId) && visited.size < 500) {
    visited.add(parentId);

    const message = byId.get(parentId);

    if (!message) {
      break;
    }

    if (
      message.author?.role === "user" &&
      message.metadata?.is_visually_hidden_from_conversation !== true
    ) {
      break;
    }

    pieces.unshift(thinkingPieces(message));
    parentId = parentOf(message);
  }

  let found = pieces.flat();

  if (found.length === 0) {
    const turn = stringValue(reply.metadata?.turn_exchange_id);

    if (turn) {
      found = [...byId.values()]
        .filter(
          (message) =>
            message !== reply &&
            message.author?.role !== "user" &&
            stringValue(message.metadata?.turn_exchange_id) === turn &&
            (message.create_time ?? 0) <= (reply.create_time ?? Infinity),
        )
        .sort((a, b) => (a.create_time ?? 0) - (b.create_time ?? 0))
        .flatMap(thinkingPieces);
    }
  }

  // An activity listed again and again ("Searching the web") once
  return found
    .filter((piece, index) => !piece.startsWith("*") || found.indexOf(piece) === index)
    .join("\n\n");
}
