/*
 * =========================================================
 * AI Exporter - message-details.ts
 * =========================================================
 *
 * What the exports write next to a message's name when
 * Settings.includeMessageDetails is on: when it was sent and, for
 * a reply, the AI model that wrote it - "2026-10-03 14:05 ·
 * gpt-4o". Times are in the person's own time zone, written the
 * one way that reads the same in every language and sorts by
 * date. The site parsers read the values from each site's API
 * (see message-metadata.ts).
 */
import type { Message } from "./export-builders.ts";

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/* "2026-10-03", in local time */
function localDay(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/* "2026-10-03 14:05", in local time */
export function messageTime(time: number): string {
  const date = new Date(time);

  return `${localDay(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/*
 * "2026-10-03 14:05:09", in local time: the form Excel and Google
 * Sheets read as a date and time.
 */
export function spreadsheetTime(time: number): string {
  return `${messageTime(time)}:${pad(new Date(time).getSeconds())}`;
}

/*
 * "2026-10-03T14:05", in local time: the form Obsidian reads as a
 * date and time in a note's properties.
 */
export function propertyTime(time: number): string {
  return messageTime(time).replace(" ", "T");
}

/* "2026-10-03T12:05:09.000Z": the standard form for data */
export function isoTime(time: number): string {
  return new Date(time).toISOString();
}

/*
 * A message's details as one line - "2026-10-03 14:05 · gpt-4o" -
 * or "" when it has none (the setting is off, or the site didn't
 * say).
 */
export function messageDetails(message: Pick<Message, "time" | "model">): string {
  return [
    message.time !== undefined ? messageTime(message.time) : "",
    message.model ?? "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/*
 * When the conversation started and was last added to, from its
 * first and last message with a time; null when none has one.
 */
export function conversationSpan(
  messages: Pick<Message, "time">[],
): { start: number; end: number } | null {
  const times = messages
    .map((message) => message.time)
    .filter((time): time is number => time !== undefined);

  return times.length > 0
    ? { start: Math.min(...times), end: Math.max(...times) }
    : null;
}

/* The models the replies were written by, each once, in order */
export function conversationModels(messages: Pick<Message, "model">[]): string[] {
  return [
    ...new Set(
      messages
        .map((message) => message.model)
        .filter((model): model is string => Boolean(model)),
    ),
  ];
}
