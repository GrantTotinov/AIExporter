/*
 * =========================================================
 * AI Exporter - notion.ts
 * =========================================================
 *
 * Notion integration: connecting an account, finding the pages
 * the person shared with AI Exporter, and creating a page with
 * the conversation under one of them. Runs in background.ts - the
 * sign-in window closes the popup, and api.notion.com doesn't
 * answer pages' cross-origin requests anyway.
 *
 * CONNECTING
 *
 * The person creates their own internal integration at
 * notion.so/profile/integrations, pastes its secret in, and
 * connects their pages to it themselves (Notion -> the page ->
 * ••• -> Connections). No server-side piece of AI Exporter's own
 * is involved - the secret only ever talks to api.notion.com.
 *
 * (Signing in through Notion's own page, the way the GitHub button
 * works, would need a client secret to turn the resulting code
 * into a token - a secret that can't live in an open-source
 * extension without a small server holding it. Not wired up here;
 * the integration-secret method above is the only one offered.)
 *
 * api.notion.com is an optional host permission, asked for when
 * the person connects, so people who never use Notion aren't
 * asked to allow it - and existing installs aren't disabled by
 * Chrome for a new permission on update.
 *
 * The token is kept in chrome.storage.local (never .sync), like
 * the GitHub one.
 */
import { t } from "./i18n.ts";
import type { NotionBlock } from "./notion-blocks.ts";

export const NOTION_HOST_PERMISSION = "https://api.notion.com/*";

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const STORAGE_KEY = "notionConnection";

/* Notion's own limits on one request */
const MAX_CHILDREN_PER_REQUEST = 100;
const MAX_BLOCKS_PER_REQUEST = 900;
const MAX_RETRIES = 3;

export interface NotionConnection {
  accessToken: string;
  workspaceName?: string;
}

export interface NotionPageOption {
  id: string;
  title: string;
  icon?: string;
}

/*
 * ---------------------------------------------------------
 * STORAGE
 * ---------------------------------------------------------
 */
export async function getNotionConnection(): Promise<NotionConnection | null> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const value = stored[STORAGE_KEY] as Partial<NotionConnection> | undefined;

  return typeof value?.accessToken === "string" && value.accessToken !== ""
    ? (value as NotionConnection)
    : null;
}

async function storeConnection(connection: NotionConnection): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: connection });
}

export async function disconnectNotion(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY);
}

async function hasHostPermission(): Promise<boolean> {
  try {
    return await chrome.permissions.contains({
      origins: [NOTION_HOST_PERMISSION],
    });
  } catch {
    return false;
  }
}

/*
 * ---------------------------------------------------------
 * REQUESTS
 * ---------------------------------------------------------
 */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rawRequest(
  token: string,
  path: string,
  init: RequestInit,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`${NOTION_API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });

    // Notion allows about three requests a second, and says how
    // long to wait when there were too many.
    if (
      (response.status === 429 || response.status >= 500) &&
      attempt < MAX_RETRIES
    ) {
      const retryAfter = Number(response.headers.get("Retry-After"));

      await wait(
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : 1000 * (attempt + 1),
      );
      continue;
    }

    return response;
  }
}

async function errorFrom(response: Response): Promise<Error> {
  const body = (await response.json().catch(() => null)) as {
    code?: string;
    message?: string;
  } | null;

  if (response.status === 404 || body?.code === "object_not_found") {
    return new Error(t("notion.error.pageNotShared"));
  }

  if (response.status === 429) {
    return new Error(t("notion.error.busy"));
  }

  return new Error(
    body?.message ?? `Notion: ${response.status} ${response.statusText}`,
  );
}

async function notionRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const connection = await getNotionConnection();

  if (!connection) {
    throw new Error(t("notion.error.notConnected"));
  }

  if (!(await hasHostPermission())) {
    throw new Error(t("notion.error.permission"));
  }

  const response = await rawRequest(connection.accessToken, path, init);

  if (response.status === 401) {
    await disconnectNotion();
    throw new Error(t("notion.error.connectionExpired"));
  }

  if (!response.ok) {
    throw await errorFrom(response);
  }

  return (await response.json()) as T;
}

/*
 * ---------------------------------------------------------
 * CONNECTING
 * ---------------------------------------------------------
 *
 * Internal integration secrets start with "ntn_" (older ones with
 * "secret_"). The secret is checked against Notion before it's
 * kept, so a typo is caught right away.
 */
export const NOTION_TOKEN_PATTERN = /^(?:ntn_|secret_)[A-Za-z0-9]{20,}$/;

export async function connectNotionWithToken(
  token: string,
): Promise<NotionConnection> {
  const trimmed = token.trim();

  if (!NOTION_TOKEN_PATTERN.test(trimmed)) {
    throw new Error(t("notion.error.tokenFormat"));
  }

  if (!(await hasHostPermission())) {
    throw new Error(t("notion.error.permission"));
  }

  const response = await rawRequest(trimmed, "/users/me", { method: "GET" });

  if (response.status === 401) {
    throw new Error(t("notion.error.tokenRejected"));
  }

  if (!response.ok) {
    throw await errorFrom(response);
  }

  const user = (await response.json()) as {
    name?: string;
    bot?: { workspace_name?: string };
  };
  const connection: NotionConnection = {
    accessToken: trimmed,
    ...(user.bot?.workspace_name || user.name
      ? { workspaceName: user.bot?.workspace_name ?? user.name }
      : {}),
  };

  await storeConnection(connection);
  return connection;
}

/*
 * ---------------------------------------------------------
 * PAGES
 * ---------------------------------------------------------
 */
interface SearchResponse {
  results: {
    object: string;
    id: string;
    archived?: boolean;
    in_trash?: boolean;
    icon?: { type: string; emoji?: string } | null;
    properties?: Record<
      string,
      { type: string; title?: { plain_text?: string }[] }
    >;
  }[];
  has_more: boolean;
  next_cursor: string | null;
}

/*
 * The pages AI Exporter can write into - the ones the person
 * shared with it - most recently edited first.
 */
export async function listNotionPages(): Promise<NotionPageOption[]> {
  const pages: NotionPageOption[] = [];
  let cursor: string | null = null;

  for (let request = 0; request < 3; request++) {
    const data: SearchResponse = await notionRequest<SearchResponse>(
      "/search",
      {
        method: "POST",
        body: JSON.stringify({
          filter: { property: "object", value: "page" },
          sort: { direction: "descending", timestamp: "last_edited_time" },
          page_size: 100,
          ...(cursor ? { start_cursor: cursor } : {}),
        }),
      },
    );

    for (const result of data.results) {
      if (result.object !== "page" || result.archived || result.in_trash) {
        continue;
      }

      const titleProperty = Object.values(result.properties ?? {}).find(
        (property) => property.type === "title",
      );
      const title = (titleProperty?.title ?? [])
        .map((part) => part.plain_text ?? "")
        .join("")
        .trim();

      pages.push({
        id: result.id,
        title: title || t("notion.untitled"),
        ...(result.icon?.type === "emoji" && result.icon.emoji
          ? { icon: result.icon.emoji }
          : {}),
      });
    }

    if (!data.has_more || !data.next_cursor) {
      break;
    }

    cursor = data.next_cursor;
  }

  return pages;
}

function countBlocks(block: NotionBlock): number {
  const children = (block[block.type] as { children?: NotionBlock[] })
    ?.children;

  return 1 + (children ?? []).reduce((sum, child) => sum + countBlocks(child), 0);
}

/*
 * Notion takes at most 100 blocks in one children list, and about
 * a thousand counting nested ones (a table's rows), per request.
 */
export function chunkBlocks(blocks: NotionBlock[]): NotionBlock[][] {
  const chunks: NotionBlock[][] = [];
  let current: NotionBlock[] = [];
  let size = 0;

  for (const block of blocks) {
    const blockSize = countBlocks(block);

    if (
      current.length > 0 &&
      (current.length >= MAX_CHILDREN_PER_REQUEST ||
        size + blockSize > MAX_BLOCKS_PER_REQUEST)
    ) {
      chunks.push(current);
      current = [];
      size = 0;
    }

    current.push(block);
    size += blockSize;
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

const PAGE_ICON = String.fromCodePoint(0x1f4ac);

export async function createNotionPage(
  parentId: string,
  title: string,
  blocks: NotionBlock[],
): Promise<{ url: string }> {
  const [first = [], ...rest] = chunkBlocks(blocks);
  const page = await notionRequest<{ id: string; url?: string }>("/pages", {
    method: "POST",
    body: JSON.stringify({
      parent: { type: "page_id", page_id: parentId },
      icon: { type: "emoji", emoji: PAGE_ICON },
      properties: {
        title: { title: [{ type: "text", text: { content: title } }] },
      },
      children: first,
    }),
  });

  for (const chunk of rest) {
    await notionRequest(`/blocks/${page.id}/children`, {
      method: "PATCH",
      body: JSON.stringify({ children: chunk }),
    });
  }

  return {
    url:
      typeof page.url === "string" && page.url.startsWith("https://")
        ? page.url
        : `https://www.notion.so/${page.id.replace(/-/g, "")}`,
  };
}
