// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://grok.com/c/0b2f7a52-1c3d-4e5f-8a9b-0c1d2e3f4a5b"}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadContentScript, type ContentScript } from "./content-harness";

/*
 * The copy shortcut works without the popup (see background.ts), so
 * the page says how it went, in a note in its corner.
 */
describe("content.ts toast", () => {
  let page: ContentScript;

  beforeEach(async () => {
    vi.useFakeTimers();
    document.body.innerHTML = "";
    page = await loadContentScript();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function toast(): HTMLElement | null {
    return document.getElementById("ai-exporter-toast");
  }

  function toastText(): string | null | undefined {
    return toast()?.querySelector(".aie-toast-text")?.textContent;
  }

  it("keeps a note of work in progress up until its outcome replaces it", async () => {
    expect(await page.send({ type: "SHOW_TOAST", text: "Copying the chat…", tone: "info" })).toEqual({
      ok: true,
    });
    expect(toastText()).toBe("Copying the chat…");
    expect(toast()?.getAttribute("role")).toBe("status");

    vi.advanceTimersByTime(60_000);
    expect(toast()).not.toBeNull();

    await page.send({ type: "SHOW_TOAST", text: "Copied!" });

    expect(document.querySelectorAll("#ai-exporter-toast")).toHaveLength(1);
    expect(toastText()).toBe("Copied!");
    expect(toast()?.dataset.tone).toBe("success");

    vi.advanceTimersByTime(4000);
    expect(toast()).toBeNull();
  });

  it("takes a note of work in progress away in the end, should no outcome come", async () => {
    await page.send({ type: "SHOW_TOAST", text: "Copying the chat…", tone: "info" });

    vi.advanceTimersByTime(120_000);
    expect(toast()).toBeNull();
  });

  it("shows an error longer, as an alert, and as text rather than markup", async () => {
    await page.send({
      type: "SHOW_TOAST",
      text: "<img src=x onerror=alert(1)> failed",
      tone: "error",
    });

    expect(toast()?.getAttribute("role")).toBe("alert");
    expect(toast()?.querySelector("img")).toBeNull();
    expect(toastText()).toBe("<img src=x onerror=alert(1)> failed");

    vi.advanceTimersByTime(4000);
    expect(toast()).not.toBeNull();
    vi.advanceTimersByTime(4000);
    expect(toast()).toBeNull();
  });
});
