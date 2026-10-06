/*
 * =========================================================
 * AI Exporter - copilot-conversation.ts
 * =========================================================
 *
 * Turns a Microsoft Copilot (copilot.microsoft.com) conversation,
 * as the web app's own API returns it, into the messages
 * content.ts hands to popup.ts.
 *
 *   GET /c/api/conversations/{id}/history?api-version=2
 *       { results: [message, ...] }, newest first
 *   GET /c/api/conversations?cursor={cursor}&types=chat
 *       { results: [conversation, ...], next }
 *
 * A signed-in person's requests carry the access token Microsoft's
 * sign-in library (MSAL) keeps in localStorage, under a key with
 * "accesstoken" in it; a guest's need none. A message's author is
 * "human" or "ai", and its content a list of parts, the "text"
 * ones holding what it says.
 *
 * Field names follow the web app's API as open-source exporters
 * read it; everything is read defensively, since the API is
 * undocumented.
 *
 * Imported only by content.ts, so Rollup inlines it into
 * content.js - see the top of claude-conversation.ts.
 */
import { messageMetadata } from "./message-metadata.ts";
import {
  anyTime,
  idValue,
  isRecord,
  record,
  records,
  safeId,
  stringValue,
  textMessage,
  unexpectedFormat,
  type SiteConversationPage,
  type SiteMessage,
} from "./site-json.ts";

/* Conversations live at /chats/{id} */
export function getCopilotConversationId(pathname: string): string | null {
  return pathname.match(/^\/chats\/([A-Za-z0-9_-]{8,128})\/?$/)?.[1] ?? null;
}

/*
 * The access token among MSAL's cache entries: the one for Copilot's
 * chat API, or else the first.
 */
export function readCopilotToken(entries: [string, string | null][]): string | null {
  let fallback: string | null = null;

  for (const [key, raw] of entries) {
    if (!key.toLowerCase().includes("accesstoken") || !raw) {
      continue;
    }

    try {
      const entry: unknown = JSON.parse(raw);
      const secret = isRecord(entry) ? stringValue(entry.secret) : "";

      if (!secret) {
        continue;
      }

      if (stringValue(record(entry).target).toLowerCase().includes("chatai.readwrite")) {
        return secret;
      }

      fallback ??= secret;
    } catch {
      /* Not a token entry */
    }
  }

  return fallback;
}

export function buildCopilotHistoryPath(id: string): string {
  return `/c/api/conversations/${encodeURIComponent(id)}/history?api-version=2`;
}

export function convertCopilotHistory(data: unknown): SiteMessage[] {
  if (!isRecord(data) || !Array.isArray(data.results)) {
    throw unexpectedFormat("Copilot");
  }

  return records(data.results)
    .reverse()
    .flatMap((message, index) => {
      const author = stringValue(record(message.author).type).toLowerCase();
      const role = author === "human" ? "user" : author === "ai" ? "assistant" : null;

      if (!role) {
        return [];
      }

      const text = records(message.content)
        .filter((part) => part.type === "text")
        .map((part) => stringValue(part.text))
        .join("");

      return (
        textMessage(
          idValue(message.id) || `${role}-${index}`,
          role,
          text,
          messageMetadata(anyTime(message.createdAt) ?? undefined),
        ) ?? []
      );
    });
}

export function buildCopilotListPath(cursor: string | null): string {
  return `/c/api/conversations?${new URLSearchParams({
    cursor: cursor ?? "",
    types: "chat",
  }).toString()}`;
}

export function parseCopilotConversationList(data: unknown): SiteConversationPage {
  if (!isRecord(data) || !Array.isArray(data.results)) {
    throw new Error("Copilot returned an unexpected chat list format.");
  }

  const items = records(data.results);
  const next = stringValue(data.next);

  return {
    conversations: items.flatMap((item) => {
      const id = safeId(item.id);

      return id
        ? [
            {
              id,
              title: stringValue(item.title).trim(),
              createdAt: anyTime(item.createdAt),
              updatedAt: anyTime(item.updatedAt) ?? anyTime(item.createdAt),
            },
          ]
        : [];
    }),
    nextCursor: next && items.length > 0 ? next : null,
  };
}
