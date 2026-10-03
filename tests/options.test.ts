// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import OPTIONS_HTML from "../public/options.html?raw";
import en from "../src/locales/en.json";
import de from "../src/locales/de.json";
import {
  DEFAULT_PDF_SETTINGS,
  DEFAULT_SETTINGS,
  type Settings,
} from "../src/settings";

const OPTIONS_BODY = OPTIONS_HTML.slice(
  OPTIONS_HTML.indexOf("<body>") + "<body>".length,
  OPTIONS_HTML.indexOf("</body>"),
);

let stored: Record<string, unknown> = {};

const storageGet = vi.fn(async (defaults: Record<string, unknown>) => ({
  ...defaults,
  ...structuredClone(stored),
}));

const storageSet = vi.fn(async (items: Record<string, unknown>) => {
  Object.assign(stored, structuredClone(items));
});

let githubStatus: { connected: boolean; login?: string } = { connected: false };

const sendMessage = vi.fn(async (message: { type: string }) => {
  if (message.type === "GITHUB_GET_STATUS") {
    return { success: true, data: githubStatus };
  }

  return { success: true };
});

function byId<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function setting(helpKey: string): HTMLElement {
  return document.querySelector(`[data-help="${helpKey}"]`) as HTMLElement;
}

function savedSettings(): Settings {
  const calls = storageSet.mock.calls;

  return calls[calls.length - 1][0] as unknown as Settings;
}

async function loadOptionsPage(initial: Partial<Settings> = {}): Promise<void> {
  stored = structuredClone(initial) as Record<string, unknown>;

  vi.stubGlobal("chrome", {
    storage: { sync: { get: storageGet, set: storageSet } },
    runtime: {
      getManifest: () => ({ version: "2.3.0" }),
      sendMessage,
      onMessage: { addListener: vi.fn() },
    },
    tabs: { create: vi.fn() },
    i18n: { getUILanguage: () => "en-US" },
  });

  document.body.innerHTML = OPTIONS_BODY;
  delete document.documentElement.dataset.theme;

  vi.resetModules();
  await import("../src/options.ts");

  await vi.waitFor(() => {
    expect(byId<HTMLInputElement>("pdfFontSize").value).not.toBe("");
    expect(sendMessage).toHaveBeenCalled();
  });

  storageSet.mockClear();
}

function typeInto(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function commit(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

beforeEach(() => {
  vi.clearAllMocks();
  githubStatus = { connected: false };
  vi.useFakeTimers();
});

/*
 * Each test imports a fresh copy of options.ts. A save still
 * waiting on its timer when a test ends would otherwise fire
 * during a later test and write into that test's storage, so
 * pending timers run here, while this test's stubs are live.
 */
afterEach(async () => {
  await vi.runOnlyPendingTimersAsync();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("options page", () => {
  it("shows the stored settings", async () => {
    await loadOptionsPage({
      includeTimestamp: true,
      headingStyle: "bold",
      theme: "dark",
      pdf: { ...DEFAULT_PDF_SETTINGS, fontSize: 14, orientation: "landscape" },
    });

    expect(byId<HTMLInputElement>("includeTimestamp").checked).toBe(true);
    expect(
      document.querySelector<HTMLInputElement>(
        'input[name="headingStyle"][value="bold"]',
      )?.checked,
    ).toBe(true);
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(byId<HTMLInputElement>("pdfFontSize").value).toBe("14");
    expect(
      document.querySelector<HTMLInputElement>(
        'input[name="pdfOrientation"][value="landscape"]',
      )?.checked,
    ).toBe(true);
    expect(document.title).toBe(en["options.title"]);
    expect(byId("app-version").textContent).toBe("Version 2.3.0");
  });

  it("fills in PDF options missing from what's stored", async () => {
    await loadOptionsPage({
      pdf: { fontSize: 12 } as Settings["pdf"],
    });

    expect(byId<HTMLInputElement>("pdfFontSize").value).toBe("12");
    expect(byId<HTMLInputElement>("pdfMarginTop").value).toBe(
      String(DEFAULT_PDF_SETTINGS.marginTop),
    );
    expect(byId<HTMLInputElement>("pdfUserInfoText").value).toBe("");
  });

  describe("auto-save", () => {
    it("saves a switch as soon as it's flipped", async () => {
      await loadOptionsPage();

      byId<HTMLInputElement>("includeTimestamp").click();
      await vi.advanceTimersByTimeAsync(300);

      expect(storageSet).toHaveBeenCalledTimes(1);
      expect(savedSettings().includeTimestamp).toBe(true);
      expect(byId("toast").classList.contains("is-visible")).toBe(true);
      expect(byId("toast-text").textContent).toBe(en["options.saved"]);
    });

    it("turns note properties for Markdown files off and on", async () => {
      await loadOptionsPage();

      const toggle = byId<HTMLInputElement>("markdownProperties");

      expect(toggle.checked).toBe(true);
      expect(byId("markdownProperties-desc").textContent?.trim()).toBe(
        en["options.properties.desc"],
      );

      toggle.click();
      await vi.advanceTimersByTimeAsync(300);

      expect(savedSettings().markdownProperties).toBe(false);
    });

    it("merges a burst of clicks into one write", async () => {
      await loadOptionsPage();

      const plus = setting("options.fontSize.help").querySelector<HTMLElement>(
        '.stepper-button[data-step="1"]',
      )!;

      plus.click();
      plus.click();
      plus.click();
      await vi.advanceTimersByTimeAsync(300);

      expect(storageSet).toHaveBeenCalledTimes(1);
      expect(savedSettings().pdf.fontSize).toBe(DEFAULT_PDF_SETTINGS.fontSize + 3);
    });

    it("waits for a pause in typing before saving text", async () => {
      await loadOptionsPage({
        pdf: { ...DEFAULT_PDF_SETTINGS, includeUserInfo: true },
      });

      typeInto(byId("pdfUserInfoText"), "Prepared by Grandma");
      await vi.advanceTimersByTimeAsync(500);

      expect(storageSet).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(400);

      expect(storageSet).toHaveBeenCalledTimes(1);
      expect(savedSettings().pdf.userInfoText).toBe("Prepared by Grandma");
    });

    it("saves right away when the page is closed mid-typing", async () => {
      await loadOptionsPage();

      typeInto(byId("pdfUserInfoText"), "Confidential");
      window.dispatchEvent(new Event("pagehide"));
      await vi.advanceTimersByTimeAsync(0);

      expect(storageSet).toHaveBeenCalledTimes(1);
      expect(savedSettings().pdf.userInfoText).toBe("Confidential");
    });

    it("doesn't write again when nothing changed", async () => {
      await loadOptionsPage();

      byId("includeTimestamp").dispatchEvent(
        new Event("change", { bubbles: true }),
      );
      await vi.advanceTimersByTimeAsync(300);

      expect(storageSet).not.toHaveBeenCalled();
    });

    it("says so when saving fails", async () => {
      await loadOptionsPage();
      storageSet.mockRejectedValueOnce(new Error("QUOTA_BYTES quota exceeded"));

      byId<HTMLInputElement>("askWhereToSave").click();
      await vi.advanceTimersByTimeAsync(300);

      expect(byId("toast").dataset.tone).toBe("error");
      expect(byId("toast-text").textContent).toBe(en["options.saveFailed"]);

      // The next change still gets saved
      byId<HTMLInputElement>("includeTimestamp").click();
      await vi.advanceTimersByTimeAsync(300);

      expect(savedSettings().askWhereToSave).toBe(false);
      expect(savedSettings().includeTimestamp).toBe(true);
    });
  });

  describe("number fields", () => {
    it("keeps a typed number within the field's range", async () => {
      await loadOptionsPage();

      const fontSize = byId<HTMLInputElement>("pdfFontSize");

      commit(fontSize, "99");
      await vi.advanceTimersByTimeAsync(300);

      expect(fontSize.value).toBe("24");
      expect(savedSettings().pdf.fontSize).toBe(24);
    });

    it("goes back to the saved value when a field is cleared", async () => {
      await loadOptionsPage({
        pdf: { ...DEFAULT_PDF_SETTINGS, marginLeft: 25 },
      });

      const marginLeft = byId<HTMLInputElement>("pdfMarginLeft");

      commit(marginLeft, "");

      expect(marginLeft.value).toBe("25");
    });

    it("disables - at the minimum and + at the maximum", async () => {
      await loadOptionsPage();

      const fontSize = byId<HTMLInputElement>("pdfFontSize");
      const [minus, plus] = Array.from(
        setting("options.fontSize.help").querySelectorAll<HTMLButtonElement>(
          ".stepper-button",
        ),
      );

      typeInto(fontSize, "6");
      expect(minus.disabled).toBe(true);
      expect(plus.disabled).toBe(false);

      typeInto(fontSize, "24");
      expect(minus.disabled).toBe(false);
      expect(plus.disabled).toBe(true);
    });

    it("draws the margins preview for the chosen page direction", async () => {
      await loadOptionsPage();

      const preview = byId("page-preview");

      expect(parseFloat(preview.style.height)).toBeGreaterThan(
        parseFloat(preview.style.width),
      );

      document
        .querySelector<HTMLInputElement>(
          'input[name="pdfOrientation"][value="landscape"]',
        )!
        .click();

      expect(parseFloat(preview.style.width)).toBeGreaterThan(
        parseFloat(preview.style.height),
      );
    });
  });

  it("shows the footer text box only while its switch is on", async () => {
    await loadOptionsPage();

    const toggle = byId<HTMLInputElement>("pdfIncludeUserInfo");
    const row = byId("pdfUserInfoTextRow");

    expect(row.hidden).toBe(true);

    toggle.click();
    expect(row.hidden).toBe(false);

    toggle.click();
    expect(row.hidden).toBe(true);
  });

  describe("search", () => {
    function search(query: string): void {
      typeInto(byId("search"), query);
    }

    it("keeps only the settings that match every word", async () => {
      await loadOptionsPage();

      search("page numbers");

      expect(
        setting("options.pageNumbers.help").classList.contains("is-filtered"),
      ).toBe(false);
      expect(
        setting("options.language.help").classList.contains("is-filtered"),
      ).toBe(true);
      expect(byId("general").classList.contains("is-filtered")).toBe(true);
      expect(
        document
          .querySelector('.nav-link[href="#general"]')
          ?.classList.contains("is-dimmed"),
      ).toBe(true);
      expect(byId("search-empty").hidden).toBe(true);
    });

    it("ignores case and accents", async () => {
      await loadOptionsPage();

      search("PÁGE NÚMBERS");

      expect(
        setting("options.pageNumbers.help").classList.contains("is-filtered"),
      ).toBe(false);
    });

    it("keeps a whole section when its name matches", async () => {
      await loadOptionsPage();

      search("saving files");

      expect(
        setting("options.downloadFolder.help").classList.contains(
          "is-filtered",
        ),
      ).toBe(false);
      expect(
        setting("options.askWhereToSave.help").classList.contains(
          "is-filtered",
        ),
      ).toBe(false);
    });

    it("offers a way back when nothing matches", async () => {
      await loadOptionsPage();

      search("zzzz");

      expect(byId("search-empty").hidden).toBe(false);
      expect(byId("search-empty-text").textContent).toContain("zzzz");

      byId("search-clear").click();

      expect(byId<HTMLInputElement>("search").value).toBe("");
      expect(byId("search-empty").hidden).toBe(true);
      expect(document.querySelectorAll(".is-filtered")).toHaveLength(0);
    });
  });

  describe("help tooltips", () => {
    it("opens the help and tip for a setting from its ? button", async () => {
      await loadOptionsPage();

      const button = setting("options.images.help").querySelector<HTMLElement>(
        ".help-button",
      )!;

      button.click();

      expect(byId("tooltip").hidden).toBe(false);
      expect(byId("tooltip-text").textContent).toBe(en["options.images.help"]);
      expect(byId("tooltip-tip-text").textContent).toBe(
        en["options.images.tip"],
      );
      expect(button.getAttribute("aria-expanded")).toBe("true");
      expect(button.getAttribute("aria-describedby")).toBe("tooltip");

      button.click();

      expect(byId("tooltip").hidden).toBe(true);
      expect(button.getAttribute("aria-expanded")).toBe("false");
    });

    it("closes with Escape", async () => {
      await loadOptionsPage();

      setting("options.margins.help")
        .querySelector<HTMLElement>(".help-button")!
        .click();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

      expect(byId("tooltip").hidden).toBe(true);
    });

    it("gives every setting a help text and a tip", async () => {
      await loadOptionsPage();

      const settings = document.querySelectorAll<HTMLElement>(".setting");

      expect(settings.length).toBeGreaterThan(0);

      for (const row of settings) {
        expect(en).toHaveProperty([row.dataset.help!]);
        expect(en).toHaveProperty([row.dataset.tip!]);
        expect(row.querySelector(".help-button")).not.toBeNull();
      }
    });
  });

  it("switches the page to a new language at once and saves it", async () => {
    await loadOptionsPage();

    const language = byId<HTMLSelectElement>("language");

    language.value = "de";
    language.dispatchEvent(new Event("change", { bubbles: true }));

    await vi.waitFor(() => {
      expect(document.documentElement.lang).toBe("de");
    });

    expect(savedSettings().language).toBe("de");
    expect(document.querySelector("h1")?.textContent).toBe(de["options.title"]);
    expect(byId("toast-text").textContent).toBe(de["options.saved"]);
  });

  describe("restore defaults", () => {
    const customized: Partial<Settings> = {
      language: "de",
      theme: "dark",
      includeTimestamp: true,
      pdf: { ...DEFAULT_PDF_SETTINGS, fontSize: 18 },
    };

    it("asks first and does nothing on Cancel", async () => {
      await loadOptionsPage(customized);

      byId("reset-defaults").click();

      expect(byId("reset-confirm").hidden).toBe(false);
      expect(byId("reset-defaults").hidden).toBe(true);

      byId("reset-cancel").click();

      expect(byId("reset-confirm").hidden).toBe(true);
      expect(byId("reset-defaults").hidden).toBe(false);
      expect(storageSet).not.toHaveBeenCalled();
    });

    it("puts every setting back, language included", async () => {
      await loadOptionsPage(customized);

      expect(document.documentElement.lang).toBe("de");

      byId("reset-defaults").click();
      byId("reset-yes").click();

      await vi.waitFor(() => {
        expect(document.documentElement.lang).toBe("en");
      });

      expect(savedSettings()).toEqual(DEFAULT_SETTINGS);
      expect(document.documentElement.dataset.theme).toBeUndefined();
      expect(byId<HTMLInputElement>("pdfFontSize").value).toBe(
        String(DEFAULT_PDF_SETTINGS.fontSize),
      );
      expect(byId("toast-text").textContent).toBe(en["options.reset.done"]);
    });
  });

  it("shows who GitHub is connected as", async () => {
    githubStatus = { connected: true, login: "octocat" };

    await loadOptionsPage();

    await vi.waitFor(() => {
      expect(byId("github-status").textContent).toBe("Connected as octocat");
    });

    expect(byId("github-connect").hidden).toBe(true);
    expect(byId("github-disconnect").hidden).toBe(false);
  });

  it("uses only translation keys that exist", () => {
    const keys = [
      ...OPTIONS_HTML.matchAll(/data-(?:i18n(?:-[a-z-]+)?|help|tip)="([^"]+)"/g),
    ].map((match) => match[1]);

    expect(keys.length).toBeGreaterThan(0);

    for (const key of keys) {
      expect(en).toHaveProperty([key]);
    }
  });
});
