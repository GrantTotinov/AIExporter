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
  const MAX_CURSOR_LENGTH = 2048;
  const MAX_REQUEST_ID_LENGTH = 100;
  const RATE_LIMIT_WINDOW_MS = 10_000;
  const MAX_REQUESTS_PER_WINDOW = 20;

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
        LEGACY_CONVERSATION_PATH_PATTERN.test(parsed.pathname)
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

  function buildConversationUrl(
    conversationId: string,
    cursor: string | null,
  ): string {
    const endpoint = cursor
      ? `/backend-api/conversations/${conversationId}/messages`
      : `/backend-api/conversations/${conversationId}`;
    const params = new URLSearchParams({
      include_has_versions: "true",
      num_turns: "10",
    });

    if (cursor) {
      params.set("before", cursor);
    }

    return `${endpoint}?${params.toString()}`;
  }

  function isApiRequestMessage(
    value: unknown,
  ): value is {
    source: "AIExporter";
    type: "AIExporter_API_REQUEST";
    requestId: string;
    conversationId: string;
    cursor: string | null;
  } {
    if (!value || typeof value !== "object") {
      return false;
    }

    const message = value as Record<string, unknown>;

    return (
      message.source === "AIExporter" &&
      message.type === "AIExporter_API_REQUEST" &&
      isValidRequestId(message.requestId) &&
      isValidConversationId(message.conversationId) &&
      isValidCursor(message.cursor)
    );
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

    const requestId = event.data.requestId;
    const url = buildConversationUrl(
      event.data.conversationId,
      event.data.cursor,
    );

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
          throw new Error(
            "ChatGPT authentication context has not been observed yet. Open or reload the conversation and try again.",
          );
        }

        /*
         * Create a copy so we don't modify the
         * captured Headers object.
         */
        const headers = new Headers(authenticatedHeaders);

        /*
         * Use the original fetch function.
         *
         * Authentication headers are supplied from
         * the authenticated ChatGPT request observed
         * above.
         */
        const response = await originalFetch(url, {
          method: "GET",
          credentials: "include",
          headers,
        });

        devLog("AI Exporter bridge: API response", response.status);

        if (!response.ok) {
          throw new Error(
            `ChatGPT API request failed: ${response.status} ${response.statusText}`,
          );
        }

        const data = await response.json();

        /*
         * Send JSON back to content.ts.
         */
        window.postMessage(
          {
            source: "AIExporter",
            type: "AIExporter_API_RESPONSE",
            requestId,
            data,
          },
          "*",
        );
      } catch (error) {
        devError("AI Exporter bridge: API request failed");

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
