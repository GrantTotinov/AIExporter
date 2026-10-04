/*
 * =========================================================
 * AI Exporter - reply-sources.ts
 * =========================================================
 *
 * What the site parsers share to carry a reply's sources into the
 * export: each distinct web page numbered once, in the order the
 * reply first cites it, and the note that marks a citation in the
 * text. source-notes.ts reads the notes back on the export side;
 * the two make the same characters (tests/source-notes.test.ts
 * checks that they agree).
 *
 * Imported only by content.ts and the site parsers it uses, so
 * Rollup inlines it into content.js, which can't `import` (see the
 * top of content.ts).
 */

export interface ReplySource {
  /* The page's title; "" when the site didn't give one. */
  title: string;
  /* An http(s) address; "" for a source without one (an uploaded file). */
  url: string;
}

const NOTE_OPEN = String.fromCharCode(0xe310);
const NOTE_CLOSE = String.fromCharCode(0xe311);

const MAX_TITLE_LENGTH = 300;
const MAX_URL_LENGTH = 2048;

/*
 * Only http(s) links are kept: an exported file makes every
 * source a clickable link, and a site's data is no reason to trust
 * a javascript: or data: one.
 */
export function isWebAddress(value: unknown): value is string {
  if (typeof value !== "string" || value.length > MAX_URL_LENGTH) {
    return false;
  }

  try {
    const url = new URL(value);

    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

/*
 * A link as the browser writes it (spaces and the like
 * percent-encoded), so the same page is always the same text -
 * or "" when it isn't a web address.
 */
function webAddress(value: unknown): string {
  return isWebAddress(value) ? new URL(value.trim()).href : "";
}

function cleanTitle(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  return Array.from(value.replace(/\s+/g, " ").trim())
    .slice(0, MAX_TITLE_LENGTH)
    .join("");
}

/*
 * A reply's sources, numbered from 1 as they're added. A page
 * added twice - cited again, or both cited and listed - keeps its
 * first number.
 */
export class ReplySources {
  readonly list: ReplySource[] = [];

  private readonly numbers = new Map<string, number>();

  /*
   * Adds a source, or finds it again, and returns its number; null
   * when there's neither a usable link nor a title.
   */
  add(url: unknown, title?: unknown): number | null {
    const link = webAddress(url);
    const name = cleanTitle(title);

    if (!link && !name) {
      return null;
    }

    const key = link || `title:${name.toLowerCase()}`;
    const known = this.numbers.get(key);

    if (known !== undefined) {
      const source = this.list[known - 1];

      // A later mention can know the title the first one lacked.
      if (!source.title && name && name !== link) {
        source.title = name;
      }

      return known;
    }

    this.list.push({ title: name === link ? "" : name, url: link });
    this.numbers.set(key, this.list.length);

    return this.list.length;
  }

  /* The number a page already has, without adding it */
  numberOf(url: unknown): number | null {
    const link = webAddress(url);

    return link ? (this.numbers.get(link) ?? null) : null;
  }

  /*
   * The note for a citation of these sources; "" when none of them
   * could be numbered.
   */
  note(numbers: Array<number | null | undefined>): string {
    const cited = [
      ...new Set(
        numbers.filter(
          (number): number is number =>
            typeof number === "number" &&
            number >= 1 &&
            number <= this.list.length,
        ),
      ),
    ];

    return cited.length > 0 ? `${NOTE_OPEN}${cited.join(",")}${NOTE_CLOSE}` : "";
  }

  get size(): number {
    return this.list.length;
  }
}

/*
 * The fields a parser hands content.ts for a reply's thinking and
 * sources; both are left out when there are none.
 */
export function replyExtras(
  thinking: string,
  sources: ReplySources,
): { thinking?: string; sources?: ReplySource[] } {
  const extras: { thinking?: string; sources?: ReplySource[] } = {};
  const trimmed = thinking.replace(/^(?:[ \t]*\n)+/, "").trimEnd();

  if (trimmed) {
    extras.thinking = trimmed;
  }

  if (sources.size > 0) {
    extras.sources = sources.list.map((source) => ({ ...source }));
  }

  return extras;
}
