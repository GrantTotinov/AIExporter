import { vi, type Mock } from "vitest";

/*
 * Loads the real content script into the test's page - the jsdom
 * URL a test file names is the chat site's - with chrome and fetch
 * stubbed, and talks to it the way the popup and the "Save many
 * chats" page do. For the sites whose loaders share one path
 * (DeepSeek, Grok, Perplexity); content-claude.test.ts and
 * content-gemini.test.ts set up their own.
 */

type Listener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response?: unknown) => void,
) => boolean | void;

export interface ContentScript {
  fetchMock: Mock;
  getURL: Mock;
  runtimeSendMessage: Mock;
  /* Sends a message the way chrome.tabs.sendMessage delivers it */
  send(message: Record<string, unknown>): Promise<any>;
  /* What was fetched: the address (path and query on the page's own site) and the request */
  requests(): { address: string; init: RequestInit | undefined }[];
}

export const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3]);

export const PNG_BASE64 = btoa(String.fromCharCode(...PNG_BYTES));

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function pngResponse(): Response {
  return new Response(PNG_BYTES, { headers: { "content-type": "image/png" } });
}

export async function loadContentScript(): Promise<ContentScript> {
  const listeners: Listener[] = [];
  const fetchMock = vi.fn();
  const getURL = vi.fn((path: string) => `chrome-extension://test-id/${path}`);
  const runtimeSendMessage = vi.fn(() => Promise.resolve());

  vi.resetModules();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);

  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("chrome", {
    runtime: {
      getURL,
      sendMessage: runtimeSendMessage,
      onMessage: {
        addListener: (listener: Listener) => {
          listeners.push(listener);
        },
      },
    },
    storage: {
      sync: {
        get: vi.fn((defaults: Record<string, unknown>) =>
          Promise.resolve(defaults),
        ),
      },
      onChanged: { addListener: vi.fn() },
    },
    i18n: { getUILanguage: () => "en-US" },
  });

  await import("../src/content");

  return {
    fetchMock,
    getURL,
    runtimeSendMessage,
    send(message) {
      return new Promise((resolve, reject) => {
        let answered = false;
        const sendResponse = (response?: unknown): void => {
          answered = true;
          resolve(response);
        };

        for (const listener of listeners) {
          if (listener(message, {}, sendResponse) === true || answered) {
            return;
          }
        }

        reject(new Error(`Nothing answered ${JSON.stringify(message)}`));
      });
    },
    requests() {
      return fetchMock.mock.calls.map(([input, init]) => {
        const url = new URL(String(input));

        return {
          address:
            url.origin === window.location.origin
              ? url.pathname + url.search
              : url.href,
          init: init as RequestInit | undefined,
        };
      });
    },
  };
}
