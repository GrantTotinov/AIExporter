/*
 * =========================================================
 * CONVERSATION LIST
 * =========================================================
 *
 * The person's conversations on a chat site, as the bulk export
 * page lists them. content.ts fetches the sidebar's own list
 * (see LIST CONVERSATIONS there); this module only describes
 * an entry and reads ChatGPT's response.
 *
 * Only content.ts imports this at runtime - the bulk page takes
 * its types alone - so Rollup inlines it into content.js, which
 * can't `import` (see the top of content.ts).
 */

export interface ConversationSummary {
  id: string;
  title: string;
  /* The conversation's own page. */
  url: string;
  /* Milliseconds since the epoch, or null when the site doesn't say. */
  createdAt: number | null;
  updatedAt: number | null;
}

/*
 * One page of the list. `nextCursor` is passed back to get the
 * next page, and is null after the last one.
 */
export interface ConversationListPage {
  conversations: ConversationSummary[];
  nextCursor: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/*
 * ChatGPT has sent both Unix seconds (1727000000.123) and ISO
 * strings ("2024-09-22T10:13:20.123456Z") for these.
 */
export function parseChatGptTime(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
  }

  if (typeof value === "string" && value) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }

  return null;
}

/*
 * A page of /backend-api/conversations: { items, total, limit,
 * offset }, each item { id, title, create_time, update_time }.
 */
export function parseChatGptConversationList(data: unknown): {
  conversations: Omit<ConversationSummary, "url">[];
  total: number | null;
} {
  if (!isRecord(data) || !Array.isArray(data.items)) {
    throw new Error("ChatGPT returned an unexpected conversation list format.");
  }

  const conversations = data.items.flatMap(
    (item): Omit<ConversationSummary, "url">[] => {
      if (!isRecord(item) || typeof item.id !== "string" || !item.id) {
        return [];
      }

      const createdAt = parseChatGptTime(item.create_time);

      return [
        {
          id: item.id,
          title: typeof item.title === "string" ? item.title.trim() : "",
          createdAt,
          updatedAt: parseChatGptTime(item.update_time) ?? createdAt,
        },
      ];
    },
  );

  return {
    conversations,
    total: typeof data.total === "number" ? data.total : null,
  };
}
