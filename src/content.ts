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
 * No DOM scrolling is used.
 * No conversation credentials are stored by this file.
 */

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
    title: "✅ Export Successful!",
    thanks: "Built with ❤️. Thanks for using AI Exporter.",
    rate: "⭐ Rate on Chrome Web Store",
    coffee: "☕ Buy Me a Coffee",
    feedbackPrompt: "Found a bug or have an idea? Reach out:",
    shareAriaLabel: "Share on X",
    feedbackAriaLabel: "Send feedback",
    close: "Close",
  },
  es: {
    title: "✅ ¡Exportación exitosa!",
    thanks: "Hecho con ❤️. Gracias por usar AI Exporter.",
    rate: "⭐ Valóranos en Chrome Web Store",
    coffee: "☕ Invítame a un café",
    feedbackPrompt: "¿Encontraste un error o tienes una idea? Contáctanos:",
    shareAriaLabel: "Compartir en X",
    feedbackAriaLabel: "Enviar comentarios",
    close: "Cerrar",
  },
  fr: {
    title: "✅ Export réussi !",
    thanks: "Créé avec ❤️. Merci d'utiliser AI Exporter.",
    rate: "⭐ Noter sur le Chrome Web Store",
    coffee: "☕ M'offrir un café",
    feedbackPrompt: "Un bug ou une idée ? Contactez-nous :",
    shareAriaLabel: "Partager sur X",
    feedbackAriaLabel: "Envoyer un commentaire",
    close: "Fermer",
  },
  de: {
    title: "✅ Export erfolgreich!",
    thanks: "Mit ❤️ erstellt. Danke, dass du AI Exporter nutzt.",
    rate: "⭐ Im Chrome Web Store bewerten",
    coffee: "☕ Spendiere mir einen Kaffee",
    feedbackPrompt: "Fehler gefunden oder eine Idee? Melde dich:",
    shareAriaLabel: "Auf X teilen",
    feedbackAriaLabel: "Feedback senden",
    close: "Schließen",
  },
  ru: {
    title: "✅ Экспорт выполнен успешно!",
    thanks: "Сделано с ❤️. Спасибо, что используете AI Exporter.",
    rate: "⭐ Оценить в Chrome Web Store",
    coffee: "☕ Угостить кофе",
    feedbackPrompt: "Нашли ошибку или есть идея? Напишите нам:",
    shareAriaLabel: "Поделиться в X",
    feedbackAriaLabel: "Отправить отзыв",
    close: "Закрыть",
  },
  zh: {
    title: "✅ 导出成功！",
    thanks: "用 ❤️ 打造。感谢您使用 AI Exporter。",
    rate: "⭐ 在 Chrome 网上应用店评分",
    coffee: "☕ 请我喝咖啡",
    feedbackPrompt: "发现了 bug 或有好想法？请联系我们：",
    shareAriaLabel: "分享到 X",
    feedbackAriaLabel: "发送反馈",
    close: "关闭",
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
 */

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

injectPageBridge();

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

    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      (isChatGptHost || isOpenAiFileHost)
    )
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

function getImageReferenceFromPart(part: ApiImagePart): ApiImageReference | null {
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

function createRequestLimiter(maxConcurrent: number): <T>(
  action: () => Promise<T>,
) => Promise<T> {
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
  const filenameExtension = fileName.match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase();

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
            throw new Error("The downloaded attachment is not a supported image type.");
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
): Promise<{ base64: string; fileName: string; mimeType: string; sizeBytes: number }> {
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
      ...(reference ? { fileId: reference.fileId, scheme: reference.scheme } : {}),
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
 *     &num_turns=10
 *
 * Older messages:
 *
 * /backend-api/conversations/{id}/messages
 *     ?before={start_cursor}
 *     &include_has_versions=true
 *     &num_turns=10
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
      throw new Error("The conversation's images exceed the 20 MB export limit.");
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
 * Injected directly into the ChatGPT page (not the popup),
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
 * with ChatGPT's own page styles.
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
const CHROME_STORE_URL =
  "https://chromewebstore.google.com/detail/objkcakdcilfaphifjfcgfamlnnbinjc";
const FEEDBACK_URL = `${PROJECT_REPOSITORY_URL}/issues`;

function removeExportSuccessOverlay(): void {
  const existing = document.getElementById(EXPORT_SUCCESS_OVERLAY_ID);

  existing?.remove();
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
  overlay.setAttribute("role", "dialog");

  const themeStyle = document.createElement("style");
  themeStyle.textContent = `
    #${EXPORT_SUCCESS_OVERLAY_ID} {
      --gpt-export-overlay: rgba(0, 0, 0, 0.4);
      --gpt-export-surface: #ffffff;
      --gpt-export-text: #1b1f24;
    }

    #${EXPORT_SUCCESS_OVERLAY_ID}[data-theme="dark"] {
      --gpt-export-overlay: rgba(0, 0, 0, 0.6);
      --gpt-export-surface: #0d1117;
      --gpt-export-text: #f0f6fc;
    }

    @media (prefers-color-scheme: dark) {
      #${EXPORT_SUCCESS_OVERLAY_ID}[data-theme="system"] {
        --gpt-export-overlay: rgba(0, 0, 0, 0.6);
        --gpt-export-surface: #0d1117;
        --gpt-export-text: #f0f6fc;
      }
    }
  `;
  document.head.appendChild(themeStyle);
  overlay.setAttribute("aria-modal", "true");
  overlay.style.cssText = `
    position: fixed;
    inset: 0;
    z-index: 2147483647;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    background: var(--gpt-export-overlay);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  `;

  const modal = document.createElement("div");
  modal.style.cssText = `
    width: 100%;
    max-width: 380px;
    max-height: calc(100vh - 32px);
    overflow-y: auto;
    padding: 24px 22px;
    border-radius: 14px;
    background: var(--gpt-export-surface);
    color: var(--gpt-export-text);
    text-align: center;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
  `;

  modal.innerHTML = `
    <p style="margin: 0 0 6px; font-size: 19px; font-weight: 700; color: #3fb950;">
      ${ct("title")}
    </p>
    <p style="margin: 0 0 20px; font-size: 13px; color: var(--gpt-export-text); line-height: 1.5;">
      ${ct("thanks")}
    </p>

    <a
      href="${CHROME_STORE_URL}"
      target="_blank"
      rel="noopener noreferrer"
      style="display: block; padding: 11px 10px; margin-bottom: 8px; border-radius: 8px; background: #10a37f; color: #ffffff; text-decoration: none; font-size: 13.5px; font-weight: 700;"
    >
      ${ct("rate")}
    </a>

    <a
      href="${COFFEE_URL}"
      target="_blank"
      rel="noopener noreferrer"
      style="display: block; padding: 11px 10px; margin-bottom: 14px; border-radius: 8px; background: #ffdd00; color: #1b1f24; text-decoration: none; font-size: 13.5px; font-weight: 700;"
    >
      ${ct("coffee")}
    </a>

    <p style="margin: 0 0 10px; font-size: 12px; color: #8b949e;">
      ${ct("feedbackPrompt")}
    </p>

    <div style="display: flex; justify-content: center; gap: 14px; margin-bottom: 16px;">
      <a
        href="https://x.com/intent/tweet?text=${encodeURIComponent("Checking out AI Exporter - a handy ChatGPT export extension!")}&url=${encodeURIComponent(PROJECT_REPOSITORY_URL)}"
        target="_blank"
        rel="noopener noreferrer"
        aria-label="${ct("shareAriaLabel")}"
        style="display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px; border-radius: 50%; background: #2d333b; color: #ffffff; text-decoration: none;"
      >✕</a>
      <a
        href="${FEEDBACK_URL}"
        target="_blank"
        rel="noopener noreferrer"
        aria-label="${ct("feedbackAriaLabel")}"
        style="display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px; border-radius: 50%; background: #2d333b; color: #ffffff; text-decoration: none; font-size: 15px;"
      >✉</a>
    </div>

    <button
      type="button"
      id="ai-exporter-export-success-close"
      style="width: 100%; padding: 9px 10px; border-radius: 8px; border: 1px solid #30363d; background: transparent; color: var(--gpt-export-text); font-size: 12.5px; font-weight: 500; cursor: pointer;"
    >
      ${ct("close")}
    </button>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const closeButton = modal.querySelector<HTMLButtonElement>(
    "#ai-exporter-export-success-close",
  );

  closeButton?.addEventListener("click", () => {
    removeExportSuccessOverlay();
  });

  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) {
      removeExportSuccessOverlay();
    }
  });

  /*
   * Close on Escape too, matching standard modal behavior.
   * Auto-removes itself once the overlay is gone so repeated
   * exports don't stack up listeners.
   */
  const handleEscape = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      removeExportSuccessOverlay();
      document.removeEventListener("keydown", handleEscape);
    }
  };

  document.addEventListener("keydown", handleEscape);
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
