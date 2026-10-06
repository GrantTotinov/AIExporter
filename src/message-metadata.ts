/*
 * =========================================================
 * AI Exporter - message-metadata.ts
 * =========================================================
 *
 * When a message was sent, and the AI model that wrote a reply,
 * as the site parsers read them from each site's API. Every site
 * writes a time its own way - Unix seconds (ChatGPT, DeepSeek), an
 * ISO 8601 string (Claude, Grok, Perplexity) or [seconds,
 * nanoseconds] (Gemini) - and the export carries all of them as
 * milliseconds since the epoch (Message.time). A value that can't
 * be a real date is left out, rather than turning into 1970 in the
 * exported file.
 *
 * Imported only by content.ts and the site parsers it uses, so
 * Rollup inlines it into content.js, which can't `import` (see
 * the top of content.ts). message-details.ts writes these values
 * into the exported files.
 */

/* Nothing older than this is a chat message's time */
const EARLIEST_TIME = Date.UTC(2000, 0, 1);
const LATEST_TIME = Date.UTC(2200, 0, 1);

function plausibleTime(time: number): number | undefined {
  return Number.isFinite(time) && time >= EARLIEST_TIME && time < LATEST_TIME
    ? Math.round(time)
    : undefined;
}

/*
 * Unix seconds, with a fraction or without, as a number or as
 * text. A number too big to be seconds is taken as milliseconds
 * already, as ChatGPT's list does now and then (see
 * parseChatGptTime in conversation-list.ts).
 */
export function timeFromSeconds(value: unknown): number | undefined {
  const seconds =
    typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim())
      ? Number(value)
      : value;

  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
    return undefined;
  }

  return plausibleTime(seconds < 1e11 ? seconds * 1000 : seconds);
}

/*
 * An ISO 8601 date and time. One without a time zone
 * ("2026-10-03T14:05:12.071") is in UTC, as the sites' servers
 * write it - JavaScript would read it as local time.
 */
export function timeFromIso(value: unknown): number | undefined {
  if (typeof value !== "string" || value.length > 64) {
    return undefined;
  }

  const text = value.trim();
  const unzoned =
    /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/.exec(text);

  if (unzoned) {
    return plausibleTime(Date.parse(`${unzoned[1]}T${unzoned[2]}Z`));
  }

  return /^\d{4}-\d{2}-\d{2}/.test(text)
    ? plausibleTime(Date.parse(text))
    : undefined;
}

/* Gemini's [seconds, nanoseconds] */
export function timeFromSecondsAndNanos(value: unknown): number | undefined {
  if (!Array.isArray(value) || typeof value[0] !== "number") {
    return undefined;
  }

  const nanos = typeof value[1] === "number" && Number.isFinite(value[1]) ? value[1] : 0;

  return timeFromSeconds(value[0] + nanos / 1e9);
}

/*
 * Placeholders a site can put where the model's name goes, which
 * say nothing about the model that answered.
 */
const NOT_A_MODEL = new Set(["auto", "default", "unknown", "none", "null"]);

/*
 * A model's name as the site writes it ("gpt-4o", "o3",
 * "grok-4"). Only letters, digits and the punctuation model names
 * use get through, so a name can't bring Markdown or markup into
 * the exported file.
 */
export function modelName(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const name = value.trim();

  return /^[\p{L}\p{N}][\p{L}\p{N} ._:/()+-]{0,79}$/u.test(name) &&
    !NOT_A_MODEL.has(name.toLowerCase())
    ? name
    : undefined;
}

/*
 * The fields a parser hands content.ts for a message's time and
 * model; each is left out when the site didn't say.
 */
export function messageMetadata(
  time: number | undefined,
  model?: string,
): { time?: number; model?: string } {
  return {
    ...(time !== undefined ? { time } : {}),
    ...(model ? { model } : {}),
  };
}
