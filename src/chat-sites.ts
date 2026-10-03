/*
 * ---------------------------------------------------------
 * SUPPORTED CHAT SITES
 * ---------------------------------------------------------
 *
 * The sites AI Exporter exports conversations from. Each one
 * is listed under content_scripts in both manifests, and
 * content.ts picks the matching loader by hostname. popup.ts
 * uses these helpers to check that the active tab is one of
 * them and to name exported files after it.
 *
 * Not imported by content.ts: a module content.js shared with
 * the popup/options/background bundles would be split into a
 * separate chunk that content.js would have to `import`, which
 * a classic content script can't do (see the top of
 * content.ts).
 */
export type ChatSite = "chatgpt" | "claude" | "gemini";

const CHAT_SITE_ORIGINS: Record<ChatSite, string> = {
  chatgpt: "https://chatgpt.com",
  claude: "https://claude.ai",
  gemini: "https://gemini.google.com",
};

export const CHAT_SITE_NAMES: Record<ChatSite, string> = {
  chatgpt: "ChatGPT",
  claude: "Claude",
  gemini: "Gemini",
};

export function getChatSite(url: string | undefined): ChatSite | null {
  if (!url) {
    return null;
  }

  try {
    const { origin } = new URL(url);

    return (
      (Object.keys(CHAT_SITE_ORIGINS) as ChatSite[]).find(
        (site) => CHAT_SITE_ORIGINS[site] === origin,
      ) ?? null
    );
  } catch {
    return null;
  }
}

/*
 * Whether the URL is a conversation the content script can
 * export, rather than another page of the site (a new chat,
 * the home page, settings). The popup asks the person to open
 * a conversation first instead of letting the export fail.
 *
 * These are the patterns content.ts reads the conversation ID
 * with: getConversationIdFromUrl() there, and
 * getClaudeConversationId() and getGeminiConversationId().
 * Importing those two from here would pull
 * claude-conversation.ts and gemini-conversation.ts out of
 * content.js into a shared chunk, so they're repeated, and
 * tests/chat-sites.test.ts checks that both agree.
 */
const CLAUDE_CONVERSATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const GEMINI_CONVERSATION_PATH =
  /^(?:\/u\/\d+)?\/(?:app|gem\/[^/]+)\/[A-Za-z0-9_-]{1,128}\/?$/;

function hasConversationId(site: ChatSite, pathname: string): boolean {
  switch (site) {
    case "chatgpt":
      return /\/c\/[0-9a-f-]{36}(?:\/|$)/i.test(pathname);
    case "claude": {
      const id = pathname.match(/\/chat\/([0-9a-f-]{36})(?:\/|$)/i)?.[1];

      return id !== undefined && CLAUDE_CONVERSATION_ID.test(id);
    }
    case "gemini":
      return GEMINI_CONVERSATION_PATH.test(pathname);
  }
}

export function isChatConversationUrl(url: string | undefined): boolean {
  const site = getChatSite(url);

  return site !== null && hasConversationId(site, new URL(url!).pathname);
}

/*
 * The sites end the tab title with their own name ("Trip ideas
 * - ChatGPT", "Trip ideas - Claude", "Trip ideas - Google
 * Gemini"); exports are named and titled after the conversation
 * alone. Gemini also puts an invisible left-to-right mark in
 * front of its titles, which is dropped too.
 */
export function stripChatSiteSuffix(title: string): string {
  return title
    .replace(/^[\u{200E}\u{200F}]+|[\u{200E}\u{200F}]+$/gu, "")
    .replace(/\s*[-|]\s*(?:ChatGPT|Claude|(?:Google\s+)?Gemini)\s*$/i, "")
    .trim();
}
