/*
 * =========================================================
 * AI Exporter - content.ts
 * =========================================================
 *
 * The content script:
 *
 * 1. Injects pageBridge.js into ChatGPT's MAIN world.
 * 2. Requests conversation pages from the bridge.
 * 3. Paginates backwards through the ChatGPT conversation API.
 * 4. Converts API messages into the format expected by popup.ts.
 *
 * On claude.ai it instead fetches the conversation straight
 * from claude.ai's own API (see LOAD CLAUDE CONVERSATION
 * below): that API authenticates with the session cookie,
 * which this script's same-origin requests send as well, so
 * no page bridge is needed there. gemini.google.com works the
 * same way (see LOAD GEMINI CONVERSATION below).
 *
 * No DOM scrolling is used.
 * No conversation credentials are stored by this file.
 */

/*
 * The only imports this file has. claude-conversation.ts and
 * gemini-conversation.ts are imported by nothing else, so
 * Rollup inlines them into content.js rather than emitting an
 * `import` (see the note below and at the top of
 * claude-conversation.ts).
 */
import {
  buildClaudeConversationPath,
  convertClaudeMessages,
  getClaudeChatOrganizationIds,
  getClaudeConversationId,
  getClaudeOrganizationIdFromCookie,
  resolveClaudeActiveBranch,
  type ClaudeConversation,
  type ClaudeImage,
} from "./claude-conversation.ts";
import {
  buildGeminiReadRequest,
  convertGeminiTurns,
  getGeminiAccountPrefix,
  getGeminiConversationId,
  isGeminiImageUrl,
  parseGeminiTurnsPage,
  readGeminiPageTokens,
  type GeminiImage,
  type GeminiPageTokens,
} from "./gemini-conversation.ts";

/*
 * ---------------------------------------------------------
 * MINIMAL LOCAL TRANSLATIONS
 * ---------------------------------------------------------
 *
 * Content scripts can't use `import` at runtime (Chrome/
 * Firefox both parse them as plain classic scripts, not ES
 * modules), so this can't pull in the shared src/i18n.ts
 * module the way popup.ts/options.ts do - doing so would
 * force Rollup to split it into a separate chunk that
 * content.js would then try to `import`, which fails outside
 * a module context. This keeps its own tiny, self-contained
 * copy of just the handful of strings the export success
 * overlay (further below) needs, translated the same way as
 * everything in src/locales/*.json.
 */
const CONTENT_LOCALES = ["en", "es", "fr", "de", "ru", "zh"] as const;
type ContentLocale = (typeof CONTENT_LOCALES)[number];

const CONTENT_STRINGS: Record<ContentLocale, Record<string, string>> = {
  en: {
    title: "Export complete",
    subtitle: "Your chat has been saved.",
    freeTitle: "Free for everyone",
    freeText:
      "No ads, no account, no tracking. AI Exporter is built by one independent developer — a review or a coffee helps keep it free and improving.",
    review: "Leave a review",
    coffee: "Buy me a coffee",
    feedbackTitle: "Questions, ideas or a problem?",
    feedbackText: "Write to me directly — I read every message.",
    writeToMe: "Write to me",
    copyEmail: "Copy email address",
    copied: "Copied",
    github: "or report it on GitHub",
    close: "Close",
    emailSubject: "AI Exporter feedback",
    emailPlaceholder: "Write your message here:",
  },
  es: {
    title: "Exportación completada",
    subtitle: "Tu chat se ha guardado.",
    freeTitle: "Gratis para todos",
    freeText:
      "Sin anuncios, sin cuenta y sin rastreo. AI Exporter lo desarrolla una sola persona: una reseña o un café ayudan a que siga siendo gratis y mejorando.",
    review: "Dejar una reseña",
    coffee: "Invítame a un café",
    feedbackTitle: "¿Preguntas, ideas o algún problema?",
    feedbackText: "Escríbeme directamente; leo todos los mensajes.",
    writeToMe: "Escríbeme",
    copyEmail: "Copiar dirección de correo",
    copied: "Copiada",
    github: "o infórmalo en GitHub",
    close: "Cerrar",
    emailSubject: "Comentarios sobre AI Exporter",
    emailPlaceholder: "Escribe tu mensaje aquí:",
  },
  fr: {
    title: "Export terminé",
    subtitle: "Votre conversation a été enregistrée.",
    freeTitle: "Gratuit pour tous",
    freeText:
      "Pas de publicité, pas de compte, pas de pistage. AI Exporter est développé par une seule personne : un avis ou un café l'aide à rester gratuit et à s'améliorer.",
    review: "Laisser un avis",
    coffee: "M'offrir un café",
    feedbackTitle: "Une question, une idée ou un problème ?",
    feedbackText: "Écrivez-moi directement, je lis tous les messages.",
    writeToMe: "M'écrire",
    copyEmail: "Copier l'adresse e-mail",
    copied: "Copiée",
    github: "ou signalez-le sur GitHub",
    close: "Fermer",
    emailSubject: "Avis sur AI Exporter",
    emailPlaceholder: "Écrivez votre message ici :",
  },
  de: {
    title: "Export abgeschlossen",
    subtitle: "Dein Chat wurde gespeichert.",
    freeTitle: "Kostenlos für alle",
    freeText:
      "Keine Werbung, kein Konto, kein Tracking. AI Exporter wird von einer einzelnen Person entwickelt — eine Bewertung oder ein Kaffee hilft, es kostenlos zu halten und weiter zu verbessern.",
    review: "Bewertung schreiben",
    coffee: "Spendiere mir einen Kaffee",
    feedbackTitle: "Fragen, Ideen oder ein Problem?",
    feedbackText: "Schreib mir direkt — ich lese jede Nachricht.",
    writeToMe: "Schreib mir",
    copyEmail: "E-Mail-Adresse kopieren",
    copied: "Kopiert",
    github: "oder melde es auf GitHub",
    close: "Schließen",
    emailSubject: "Feedback zu AI Exporter",
    emailPlaceholder: "Schreib deine Nachricht hier:",
  },
  ru: {
    title: "Экспорт завершён",
    subtitle: "Ваш чат сохранён.",
    freeTitle: "Бесплатно для всех",
    freeText:
      "Без рекламы, без регистрации и без слежки. AI Exporter создаёт один независимый разработчик — отзыв или чашка кофе помогают ему оставаться бесплатным и становиться лучше.",
    review: "Оставить отзыв",
    coffee: "Угостить кофе",
    feedbackTitle: "Вопросы, идеи или что-то не работает?",
    feedbackText: "Напишите мне напрямую — я читаю каждое сообщение.",
    writeToMe: "Написать мне",
    copyEmail: "Скопировать адрес",
    copied: "Скопировано",
    github: "или сообщите на GitHub",
    close: "Закрыть",
    emailSubject: "Отзыв об AI Exporter",
    emailPlaceholder: "Напишите ваше сообщение здесь:",
  },
  zh: {
    title: "导出完成",
    subtitle: "您的对话已保存。",
    freeTitle: "完全免费",
    freeText:
      "无广告、无需账号、无跟踪。AI Exporter 由一名独立开发者打造——留个评价或请杯咖啡，都能帮助它保持免费并持续改进。",
    review: "留下评价",
    coffee: "请我喝咖啡",
    feedbackTitle: "有问题、想法或遇到故障？",
    feedbackText: "直接给我写信——每条消息我都会阅读。",
    writeToMe: "给我写信",
    copyEmail: "复制邮箱地址",
    copied: "已复制",
    github: "或在 GitHub 上反馈",
    close: "关闭",
    emailSubject: "AI Exporter 反馈",
    emailPlaceholder: "请在此输入您的消息：",
  },
};

let contentLocale: ContentLocale = "en";

function isContentLocale(value: string): value is ContentLocale {
  return (CONTENT_LOCALES as readonly string[]).includes(value);
}

function detectBrowserLocale(): ContentLocale {
  const candidates: string[] = [];

  try {
    const uiLanguage = chrome?.i18n?.getUILanguage?.();

    if (uiLanguage) {
      candidates.push(uiLanguage);
    }
  } catch {
    /* chrome.i18n unavailable - ignore */
  }

  candidates.push(navigator.language, ...(navigator.languages ?? []));

  for (const candidate of candidates) {
    if (!candidate) continue;

    const short = candidate.slice(0, 2).toLowerCase();

    if (isContentLocale(short)) {
      return short;
    }
  }

  return "en";
}

/*
 * Mirrors Settings["language"] from settings.ts without
 * importing it (same reason as above - keeps this file
 * import-free). Reads the raw stored value directly.
 */
async function initContentI18n(): Promise<void> {
  const stored = await chrome.storage.sync.get({ language: "auto" });
  const preference = String(stored.language ?? "auto");

  contentLocale =
    preference === "auto"
      ? detectBrowserLocale()
      : isContentLocale(preference)
        ? preference
        : "en";
}

function ct(key: string): string {
  return (
    CONTENT_STRINGS[contentLocale]?.[key] ?? CONTENT_STRINGS.en[key] ?? key
  );
}

/*
 * Kicked off once at load time rather than per-overlay - by
 * the time an export finishes (at minimum a few seconds of
 * conversation loading plus a download/GitHub save), this has
 * long since resolved.
 */
void initContentI18n();

const devLog = (...args: unknown[]): void => {
  if (import.meta.env.DEV) {
    console.log(...args);
  }
};

const devWarn = (...args: unknown[]): void => {
  if (import.meta.env.DEV) {
    console.warn(...args);
  }
};

const devError = (...args: unknown[]): void => {
  if (import.meta.env.DEV) {
    console.error(...args);
  }
};

/*
 * ---------------------------------------------------------
 * PAGE BRIDGE INJECTION
 * ---------------------------------------------------------
 *
 * ChatGPT only - claude.ai and gemini.google.com are loaded
 * without the bridge (see the top of this file).
 */

const IS_CLAUDE_SITE = window.location.hostname === "claude.ai";
const IS_GEMINI_SITE = window.location.hostname === "gemini.google.com";

function injectPageBridge(): void {
  if (document.documentElement.dataset.aiExporterBridgeInjected === "true") {
    return;
  }

  const script = document.createElement("script");

  script.src = chrome.runtime.getURL("pageBridge.js");

  script.dataset.aiExporter = "page-bridge";

  script.onload = () => {
    script.remove();

    devLog("AI Exporter: page bridge injected");
  };

  script.onerror = () => {
    devError("AI Exporter: failed to inject page bridge");
  };

  (document.head || document.documentElement).appendChild(script);

  document.documentElement.dataset.aiExporterBridgeInjected = "true";
}

if (!IS_CLAUDE_SITE && !IS_GEMINI_SITE) {
  injectPageBridge();
}

/*
 * ---------------------------------------------------------
 * EXPORT MESSAGE TYPE
 * ---------------------------------------------------------
 */

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  order: number;
  imagePaths?: string[];
}

interface ExportImageFile {
  path: string;
  mimeType: string;
  base64: string;
  sizeBytes: number;
}

interface ConversationLoadResult {
  messages: Message[];
  images: ExportImageFile[];
}

/*
 * ---------------------------------------------------------
 * CHATGPT API TYPES
 * ---------------------------------------------------------
 */

interface ApiMessage {
  id?: string;

  message?: ApiMessage | null;

  parent?: string | null;

  parent_message_id?: string | null;

  parent_id?: string | null;

  children?: string[];

  author?: {
    role?: string;
  };

  create_time?: number | null;

  content?: {
    content_type?: string;
    parts?: unknown[];
  };

  status?: string;

  end_turn?: boolean | null;

  recipient?: string | null;

  channel?: string | null;

  metadata?: {
    is_visually_hidden_from_conversation?: boolean;
    parent_id?: string | null;
    parent_message_id?: string | null;
    request_id?: string | null;
    turn_exchange_id?: string | null;
    [key: string]: unknown;
  };
}

interface ApiImagePart {
  content_type?: string;
  asset_pointer?: string;
  image_url?: unknown;
  url?: unknown;
}

interface ApiImageReference {
  fileId: string;
  scheme: "file-service" | "sediment";
}

interface ApiMappingNode {
  id?: string;
  parent?: string | null;
  children?: string[];
  message?: ApiMessage | null;
}

interface ConversationPage {
  messages?: ApiMessage[];

  mapping?: Record<string, ApiMappingNode>;

  current_node?: string | null;

  page_info?: {
    start_cursor?: string | null;
    end_cursor?: string | null;
    has_previous_page?: boolean;
    has_next_page?: boolean;
  };
}

function normalizeConversationPage(page: ConversationPage): ConversationPage {
  if (page.mapping) {
    const messages: ApiMessage[] = [];

    for (const [nodeId, node] of Object.entries(page.mapping)) {
      if (!node.message) {
        messages.push({
          id: nodeId,
          parent: node.parent,
          children: node.children,
        });
        continue;
      }

      messages.push({
        ...node.message,
        id: node.message.id ?? nodeId,
        parent: node.parent ?? node.message.parent,
        children: node.children ?? node.message.children,
      });
    }

    return {
      ...page,
      messages,
    };
  }

  const nestedMessages = page.messages?.filter(
    (message) => message.message !== null && message.message !== undefined,
  );

  if (!nestedMessages || nestedMessages.length === 0) {
    return page;
  }

  const messages: ApiMessage[] = [];

  for (const rawNode of page.messages ?? []) {
    const node = rawNode as ApiMappingNode;
    messages.push({
      ...(node.message ?? {}),
      id: node.message?.id ?? node.id ?? rawNode.id,
      parent: node.parent ?? node.message?.parent,
      children: node.children ?? node.message?.children,
    });
  }

  return {
    ...page,
    messages,
  };
}

function getApiMessageParentId(message: ApiMessage): string | null {
  const candidates = [
    message.parent,
    message.parent_message_id,
    message.parent_id,
    message.metadata?.parent_message_id,
    message.metadata?.parent_id,
  ];

  return (
    candidates.find(
      (candidate): candidate is string =>
        typeof candidate === "string" && candidate.length > 0,
    ) ?? null
  );
}

function getTurnExchangeId(message: ApiMessage): string | null {
  const value = message.metadata?.turn_exchange_id;

  return typeof value === "string" && value.length > 0 ? value : null;
}

function getApiMessageTime(message: ApiMessage): number {
  return message.create_time ?? Number.MAX_SAFE_INTEGER;
}

function resolveActiveMessages(
  rawById: Map<string, ApiMessage>,
  collected: Map<string, ApiMessage>,
  currentNode: string | null,
  downloadImagesLocally: boolean,
): ApiMessage[] {
  const exportable = Array.from(collected.values());
  const turnGroups = new Map<
    string,
    { user?: ApiMessage; assistant?: ApiMessage }
  >();

  for (const message of exportable) {
    const turnId = getTurnExchangeId(message);

    if (!turnId) {
      continue;
    }

    const group = turnGroups.get(turnId) ?? {};

    if (message.author?.role === "user") {
      group.user = message;
    } else if (message.author?.role === "assistant") {
      group.assistant = message;
    }

    turnGroups.set(turnId, group);
  }

  const completeTurns = Array.from(turnGroups.values()).filter(
    (turn): turn is { user: ApiMessage; assistant: ApiMessage } =>
      Boolean(turn.user && turn.assistant),
  );

  if (completeTurns.length > 0) {
    completeTurns.sort(
      (a, b) => getApiMessageTime(a.assistant) - getApiMessageTime(b.assistant),
    );

    return completeTurns.flatMap(({ user, assistant }) => [user, assistant]);
  }

  const users = exportable
    .filter((message) => message.author?.role === "user")
    .sort((a, b) => getApiMessageTime(a) - getApiMessageTime(b));
  const assistants = exportable
    .filter((message) => message.author?.role === "assistant")
    .sort((a, b) => getApiMessageTime(a) - getApiMessageTime(b));

  const assistantsByParent = new Map<string, ApiMessage[]>();

  for (const message of exportable) {
    if (message.author?.role !== "assistant") {
      continue;
    }

    const parentId = getApiMessageParentId(message);

    if (!parentId) {
      continue;
    }

    const assistants = assistantsByParent.get(parentId) ?? [];
    assistants.push(message);
    assistantsByParent.set(parentId, assistants);
  }

  const currentAssistant = currentNode ? rawById.get(currentNode) : undefined;
  const currentUserId = currentAssistant
    ? getApiMessageParentId(currentAssistant)
    : null;
  const usedAssistants = new Set<string>();
  const turns: Array<{
    user: ApiMessage;
    assistant?: ApiMessage;
    order: number;
  }> = [];

  /*
   * `assistants` is sorted by time. Rather than re-scanning
   * it from the start for every user (O(users * assistants)),
   * walk it once with a forward-only pointer: since users are
   * also processed in time order, any assistant the pointer
   * has already passed can never match a later user either.
   */
  let assistantPointer = 0;

  for (const [userIndex, user] of users.entries()) {
    if (!user.id) {
      continue;
    }

    const userTime = getApiMessageTime(user);

    const candidates = assistantsByParent.get(user.id) ?? [];
    const mappedAssistant =
      user.id === currentUserId
        ? currentAssistant
        : candidates.sort(
            (a, b) => getApiMessageTime(b) - getApiMessageTime(a),
          )[0];
    const nextUserTime =
      users[userIndex + 1] === undefined
        ? Number.POSITIVE_INFINITY
        : getApiMessageTime(users[userIndex + 1]);

    /*
     * Advance the pointer past any assistant strictly
     * earlier than this user - those can never be chosen
     * for this or any later user.
     */
    while (
      assistantPointer < assistants.length &&
      getApiMessageTime(assistants[assistantPointer]) < userTime
    ) {
      assistantPointer++;
    }

    let chronologicalAssistant: ApiMessage | undefined;
    let nearestAssistant: ApiMessage | undefined;

    for (let i = assistantPointer; i < assistants.length; i++) {
      const assistant = assistants[i];

      if (!assistant.id || usedAssistants.has(assistant.id)) {
        continue;
      }

      const assistantTime = getApiMessageTime(assistant);

      if (nearestAssistant === undefined) {
        nearestAssistant = assistant;
      }

      if (assistantTime < nextUserTime) {
        chronologicalAssistant = assistant;
      }

      /*
       * Once we've found both the in-window match and the
       * nearest fallback, or moved past the window, further
       * scanning can't improve either answer.
       */
      if (
        chronologicalAssistant !== undefined ||
        assistantTime >= nextUserTime
      ) {
        break;
      }
    }

    const assistant =
      mappedAssistant ?? chronologicalAssistant ?? nearestAssistant;

    const selectedAssistant =
      assistant &&
      assistant.id &&
      !usedAssistants.has(assistant.id) &&
      isExportableApiMessage(assistant, downloadImagesLocally)
        ? assistant
        : undefined;

    if (selectedAssistant?.id) {
      usedAssistants.add(selectedAssistant.id);
    }

    turns.push({
      user,
      assistant: selectedAssistant,
      order: selectedAssistant
        ? getApiMessageTime(selectedAssistant)
        : getApiMessageTime(user),
    });
  }

  turns.sort((a, b) => a.order - b.order);

  return turns.flatMap(({ user, assistant }) =>
    assistant ? [user, assistant] : [user],
  );
}

function mergeApiMessages(
  existing: ApiMessage | undefined,
  incoming: ApiMessage,
): ApiMessage {
  if (!existing) {
    return incoming;
  }

  return {
    ...existing,
    ...incoming,
    metadata: {
      ...existing.metadata,
      ...incoming.metadata,
    },
    children: incoming.children ?? existing.children,
  };
}

function isExportableApiMessage(
  message: ApiMessage,
  downloadImagesLocally: boolean,
): boolean {
  const role = message.author?.role;

  return (
    (role === "user" || role === "assistant") &&
    !message.metadata?.is_visually_hidden_from_conversation &&
    (role === "user" || message.end_turn === true) &&
    (Boolean(extractApiMessageText(message)) ||
      (downloadImagesLocally && getApiMessageImageParts(message).length > 0))
  );
}

/*
 * ---------------------------------------------------------
 * CONVERSATION ID
 * ---------------------------------------------------------
 */

function getConversationIdFromUrl(): string | null {
  const match = window.location.pathname.match(/\/c\/([0-9a-f-]{36})(?:\/|$)/i);

  return match?.[1] ?? null;
}

/*
 * ---------------------------------------------------------
 * API MESSAGE TEXT
 * ---------------------------------------------------------
 */

function extractApiMessageText(message: ApiMessage): string {
  const parts = message.content?.parts;

  if (!Array.isArray(parts)) {
    return "";
  }

  return parts
    .filter((part): part is string => typeof part === "string")
    .join("\n")
    .trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getApiMessageImageParts(message: ApiMessage): ApiImagePart[] {
  const parts = message.content?.parts;

  if (!Array.isArray(parts)) {
    return [];
  }

  return parts.filter((part): part is ApiImagePart => {
    if (!isRecord(part)) {
      return false;
    }

    const assetPointer = part.asset_pointer;

    return (
      part.content_type === "image_asset_pointer" ||
      typeof part.image_url === "string" ||
      isRecord(part.image_url) ||
      (typeof part.url === "string" &&
        Boolean(getSafeHostedImageUrl(part.url))) ||
      (typeof assetPointer === "string" &&
        /^(?:file-service|sediment):\/\//i.test(assetPointer))
    );
  });
}

function getSafeHostedImageUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }

  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const isChatGptImagePath =
      /^\/backend-api\/estuary\/content$/i.test(url.pathname) ||
      /^\/backend-api\/files\/(?:download\/)?file[-_][a-z0-9_-]+(?:\/download)?$/i.test(
        url.pathname,
      ) ||
      /^\/backend-api\/conversation\/[0-9a-f-]{36}\/attachment\/file[-_][a-z0-9_-]+\/download$/i.test(
        url.pathname,
      );
    const isChatGptHost =
      url.origin === window.location.origin && isChatGptImagePath;
    const isOpenAiFileHost =
      hostname === "oaiusercontent.com" ||
      hostname.endsWith(".oaiusercontent.com") ||
      hostname === "oaistatic.com" ||
      hostname.endsWith(".oaistatic.com");

    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      (isChatGptHost || isOpenAiFileHost)
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function getImageUrlFromPart(part: ApiImagePart): string | null {
  if (typeof part.image_url === "string") {
    return getSafeHostedImageUrl(part.image_url);
  }

  if (isRecord(part.image_url)) {
    const nestedUrl = getSafeHostedImageUrl(part.image_url.url);

    if (nestedUrl) {
      return nestedUrl;
    }
  }

  return getSafeHostedImageUrl(part.url);
}

function getImageReferenceFromPart(
  part: ApiImagePart,
): ApiImageReference | null {
  const pointer = part.asset_pointer;

  if (typeof pointer !== "string") {
    return null;
  }

  const match = pointer.match(/^(file-service|sediment):\/\/(.+)$/i);

  if (!match) {
    return null;
  }

  const scheme = match[1].toLowerCase() as ApiImageReference["scheme"];
  const referencedIds = match[2].match(/file[-_][A-Za-z0-9_-]+/gi);
  const fileId = referencedIds?.at(-1);

  return fileId
    ? {
        fileId,
        scheme,
      }
    : null;
}

function createRequestLimiter(
  maxConcurrent: number,
): <T>(action: () => Promise<T>) => Promise<T> {
  let activeRequests = 0;
  const queue: Array<() => void> = [];

  return async <T>(action: () => Promise<T>): Promise<T> => {
    if (activeRequests >= maxConcurrent) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }

    activeRequests++;

    try {
      return await action();
    } finally {
      activeRequests--;
      queue.shift()?.();
    }
  };
}

const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;

function getImageFileType(
  fileName: string,
  mimeType: string,
): { extension: string; mimeType: string } | null {
  const mimeToExtension: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/avif": "avif",
    "image/heic": "heic",
    "image/heif": "heif",
    "image/bmp": "bmp",
    "image/tiff": "tif",
  };
  const extensionToMime: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    heic: "image/heic",
    heif: "image/heif",
    bmp: "image/bmp",
    tif: "image/tiff",
    tiff: "image/tiff",
  };
  const normalizedMimeType = mimeType.split(";", 1)[0].trim().toLowerCase();
  const mimeExtension = mimeToExtension[normalizedMimeType];
  const filenameExtension = fileName
    .match(/\.([a-z0-9]{2,5})$/i)?.[1]
    ?.toLowerCase();

  if (normalizedMimeType.startsWith("image/") && !mimeExtension) {
    return null;
  }

  const extension = mimeExtension ?? filenameExtension;
  const normalizedExtension = extension === "jpeg" ? "jpg" : extension;
  const safeMimeType = normalizedExtension
    ? extensionToMime[normalizedExtension]
    : undefined;

  if (
    !normalizedExtension ||
    !safeMimeType ||
    !extensionToMime[normalizedExtension]
  ) {
    return null;
  }

  return {
    extension: normalizedExtension,
    mimeType: safeMimeType,
  };
}

async function extractApiMessageContent(
  message: ApiMessage,
  conversationId: string,
  downloadImagesLocally: boolean,
  imageFileCache: Map<string, Promise<ExportImageFile>>,
  limitImageRequests: <T>(action: () => Promise<T>) => Promise<T>,
  reserveImageIndex: () => number,
  addDownloadedImageBytes: (sizeBytes: number) => void,
): Promise<{ content: string; imagePaths: string[] }> {
  const parts = message.content?.parts;

  if (!Array.isArray(parts)) {
    return { content: "", imagePaths: [] };
  }

  let imageNumber = 0;
  const imagePaths: string[] = [];

  const renderedParts = await Promise.all(
    parts.map(async (part): Promise<string> => {
      if (typeof part === "string") {
        return part;
      }

      if (!isRecord(part)) {
        return "";
      }

      const imagePart = part as ApiImagePart;
      const directUrl = getImageUrlFromPart(imagePart);
      const imageReference = getImageReferenceFromPart(imagePart);
      const isImageAttachment =
        imagePart.content_type === "image_asset_pointer" ||
        typeof imagePart.image_url === "string" ||
        isRecord(imagePart.image_url) ||
        Boolean(directUrl) ||
        Boolean(imageReference);

      if (!isImageAttachment) {
        return "";
      }

      // Preserve the original text-only export unless image bundling is enabled.
      if (!downloadImagesLocally) {
        return "";
      }

      imageNumber++;

      if (!directUrl && !imageReference) {
        return "[Image attachment could not be downloaded]";
      }

      const cacheKey = imageReference
        ? `${imageReference.scheme}:${imageReference.fileId}`
        : `url:${directUrl}`;
      let pendingImage = imageFileCache.get(cacheKey);

      if (!pendingImage) {
        const imageIndex = reserveImageIndex();
        pendingImage = limitImageRequests(async () => {
          const downloaded = await fetchImageFile(
            imageReference,
            directUrl,
            conversationId,
          );
          const fileType = getImageFileType(
            downloaded.fileName,
            downloaded.mimeType,
          );

          if (!fileType) {
            throw new Error(
              "The downloaded attachment is not a supported image type.",
            );
          }

          addDownloadedImageBytes(downloaded.sizeBytes);

          return {
            path: `images/image-${String(imageIndex).padStart(3, "0")}.${fileType.extension}`,
            mimeType: fileType.mimeType,
            base64: downloaded.base64,
            sizeBytes: downloaded.sizeBytes,
          };
        });
        imageFileCache.set(cacheKey, pendingImage);
      }

      try {
        const imageFile = await pendingImage;
        imagePaths.push(imageFile.path);

        return `![Image ${imageNumber}](${imageFile.path})`;
      } catch (error) {
        devWarn("AI Exporter: failed to download an uploaded image", error);

        return "[Image attachment could not be downloaded]";
      }
    }),
  );

  return {
    content: renderedParts.filter(Boolean).join("\n").trim(),
    imagePaths: [...new Set(imagePaths)],
  };
}

/*
 * ---------------------------------------------------------
 * PAGE BRIDGE REQUEST
 * ---------------------------------------------------------
 *
 * content.ts cannot directly access the authenticated
 * ChatGPT fetch context.
 *
 * pageBridge.js runs in ChatGPT's MAIN world and performs
 * the authenticated request.
 *
 * Communication:
 *
 * content.ts
 *     |
 *     | window.postMessage()
 *     v
 *
 * pageBridge.js
 *     |
 *     | authenticated fetch()
 *     v
 *
 * ChatGPT backend
 *
 *     |
 *     | JSON
 *     v
 *
 * pageBridge.js
 *     |
 *     | window.postMessage()
 *     v
 *
 * content.ts
 */

interface BridgeResponse {
  source?: string;
  type?: string;
  requestId?: string;
  data?: ConversationPage;
  imageFile?: {
    base64?: string;
    fileName?: string;
    mimeType?: string;
    sizeBytes?: number;
  };
  error?: string;
}

function fetchConversationPage(
  conversationId: string,
  cursor: string | null,
): Promise<ConversationPage> {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();

    let finished = false;
    let timeoutId: number | undefined;

    const cleanup = (): void => {
      window.removeEventListener("message", handleMessage);

      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }
    };

    const finishError = (error: Error): void => {
      if (finished) {
        return;
      }

      finished = true;
      cleanup();
      reject(error);
    };

    const handleMessage = (event: MessageEvent<BridgeResponse>): void => {
      if (event.source !== window) {
        return;
      }

      const data = event.data;

      if (!data || data.source !== "AIExporter") {
        return;
      }

      if (data.requestId !== requestId) {
        return;
      }

      if (data.type === "AIExporter_API_ERROR") {
        finishError(
          new Error(
            data.error ?? "Unknown error from AI Exporter page bridge.",
          ),
        );

        return;
      }

      if (data.type !== "AIExporter_API_RESPONSE") {
        return;
      }

      if (!data.data) {
        finishError(
          new Error("AI Exporter page bridge returned an empty API response."),
        );

        return;
      }

      if (finished) {
        return;
      }

      finished = true;

      cleanup();

      resolve(normalizeConversationPage(data.data));
    };

    window.addEventListener("message", handleMessage);

    window.postMessage(
      {
        source: "AIExporter",
        type: "AIExporter_API_REQUEST",
        requestId,
        conversationId,
        cursor,
      },
      "*",
    );

    /*
     * Safety timeout.
     *
     * If the bridge does not respond, don't leave
     * the Promise hanging forever.
     */
    timeoutId = window.setTimeout(() => {
      if (finished) {
        return;
      }

      finishError(
        new Error(
          "AI Exporter page bridge timed out while requesting the conversation API.",
        ),
      );
    }, 30000);
  });
}

function fetchImageFile(
  reference: ApiImageReference | null,
  imageUrl: string | null,
  conversationId: string,
): Promise<{
  base64: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}> {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();

    let finished = false;
    let timeoutId: number | undefined;

    const cleanup = (): void => {
      window.removeEventListener("message", handleMessage);

      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }
    };

    const finishError = (error: Error): void => {
      if (finished) {
        return;
      }

      finished = true;
      cleanup();
      reject(error);
    };

    const handleMessage = (event: MessageEvent<BridgeResponse>): void => {
      if (
        event.source !== window ||
        event.data?.source !== "AIExporter" ||
        event.data.requestId !== requestId
      ) {
        return;
      }

      if (event.data.type === "AIExporter_API_ERROR") {
        finishError(new Error(event.data.error ?? "Could not download image."));

        return;
      }

      if (event.data.type !== "AIExporter_FILE_DOWNLOAD_RESPONSE") {
        return;
      }

      const downloaded = event.data.imageFile;

      if (
        typeof downloaded?.base64 !== "string" ||
        typeof downloaded.fileName !== "string" ||
        typeof downloaded.mimeType !== "string" ||
        typeof downloaded.sizeBytes !== "number" ||
        downloaded.sizeBytes <= 0 ||
        downloaded.sizeBytes > 8 * 1024 * 1024 ||
        downloaded.base64.length !== Math.ceil(downloaded.sizeBytes / 3) * 4 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          downloaded.base64,
        )
      ) {
        finishError(new Error("ChatGPT returned an invalid image file."));

        return;
      }

      finished = true;
      cleanup();
      resolve({
        base64: downloaded.base64,
        fileName: downloaded.fileName,
        mimeType: downloaded.mimeType,
        sizeBytes: downloaded.sizeBytes,
      });
    };

    window.addEventListener("message", handleMessage);

    window.postMessage(
      {
        source: "AIExporter",
        type: "AIExporter_FILE_DOWNLOAD_REQUEST",
        requestId,
        conversationId,
        ...(reference
          ? { fileId: reference.fileId, scheme: reference.scheme }
          : {}),
        ...(imageUrl ? { imageUrl } : {}),
      },
      "*",
    );

    timeoutId = window.setTimeout(() => {
      finishError(new Error("Timed out while downloading an uploaded image."));
    }, 60000);
  });
}

/*
 * ---------------------------------------------------------
 * LOAD ENTIRE CONVERSATION VIA API
 * ---------------------------------------------------------
 *
 * Initial request:
 *
 * /backend-api/conversations/{id}
 *     ?include_has_versions=true
 *     &num_turns=100
 *
 * Older messages:
 *
 * /backend-api/conversations/{id}/messages
 *     ?before={start_cursor}
 *     &include_has_versions=true
 *     &num_turns=100
 *
 * (100 turns a page rather than the web app's 10 - see
 * PAGE_TURNS in page-bridge.ts.)
 *
 * Pagination continues until:
 *
 * has_previous_page === false
 *
 * This avoids DOM virtualization and scrolling entirely.
 */

/*
 * Prevent an export from starting before the bridge
 * has had a chance to initialize.
 */
let bridgeReady = false;

window.addEventListener("message", (event) => {
  if (event.source !== window) {
    return;
  }

  if (!event.data || event.data.source !== "AIExporter") {
    return;
  }

  if (event.data.type === "BRIDGE_READY") {
    bridgeReady = true;

    devLog("AI Exporter: page bridge ready");
  }
});

async function waitForBridge(): Promise<void> {
  if (bridgeReady) {
    return;
  }

  /*
   * Give the injected MAIN-world script a short time
   * to initialize.
   */
  const timeoutMs = 5000;
  const intervalMs = 50;

  const started = Date.now();

  while (!bridgeReady && Date.now() - started < timeoutMs) {
    await new Promise<void>((resolve) =>
      window.setTimeout(resolve, intervalMs),
    );
  }

  /*
   * We do not necessarily fail here.
   *
   * The bridge may already exist but its READY message
   * may have been emitted before this listener was added.
   *
   * The actual request below will provide the definitive
   * error if the bridge is unavailable.
   */
}

async function loadEntireConversation(
  downloadImagesLocally: boolean,
): Promise<ConversationLoadResult> {
  if (IS_CLAUDE_SITE) {
    return loadClaudeConversation(downloadImagesLocally);
  }

  if (IS_GEMINI_SITE) {
    return loadGeminiConversation(downloadImagesLocally);
  }

  await waitForBridge();

  const conversationId = getConversationIdFromUrl();

  if (!conversationId) {
    throw new Error(
      "Could not determine the ChatGPT conversation ID from the current URL.",
    );
  }

  devLog("AI Exporter: API conversation ID", conversationId);

  /*
   * -----------------------------------------------------
   * COLLECTED MESSAGES
   * -----------------------------------------------------
   */

  const rawById = new Map<string, ApiMessage>();
  const collected = new Map<string, ApiMessage>();

  /*
   * -----------------------------------------------------
   * COLLECT PAGE
   * -----------------------------------------------------
   */

  const collectPage = (currentPage: ConversationPage): void => {
    const messages = currentPage.messages ?? [];

    devLog("AI Exporter: API page contains", messages.length, "raw messages");

    for (const message of messages) {
      const id = message.id;

      if (!id) {
        continue;
      }

      const mergedMessage = mergeApiMessages(rawById.get(id), message);

      rawById.set(id, mergedMessage);

      if (isExportableApiMessage(mergedMessage, downloadImagesLocally)) {
        collected.set(id, mergedMessage);
      }
    }
  };

  /*
   * -----------------------------------------------------
   * INITIAL PAGE
   * -----------------------------------------------------
   */

  let page = await fetchConversationPage(conversationId, null);

  let pageNumber = 0;
  const currentNode = page.current_node ?? null;

  collectPage(page);

  devLog(
    `AI Exporter: API page ${pageNumber}, ` + `collected=${collected.size}`,
  );

  /*
   * -----------------------------------------------------
   * PAGINATION
   * -----------------------------------------------------
   */

  const seenCursors = new Set<string>();

  while (page.page_info?.has_previous_page === true) {
    const cursor = page.page_info.start_cursor;

    if (!cursor) {
      throw new Error(
        "ChatGPT reported that previous pages exist, but no pagination cursor was returned.",
      );
    }

    /*
     * Prevent infinite loops if the API returns
     * the same cursor twice.
     */
    if (seenCursors.has(cursor)) {
      throw new Error(
        "ChatGPT returned a repeated pagination cursor. Pagination was stopped to prevent an infinite loop.",
      );
    }

    seenCursors.add(cursor);

    pageNumber++;

    page = await fetchConversationPage(conversationId, cursor);

    collectPage(page);

    devLog(
      `AI Exporter: API page ${pageNumber}, ` + `collected=${collected.size}`,
    );

    /*
     * Optional progress notification.
     */
    try {
      chrome.runtime.sendMessage({
        type: "EXPORT_PROGRESS",
        collected: collected.size,
      });
    } catch {
      /*
       * Progress reporting must never
       * break the export.
       */
    }
  }

  const messages = resolveActiveMessages(
    rawById,
    collected,
    currentNode,
    downloadImagesLocally,
  );

  if (!currentNode) {
    devWarn(
      "AI Exporter: API response did not include current_node; using chronological fallback",
    );
  }

  devLog("AI Exporter: resolved active conversation", {
    currentNode,
    rawMessages: rawById.size,
    messages: messages.length,
  });

  /*
   * -----------------------------------------------------
   * CONVERT TO EXPORT FORMAT
   * -----------------------------------------------------
   */

  const imageFileCache = new Map<string, Promise<ExportImageFile>>();
  const limitImageRequests = createRequestLimiter(2);
  let nextImageIndex = 1;
  let downloadedImageBytes = 0;

  const reserveImageIndex = (): number => nextImageIndex++;
  const addDownloadedImageBytes = (sizeBytes: number): void => {
    if (downloadedImageBytes + sizeBytes > MAX_TOTAL_IMAGE_BYTES) {
      throw new Error(
        "The conversation's images exceed the 20 MB export limit.",
      );
    }

    downloadedImageBytes += sizeBytes;
  };

  const convertedMessages = await Promise.all(
    messages.map(async (message, order): Promise<Message | null> => {
      const id = message.id;

      const role = message.author?.role;

      const extracted = await extractApiMessageContent(
        message,
        conversationId,
        downloadImagesLocally,
        imageFileCache,
        limitImageRequests,
        reserveImageIndex,
        addDownloadedImageBytes,
      );

      if (
        !id ||
        (role !== "user" && role !== "assistant") ||
        !extracted.content
      ) {
        return null;
      }

      return {
        id,
        role,
        content: extracted.content,
        order,
        imagePaths: extracted.imagePaths,
      };
    }),
  );

  const result = convertedMessages
    .filter((message): message is Message => message !== null)
    .map((message, order) => ({ ...message, order }));
  const settledImages = await Promise.allSettled(imageFileCache.values());
  const images = settledImages.flatMap((item) =>
    item.status === "fulfilled" ? [item.value] : [],
  );

  /*
   * -----------------------------------------------------
   * FINAL LOG
   * -----------------------------------------------------
   */

  devLog("AI Exporter: API export complete", {
    conversationId,
    pages: pageNumber + 1,
    messages: result.length,
    images: images.length,
  });

  result.forEach((message, index) => {
    devLog(`${index + 1} ${message.role}:`, message.content.substring(0, 70));
  });

  return { messages: result, images };
}

/*
 * ---------------------------------------------------------
 * LOAD CLAUDE CONVERSATION
 * ---------------------------------------------------------
 *
 * claude.ai needs no page bridge: its API authenticates with
 * the session cookie, and requests from this script to the
 * page's own origin are same-origin requests that carry it,
 * in Chrome and Firefox alike. A single request returns the
 * whole conversation, every branch included - no pagination:
 *
 * /api/organizations/{org}/chat_conversations/{id}
 *     ?tree=True
 *     &rendering_mode=messages
 *     &render_all_tools=true
 *
 * claude-conversation.ts picks the branch on screen and turns
 * it into export messages; this part makes the requests and
 * downloads the images.
 */

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function fetchClaudeApi(path: string): Promise<Response> {
  return fetch(new URL(path, window.location.origin), {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
  });
}

async function fetchClaudeConversation(
  conversationId: string,
): Promise<ClaudeConversation> {
  const triedOrganizations = new Set<string>();

  /*
   * null when the conversation belongs to another of the
   * person's organizations - claude.ai answers 403 or 404.
   */
  const fetchFromOrganization = async (
    organizationId: string,
  ): Promise<ClaudeConversation | null> => {
    triedOrganizations.add(organizationId);

    const response = await fetchClaudeApi(
      buildClaudeConversationPath(organizationId, conversationId),
    );

    if (response.status === 403 || response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`Claude API request failed: ${response.status}`);
    }

    const data: unknown = await response.json();

    if (!isRecord(data) || !Array.isArray(data.chat_messages)) {
      throw new Error("Claude returned an unexpected conversation format.");
    }

    return data as ClaudeConversation;
  };

  const lastActiveOrganizationId = getClaudeOrganizationIdFromCookie(
    document.cookie,
  );

  if (lastActiveOrganizationId) {
    const conversation = await fetchFromOrganization(lastActiveOrganizationId);

    if (conversation) {
      return conversation;
    }
  }

  const organizationsResponse = await fetchClaudeApi("/api/organizations");

  if (!organizationsResponse.ok) {
    throw new Error(
      `Claude API request failed: ${organizationsResponse.status}`,
    );
  }

  const organizationIds = getClaudeChatOrganizationIds(
    await organizationsResponse.json(),
  );

  for (const organizationId of organizationIds) {
    if (triedOrganizations.has(organizationId)) {
      continue;
    }

    const conversation = await fetchFromOrganization(organizationId);

    if (conversation) {
      return conversation;
    }
  }

  throw new Error("Claude could not find this conversation.");
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)),
    );
  }

  return btoa(binary);
}

async function downloadClaudeImage(
  path: string,
): Promise<{ base64: string; mimeType: string; sizeBytes: number }> {
  const url = new URL(path, window.location.origin);

  /*
   * The request carries the person's claude.ai session, so
   * images are only ever requested from claude.ai's own API.
   */
  if (
    url.origin !== window.location.origin ||
    !url.pathname.startsWith("/api/")
  ) {
    throw new Error("Claude returned an image URL outside its API.");
  }

  const response = await fetch(url, {
    method: "GET",
    credentials: "include",
  });

  if (!response.ok) {
    throw new Error(
      `Claude image download failed: ${response.status} ${response.statusText}`,
    );
  }

  if (Number(response.headers.get("content-length") ?? 0) > MAX_IMAGE_BYTES) {
    throw new Error("The image is larger than the 8 MB export limit.");
  }

  const bytes = new Uint8Array(await response.arrayBuffer());

  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error("The image is empty or larger than the 8 MB export limit.");
  }

  return {
    base64: bytesToBase64(bytes),
    mimeType: response.headers.get("content-type") ?? "",
    sizeBytes: bytes.byteLength,
  };
}

async function loadClaudeConversation(
  downloadImagesLocally: boolean,
): Promise<ConversationLoadResult> {
  const conversationId = getClaudeConversationId(window.location.pathname);

  if (!conversationId) {
    throw new Error(
      "Could not determine the Claude conversation ID from the current URL.",
    );
  }

  devLog("AI Exporter: Claude conversation ID", conversationId);

  const conversation = await fetchClaudeConversation(conversationId);
  const exportMessages = convertClaudeMessages(
    resolveClaudeActiveBranch(conversation),
  );

  const imageFileCache = new Map<string, Promise<ExportImageFile>>();
  const limitImageRequests = createRequestLimiter(2);
  let nextImageIndex = 1;
  let downloadedImageBytes = 0;

  const getImageFile = (
    image: ClaudeImage & { url: string },
  ): Promise<ExportImageFile> => {
    let pendingImage = imageFileCache.get(image.url);

    if (!pendingImage) {
      const imageIndex = nextImageIndex++;

      pendingImage = limitImageRequests(async () => {
        const downloaded = await downloadClaudeImage(image.url);
        const fileType = getImageFileType(image.fileName, downloaded.mimeType);

        if (!fileType) {
          throw new Error(
            "The downloaded attachment is not a supported image type.",
          );
        }

        if (downloadedImageBytes + downloaded.sizeBytes > MAX_TOTAL_IMAGE_BYTES) {
          throw new Error(
            "The conversation's images exceed the 20 MB export limit.",
          );
        }

        downloadedImageBytes += downloaded.sizeBytes;

        return {
          path: `images/image-${String(imageIndex).padStart(3, "0")}.${fileType.extension}`,
          mimeType: fileType.mimeType,
          base64: downloaded.base64,
          sizeBytes: downloaded.sizeBytes,
        };
      });
      imageFileCache.set(image.url, pendingImage);
    }

    return pendingImage;
  };

  const convertedMessages = await Promise.all(
    exportMessages.map(
      async (message): Promise<Omit<Message, "order"> | null> => {
        let imageNumber = 0;

        const renderedParts = await Promise.all(
          message.parts.map(
            async (part): Promise<{ text: string; imagePath?: string }> => {
              if (part.kind === "text") {
                return { text: part.text };
              }

              // Like ChatGPT uploads: left out unless image bundling is on.
              if (!downloadImagesLocally) {
                return { text: "" };
              }

              const number = ++imageNumber;
              const { url, fileName } = part.image;

              if (!url) {
                return { text: "[Image attachment could not be downloaded]" };
              }

              try {
                const imageFile = await getImageFile({ url, fileName });

                return {
                  text: `![Image ${number}](${imageFile.path})`,
                  imagePath: imageFile.path,
                };
              } catch (error) {
                devWarn("AI Exporter: failed to download a Claude image", error);

                return { text: "[Image attachment could not be downloaded]" };
              }
            },
          ),
        );

        const content = renderedParts
          .map((part) => part.text)
          .filter(Boolean)
          .join("\n\n")
          .trim();

        return content
          ? {
              id: message.id,
              role: message.role,
              content,
              imagePaths: [
                ...new Set(
                  renderedParts.flatMap((part) =>
                    part.imagePath ? [part.imagePath] : [],
                  ),
                ),
              ],
            }
          : null;
      },
    ),
  );

  const result = convertedMessages
    .filter((message): message is Omit<Message, "order"> => message !== null)
    .map((message, order) => ({ ...message, order }));
  const settledImages = await Promise.allSettled(imageFileCache.values());
  const images = settledImages.flatMap((item) =>
    item.status === "fulfilled" ? [item.value] : [],
  );

  devLog("AI Exporter: Claude export complete", {
    conversationId,
    rawMessages: conversation.chat_messages?.length ?? 0,
    messages: result.length,
    images: images.length,
  });

  return { messages: result, images };
}

/*
 * ---------------------------------------------------------
 * LOAD GEMINI CONVERSATION
 * ---------------------------------------------------------
 *
 * Like claude.ai, gemini.google.com needs no page bridge. Its
 * web app reads conversations through Google's batchexecute
 * endpoint, which authenticates with the session cookie - sent
 * with this script's same-origin requests too - plus an XSRF
 * token from the page's own HTML. Each request returns ten
 * turns, newest first, and a cursor for the ten before them:
 *
 * POST /_/BardChatUi/data/batchexecute
 *     ?rpcids=hNvQHb&source-path=...&bl=...&f.sid=...&rt=c
 *     f.req=[[["hNvQHb","[\"c_{id}\",10,{cursor},...]",...]]]
 *     &at={XSRF token}
 *
 * gemini-conversation.ts builds the requests and turns the
 * answers into export messages; this part makes the requests
 * and downloads the images.
 */

/* Ten turns a page: a 10,000-turn conversation. */
const MAX_GEMINI_PAGES = 1000;

/*
 * The tokens sit in an inline script the page loaded with
 * (window.WIZ_global_data). They're read from the DOM: this
 * script can't see the page's JavaScript variables.
 */
function readGeminiTokensFromPage(): GeminiPageTokens | null {
  for (const script of Array.from(document.scripts)) {
    const text = script.src ? "" : (script.textContent ?? "");

    if (text.includes("SNlM0e")) {
      const tokens = readGeminiPageTokens(text);

      if (tokens) {
        return tokens;
      }
    }
  }

  return null;
}

/*
 * Fresh tokens from the app's start page, for when the page's
 * own can't be found or have expired (the tab has been open a
 * long time).
 */
async function fetchGeminiTokens(
  accountPrefix: string,
): Promise<GeminiPageTokens> {
  const response = await fetch(
    new URL(`${accountPrefix}/app`, window.location.origin),
    {
      method: "GET",
      credentials: "include",
      headers: { Accept: "text/html" },
    },
  );

  if (!response.ok) {
    throw new Error(`Gemini request failed: ${response.status}`);
  }

  const tokens = readGeminiPageTokens(await response.text());

  if (!tokens) {
    throw new Error("Sign in to Gemini to export this conversation.");
  }

  return tokens;
}

async function downloadGeminiImage(
  url: string,
): Promise<{ base64: string; mimeType: string; sizeBytes: number }> {
  /*
   * The request can carry the person's Google session, so
   * images are only ever requested from Google's image hosts.
   */
  if (!isGeminiImageUrl(url)) {
    throw new Error(
      "Gemini returned an image URL outside Google's image hosts.",
    );
  }

  let response: Response | undefined;
  let lastError: unknown;

  /*
   * First without cookies - an image URL from the conversation
   * usually works on its own, and a request that needs no
   * session is the better one to make - then with the person's
   * Google session if that one is refused.
   */
  for (const credentials of ["omit", "include"] as const) {
    try {
      const attempt = await fetch(url, { method: "GET", credentials });

      if (attempt.ok) {
        response = attempt;
        break;
      }

      lastError = new Error(
        `Gemini image download failed: ${attempt.status} ${attempt.statusText}`,
      );
    } catch (error) {
      lastError = error;
    }
  }

  if (!response) {
    throw lastError instanceof Error
      ? lastError
      : new Error("Gemini image download failed.");
  }

  if (Number(response.headers.get("content-length") ?? 0) > MAX_IMAGE_BYTES) {
    throw new Error("The image is larger than the 8 MB export limit.");
  }

  const bytes = new Uint8Array(await response.arrayBuffer());

  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error("The image is empty or larger than the 8 MB export limit.");
  }

  return {
    base64: bytesToBase64(bytes),
    mimeType: response.headers.get("content-type") ?? "",
    sizeBytes: bytes.byteLength,
  };
}

async function loadGeminiConversation(
  downloadImagesLocally: boolean,
): Promise<ConversationLoadResult> {
  const { pathname } = window.location;
  const conversationId = getGeminiConversationId(pathname);

  if (!conversationId) {
    throw new Error(
      "Could not determine the Gemini conversation ID from the current URL.",
    );
  }

  devLog("AI Exporter: Gemini conversation ID", conversationId);

  const accountPrefix = getGeminiAccountPrefix(pathname);
  let tokens = readGeminiTokensFromPage();
  let tokensAreFresh = tokens === null;

  tokens ??= await fetchGeminiTokens(accountPrefix);

  /*
   * batchexecute's _reqid: the web app starts it at a random
   * number and adds 100000 for every request.
   */
  let requestId = 10000 + Math.floor(Math.random() * 90000);

  const fetchPage = (
    pageTokens: GeminiPageTokens,
    cursor: string | null,
  ): Promise<Response> => {
    const request = buildGeminiReadRequest({
      conversationId,
      cursor,
      tokens: pageTokens,
      accountPrefix,
      sourcePath: pathname,
      requestId,
    });

    requestId += 100000;

    return fetch(new URL(request.path, window.location.origin), {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        "X-Same-Domain": "1",
      },
      body: request.body,
    });
  };

  const turns: unknown[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;

  for (let pageNumber = 1; ; pageNumber++) {
    let response = await fetchPage(tokens, cursor);

    /*
     * The page's token has most likely expired - tried once more
     * with fresh ones.
     */
    if (
      (response.status === 400 || response.status === 401) &&
      !tokensAreFresh
    ) {
      tokens = await fetchGeminiTokens(accountPrefix);
      tokensAreFresh = true;
      response = await fetchPage(tokens, cursor);
    }

    if (!response.ok) {
      throw new Error(`Gemini API request failed: ${response.status}`);
    }

    const page = parseGeminiTurnsPage(await response.text());

    turns.push(...page.turns);

    devLog(`AI Exporter: Gemini page ${pageNumber}, turns=${turns.length}`);

    if (!page.nextCursor || page.turns.length === 0) {
      break;
    }

    if (seenCursors.has(page.nextCursor)) {
      throw new Error(
        "Gemini returned a repeated pagination cursor. Pagination was stopped to prevent an infinite loop.",
      );
    }

    if (pageNumber >= MAX_GEMINI_PAGES) {
      throw new Error("The Gemini conversation is too long to export.");
    }

    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;

    /*
     * Optional progress notification - a prompt and a reply per
     * turn. Never allowed to break the export, not even when the
     * popup has closed and nothing receives it.
     */
    try {
      void Promise.resolve(
        chrome.runtime.sendMessage({
          type: "EXPORT_PROGRESS",
          collected: turns.length * 2,
        }),
      ).catch(() => undefined);
    } catch {
      /* Progress reporting must never break the export. */
    }
  }

  const exportMessages = convertGeminiTurns(turns);

  const imageFileCache = new Map<string, Promise<ExportImageFile>>();
  const limitImageRequests = createRequestLimiter(2);
  let nextImageIndex = 1;
  let downloadedImageBytes = 0;

  const getImageFile = (
    image: GeminiImage & { url: string },
  ): Promise<ExportImageFile> => {
    let pendingImage = imageFileCache.get(image.url);

    if (!pendingImage) {
      const imageIndex = nextImageIndex++;

      pendingImage = limitImageRequests(async () => {
        const downloaded = await downloadGeminiImage(image.url);
        const fileType = getImageFileType(image.fileName, downloaded.mimeType);

        if (!fileType) {
          throw new Error(
            "The downloaded attachment is not a supported image type.",
          );
        }

        if (downloadedImageBytes + downloaded.sizeBytes > MAX_TOTAL_IMAGE_BYTES) {
          throw new Error(
            "The conversation's images exceed the 20 MB export limit.",
          );
        }

        downloadedImageBytes += downloaded.sizeBytes;

        return {
          path: `images/image-${String(imageIndex).padStart(3, "0")}.${fileType.extension}`,
          mimeType: fileType.mimeType,
          base64: downloaded.base64,
          sizeBytes: downloaded.sizeBytes,
        };
      });
      imageFileCache.set(image.url, pendingImage);
    }

    return pendingImage;
  };

  const convertedMessages = await Promise.all(
    exportMessages.map(
      async (message): Promise<Omit<Message, "order"> | null> => {
        let imageNumber = 0;

        const renderedParts = await Promise.all(
          message.parts.map(
            async (part): Promise<{ text: string; imagePath?: string }> => {
              if (part.kind === "text") {
                return { text: part.text };
              }

              // Like ChatGPT and Claude images: left out unless image bundling is on.
              if (!downloadImagesLocally) {
                return { text: "" };
              }

              const number = ++imageNumber;
              const { url, fileName } = part.image;

              if (!url) {
                return { text: "[Image attachment could not be downloaded]" };
              }

              try {
                const imageFile = await getImageFile({ url, fileName });

                return {
                  text: `![Image ${number}](${imageFile.path})`,
                  imagePath: imageFile.path,
                };
              } catch (error) {
                devWarn("AI Exporter: failed to download a Gemini image", error);

                return { text: "[Image attachment could not be downloaded]" };
              }
            },
          ),
        );

        const content = renderedParts
          .map((part) => part.text)
          .filter(Boolean)
          .join("\n\n")
          .trim();

        return content
          ? {
              id: message.id,
              role: message.role,
              content,
              imagePaths: [
                ...new Set(
                  renderedParts.flatMap((part) =>
                    part.imagePath ? [part.imagePath] : [],
                  ),
                ),
              ],
            }
          : null;
      },
    ),
  );

  const result = convertedMessages
    .filter((message): message is Omit<Message, "order"> => message !== null)
    .map((message, order) => ({ ...message, order }));
  const settledImages = await Promise.allSettled(imageFileCache.values());
  const images = settledImages.flatMap((item) =>
    item.status === "fulfilled" ? [item.value] : [],
  );

  devLog("AI Exporter: Gemini export complete", {
    conversationId,
    turns: turns.length,
    messages: result.length,
    images: images.length,
  });

  return { messages: result, images };
}

/*
 * ---------------------------------------------------------
 * READY
 * ---------------------------------------------------------
 */

window.postMessage(
  {
    source: "AIExporter",
    type: "READY",
  },
  "*",
);

/*
 * ---------------------------------------------------------
 * CONCURRENCY GUARD
 * ---------------------------------------------------------
 *
 * If popup sends LOAD_CONVERSATION more than once,
 * only one API pagination run is performed.
 */

let inFlightLoad: {
  downloadImagesLocally: boolean;
  promise: Promise<ConversationLoadResult>;
} | null = null;

function loadEntireConversationSingleFlight(
  downloadImagesLocally: boolean,
): Promise<ConversationLoadResult> {
  if (inFlightLoad) {
    if (inFlightLoad.downloadImagesLocally === downloadImagesLocally) {
      devLog("AI Exporter: reusing the in-progress conversation load");
      return inFlightLoad.promise;
    }

    return inFlightLoad.promise
      .catch(() => undefined)
      .then(() => loadEntireConversationSingleFlight(downloadImagesLocally));
  }

  const run = loadEntireConversation(downloadImagesLocally).finally(() => {
    if (inFlightLoad?.promise === run) {
      inFlightLoad = null;
    }
  });

  inFlightLoad = { downloadImagesLocally, promise: run };

  return run;
}

/*
 * ---------------------------------------------------------
 * EXPORT SUCCESS OVERLAY
 * ---------------------------------------------------------
 *
 * Injected directly into the ChatGPT/Claude/Gemini page (not the popup),
 * so it stays visible even after the person closes the
 * extension popup - which Chrome does automatically the
 * moment focus moves anywhere outside the popup, including
 * onto the page itself. popup.ts sends a SHOW_EXPORT_SUCCESS
 * message here once a download or GitHub save actually
 * completes; this function builds and shows the overlay.
 *
 * Self-contained: styles are inlined on the injected elements
 * rather than relying on a separate stylesheet, since content
 * scripts don't get a free way to load one without a matching
 * manifest entry, and this way there's no risk of colliding
 * with the site's own page styles.
 */

const EXPORT_SUCCESS_OVERLAY_ID = "ai-exporter-export-success-overlay";

type ExportTheme = "system" | "light" | "dark";

let exportTheme: ExportTheme = "system";

void chrome.storage.sync.get({ theme: "system" }).then((result) => {
  if (result.theme === "light" || result.theme === "dark") {
    exportTheme = result.theme;
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync" || !changes.theme) {
    return;
  }

  exportTheme =
    changes.theme.newValue === "light" || changes.theme.newValue === "dark"
      ? changes.theme.newValue
      : "system";
});

const PROJECT_REPOSITORY_URL = "https://github.com/GrantTotinov/AIExporter";
const COFFEE_URL = "https://buymeacoffee.com/granttotinov";
const FEEDBACK_EMAIL = "granttotinov604@gmail.com";
const CHROME_STORE_URL =
  "https://chromewebstore.google.com/detail/objkcakdcilfaphifjfcgfamlnnbinjc/reviews";
/*
 * addons.mozilla.org resolves an add-on's GUID (the gecko ID
 * in manifest.firefox.json) the same way it resolves its slug.
 */
const FIREFOX_STORE_URL =
  "https://addons.mozilla.org/firefox/addon/gptchatdownloader@granttotinov.com/";
const GITHUB_ISSUES_URL = `${PROJECT_REPOSITORY_URL}/issues`;

/*
 * Extension pages run on moz-extension:// in Firefox and
 * chrome-extension:// everywhere else (Chrome, Edge, Brave...,
 * which all install from the Chrome Web Store).
 */
function isFirefoxExtension(): boolean {
  try {
    return chrome.runtime.getURL("").startsWith("moz-extension:");
  } catch {
    return false;
  }
}

function getExtensionVersion(): string {
  try {
    return chrome.runtime.getManifest().version;
  } catch {
    return "";
  }
}

/*
 * A ready-to-send email: the subject is filled in, and the
 * version/browser/site go at the bottom so a bug report
 * already says where it happened without the person having
 * to know or look any of it up. Nothing about the chat itself
 * is included.
 */
function buildFeedbackMailto(): string {
  const details = [
    `AI Exporter ${getExtensionVersion()}`.trim(),
    isFirefoxExtension() ? "Firefox" : "Chrome",
    window.location.hostname,
  ].join(" · ");

  const body = `${ct("emailPlaceholder")}\n\n\n\n---\n${details}`;

  return `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent(
    ct("emailSubject"),
  )}&body=${encodeURIComponent(body)}`;
}

const OVERLAY_ICONS = {
  check:
    '<path d="M20 6 9 17l-5-5"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  heart:
    '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
  star: '<path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>',
  coffee:
    '<path d="M17 8h1a4 4 0 1 1 0 8h-1"/><path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z"/><path d="M6 2v2M10 2v2M14 2v2"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  mail: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
} as const;

function overlayIcon(name: keyof typeof OVERLAY_ICONS): string {
  return `<svg class="aie-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${OVERLAY_ICONS[name]}</svg>`;
}

/*
 * Scoped under the overlay's ID, and inside the overlay
 * element itself, so it can't leak into (or be overridden by)
 * the site's own styles and is removed together with it.
 */
const OVERLAY_STYLES = `
  #${EXPORT_SUCCESS_OVERLAY_ID} {
    --aie-backdrop: rgba(15, 23, 42, 0.45);
    --aie-surface: #ffffff;
    --aie-soft: #f6f8fa;
    --aie-border: #d8dee4;
    --aie-text: #1f2328;
    --aie-muted: #59636e;
    --aie-success: #1a7f37;
    --aie-success-bg: #dafbe1;
    --aie-primary: #0b7a5e;
    --aie-primary-hover: #096650;
    --aie-on-primary: #ffffff;
    --aie-heart: #cf222e;
    --aie-star: #bf8700;
    --aie-coffee: #b45309;
    --aie-focus: #0969da;

    all: initial;
    position: fixed;
    inset: 0;
    z-index: 2147483647;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    background: var(--aie-backdrop);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    animation: aie-fade 160ms ease-out;
  }

  #${EXPORT_SUCCESS_OVERLAY_ID}[data-theme="dark"] {
    --aie-backdrop: rgba(1, 4, 9, 0.65);
    --aie-surface: #161b22;
    --aie-soft: #0d1117;
    --aie-border: #30363d;
    --aie-text: #f0f6fc;
    --aie-muted: #9198a1;
    --aie-success: #3fb950;
    --aie-success-bg: rgba(46, 160, 67, 0.15);
    --aie-primary: #238636;
    --aie-primary-hover: #2ea043;
    --aie-heart: #f85149;
    --aie-star: #d29922;
    --aie-coffee: #e3a008;
    --aie-focus: #4493f8;
  }

  @media (prefers-color-scheme: dark) {
    #${EXPORT_SUCCESS_OVERLAY_ID}[data-theme="system"] {
      --aie-backdrop: rgba(1, 4, 9, 0.65);
      --aie-surface: #161b22;
      --aie-soft: #0d1117;
      --aie-border: #30363d;
      --aie-text: #f0f6fc;
      --aie-muted: #9198a1;
      --aie-success: #3fb950;
      --aie-success-bg: rgba(46, 160, 67, 0.15);
      --aie-primary: #238636;
      --aie-primary-hover: #2ea043;
      --aie-heart: #f85149;
      --aie-star: #d29922;
      --aie-coffee: #e3a008;
      --aie-focus: #4493f8;
    }
  }

  #${EXPORT_SUCCESS_OVERLAY_ID} * {
    box-sizing: border-box;
    margin: 0;
    font-family: inherit;
  }

  #${EXPORT_SUCCESS_OVERLAY_ID} .aie-modal {
    position: relative;
    width: 100%;
    max-width: 400px;
    max-height: calc(100vh - 32px);
    overflow-y: auto;
    padding: 28px 24px 20px;
    border: 1px solid var(--aie-border);
    border-radius: 16px;
    background: var(--aie-surface);
    color: var(--aie-text);
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.28);
    text-align: center;
    animation: aie-rise 200ms ease-out;
    outline: none;
  }

  #${EXPORT_SUCCESS_OVERLAY_ID} .aie-icon {
    width: 16px;
    height: 16px;
    flex: none;
  }

  #${EXPORT_SUCCESS_OVERLAY_ID} .aie-dismiss {
    position: absolute;
    top: 12px;
    right: 12px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    padding: 0;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--aie-muted);
    cursor: pointer;
  }

  #${EXPORT_SUCCESS_OVERLAY_ID} .aie-dismiss:hover {
    background: var(--aie-soft);
    color: var(--aie-text);
  }

  #${EXPORT_SUCCESS_OVERLAY_ID} .aie-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 52px;
    height: 52px;
    margin-bottom: 14px;
    border-radius: 50%;
    background: var(--aie-success-bg);
    color: var(--aie-success);
  }

  #${EXPORT_SUCCESS_OVERLAY_ID} .aie-badge .aie-icon {
    width: 26px;
    height: 26px;
    stroke-width: 2.5;
  }

  #${EXPORT_SUCCESS_OVERLAY_ID} .aie-title {
    font-size: 20px;
    font-weight: 700;
    line-height: 1.3;
    color: var(--aie-text);
  }

  #${EXPORT_SUCCESS_OVERLAY_ID} .aie-subtitle {
    margin-top: 4px;
    font-size: 14px;
    line-height: 1.5;
    color: var(--aie-muted);
  }

  #${EXPORT_SUCCESS_OVERLAY_ID} .aie-section {
    margin-top: 20px;
    padding: 16px;
    border: 1px solid var(--aie-border);
    border-radius: 12px;
    background: var(--aie-soft);
    text-align: left;
  }

  #${EXPORT_SUCCESS_OVERLAY_ID} .aie-section-title {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 14px;
    font-weight: 700;
    line-height: 1.4;
    color: var(--aie-text);
  }

  #${EXPORT_SUCCESS_OVERLAY_ID} .aie-section-title > span,
  #${EXPORT_SUCCESS_OVERLAY_ID} .aie-button > span {
    display: inline-flex;
  }

  #${EXPORT_SUCCESS_OVERLAY_ID} .aie-section-title .aie-heart {
    color: var(--aie-heart);
  }

  #${EXPORT_SUCCESS_OVERLAY_ID} .aie-section-title .aie-mail {
    color: var(--aie-muted);
  }

  #${EXPORT_SUCCESS_OVERLAY_ID} .aie-section-text {
    margin-top: 6px;
    font-size: 13px;
    line-height: 1.55;
    color: var(--aie-muted);
  }

  #${EXPORT_SUCCESS_OVERLAY_ID} .aie-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 12px;
  }

  #${EXPORT_SUCCESS_OVERLAY_ID} .aie-button {
    display: inline-flex;
    flex: 1 1 140px;
    align-items: center;
    justify-content: center;
    gap: 8px;
    min-height: 40px;
    padding: 9px 12px;
    border: 1px solid var(--aie-border);
    border-radius: 10px;
    background: var(--aie-surface);
    color: var(--aie-text);
    font-size: 13.5px;
    font-weight: 600;
    line-height: 1.3;
    text-align: center;
    text-decoration: none;
    cursor: pointer;
    transition: background-color 120ms ease, border-color 120ms ease;
  }

  #${EXPORT_SUCCESS_OVERLAY_ID} .aie-button:hover {
    border-color: var(--aie-muted);
  }

  #${EXPORT_SUCCESS_OVERLAY_ID} .aie-button.aie-primary {
    border-color: var(--aie-primary);
    background: var(--aie-primary);
    color: var(--aie-on-primary);
  }

  #${EXPORT_SUCCESS_OVERLAY_ID} .aie-button.aie-primary:hover {
    border-color: var(--aie-primary-hover);
    background: var(--aie-primary-hover);
  }

  #${EXPORT_SUCCESS_OVERLAY_ID} .aie-star {
    color: var(--aie-star);
  }

  #${EXPORT_SUCCESS_OVERLAY_ID} .aie-coffee {
    color: var(--aie-coffee);
  }

  #${EXPORT_SUCCESS_OVERLAY_ID} .aie-address {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    width: 100%;
    margin-top: 8px;
    padding: 6px 8px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--aie-text);
    font-size: 13px;
    cursor: pointer;
  }

  #${EXPORT_SUCCESS_OVERLAY_ID} .aie-address:hover {
    background: var(--aie-surface);
  }

  #${EXPORT_SUCCESS_OVERLAY_ID} .aie-address-text {
    overflow-wrap: anywhere;
  }

  #${EXPORT_SUCCESS_OVERLAY_ID} .aie-address .aie-icon {
    width: 14px;
    height: 14px;
    color: var(--aie-muted);
  }

  #${EXPORT_SUCCESS_OVERLAY_ID} .aie-copied {
    color: var(--aie-success);
    font-weight: 600;
  }

  #${EXPORT_SUCCESS_OVERLAY_ID} [hidden] {
    display: none;
  }

  #${EXPORT_SUCCESS_OVERLAY_ID} .aie-link {
    display: block;
    width: fit-content;
    margin: 4px auto 0;
    font-size: 12.5px;
    color: var(--aie-muted);
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  #${EXPORT_SUCCESS_OVERLAY_ID} .aie-link:hover {
    color: var(--aie-text);
  }

  #${EXPORT_SUCCESS_OVERLAY_ID} .aie-close {
    width: 100%;
    margin-top: 16px;
    padding: 10px 12px;
    border: 0;
    border-radius: 10px;
    background: transparent;
    color: var(--aie-muted);
    font-size: 13.5px;
    font-weight: 600;
    cursor: pointer;
  }

  #${EXPORT_SUCCESS_OVERLAY_ID} .aie-close:hover {
    background: var(--aie-soft);
    color: var(--aie-text);
  }

  #${EXPORT_SUCCESS_OVERLAY_ID} a:focus-visible,
  #${EXPORT_SUCCESS_OVERLAY_ID} button:focus-visible {
    outline: 2px solid var(--aie-focus);
    outline-offset: 2px;
  }

  @keyframes aie-fade {
    from { opacity: 0; }
  }

  @keyframes aie-rise {
    from { opacity: 0; transform: translateY(8px) scale(0.98); }
  }

  @media (prefers-reduced-motion: reduce) {
    #${EXPORT_SUCCESS_OVERLAY_ID},
    #${EXPORT_SUCCESS_OVERLAY_ID} .aie-modal {
      animation: none;
    }
  }
`;

let removeOverlayKeyListener: (() => void) | null = null;

function removeExportSuccessOverlay(): void {
  removeOverlayKeyListener?.();
  removeOverlayKeyListener = null;

  document.getElementById(EXPORT_SUCCESS_OVERLAY_ID)?.remove();
}

function showExportSuccessOverlay(): void {
  /*
   * Only one at a time - if a previous overlay is somehow
   * still around (e.g. rapid repeated exports), replace it
   * rather than stacking.
   */
  removeExportSuccessOverlay();

  const overlay = document.createElement("div");
  overlay.id = EXPORT_SUCCESS_OVERLAY_ID;
  overlay.dataset.theme = exportTheme;

  const storeUrl = isFirefoxExtension() ? FIREFOX_STORE_URL : CHROME_STORE_URL;

  overlay.innerHTML = `
    <style>${OVERLAY_STYLES}</style>
    <div
      class="aie-modal"
      tabindex="-1"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ai-exporter-export-success-title"
      aria-describedby="ai-exporter-export-success-subtitle"
    >
      <button type="button" class="aie-dismiss" data-aie-close aria-label="${ct("close")}">
        ${overlayIcon("close")}
      </button>

      <div class="aie-badge">${overlayIcon("check")}</div>
      <h2 class="aie-title" id="ai-exporter-export-success-title">${ct("title")}</h2>
      <p class="aie-subtitle" id="ai-exporter-export-success-subtitle">${ct("subtitle")}</p>

      <section class="aie-section">
        <p class="aie-section-title">
          <span class="aie-heart">${overlayIcon("heart")}</span>
          ${ct("freeTitle")}
        </p>
        <p class="aie-section-text">${ct("freeText")}</p>
        <div class="aie-row">
          <a class="aie-button" data-aie-link="review" href="${storeUrl}" target="_blank" rel="noopener noreferrer">
            <span class="aie-star">${overlayIcon("star")}</span>
            ${ct("review")}
          </a>
          <a class="aie-button" data-aie-link="coffee" href="${COFFEE_URL}" target="_blank" rel="noopener noreferrer">
            <span class="aie-coffee">${overlayIcon("coffee")}</span>
            ${ct("coffee")}
          </a>
        </div>
      </section>

      <section class="aie-section">
        <p class="aie-section-title">
          <span class="aie-mail">${overlayIcon("mail")}</span>
          ${ct("feedbackTitle")}
        </p>
        <p class="aie-section-text">${ct("feedbackText")}</p>
        <div class="aie-row">
          <a class="aie-button aie-primary" data-aie-link="email" href="${buildFeedbackMailto()}">
            ${overlayIcon("mail")}
            ${ct("writeToMe")}
          </a>
        </div>
        <button type="button" class="aie-address" data-aie-copy aria-label="${ct("copyEmail")}" title="${ct("copyEmail")}">
          <span class="aie-address-text">${FEEDBACK_EMAIL}</span>
          ${overlayIcon("copy")}
          <span class="aie-copied" hidden>${ct("copied")}</span>
        </button>
        <a class="aie-link" data-aie-link="github" href="${GITHUB_ISSUES_URL}" target="_blank" rel="noopener noreferrer">
          ${ct("github")}
        </a>
      </section>

      <button type="button" class="aie-close" id="ai-exporter-export-success-close" data-aie-close>
        ${ct("close")}
      </button>
    </div>
  `;

  document.body.appendChild(overlay);

  for (const button of overlay.querySelectorAll("[data-aie-close]")) {
    button.addEventListener("click", removeExportSuccessOverlay);
  }

  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) {
      removeExportSuccessOverlay();
    }
  });

  /*
   * Close on Escape too, matching standard modal behavior.
   * Removed together with the overlay however it's closed, so
   * repeated exports don't stack up listeners.
   */
  const handleEscape = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      removeExportSuccessOverlay();
    }
  };

  document.addEventListener("keydown", handleEscape);
  removeOverlayKeyListener = () =>
    document.removeEventListener("keydown", handleEscape);

  const copyButton = overlay.querySelector<HTMLButtonElement>("[data-aie-copy]");

  copyButton?.addEventListener("click", () => {
    void navigator.clipboard
      ?.writeText(FEEDBACK_EMAIL)
      .then(() => {
        const copied = copyButton.querySelector<HTMLElement>(".aie-copied");

        if (copied) {
          copied.hidden = false;
          window.setTimeout(() => {
            copied.hidden = true;
          }, 2000);
        }
      })
      .catch(() => undefined);
  });

  /*
   * Focus the dialog itself rather than one of its buttons, so
   * keyboard and screen reader users land inside it without a
   * focus ring appearing on a button nobody chose yet.
   */
  overlay
    .querySelector<HTMLElement>(".aie-modal")
    ?.focus({ preventScroll: true });
}

/*
 * ---------------------------------------------------------
 * CHROME MESSAGE HANDLER
 * ---------------------------------------------------------
 */

chrome.runtime.onMessage.addListener(
  (
    message: {
      type: string;
      downloadImagesLocally?: boolean;
    },
    _sender,
    sendResponse,
  ) => {
    if (message.type !== "LOAD_CONVERSATION") {
      return false;
    }

    devLog("AI Exporter: LOAD_CONVERSATION received");

    loadEntireConversationSingleFlight(message.downloadImagesLocally === true)
      .then((result) => {
        devLog("AI Exporter: sending conversation", result);

        sendResponse({
          success: true,
          data: result,
        });
      })
      .catch((error) => {
        devError("AI Exporter: failed to load conversation", error);

        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });

    /*
     * Keep the Chrome message channel open while
     * the asynchronous operation is running.
     */
    return true;
  },
);

/*
 * SHOW_EXPORT_SUCCESS is sent by popup.ts once a download or
 * GitHub save has actually completed (see background.ts's
 * chrome.downloads.onChanged tracking for downloads, and the
 * GitHub save response handler for repo saves). Shown here in
 * the page itself, not the popup, so it stays visible even if
 * the popup has already closed by the time the download
 * finishes - which Chrome does automatically as soon as focus
 * leaves the popup, including a native Save As dialog opening.
 */
chrome.runtime.onMessage.addListener((message: { type: string }) => {
  if (message.type !== "SHOW_EXPORT_SUCCESS") {
    return false;
  }

  showExportSuccessOverlay();

  return false;
});
