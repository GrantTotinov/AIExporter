/*
 * ---------------------------------------------------------
 * SUPPORTED CHAT SITES
 * ---------------------------------------------------------
 *
 * The sites AI Exporter exports conversations from. All of them
 * are listed under content_scripts in both manifests, so their
 * pages always have content.js, with no access to grant first.
 *
 * A site added there is a new permission: Chrome turns the
 * extension off for every person who has it until they agree to
 * it again - most never find out why - and Firefox holds the
 * update back. New sites are best added together, in one release.
 *
 * content.ts picks the matching loader by hostname. popup.ts uses
 * these helpers to check that the active tab is one of them and
 * to name exported files after it.
 *
 * Not imported by content.ts: a module content.js shared with
 * the popup/options/background bundles would be split into a
 * separate chunk that content.js would have to `import`, which
 * a classic content script can't do (see the top of
 * content.ts).
 */
export type ChatSite =
  | "chatgpt"
  | "claude"
  | "gemini"
  | "deepseek"
  | "grok"
  | "perplexity";

export const CHAT_SITES: readonly ChatSite[] = [
  "chatgpt",
  "claude",
  "gemini",
  "deepseek",
  "grok",
  "perplexity",
];

/* The addresses each site's pages live at; the first is its own. */
const CHAT_SITE_ORIGINS: Record<ChatSite, readonly string[]> = {
  chatgpt: ["https://chatgpt.com"],
  claude: ["https://claude.ai"],
  gemini: ["https://gemini.google.com"],
  deepseek: ["https://chat.deepseek.com"],
  grok: ["https://grok.com"],
  perplexity: ["https://www.perplexity.ai", "https://perplexity.ai"],
};

export const CHAT_SITE_NAMES: Record<ChatSite, string> = {
  chatgpt: "ChatGPT",
  claude: "Claude",
  gemini: "Gemini",
  deepseek: "DeepSeek",
  grok: "Grok",
  perplexity: "Perplexity",
};

/* The page the popup opens for a site */
export const CHAT_SITE_START_URLS: Record<ChatSite, string> = {
  chatgpt: "https://chatgpt.com/",
  claude: "https://claude.ai/new",
  gemini: "https://gemini.google.com/app",
  deepseek: "https://chat.deepseek.com/",
  grok: "https://grok.com/",
  perplexity: "https://www.perplexity.ai/",
};

export function isChatSite(value: unknown): value is ChatSite {
  return (CHAT_SITES as readonly unknown[]).includes(value);
}

export function getChatSite(url: string | undefined): ChatSite | null {
  if (!url) {
    return null;
  }

  try {
    const { origin } = new URL(url);

    return (
      CHAT_SITES.find((site) => CHAT_SITE_ORIGINS[site].includes(origin)) ??
      null
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
 * These are the patterns content.ts and the site modules read
 * the conversation ID with: getConversationIdFromUrl() there,
 * and getClaudeConversationId(), getGeminiConversationId(),
 * getDeepSeekConversationId(), getGrokConversationId() and
 * getPerplexityThreadSlug(). Importing those would pull the site
 * modules out of content.js into a shared chunk, so they're
 * repeated, and tests/chat-sites.test.ts checks that they agree.
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const GEMINI_CONVERSATION_PATH =
  /^(?:\/u\/\d+)?\/(?:app|gem\/[^/]+)\/[A-Za-z0-9_-]{1,128}\/?$/;

const DEEPSEEK_CONVERSATION_PATH = /^\/a\/[A-Za-z0-9_-]+\/s\/[A-Za-z0-9_-]{1,128}\/?$/;

const GROK_CONVERSATION_PATH =
  /^(?:\/[a-z]{2}(?:-[A-Za-z]{2,4})?)?\/(?:c|chat)\/([0-9a-f-]{36})\/?$/i;

const PERPLEXITY_THREAD_PATH = /^\/search\/[^/]{1,512}\/?$/;

function hasConversationId(site: ChatSite, pathname: string): boolean {
  switch (site) {
    case "chatgpt":
      return /\/c\/[0-9a-f-]{36}(?:\/|$)/i.test(pathname);
    case "claude": {
      const id = pathname.match(/\/chat\/([0-9a-f-]{36})(?:\/|$)/i)?.[1];

      return id !== undefined && UUID_PATTERN.test(id);
    }
    case "gemini":
      return GEMINI_CONVERSATION_PATH.test(pathname);
    case "deepseek":
      return DEEPSEEK_CONVERSATION_PATH.test(pathname);
    case "grok": {
      const id = pathname.match(GROK_CONVERSATION_PATH)?.[1];

      return id !== undefined && UUID_PATTERN.test(id);
    }
    case "perplexity":
      return PERPLEXITY_THREAD_PATH.test(pathname);
  }
}

export function isChatConversationUrl(url: string | undefined): boolean {
  const site = getChatSite(url);

  return site !== null && hasConversationId(site, new URL(url!).pathname);
}

/*
 * The sites end the tab title with their own name ("Trip ideas
 * - ChatGPT", "Trip ideas - Claude", "Trip ideas - Google
 * Gemini", "Trip ideas - DeepSeek"); exports are named and titled
 * after the conversation alone. Gemini also puts an invisible
 * left-to-right mark in front of its titles, which is dropped too.
 */
export function stripChatSiteSuffix(title: string): string {
  return title
    .replace(/^[\u{200E}\u{200F}]+|[\u{200E}\u{200F}]+$/gu, "")
    .replace(
      /\s*[-|·–—]\s*(?:ChatGPT|Claude|(?:Google\s+)?Gemini|DeepSeek|Grok|Perplexity(?:\s+AI)?)\s*$/i,
      "",
    )
    .trim();
}
