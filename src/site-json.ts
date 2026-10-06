/*
 * =========================================================
 * AI Exporter - site-json.ts
 * =========================================================
 *
 * What the parsers of the sites added in 2.4 share: reading the
 * undocumented JSON their web apps' APIs answer with, defensively
 * - a field that's missing or of another type is treated as absent
 * rather than throwing - and the message shape content.ts turns
 * into the export's (see toExportMessages there).
 *
 * Imported only by content.ts and the site parsers it uses, so
 * Rollup inlines it into content.js, which can't `import` (see the
 * top of content.ts).
 */
import type { ReplySource } from "./reply-sources.ts";

export type SiteMessagePart =
  | { kind: "text"; text: string }
  | { kind: "image"; image: { url: string | null; fileName: string } };

export interface SiteMessage {
  id: string;
  role: "user" | "assistant";
  parts: SiteMessagePart[];
  thinking?: string;
  sources?: ReplySource[];
  /* When it was sent, in milliseconds since the epoch */
  time?: number;
  model?: string;
}

/* A conversation in a site's list, for "Save many chats" */
export interface SiteConversationSummary {
  id: string;
  title: string;
  createdAt: number | null;
  updatedAt: number | null;
}

export interface SiteConversationPage {
  conversations: SiteConversationSummary[];
  nextCursor: string | null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

export function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function idValue(value: unknown): string {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value))
    ? String(value)
    : "";
}

/*
 * A conversation id content.ts accepts (LOAD_CONVERSATION only
 * takes these), or "" for anything else.
 */
export function safeId(value: unknown): string {
  const id = idValue(value);

  return /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : "";
}

/* Text with its blank first lines and trailing whitespace dropped */
export function trimText(text: string): string {
  return text.replace(/^(?:[ \t]*\n)+/, "").trimEnd();
}

/* The non-empty texts, joined as paragraphs */
export function joinTexts(texts: string[]): string {
  return texts.map(trimText).filter(Boolean).join("\n\n");
}

/*
 * A time given as Unix seconds or milliseconds, as a number or a
 * string of digits, or as an ISO date - in milliseconds.
 */
export function anyTime(value: unknown): number | null {
  const number =
    typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim())
      ? Number(value)
      : value;

  if (typeof number === "number" && Number.isFinite(number) && number > 0) {
    return number > 1e11 ? Math.round(number) : Math.round(number * 1000);
  }

  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    const parsed = Date.parse(value);

    return Number.isNaN(parsed) ? null : parsed;
  }

  return null;
}

/* A message made of one text part, unless it's empty */
export function textMessage(
  id: string,
  role: "user" | "assistant",
  text: string,
  extras: Omit<SiteMessage, "id" | "role" | "parts"> = {},
): SiteMessage | null {
  const content = trimText(text);

  if (!content && !extras.thinking) {
    return null;
  }

  return {
    id,
    role,
    parts: content ? [{ kind: "text", text: content }] : [],
    ...extras,
  };
}

/*
 * The site's answer, parsed - or an error that says the site's
 * format wasn't understood, naming the site.
 */
export function unexpectedFormat(siteName: string): Error {
  return new Error(`${siteName} returned an unexpected conversation format.`);
}
