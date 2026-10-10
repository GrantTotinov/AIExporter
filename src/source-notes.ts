/*
 * =========================================================
 * AI Exporter - source-notes.ts
 * =========================================================
 *
 * A reply's sources - the web pages it drew on - and the notes
 * in its text that point at them. The site parsers put a note
 * where the site showed a citation (see reply-sources.ts on the
 * content script's side): NOTE_OPEN, the numbers of the sources
 * it cites ("1,3", counted from 1 in the reply's own `sources`),
 * then NOTE_CLOSE. They're Private Use Area characters, like the
 * math placeholders in math.ts, so a note can't be mistaken for
 * anything a chat says.
 *
 * Every export format turns notes into what it knows - a Markdown
 * footnote, a raised number linked to the page in PDF, Word and
 * web page files, "[1]" in plain text - or drops them when sources
 * are switched off in the settings.
 */

export interface MessageSource {
  /* The page's title; "" when the site didn't give one. */
  title: string;
  /* An http(s) address; "" for a source without one (an uploaded file). */
  url: string;
}

/*
 * Built from character codes, like math.ts' placeholders, since
 * raw Private Use Area characters are invisible in most editors.
 * reply-sources.ts makes the same two (tests/source-notes.test.ts
 * checks that they agree).
 */
export const NOTE_OPEN = String.fromCharCode(0xe310);
export const NOTE_CLOSE = String.fromCharCode(0xe311);

const NOTE_RE = new RegExp(`${NOTE_OPEN}([0-9,]{0,200})${NOTE_CLOSE}`, "g");

/* Any note left without its partner, which nothing can render */
const STRAY_NOTE_CHAR_RE = new RegExp(`[${NOTE_OPEN}${NOTE_CLOSE}]`, "g");

/* A whole note (group 1 its numbers), or else a stray half of one */
const NOTE_OR_STRAY_RE = new RegExp(
  `${NOTE_OPEN}([0-9,]{0,200})${NOTE_CLOSE}|[${NOTE_OPEN}${NOTE_CLOSE}]`,
  "g",
);

/*
 * The sources a note cites, in order and each once, keeping only
 * numbers the reply's list has (1 to `count`).
 */
export function noteNumbers(payload: string, count: number): number[] {
  const numbers: number[] = [];

  for (const part of payload.split(",")) {
    const number = Number(part);

    if (
      Number.isInteger(number) &&
      number >= 1 &&
      number <= count &&
      !numbers.includes(number)
    ) {
      numbers.push(number);
    }
  }

  return numbers;
}

/*
 * Replaces every note with what `render` makes of the sources it
 * cites; a note citing none of them is just removed, and so is a
 * stray half of one. One pass, so what `render` writes - a note,
 * for normalizeNotes - is left as it is.
 */
export function replaceNotes(
  content: string,
  count: number,
  render: (numbers: number[]) => string,
): string {
  return content.replace(NOTE_OR_STRAY_RE, (_match, payload?: string) => {
    if (payload === undefined) {
      return "";
    }

    const numbers = noteNumbers(payload, count);
    return numbers.length > 0 ? render(numbers) : "";
  });
}

/*
 * The notes rewritten to cite only sources the reply has, so the
 * renderers can trust every number they find.
 */
export function normalizeNotes(content: string, count: number): string {
  return replaceNotes(
    content,
    count,
    (numbers) => `${NOTE_OPEN}${numbers.join(",")}${NOTE_CLOSE}`,
  );
}

/* The text without its notes - when sources are off, or for a preview */
export function stripNotes(content: string): string {
  return content.replace(NOTE_RE, "").replace(STRAY_NOTE_CHAR_RE, "");
}

export function hasNotes(content: string): boolean {
  NOTE_RE.lastIndex = 0;
  const found = NOTE_RE.test(content);
  NOTE_RE.lastIndex = 0;
  return found;
}

/* "en.wikipedia.org" for a link to one of its pages */
export function sourceHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/* What a source is called on the page: its title, or else its site */
export function sourceLabel(source: MessageSource): string {
  return source.title.trim() || sourceHost(source.url) || source.url || "Source";
}

/* Only links a reader may follow from an exported file */
export function isSafeSourceUrl(url: string): boolean {
  return /^https?:\/\/\S+$/i.test(url);
}

/*
 * ---------------------------------------------------------
 * MARKDOWN AND PLAIN TEXT
 * ---------------------------------------------------------
 */

function escapeMarkdownLabel(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/([[\]*_`])/g, "\\$1");
}

/* A link destination that stays one link: no spaces, no stray brackets */
function markdownUrl(url: string): string {
  return url.replace(/ /g, "%20").replace(/</g, "%3C").replace(/>/g, "%3E");
}

/* "[Title](https://...)", or the title alone for a source without a link */
export function markdownSourceLink(source: MessageSource): string {
  const label = escapeMarkdownLabel(sourceLabel(source));

  return isSafeSourceUrl(source.url)
    ? `[${label}](${markdownUrl(source.url)})`
    : label;
}

/*
 * Markdown footnotes. A footnote's label must be unique in the
 * whole file, so a reply's notes are numbered on from `offset` -
 * the notes of the replies before it - and defined right after it:
 *
 *   ...as of 2024.[^3]
 *
 *   [^3]: [Title](https://...)
 */
export function markdownFootnotes(
  content: string,
  sources: MessageSource[],
  offset: number,
): string {
  return replaceNotes(content, sources.length, (numbers) =>
    numbers.map((number) => `[^${offset + number}]`).join(""),
  );
}

export function markdownFootnoteDefinitions(
  sources: MessageSource[],
  offset: number,
): string {
  return sources
    .map(
      (source, index) =>
        `[^${offset + index + 1}]: ${markdownSourceLink(source)}`,
    )
    .join("\n");
}

/*
 * A fenced code block, or else a line of small print - a ChatGPT
 * note, "<small>...</small>" (see chatgpt-components.ts).
 */
const CODE_OR_SMALL_PRINT_RE =
  /^[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]{0,3}\1[`~]*[ \t]*$|^<small>(.*)<\/small>[ \t]*$/gm;

/*
 * "[1]", "[1][3]" - for text that's read as it is, where small print
 * is just its text too.
 */
export function bracketNotes(content: string, sources: MessageSource[]): string {
  return replaceNotes(content, sources.length, (numbers) =>
    numbers.map((number) => `[${number}]`).join(""),
  ).replace(
    CODE_OR_SMALL_PRINT_RE,
    (match, fence: string | undefined, small: string | undefined) =>
      fence === undefined ? (small ?? match) : match,
  );
}

/*
 * The list under a reply in plain text:
 *
 *   Sources:
 *   [1] Title - https://...
 */
export function bracketSourceList(sources: MessageSource[]): string {
  return [
    "Sources:",
    ...sources.map((source, index) => {
      const label = sourceLabel(source);

      return isSafeSourceUrl(source.url) && label !== source.url
        ? `[${index + 1}] ${label} - ${source.url}`
        : `[${index + 1}] ${label}`;
    }),
  ].join("\n");
}
