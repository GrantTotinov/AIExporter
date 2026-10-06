/*
 * =========================================================
 * AI Exporter - i18n.ts
 * =========================================================
 *
 * Small, dependency-free translation layer for the extension's
 * UI. English is the source of truth and the fallback for any
 * key missing from another language - dictionaries only need
 * to cover what's actually translated, so adding a new
 * language (or filling one in gradually) never breaks the UI.
 *
 * Chrome's own chrome.i18n/_locales mechanism was intentionally
 * NOT used here: it picks a locale from the browser's UI
 * language with no way for the person to override it from
 * within the extension itself. This module instead reads a
 * `language` preference from Settings (see settings.ts),
 * defaulting to "auto" (browser language, detected once via
 * chrome.i18n.getUILanguage()/navigator.language), so the
 * options page can offer an explicit language switcher.
 *
 * Adding a new language:
 *   1. Copy src/locales/en.json to src/locales/<code>.json and
 *      translate the values (keys must stay identical).
 *   2. Import it below and add it to DICTIONARIES and
 *      SUPPORTED_LOCALES.
 *   3. Add an <option> for it in the options.html language
 *      select (or render SUPPORTED_LOCALES there dynamically).
 */
import en from "./locales/en.json";
import es from "./locales/es.json";
import fr from "./locales/fr.json";
import de from "./locales/de.json";
import ru from "./locales/ru.json";
import zh from "./locales/zh.json";
import ja from "./locales/ja.json";
import ko from "./locales/ko.json";
import hi from "./locales/hi.json";
import pt from "./locales/pt.json";
import id from "./locales/id.json";
import tr from "./locales/tr.json";
import it from "./locales/it.json";
import { loadSettings } from "./settings.ts";

export type Locale =
  | "en"
  | "es"
  | "fr"
  | "de"
  | "ru"
  | "zh"
  | "ja"
  | "ko"
  | "hi"
  | "pt"
  | "id"
  | "tr"
  | "it";

const DICTIONARIES: Record<Locale, Record<string, string>> = {
  en,
  es,
  fr,
  de,
  ru,
  zh,
  ja,
  ko,
  hi,
  pt,
  id,
  tr,
  it,
};

export const SUPPORTED_LOCALES: { code: Locale; label: string }[] = [
  { code: "en", label: "English" },
  { code: "es", label: "Español" },
  { code: "fr", label: "Français" },
  { code: "de", label: "Deutsch" },
  { code: "ru", label: "Русский" },
  { code: "zh", label: "中文" },
  { code: "ja", label: "日本語" },
  { code: "ko", label: "한국어" },
  { code: "hi", label: "हिन्दी" },
  { code: "pt", label: "Português (Brasil)" },
  { code: "id", label: "Bahasa Indonesia" },
  { code: "tr", label: "Türkçe" },
  { code: "it", label: "Italiano" },
];

let currentLocale: Locale = "en";

function isSupportedLocale(value: string): value is Locale {
  return Object.prototype.hasOwnProperty.call(DICTIONARIES, value);
}

/*
 * Tries chrome.i18n.getUILanguage() first (available in every
 * extension context, including the background service worker,
 * where `navigator` is more limited), then falls back to
 * navigator.language/navigator.languages. Only the language
 * subtag (e.g. "pt" from "pt-BR") is matched against the
 * dictionaries we actually ship.
 */
function detectBrowserLocale(): Locale {
  const candidates: string[] = [];

  try {
    const uiLanguage = chrome?.i18n?.getUILanguage?.();

    if (uiLanguage) {
      candidates.push(uiLanguage);
    }
  } catch {
    /* chrome.i18n unavailable in this context - ignore */
  }

  if (typeof navigator !== "undefined") {
    if (navigator.language) {
      candidates.push(navigator.language);
    }

    if (navigator.languages) {
      candidates.push(...navigator.languages);
    }
  }

  for (const candidate of candidates) {
    const short = candidate.slice(0, 2).toLowerCase();

    if (isSupportedLocale(short)) {
      return short;
    }
  }

  return "en";
}

export function getLocale(): Locale {
  return currentLocale;
}

export function setLocale(locale: string): void {
  currentLocale = isSupportedLocale(locale) ? locale : "en";
}

/*
 * Reads the stored `language` preference and resolves it to an
 * actual Locale, resolving "auto" via detectBrowserLocale().
 * Should be called once per page (popup.ts/options.ts) before
 * the first render, and once in background.ts before it needs
 * to translate anything (e.g. github.ts error messages).
 */
export async function initI18n(): Promise<Locale> {
  const settings = await loadSettings();
  const preference = settings.language ?? "auto";

  setLocale(preference === "auto" ? detectBrowserLocale() : preference);

  return currentLocale;
}

/*
 * Looks up `key` in the current locale, falling back to
 * English, then to the raw key itself (so a missing
 * translation is visibly wrong rather than silently blank).
 * `vars` fills in `{{name}}` placeholders, e.g.
 * t("popup.selector.count", { checked: 2, total: 5 }).
 */
export function t(key: string, vars?: Record<string, string | number>): string {
  const template =
    DICTIONARIES[currentLocale]?.[key] ?? DICTIONARIES.en[key] ?? key;

  if (!vars) {
    return template;
  }

  return Object.entries(vars).reduce(
    (result, [name, value]) => result.replaceAll(`{{${name}}}`, String(value)),
    template,
  );
}

/*
 * Walks `root` for elements tagged with data-i18n* attributes
 * and fills them in from the current locale. Call this once
 * after initI18n() on any page that renders translated static
 * markup (popup.html, options.html), and again on any subtree
 * inserted dynamically after that (there are none currently,
 * but this keeps the pattern reusable).
 *
 * Supported attributes:
 *   data-i18n              -> element.textContent
 *   data-i18n-html         -> element.innerHTML (only for
 *                              strings that intentionally
 *                              contain markup, e.g. a link)
 *   data-i18n-placeholder  -> placeholder attribute
 *   data-i18n-aria-label   -> aria-label attribute
 *   data-i18n-title        -> title attribute
 */
export function applyTranslations(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
    const key = el.dataset.i18n;

    if (key) {
      el.textContent = t(key);
    }
  });

  root.querySelectorAll<HTMLElement>("[data-i18n-html]").forEach((el) => {
    const key = el.dataset.i18nHtml;

    if (key) {
      el.innerHTML = t(key);
    }
  });

  root
    .querySelectorAll<HTMLElement>("[data-i18n-placeholder]")
    .forEach((el) => {
      const key = el.dataset.i18nPlaceholder;

      if (key) {
        el.setAttribute("placeholder", t(key));
      }
    });

  root.querySelectorAll<HTMLElement>("[data-i18n-aria-label]").forEach((el) => {
    const key = el.dataset.i18nAriaLabel;

    if (key) {
      el.setAttribute("aria-label", t(key));
    }
  });

  root.querySelectorAll<HTMLElement>("[data-i18n-title]").forEach((el) => {
    const key = el.dataset.i18nTitle;

    if (key) {
      el.setAttribute("title", t(key));
    }
  });

  if (root === document) {
    document.documentElement.lang = currentLocale;
  }
}
