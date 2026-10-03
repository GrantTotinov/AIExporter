// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://claude.ai/chat/0b2f7a52-1c3d-4e5f-8a9b-0c1d2e3f4a5b"}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * ---------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------
 *
 * Covers the "export complete" dialog the content script shows
 * in the chat page once a download or GitHub save finishes:
 * what it says, where its links go (the right store for the
 * browser, a ready-to-send feedback email) and that closing it
 * leaves nothing behind on the page.
 */

type Listener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response?: unknown) => void,
) => boolean | void;

const OVERLAY_ID = "ai-exporter-export-success-overlay";

const onMessageListeners: Listener[] = [];

async function loadContentScript(
  extensionOrigin = "chrome-extension://test-id/",
  language = "en",
): Promise<void> {
  vi.resetModules();
  onMessageListeners.length = 0;

  vi.stubGlobal("chrome", {
    runtime: {
      getURL: (path: string) => `${extensionOrigin}${path}`,
      getManifest: () => ({ version: "9.8.7" }),
      sendMessage: vi.fn(),
      onMessage: {
        addListener: (listener: Listener) => {
          onMessageListeners.push(listener);
        },
      },
    },
    storage: {
      sync: {
        get: vi.fn((defaults: Record<string, unknown>) =>
          Promise.resolve({ ...defaults, language }),
        ),
      },
      onChanged: { addListener: vi.fn() },
    },
    i18n: { getUILanguage: () => "en-US" },
  });

  await import("../src/content");
  /* Let initContentI18n's storage read settle. */
  await Promise.resolve();
  await Promise.resolve();
}

function showOverlay(): HTMLElement {
  for (const listener of onMessageListeners) {
    listener({ type: "SHOW_EXPORT_SUCCESS" }, {}, () => undefined);
  }

  const overlay = document.getElementById(OVERLAY_ID);

  if (!overlay) {
    throw new Error("Overlay was not shown");
  }

  return overlay;
}

function link(overlay: HTMLElement, name: string): HTMLAnchorElement {
  const anchor = overlay.querySelector<HTMLAnchorElement>(
    `[data-aie-link="${name}"]`,
  );

  if (!anchor) {
    throw new Error(`No ${name} link`);
  }

  return anchor;
}

describe("export success dialog", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    document.getElementById(OVERLAY_ID)?.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("confirms the export and says the extension is free", async () => {
    await loadContentScript();

    const overlay = showOverlay();
    const dialog = overlay.querySelector('[role="dialog"]');

    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    expect(overlay.textContent).toContain("Export complete");
    expect(overlay.textContent).toContain("Free for everyone");
    expect(document.activeElement).toBe(dialog);
  });

  it("links to the Chrome Web Store reviews in Chrome", async () => {
    await loadContentScript();

    const review = link(showOverlay(), "review");

    expect(review.href).toContain("chromewebstore.google.com");
    expect(review.target).toBe("_blank");
    expect(review.rel).toContain("noopener");
  });

  it("links to Firefox Add-ons in Firefox", async () => {
    await loadContentScript("moz-extension://test-id/");

    const review = link(showOverlay(), "review");

    expect(review.href).toContain("addons.mozilla.org");
    expect(review.href).toContain("gptchatdownloader@granttotinov.com");
  });

  it("opens a feedback email with the subject, version, browser and site filled in", async () => {
    await loadContentScript();

    const email = link(showOverlay(), "email");
    const url = new URL(email.href);

    expect(url.protocol).toBe("mailto:");
    expect(url.pathname).toBe("granttotinov604@gmail.com");
    expect(url.searchParams.get("subject")).toBe("AI Exporter feedback");

    const body = url.searchParams.get("body") ?? "";

    expect(body).toContain("Write your message here:");
    expect(body).toContain("AI Exporter 9.8.7 · Chrome · claude.ai");
  });

  it("uses the chosen language", async () => {
    await loadContentScript("chrome-extension://test-id/", "de");

    const overlay = showOverlay();

    expect(overlay.textContent).toContain("Export abgeschlossen");
    expect(
      new URL(link(overlay, "email").href).searchParams.get("subject"),
    ).toBe("Feedback zu AI Exporter");
  });

  it("copies the email address for people without a mail app", async () => {
    await loadContentScript();

    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    const overlay = showOverlay();
    overlay.querySelector<HTMLButtonElement>("[data-aie-copy]")?.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledWith("granttotinov604@gmail.com");
    expect(overlay.querySelector<HTMLElement>(".aie-copied")?.hidden).toBe(
      false,
    );
  });

  it.each([
    ["the close button", () =>
      document
        .querySelector<HTMLButtonElement>("#ai-exporter-export-success-close")
        ?.click()],
    ["the corner X", () =>
      document.querySelector<HTMLButtonElement>(".aie-dismiss")?.click()],
    ["Escape", () =>
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))],
    ["a click on the backdrop", () =>
      document.getElementById(OVERLAY_ID)?.click()],
  ])("closes with %s", async (_name, close) => {
    await loadContentScript();
    showOverlay();

    close();

    expect(document.getElementById(OVERLAY_ID)).toBeNull();
  });

  it("doesn't stack dialogs, styles or Escape listeners across exports", async () => {
    await loadContentScript();
    const removeListener = vi.spyOn(document, "removeEventListener");

    showOverlay();
    showOverlay();

    expect(document.querySelectorAll(`#${OVERLAY_ID}`)).toHaveLength(1);
    expect(document.head.querySelectorAll("style")).toHaveLength(0);
    expect(removeListener).toHaveBeenCalledWith("keydown", expect.any(Function));

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(document.getElementById(OVERLAY_ID)).toBeNull();
    expect(document.querySelectorAll("style")).toHaveLength(0);
  });
});
