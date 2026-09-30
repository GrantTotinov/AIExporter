// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../src/locales/en.json";

const storageGet = vi.fn();

describe("i18n", () => {
  let i18n: typeof import("../src/i18n");

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    vi.stubGlobal("chrome", {
      storage: {
        sync: {
          get: storageGet,
        },
      },
      i18n: {
        getUILanguage: vi.fn(() => "en-US"),
      },
    });

    i18n = await import("../src/i18n");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults to English", () => {
    expect(i18n.getLocale()).toBe("en");
  });

  it("sets a supported locale", () => {
    i18n.setLocale("fr");
    expect(i18n.getLocale()).toBe("fr");
  });

  it("falls back to English for an unsupported locale", () => {
    i18n.setLocale("xx");
    expect(i18n.getLocale()).toBe("en");
  });

  it("lists all supported locales", () => {
    const codes = i18n.SUPPORTED_LOCALES.map((locale) => locale.code);
    expect(codes).toEqual(["en", "es", "fr", "de", "ru", "zh"]);
  });

  it("translates a known key", () => {
    i18n.setLocale("en");
    expect(i18n.t("popup.copy")).toBe(en["popup.copy"]);
  });

  it("falls back to English when a key is missing from the active locale", () => {
    i18n.setLocale("fr");
    expect(i18n.t("popup.copy")).toBeTruthy();
  });

  it("falls back to the raw key when missing everywhere", () => {
    expect(i18n.t("does.not.exist")).toBe("does.not.exist");
  });

  it("substitutes {{placeholders}} with provided variables", () => {
    i18n.setLocale("en");
    const result = i18n.t("popup.selector.count", { checked: 2, total: 5 });
    expect(result).not.toContain("{{checked}}");
    expect(result).not.toContain("{{total}}");
  });

  it("initializes locale from stored settings", async () => {
    storageGet.mockResolvedValue({ language: "de" });

    const locale = await i18n.initI18n();

    expect(locale).toBe("de");
    expect(i18n.getLocale()).toBe("de");
  });

  it("resolves 'auto' via the detected browser locale", async () => {
    storageGet.mockResolvedValue({ language: "auto" });

    const locale = await i18n.initI18n();

    expect(locale).toBe("en");
  });

  describe("applyTranslations", () => {
    it("fills text content, attributes and innerHTML from data-i18n* attributes", () => {
      i18n.setLocale("en");

      document.body.innerHTML = `
        <div>
          <span data-i18n="popup.copy"></span>
          <input data-i18n-placeholder="popup.copy" />
          <button data-i18n-aria-label="popup.copy"></button>
          <div data-i18n-title="popup.copy"></div>
          <div data-i18n-html="popup.copy"></div>
        </div>
      `;

      i18n.applyTranslations(document);

      expect(document.querySelector("span")?.textContent).toBe(en["popup.copy"]);
      expect(document.querySelector("input")?.getAttribute("placeholder")).toBe(
        en["popup.copy"],
      );
      expect(document.querySelector("button")?.getAttribute("aria-label")).toBe(
        en["popup.copy"],
      );
      expect(document.querySelector("[data-i18n-title]")?.getAttribute("title")).toBe(
        en["popup.copy"],
      );
      expect(document.querySelector("[data-i18n-html]")?.innerHTML).toBe(
        en["popup.copy"],
      );
      expect(document.documentElement.lang).toBe("en");
    });

    it("only translates elements within the given root", () => {
      i18n.setLocale("en");

      document.body.innerHTML = `
        <div id="root"><span data-i18n="popup.copy"></span></div>
        <span id="outside" data-i18n="popup.copy"></span>
      `;

      const root = document.getElementById("root")!;
      i18n.applyTranslations(root);

      expect(root.querySelector("span")?.textContent).toBe(en["popup.copy"]);
      expect(document.getElementById("outside")?.textContent).toBe("");
    });
  });
});
