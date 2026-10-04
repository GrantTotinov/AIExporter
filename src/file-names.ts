/*
 * =========================================================
 * AI Exporter - file-names.ts
 * =========================================================
 *
 * Names the files AI Exporter saves. The person picks how in the
 * settings (Settings.fileNameTemplate): AI Exporter's standard
 * name, such as "chatgpt-export-trip-ideas-2026-10-04", or a
 * pattern written with {title}, {site}, {date} and {time}, such
 * as "{date} {title}".
 *
 * Every name is cleaned into one browsers accept. Chrome and
 * Firefox don't fix a download's name - they refuse the download:
 * Chrome any of \ / : * ? " < > | ~, an invisible formatting
 * character, a space or dot at either end, or a name Windows
 * reserves (CON, NUL...); Firefox mostly the same. background.ts
 * checks every name with isSafeFileName() before it downloads or
 * saves anything.
 */
import { CHAT_SITE_NAMES, type ChatSite } from "./chat-sites.ts";

/* In the settings, "" stands for the standard name. */
export const STANDARD_FILE_NAME = "";

/*
 * The ready-made patterns the settings page offers, besides the
 * person's own.
 */
export const FILE_NAME_PRESETS = {
  standard: STANDARD_FILE_NAME,
  title: "{title}",
  dateTitle: "{date} {title}",
  siteTitleDate: "{site} - {title} - {date}",
} as const;

export type FileNamePreset = keyof typeof FILE_NAME_PRESETS;

export const FILE_NAME_TOKENS = ["title", "site", "date", "time"] as const;

export type FileNameToken = (typeof FILE_NAME_TOKENS)[number];

/*
 * Linux and macOS allow 255 bytes per name; this leaves room for
 * the extension and a "-2" that tells two same-named chats apart.
 */
const MAX_NAME_BYTES = 180;

const SLUG_LENGTH = 60;

export interface FileNameInput {
  /* The chat's title, without the site's name; "" when it has none. */
  title: string;
  site: ChatSite | null;
  /*
   * When the chat was saved - or, in "Save many chats", when it was
   * last used, so the files sort by date.
   */
  date: Date;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/* "2026-10-04", in local time */
export function fileNameDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/* "14-05": file names can't hold a ":" */
export function fileNameTime(date: Date): string {
  return `${pad(date.getHours())}-${pad(date.getMinutes())}`;
}

/*
 * The standard name's form of a title, in any script: lowercase,
 * with everything that isn't a letter or a digit turned into "-".
 */
export function titleSlug(title: string, maxLength = SLUG_LENGTH): string {
  const slug = title
    .normalize("NFC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");

  return Array.from(slug).slice(0, maxLength).join("").replace(/-+$/, "");
}

/*
 * Code points no file name may hold: control and formatting
 * characters (bidi marks, zero-width joiners...), line and
 * paragraph separators, lone surrogates and Unicode noncharacters.
 */
function isInvisible(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;

  return (
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(char) ||
    (code >= 0xd800 && code <= 0xdfff) ||
    (code >= 0xfdd0 && code <= 0xfdef) ||
    (code & 0xfffe) === 0xfffe
  );
}

const RESERVED_NAME_RE = /^(?:con|prn|aux|nul|com\d|lpt\d|clock\$)(?:\.|$)/i;

function truncateBytes(text: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  let out = "";
  let bytes = 0;

  for (const char of text) {
    bytes += encoder.encode(char).length;

    if (bytes > maxBytes) {
      break;
    }

    out += char;
  }

  return out;
}

const END_TRIM_RE = /^[\s.\-]+|[\s.\-]+$/g;

/*
 * Turns any text into a name both browsers accept, keeping it as
 * readable as possible: a path's "/" or "\" becomes "-", a ":" a
 * " - " ("Python: lists" -> "Python - lists", "10:30" -> "10-30"),
 * a '"' a "'", and the characters with no stand-in are left out.
 * Returns "" when nothing usable is left.
 */
export function sanitizeFileName(text: string): string {
  const visible = Array.from(text.normalize("NFC"))
    .filter((char) => !isInvisible(char))
    .join("");

  const cleaned = visible
    .replace(/\s+/gu, " ")
    .replace(/(\d):(?=\d)/g, "$1-")
    .replace(/:/g, " - ")
    .replace(/[/\\|]/g, "-")
    .replace(/"/g, "'")
    .replace(/[*?<>~]/g, "")
    .replace(/\.{2,}/g, ".")
    .replace(/ {2,}/g, " ")
    .replace(/(?: ?- ?){2,}/g, " - ")
    .replace(END_TRIM_RE, "");

  const name = truncateBytes(cleaned, MAX_NAME_BYTES).replace(END_TRIM_RE, "");

  return RESERVED_NAME_RE.test(name) ? `${name}_` : name;
}

/*
 * AI Exporter's standard name, as it has always been:
 * "chatgpt-export-trip-ideas-2026-10-04".
 */
export function standardFileName(input: FileNameInput): string {
  return sanitizeFileName(
    `${input.site ?? "chatgpt"}-export-${titleSlug(input.title) || "conversation"}-${fileNameDate(input.date)}`,
  );
}

/*
 * A name from the person's pattern. Tokens are matched in any
 * case ({Title} works too); anything else in braces is kept as
 * written. A pattern that leaves nothing behind - only spaces, or
 * only {title} for an untitled chat - falls back to the standard
 * name, so no file is ever nameless.
 */
export function renderFileName(template: string, input: FileNameInput): string {
  if (template.trim() === STANDARD_FILE_NAME) {
    return standardFileName(input);
  }

  const values: Record<FileNameToken, string> = {
    title: input.title.trim(),
    site: input.site ? CHAT_SITE_NAMES[input.site] : "",
    date: fileNameDate(input.date),
    time: fileNameTime(input.date),
  };

  const name = sanitizeFileName(
    template.replace(
      /\{(title|site|date|time)\}/gi,
      (_match, token: string) => values[token.toLowerCase() as FileNameToken],
    ),
  );

  return name || standardFileName(input);
}

/*
 * Which ready-made pattern a stored one is, or null for the
 * person's own.
 */
export function fileNamePreset(template: string): FileNamePreset | null {
  const trimmed = template.trim();

  return (
    (Object.keys(FILE_NAME_PRESETS) as FileNamePreset[]).find(
      (preset) => FILE_NAME_PRESETS[preset] === trimmed,
    ) ?? null
  );
}

/*
 * Whether a full file name ("Trip ideas.pdf") is one this module
 * could have made: background.ts accepts no other.
 */
export function isSafeFileName(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 255) {
    return false;
  }

  const match = value.match(/^(.+)\.([A-Za-z0-9]{1,8})$/);

  return (
    match !== null &&
    sanitizeFileName(match[1]) === match[1] &&
    !value.includes("..") &&
    new TextEncoder().encode(value).length <= 255
  );
}

/*
 * The last resort when a browser still turns a name down: only
 * letters, digits, "-", "_" and "." from the ASCII range.
 */
export function asciiFileName(fileName: string): string {
  const match = fileName.match(/^(.*?)(\.[A-Za-z0-9]{1,8})?$/);
  const base = (match?.[1] ?? "")
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[.\-]+|[.\-]+$/g, "")
    .slice(0, 120);

  return `${base || "chat-export"}${match?.[2] ?? ""}`;
}
