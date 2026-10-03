/*
 * AI Exporter - MAIN world bridge
 *
 * This file runs in the ChatGPT page's MAIN world.
 *
 * It observes authenticated ChatGPT conversation requests
 * and performs conversation API requests inside the same
 * page context.
 */

(() => {
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

  const originalFetch = window.fetch;

  let authenticatedHeaders: Headers | null = null;

  /*
   * ---------------------------------------------------------
   * CONVERSATION URL
   * ---------------------------------------------------------
   */

  const CONVERSATION_ID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const CONVERSATION_PATH_PATTERN =
    /^\/backend-api\/conversations\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\/messages)?$/i;
  const LEGACY_CONVERSATION_PATH_PATTERN =
    /^\/backend-api\/conversation\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\/messages)?$/i;
  // The sidebar's conversation list (?offset=..&limit=..).
  const CONVERSATION_LIST_PATH_PATTERN = /^\/backend-api\/conversations\/?$/i;
  const MAX_LIST_PAGE_SIZE = 100;
  const MAX_LIST_OFFSET = 1_000_000;
  const MAX_CURSOR_LENGTH = 2048;
  const MAX_REQUEST_ID_LENGTH = 100;
  const FILE_ID_PATTERN = /^file[_-][A-Za-z0-9_-]{1,255}$/i;
  const RATE_LIMIT_WINDOW_MS = 10_000;
  const MAX_REQUESTS_PER_WINDOW = 50;

  let requestWindowStartedAt = Date.now();
  let requestsInWindow = 0;

  function isConversationUrl(url: string): boolean {
    try {
      const parsed = new URL(url, window.location.origin);

      if (
        parsed.origin !== window.location.origin ||
        (parsed.protocol !== "https:" && parsed.protocol !== "http:")
      ) {
        return false;
      }

      return (
        CONVERSATION_PATH_PATTERN.test(parsed.pathname) ||
        LEGACY_CONVERSATION_PATH_PATTERN.test(parsed.pathname) ||
        CONVERSATION_LIST_PATH_PATTERN.test(parsed.pathname)
      );
    } catch {
      return false;
    }
  }

  function isValidConversationId(value: unknown): value is string {
    return typeof value === "string" && CONVERSATION_ID_PATTERN.test(value);
  }

  function isValidCursor(value: unknown): value is string | null {
    return (
      value === null ||
      (typeof value === "string" &&
        value.length > 0 &&
        value.length <= MAX_CURSOR_LENGTH)
    );
  }

  function isValidRequestId(value: unknown): value is string {
    return (
      typeof value === "string" &&
      value.length > 0 &&
      value.length <= MAX_REQUEST_ID_LENGTH
    );
  }

  function isValidFileId(value: unknown): value is string {
    return typeof value === "string" && FILE_ID_PATTERN.test(value);
  }

  function allowRequest(): boolean {
    const now = Date.now();

    if (now - requestWindowStartedAt >= RATE_LIMIT_WINDOW_MS) {
      requestWindowStartedAt = now;
      requestsInWindow = 0;
    }

    if (requestsInWindow >= MAX_REQUESTS_PER_WINDOW) {
      return false;
    }

    requestsInWindow++;

    return true;
  }

  /*
   * Turns per conversation page. The ChatGPT web app asks for 10,
   * since it only needs the newest few on screen, but an export
   * needs every turn, and each page costs another round trip that
   * can't start before the previous one returns its cursor - 10
   * per page took 2 requests for a 30-message chat and 11 for a
   * 200-message one. The endpoint takes larger pages; should it
   * ever reject one, the page is requested again at the web app's
   * own size.
   */
  const PAGE_TURNS = 100;
  const WEB_APP_PAGE_TURNS = 10;

  function buildConversationUrl(
    conversationId: string,
    cursor: string | null,
    numTurns: number,
  ): string {
    const endpoint = cursor
      ? `/backend-api/conversations/${conversationId}/messages`
      : `/backend-api/conversations/${conversationId}`;
    const params = new URLSearchParams({
      include_has_versions: "true",
      num_turns: String(numTurns),
    });

    if (cursor) {
      params.set("before", cursor);
    }

    return `${endpoint}?${params.toString()}`;
  }

  type ApiRequestMessage = {
    source: "AIExporter";
    type: "AIExporter_API_REQUEST";
    requestId: string;
    conversationId: string;
    cursor: string | null;
  };

  type FileDownloadRequestMessage = {
    source: "AIExporter";
    type: "AIExporter_FILE_DOWNLOAD_REQUEST";
    requestId: string;
    conversationId: string;
    fileId?: string;
    scheme?: "file-service" | "sediment";
    imageUrl?: string;
  };

  /*
   * A page of the conversation list, for the bulk export page:
   * the request the sidebar makes, newest first.
   */
  type ListRequestMessage = {
    source: "AIExporter";
    type: "AIExporter_LIST_REQUEST";
    requestId: string;
    offset: number;
    limit: number;
  };

  type BridgeRequestMessage =
    | ApiRequestMessage
    | FileDownloadRequestMessage
    | ListRequestMessage;

  function isValidListPage(message: Record<string, unknown>): boolean {
    const { offset, limit } = message;

    return (
      Number.isInteger(offset) &&
      (offset as number) >= 0 &&
      (offset as number) <= MAX_LIST_OFFSET &&
      Number.isInteger(limit) &&
      (limit as number) > 0 &&
      (limit as number) <= MAX_LIST_PAGE_SIZE
    );
  }

  function buildConversationListUrl(offset: number, limit: number): string {
    const params = new URLSearchParams({
      offset: String(offset),
      limit: String(limit),
      order: "updated",
    });

    return `/backend-api/conversations?${params.toString()}`;
  }

  function isApiRequestMessage(
    value: unknown,
  ): value is BridgeRequestMessage {
    if (!value || typeof value !== "object") {
      return false;
    }

    const message = value as Record<string, unknown>;

    if (message.type === "AIExporter_LIST_REQUEST") {
      return (
        message.source === "AIExporter" &&
        isValidRequestId(message.requestId) &&
        isValidListPage(message)
      );
    }

    const hasValidCommonFields =
      message.source === "AIExporter" &&
      isValidRequestId(message.requestId) &&
      isValidConversationId(message.conversationId);

    if (!hasValidCommonFields) {
      return false;
    }

    if (message.type === "AIExporter_API_REQUEST") {
      return isValidCursor(message.cursor);
    }

    if (message.type !== "AIExporter_FILE_DOWNLOAD_REQUEST") {
      return false;
    }

    const hasFileReference =
      isValidFileId(message.fileId) &&
      (message.scheme === "file-service" || message.scheme === "sediment");
    const hasSafeImageUrl = Boolean(getSafeHostedDownloadUrl(message.imageUrl));

    return hasFileReference || hasSafeImageUrl;
  }

  function buildFileDownloadUrls(
    message: {
      conversationId: string;
      fileId: string;
      scheme: "file-service" | "sediment";
    },
  ): string[] {
    const fileId = encodeURIComponent(message.fileId);
    const conversationId = encodeURIComponent(message.conversationId);
    const resolverParams = new URLSearchParams({
      conversation_id: message.conversationId,
      download_intent: "false",
      inline: "true",
    });
    const byFilesDownload =
      `/backend-api/files/download/${fileId}?${resolverParams.toString()}`;
    const byFileId = `/backend-api/files/${fileId}/download`;
    const byConversationAttachment =
      `/backend-api/conversation/${conversationId}/attachment/${fileId}/download`;

    return message.scheme === "file-service"
      ? [byFileId, byFilesDownload]
      : [byFilesDownload, byConversationAttachment, byFileId];
  }

  function getSafeHostedDownloadUrl(value: unknown): string | null {
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

  function getImageFilename(
    response: Response,
    url: string,
    preferredFileName?: string,
  ): string {
    if (preferredFileName) {
      return preferredFileName;
    }

    const disposition = response.headers.get("content-disposition") ?? "";
    const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
    const regularName = disposition.match(/filename=["']?([^"';]+)["']?/i)?.[1];

    if (encodedName || regularName) {
      const value = encodedName ?? regularName ?? "";

      try {
        return decodeURIComponent(value.replace(/^"|"$/g, ""));
      } catch {
        return value.replace(/^"|"$/g, "");
      }
    }

    try {
      return decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "image");
    } catch {
      return "image";
    }
  }

  async function downloadImage(
    url: string,
    headers: Headers,
    preferredFileName?: string,
  ): Promise<{
    base64: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
  }> {
    const parsedUrl = new URL(url);
    const sameOrigin = parsedUrl.origin === window.location.origin;
    const imageHeaders = sameOrigin ? new Headers(headers) : new Headers();
    const response = await originalFetch(parsedUrl.toString(), {
      method: "GET",
      credentials: sameOrigin ? "include" : "omit",
      headers: imageHeaders,
    });

    if (!response.ok) {
      throw new Error(
        `ChatGPT image download failed: ${response.status} ${response.statusText}`,
      );
    }

    const declaredMimeType = (response.headers.get("content-type") ?? "")
      .split(";", 1)[0]
      .trim()
      .toLowerCase();
    const fileName = getImageFilename(
      response,
      response.url || url,
      preferredFileName,
    );
    const extension = fileName.match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase();
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
    const mimeIsSupported =
      /^image\/(?:png|jpe?g|gif|webp|avif|heic|heif|bmp|tiff?)$/i.test(
        declaredMimeType,
      );
    const mimeCanUseFilename =
      !declaredMimeType ||
      declaredMimeType === "application/octet-stream" ||
      declaredMimeType === "application/binary";

    if (!mimeIsSupported && !mimeCanUseFilename) {
      throw new Error("ChatGPT returned a non-image attachment.");
    }

    const mimeType = mimeIsSupported
      ? declaredMimeType === "image/jpg"
        ? "image/jpeg"
        : declaredMimeType
      : extension
        ? extensionToMime[extension]
        : undefined;

    if (!mimeType) {
      throw new Error("ChatGPT returned an unsupported image type.");
    }

    const declaredLength = Number(response.headers.get("content-length") ?? 0);

    if (declaredLength > 8 * 1024 * 1024) {
      throw new Error("The image is larger than the 8 MB export limit.");
    }

    const maxBytes = 8 * 1024 * 1024;
    const chunks: Uint8Array[] = [];
    let sizeBytes = 0;

    if (response.body) {
      const reader = response.body.getReader();

      while (true) {
        const result = await reader.read();

        if (result.done) {
          break;
        }

        sizeBytes += result.value.byteLength;

        if (sizeBytes > maxBytes) {
          void reader.cancel();
          throw new Error("The image is larger than the 8 MB export limit.");
        }

        chunks.push(result.value);
      }
    } else {
      const buffer = await response.arrayBuffer();

      sizeBytes = buffer.byteLength;

      if (sizeBytes > maxBytes) {
        throw new Error("The image is larger than the 8 MB export limit.");
      }

      chunks.push(new Uint8Array(buffer));
    }

    if (sizeBytes === 0 || sizeBytes > maxBytes) {
      throw new Error("The image is empty or larger than the 8 MB export limit.");
    }

    const bytes = new Uint8Array(sizeBytes);
    let offset = 0;

    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return {
      base64: bytesToBase64(bytes),
      fileName,
      mimeType,
      sizeBytes,
    };
  }

  /*
   * When no ChatGPT request has been seen yet to copy headers
   * from - a bulk export started from a page that hasn't loaded a
   * conversation - the web app's own session endpoint gives the
   * access token its requests carry.
   */
  async function fetchSessionHeaders(): Promise<Headers | null> {
    try {
      const response = await originalFetch("/api/auth/session", {
        method: "GET",
        credentials: "include",
      });

      if (!response.ok) {
        return null;
      }

      const session = (await response.json()) as { accessToken?: unknown };

      return typeof session.accessToken === "string" && session.accessToken
        ? new Headers({ Authorization: `Bearer ${session.accessToken}` })
        : null;
    } catch {
      return null;
    }
  }

  /*
   * ---------------------------------------------------------
   * REQUEST URL
   * ---------------------------------------------------------
   */

  function getRequestUrl(input: RequestInfo | URL): string {
    if (input instanceof Request) {
      return input.url;
    }

    return String(input);
  }

  /*
   * ---------------------------------------------------------
   * INTERCEPT FETCH
   * ---------------------------------------------------------
   *
   * ChatGPT itself makes authenticated requests to:
   *
   * /backend-api/conversations/...
   *
   * We observe one of these requests and copy its headers
   * into MAIN-world memory.
   *
   * Nothing is persisted to storage.
   */

  window.fetch = function (
    this: Window,
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url = getRequestUrl(input);
    const isConversationRequest = isConversationUrl(url);

    /*
     * Capture authentication headers from the
     * existing ChatGPT request.
     */
    if (isConversationRequest) {
      try {
        if (input instanceof Request) {
          /*
           * Clone only for reading headers.
           *
           * The original Request is still passed
           * untouched to fetch below.
           */
          const cloned = input.clone();

          authenticatedHeaders = new Headers(cloned.headers);
        } else {
          authenticatedHeaders = new Headers(init?.headers);
        }

        devLog(
          "AI Exporter bridge: authenticated conversation request detected",
        );
      } catch (error) {
        devWarn(
          "AI Exporter bridge: could not inspect request headers",
          error,
        );
      }
    }

    /*
     * IMPORTANT
     *
     * Do NOT use `arguments`.
     *
     * Do NOT create a new Request from `input`.
     *
     * Forward the original input/init directly.
     *
     * This prevents:
     *
     * "Request object already been used"
     */
    return Reflect.apply(originalFetch, this, [input, init]);
  };

  /*
   * ---------------------------------------------------------
   * AI Exporter API REQUEST
   * ---------------------------------------------------------
   *
   * content.ts sends:
   *
   * {
   *     source: "AIExporter",
   *     type: "AIExporter_API_REQUEST",
   *     requestId,
   *     conversationId,
   *     cursor
   * }
   *
   * This listener performs the authenticated request
   * inside the ChatGPT MAIN world.
   */

  window.addEventListener("message", (event) => {
    /*
     * Only accept messages originating from this page.
     */
    if (
      event.source !== window ||
      !isApiRequestMessage(event.data)
    ) {
      return;
    }

    if (!allowRequest()) {
      window.postMessage(
        {
          source: "AIExporter",
          type: "AIExporter_API_ERROR",
          requestId: event.data.requestId,
          error: "Too many conversation API requests.",
        },
        "*",
      );

      return;
    }

    const request = event.data;
    const requestId = request.requestId;

    /*
     * -------------------------------------------------
     * PERFORM AUTHENTICATED REQUEST
     * -------------------------------------------------
     */

    void (async () => {
      try {
        /*
         * We need to have observed at least one
         * authenticated ChatGPT conversation request.
         */
        if (!authenticatedHeaders) {
          authenticatedHeaders = await fetchSessionHeaders();
        }

        if (!authenticatedHeaders) {
          throw new Error(
            "ChatGPT authentication context has not been observed yet. Open or reload the conversation and try again.",
          );
        }

        /*
         * Create a copy so we don't modify the
         * captured Headers object.
         */
        const headers = new Headers(authenticatedHeaders);

        if (request.type === "AIExporter_LIST_REQUEST") {
          const response = await originalFetch(
            buildConversationListUrl(request.offset, request.limit),
            { method: "GET", credentials: "include", headers },
          );

          if (!response.ok) {
            throw new Error(
              `ChatGPT API request failed: ${response.status} ${response.statusText}`,
            );
          }

          window.postMessage(
            {
              source: "AIExporter",
              type: "AIExporter_API_RESPONSE",
              requestId,
              data: await response.json(),
            },
            "*",
          );

          return;
        }

        /*
         * Use the original fetch function.
         *
         * Authentication headers are supplied from
         * the authenticated ChatGPT request observed
         * above.
         */
        if (request.type === "AIExporter_API_REQUEST") {
          const fetchPage = (numTurns: number): Promise<Response> =>
            originalFetch(
              buildConversationUrl(
                request.conversationId,
                request.cursor,
                numTurns,
              ),
              {
                method: "GET",
                credentials: "include",
                headers,
              },
            );

          let response = await fetchPage(PAGE_TURNS);

          if (response.status === 400 || response.status === 422) {
            response = await fetchPage(WEB_APP_PAGE_TURNS);
          }

          devLog(
            "AI Exporter bridge: conversation API response",
            response.status,
          );

          if (!response.ok) {
            throw new Error(
              `ChatGPT API request failed: ${response.status} ${response.statusText}`,
            );
          }

          const data = await response.json();

          window.postMessage(
            {
              source: "AIExporter",
              type: "AIExporter_API_RESPONSE",
              requestId,
              data,
            },
            "*",
          );

          return;
        }

        let downloadedImage:
          | {
              base64: string;
              fileName: string;
              mimeType: string;
              sizeBytes: number;
            }
          | null = null;
        let lastDownloadError: unknown;
        const directImageUrl = getSafeHostedDownloadUrl(request.imageUrl);

        if (directImageUrl) {
          try {
            downloadedImage = await downloadImage(directImageUrl, headers);
          } catch (error) {
            lastDownloadError = error;
            devWarn("AI Exporter bridge: direct image download failed");
          }
        }

        if (
          !downloadedImage &&
          isValidFileId(request.fileId) &&
          (request.scheme === "file-service" || request.scheme === "sediment")
        ) {
          const fileRequest = request as FileDownloadRequestMessage & {
            fileId: string;
            scheme: "file-service" | "sediment";
          };

          for (const url of buildFileDownloadUrls(fileRequest)) {
            const response = await originalFetch(url, {
              method: "GET",
              credentials: "include",
              headers: new Headers(headers),
            });

            devLog("AI Exporter bridge: image resolver response", response.status);

            if (!response.ok) {
              if (
                response.status === 400 ||
                response.status === 404 ||
                response.status === 405 ||
                response.status === 422
              ) {
                continue;
              }

              lastDownloadError = new Error(
                `ChatGPT image request failed: ${response.status} ${response.statusText}`,
              );
              break;
            }

            try {
              const data = (await response.json()) as Record<string, unknown>;
              const downloadUrl = getSafeHostedDownloadUrl(
                data.download_url ?? data.url,
              );

              if (!downloadUrl) {
                continue;
              }

              downloadedImage = await downloadImage(
                downloadUrl,
                headers,
                typeof data.file_name === "string" ? data.file_name : undefined,
              );

              break;
            } catch (error) {
              lastDownloadError = error;
            }
          }
        }

        if (!downloadedImage) {
          throw lastDownloadError instanceof Error
            ? lastDownloadError
            : new Error("ChatGPT did not return a usable image file.");
        }

        window.postMessage(
          {
            source: "AIExporter",
            type: "AIExporter_FILE_DOWNLOAD_RESPONSE",
            requestId,
            imageFile: downloadedImage,
          },
          "*",
        );
      } catch (error) {
        devError("AI Exporter bridge: request failed");

        window.postMessage(
          {
            source: "AIExporter",
            type: "AIExporter_API_ERROR",
            requestId,
            error: error instanceof Error ? error.message : String(error),
          },
          "*",
        );
      }
    })();
  });

  /*
   * ---------------------------------------------------------
   * BRIDGE READY
   * ---------------------------------------------------------
   *
   * content.ts listens for this message.
   */

  window.postMessage(
    {
      source: "AIExporter",
      type: "BRIDGE_READY",
    },
    "*",
  );

  devLog("AI Exporter bridge: installed");
})();
