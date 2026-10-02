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
