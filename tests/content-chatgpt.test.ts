// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://chatgpt.com/c/0b2f7a52-1c3d-4e5f-8a9b-0c1d2e3f4a5b"}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * content.js now runs on claude.ai too, where it skips the
 * MAIN-world page bridge (see content-claude.test.ts). This
 * makes sure ChatGPT still gets it - the ChatGPT export can't
 * authenticate without it.
 */

const getURL = vi.fn((path: string) => `chrome-extension://test-id/${path}`);

describe("content.ts on chatgpt.com", () => {
  beforeEach(async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    vi.stubGlobal("chrome", {
      runtime: {
        getURL,
        sendMessage: vi.fn(),
        onMessage: { addListener: vi.fn() },
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
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("injects the page bridge", () => {
    expect(getURL).toHaveBeenCalledWith("pageBridge.js");
    expect(
      document
        .querySelector<HTMLScriptElement>('script[data-ai-exporter="page-bridge"]')
        ?.getAttribute("src"),
    ).toBe("chrome-extension://test-id/pageBridge.js");
    expect(document.documentElement.dataset.aiExporterBridgeInjected).toBe(
      "true",
    );
  });
});
