/*
 * =========================================================
 * BULK EXPORT HELPERS
 * =========================================================
 *
 * The parts of the bulk export page (bulk.ts) that don't touch
 * the DOM: searching and date-filtering the conversation list,
 * and naming the files inside the ZIP.
 */
import type { ChatSite } from "./chat-sites.ts";
import type { ConversationSummary } from "./conversation-list.ts";
import { STANDARD_FILE_NAME, renderFileName, titleSlug } from "./file-names.ts";

export type DatePreset = "all" | "7d" | "30d" | "90d" | "365d" | "custom";

export interface ConversationFilter {
  query: string;
  preset: DatePreset;
  /* "YYYY-MM-DD" from the date inputs; used with preset "custom". */
  from: string;
  to: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const PRESET_DAYS: Partial<Record<DatePreset, number>> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  "365d": 365,
};

/* A "YYYY-MM-DD" date input's value as local midnight. */
function parseDateInput(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);

  return match
    ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime()
    : null;
}

/*
 * The [start, end) range of last-activity times a filter keeps;
 * an open end is null. A custom range includes the whole "to"
 * day.
 */
export function filterRange(
  filter: Pick<ConversationFilter, "preset" | "from" | "to">,
  now: number,
): { start: number | null; end: number | null } {
  const days = PRESET_DAYS[filter.preset];

  if (days !== undefined) {
    return { start: now - days * DAY_MS, end: null };
  }

  if (filter.preset === "custom") {
    const start = parseDateInput(filter.from);
    const to = parseDateInput(filter.to);

    return {
      start,
      end: to === null ? null : new Date(to).setDate(new Date(to).getDate() + 1),
    };
  }

  return { start: null, end: null };
}

/*
 * Case- and accent-insensitive, every word of the query somewhere
 * in the title. A conversation without a date is kept by any date
 * filter: the site didn't say when it was used (a sidebar scraped
 * because the list API failed), and dropping it silently would
 * lose it from the export.
 */
export function filterConversations(
  conversations: ConversationSummary[],
  filter: ConversationFilter,
  now: number,
): ConversationSummary[] {
  const normalize = (text: string): string =>
    text.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();
  const words = normalize(filter.query).split(/\s+/).filter(Boolean);
  const { start, end } = filterRange(filter, now);

  return conversations.filter((conversation) => {
    const time = conversation.updatedAt ?? conversation.createdAt;

    if (time !== null) {
      if ((start !== null && time < start) || (end !== null && time >= end)) {
        return false;
      }
    }

    const title = normalize(conversation.title);
    return words.every((word) => title.includes(word));
  });
}

/* "2026-10-03" in local time. */
export function localDate(time: number): string {
  const date = new Date(time);
  const pad = (value: number) => String(value).padStart(2, "0");

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/*
 * A file name for a conversation. The standard one is its
 * last-activity date, so the ZIP sorts by date, and its title in
 * any script - lowercased, with everything that isn't a letter or
 * digit turned into "-". With a pattern of the person's own (see
 * file-names.ts), {date} and {time} are that last activity too:
 * every chat in the ZIP was saved on the same day.
 */
export function conversationFileBase(
  conversation: ConversationSummary,
  template: string = STANDARD_FILE_NAME,
  site: ChatSite | null = null,
): string {
  const time = conversation.updatedAt ?? conversation.createdAt;

  if (template.trim() !== STANDARD_FILE_NAME) {
    return renderFileName(template, {
      title: conversation.title,
      site,
      date: new Date(time ?? Date.now()),
    });
  }

  const name = titleSlug(conversation.title) || "chat";

  return time === null ? name : `${localDate(time)}-${name}`;
}

/*
 * `base`, or `base-2`, `base-3`... when an earlier conversation
 * already took the name (two chats titled "New chat" on one day);
 * a name written with spaces gets "base (2)" instead.
 */
export function uniqueName(base: string, used: Set<string>): string {
  let name = base;

  for (let index = 2; used.has(name.toLowerCase()); index++) {
    name = base.includes(" ") ? `${base} (${index})` : `${base}-${index}`;
  }

  used.add(name.toLowerCase());
  return name;
}
