import {
  type Settings,
  type PdfSettings,
  DEFAULT_SETTINGS,
  DEFAULT_PDF_SETTINGS,
  loadSettings,
  saveSettings,
} from "./settings.ts";
import { initI18n, applyTranslations, t } from "./i18n.ts";

const devError = (...args: unknown[]): void => {
  if (import.meta.env.DEV) {
    console.error(...args);
  }
};

/*
 * Every change saves on its own - there's no Save button to
 * forget. Typing waits for a pause first; anything else
 * (switches, choices, the + and - buttons) saves almost at
 * once, the short delay only merging a burst of clicks into
 * one write. Both keep well inside chrome.storage.sync's
 * limit of 120 writes a minute.
 */
const TYPING_SAVE_DELAY_MS = 800;
const CHANGE_SAVE_DELAY_MS = 250;

const TOOLTIP_SHOW_DELAY_MS = 350;
const TOOLTIP_HIDE_DELAY_MS = 150;

/*
 * How far below the top of the window a section counts as
 * "current". Kept smaller than the shortest section, so the
 * link just clicked is the one that lights up.
 */
const NAV_ACTIVE_OFFSET_PX = 180;

/* Portrait paper sizes in millimeters, for the margins preview */
const PAPER_SIZES_MM: Record<PdfSettings["pageFormat"], [number, number]> = {
  a4: [210, 297],
  letter: [215.9, 279.4],
  legal: [215.9, 355.6],
};

/* Length of the preview page's longer side, in pixels */
const PREVIEW_PAGE_PX = 160;

const settingsRoot = document.getElementById("settings") as HTMLElement;

const languageInput = document.getElementById("language") as HTMLSelectElement;

const askWhereToSaveInput = document.getElementById(
  "askWhereToSave",
) as HTMLInputElement;

const downloadImagesLocallyInput = document.getElementById(
  "downloadImagesLocally",
) as HTMLInputElement;

const includeTimestampInput = document.getElementById(
  "includeTimestamp",
) as HTMLInputElement;

const markdownPropertiesInput = document.getElementById(
  "markdownProperties",
) as HTMLInputElement;

const pdfFontSizeInput = document.getElementById(
  "pdfFontSize",
) as HTMLInputElement;
const pdfMarginTopInput = document.getElementById(
  "pdfMarginTop",
) as HTMLInputElement;
const pdfMarginRightInput = document.getElementById(
  "pdfMarginRight",
) as HTMLInputElement;
const pdfMarginBottomInput = document.getElementById(
  "pdfMarginBottom",
) as HTMLInputElement;
const pdfMarginLeftInput = document.getElementById(
  "pdfMarginLeft",
) as HTMLInputElement;
const pdfIncludeTableOfContentsInput = document.getElementById(
  "pdfIncludeTableOfContents",
) as HTMLInputElement;
const pdfIncludePageNumbersInput = document.getElementById(
  "pdfIncludePageNumbers",
) as HTMLInputElement;
const pdfIncludeUserInfoInput = document.getElementById(
  "pdfIncludeUserInfo",
) as HTMLInputElement;
const pdfUserInfoTextRow = document.getElementById(
  "pdfUserInfoTextRow",
) as HTMLDivElement;
const pdfUserInfoTextInput = document.getElementById(
  "pdfUserInfoText",
) as HTMLInputElement;

const pagePreview = document.getElementById("page-preview") as HTMLDivElement;

const steppers = Array.from(
  settingsRoot.querySelectorAll<HTMLElement>(".stepper"),
);

const openDownloadSettingsButton = document.getElementById(
  "open-download-settings",
) as HTMLButtonElement;

const searchInput = document.getElementById("search") as HTMLInputElement;

const searchEmpty = document.getElementById("search-empty") as HTMLDivElement;

const searchEmptyText = document.getElementById(
  "search-empty-text",
) as HTMLParagraphElement;

const searchClearButton = document.getElementById(
  "search-clear",
) as HTMLButtonElement;

const navLinks = Array.from(
  document.querySelectorAll<HTMLAnchorElement>(".nav-link"),
);

const sections = Array.from(
  settingsRoot.querySelectorAll<HTMLElement>("section.card"),
);

const tooltip = document.getElementById("tooltip") as HTMLDivElement;

const tooltipText = document.getElementById(
  "tooltip-text",
) as HTMLParagraphElement;

const tooltipTip = document.getElementById(
  "tooltip-tip",
) as HTMLParagraphElement;

const tooltipTipText = document.getElementById(
  "tooltip-tip-text",
) as HTMLSpanElement;

const toast = document.getElementById("toast") as HTMLDivElement;

const toastText = document.getElementById("toast-text") as HTMLSpanElement;

const resetButton = document.getElementById(
  "reset-defaults",
) as HTMLButtonElement;

const resetConfirm = document.getElementById("reset-confirm") as HTMLDivElement;

const resetYesButton = document.getElementById(
  "reset-yes",
) as HTMLButtonElement;

const resetCancelButton = document.getElementById(
  "reset-cancel",
) as HTMLButtonElement;

const versionLabel = document.getElementById("app-version") as HTMLSpanElement;

const githubStatusLabel = document.getElementById(
  "github-status",
) as HTMLSpanElement;

const githubConnectButton = document.getElementById(
  "github-connect",
) as HTMLButtonElement;

const githubConnectLabel = document.getElementById(
  "github-connect-label",
) as HTMLSpanElement;

const githubDisconnectButton = document.getElementById(
  "github-disconnect",
) as HTMLButtonElement;

const githubOverlay = document.getElementById(
  "github-overlay",
) as HTMLDivElement;

const githubOverlayCode = document.getElementById(
  "github-overlay-code",
) as HTMLParagraphElement;

const githubOverlayError = document.getElementById(
  "github-overlay-error",
) as HTMLParagraphElement;

const githubOverlaySpinner = document.getElementById(
  "github-overlay-spinner",
) as HTMLDivElement;

const githubOverlayCancelButton = document.getElementById(
  "github-overlay-cancel",
) as HTMLButtonElement;

function applyTheme(theme: Settings["theme"]): void {
  if (theme === "system") {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = theme;
  }
}

function getRadioValue<T extends string>(name: string, fallback: T): T {
  const checked = document.querySelector<HTMLInputElement>(
    `input[name="${name}"]:checked`,
  );

  return (checked?.value as T) ?? fallback;
}

function setRadioValue(name: string, value: string): void {
  const input = document.querySelector<HTMLInputElement>(
    `input[name="${name}"][value="${value}"]`,
  );

  if (input) {
    input.checked = true;
  }
}

/*
 * ---------------------------------------------------------
 * FORM <-> SETTINGS
 * ---------------------------------------------------------
 */

/*
 * The settings as last written to storage. A number field
 * falls back to its saved value while it's empty or holds
 * something that isn't a number, and a form that hasn't
 * changed since the last write isn't written again.
 */
let savedSettings: Settings = DEFAULT_SETTINGS;
let savedJson = JSON.stringify(DEFAULT_SETTINGS);

/*
 * Fills in anything missing from what's stored (such as a PDF
 * option added after the person last saved), so every field
 * on the page starts from a real value.
 */
function withDefaults(settings: Settings): Settings {
  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    pdf: { ...DEFAULT_PDF_SETTINGS, ...settings.pdf },
  };
}

/* Reads a number field, kept within the field's own min/max */
function readNumber(input: HTMLInputElement, fallback: number): number {
  const value = Number(input.value);

  if (input.value.trim() === "" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(Number(input.max), Math.max(Number(input.min), value));
}

function readPdfSettingsFromForm(): PdfSettings {
  const saved = savedSettings.pdf;

  return {
    pageFormat: getRadioValue("pdfPageFormat", saved.pageFormat),
    orientation: getRadioValue("pdfOrientation", saved.orientation),
    marginTop: readNumber(pdfMarginTopInput, saved.marginTop),
    marginRight: readNumber(pdfMarginRightInput, saved.marginRight),
    marginBottom: readNumber(pdfMarginBottomInput, saved.marginBottom),
    marginLeft: readNumber(pdfMarginLeftInput, saved.marginLeft),
    fontSize: readNumber(pdfFontSizeInput, saved.fontSize),
    includeTableOfContents: pdfIncludeTableOfContentsInput.checked,
    includePageNumbers: pdfIncludePageNumbersInput.checked,
    includeUserInfo: pdfIncludeUserInfoInput.checked,
    userInfoText: pdfUserInfoTextInput.value,
  };
}

function readSettingsFromForm(): Settings {
  return {
    headingStyle: getRadioValue("headingStyle", savedSettings.headingStyle),
    messageSeparator: getRadioValue(
      "messageSeparator",
      savedSettings.messageSeparator,
    ),
    includeTimestamp: includeTimestampInput.checked,
    markdownProperties: markdownPropertiesInput.checked,
    askWhereToSave: askWhereToSaveInput.checked,
    downloadImagesLocally: downloadImagesLocallyInput.checked,
    theme: getRadioValue("theme", savedSettings.theme),
    language: languageInput.value as Settings["language"],
    pdf: readPdfSettingsFromForm(),
  };
}

function applyPdfNumbersToForm(pdf: PdfSettings): void {
  pdfFontSizeInput.value = String(pdf.fontSize);
  pdfMarginTopInput.value = String(pdf.marginTop);
  pdfMarginRightInput.value = String(pdf.marginRight);
  pdfMarginBottomInput.value = String(pdf.marginBottom);
  pdfMarginLeftInput.value = String(pdf.marginLeft);
}

function applySettingsToForm(settings: Settings): void {
  setRadioValue("theme", settings.theme);
  applyTheme(settings.theme);

  languageInput.value = settings.language;

  askWhereToSaveInput.checked = settings.askWhereToSave;
  downloadImagesLocallyInput.checked = settings.downloadImagesLocally;
  includeTimestampInput.checked = settings.includeTimestamp;
  markdownPropertiesInput.checked = settings.markdownProperties;

  setRadioValue("headingStyle", settings.headingStyle);
  setRadioValue("messageSeparator", settings.messageSeparator);

  setRadioValue("pdfPageFormat", settings.pdf.pageFormat);
  setRadioValue("pdfOrientation", settings.pdf.orientation);
  applyPdfNumbersToForm(settings.pdf);
  pdfIncludeTableOfContentsInput.checked = settings.pdf.includeTableOfContents;
  pdfIncludePageNumbersInput.checked = settings.pdf.includePageNumbers;
  pdfIncludeUserInfoInput.checked = settings.pdf.includeUserInfo;
  pdfUserInfoTextInput.value = settings.pdf.userInfoText;

  updateFooterTextRow();
  updateDependentControls();
}

/*
 * ---------------------------------------------------------
 * AUTO-SAVE
 * ---------------------------------------------------------
 */

let saveTimer: number | undefined;

/*
 * Writes the form to storage right away (cancelling any
 * pending delayed save) and, unless `announce` is false, says
 * so with a toast. Resolves to false if the write failed,
 * which is always shown as a toast.
 */
async function saveNow({ announce = true } = {}): Promise<boolean> {
  window.clearTimeout(saveTimer);
  saveTimer = undefined;

  const settings = readSettingsFromForm();
  const json = JSON.stringify(settings);

  if (json === savedJson) {
    return true;
  }

  const previousJson = savedJson;
  savedJson = json;

  try {
    await saveSettings(settings);
  } catch (error) {
    devError("AI Exporter: saving settings failed", error);
    savedJson = previousJson;
    showToast(t("options.saveFailed"), "error");
    return false;
  }

  savedSettings = settings;

  if (announce) {
    showToast(t("options.saved"));
  }

  return true;
}

function scheduleSave(delay: number): void {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void saveNow(), delay);
}

/*
 * Closing the tab mid-typing would otherwise drop the last
 * few keystrokes still waiting for their delayed save.
 */
function flushPendingSave(): void {
  if (saveTimer !== undefined) {
    void saveNow();
  }
}

window.addEventListener("pagehide", flushPendingSave);

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    flushPendingSave();
  }
});

settingsRoot.addEventListener("input", (event) => {
  const target = event.target;

  if (!(target instanceof HTMLInputElement)) {
    return;
  }

  if (target.type === "number") {
    updateDependentControls();
  }

  if (target.type === "number" || target.type === "text") {
    scheduleSave(TYPING_SAVE_DELAY_MS);
  }
});

settingsRoot.addEventListener("change", (event) => {
  const target = event.target;

  if (target === languageInput) {
    void changeLanguage();
    return;
  }

  if (!(target instanceof HTMLInputElement)) {
    return;
  }

  if (target.type === "number") {
    // Show the value that will actually be used: clamped to
    // the field's range, or back to the saved one if cleared.
    applyPdfNumbersToForm(readPdfSettingsFromForm());
  }

  if (target.name === "theme") {
    applyTheme(target.value as Settings["theme"]);
  }

  if (target === pdfIncludeUserInfoInput) {
    updateFooterTextRow();

    if (target.checked && pdfUserInfoTextInput.value === "") {
      pdfUserInfoTextInput.focus();
    }
  }

  updateDependentControls();
  scheduleSave(CHANGE_SAVE_DELAY_MS);
});

/*
 * Applies a newly chosen language to this page right away.
 * It's saved first because initI18n() reads the preference
 * back from storage (resolving "auto" to the browser's own
 * language along the way); the "Saved" toast waits until the
 * page has switched, so it comes up in the new language.
 */
async function changeLanguage(): Promise<void> {
  if (await saveNow({ announce: false })) {
    await initI18n();
    renderTranslations();
    showToast(t("options.saved"));
  }
}

/*
 * Everything on the page that isn't plain data-i18n markup:
 * text built from variables, and state-dependent labels.
 */
function renderTranslations(): void {
  applyTranslations();
  document.title = t("options.title");
  versionLabel.textContent = t("options.about.version", {
    version: chrome.runtime.getManifest().version,
  });
  renderGithub();
  applySearch();
}

/*
 * ---------------------------------------------------------
 * DEPENDENT CONTROLS (footer text, steppers, page preview)
 * ---------------------------------------------------------
 */

/* The footer text box only matters while its switch is on */
function updateFooterTextRow(): void {
  pdfUserInfoTextRow.hidden = !pdfIncludeUserInfoInput.checked;
}

function updateDependentControls(): void {
  updateSteppers();
  updatePagePreview();
}

function stepperParts(stepper: HTMLElement): {
  input: HTMLInputElement;
  buttons: HTMLButtonElement[];
} {
  return {
    input: stepper.querySelector("input") as HTMLInputElement,
    buttons: Array.from(
      stepper.querySelectorAll<HTMLButtonElement>(".stepper-button"),
    ),
  };
}

function updateSteppers(): void {
  for (const stepper of steppers) {
    const { input, buttons } = stepperParts(stepper);
    const value = Number(input.value);

    for (const button of buttons) {
      const step = Number(button.dataset.step);

      button.disabled =
        step < 0 ? value <= Number(input.min) : value >= Number(input.max);
    }
  }
}

for (const stepper of steppers) {
  const { input, buttons } = stepperParts(stepper);

  for (const button of buttons) {
    // Keep focus where it was (usually the number itself), so
    // clicking + doesn't pull it onto a button that's hidden
    // from keyboards and screen readers anyway - the field's
    // own arrow keys do the same job there.
    button.addEventListener("mousedown", (event) => event.preventDefault());

    button.addEventListener("click", () => {
      const current = Number(input.value);
      const base =
        input.value.trim() === "" || !Number.isFinite(current)
          ? Number(input.min)
          : current;

      input.value = String(
        Math.min(
          Number(input.max),
          Math.max(Number(input.min), base + Number(button.dataset.step)),
        ),
      );
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }
}

/*
 * Draws the margins preview to scale: the page takes the
 * chosen paper size and direction, and the dashed text area
 * sits in from each edge by that side's margin.
 */
function updatePagePreview(): void {
  const pdf = readPdfSettingsFromForm();
  const [shortSide, longSide] = PAPER_SIZES_MM[pdf.pageFormat];
  const [width, height] =
    pdf.orientation === "landscape"
      ? [longSide, shortSide]
      : [shortSide, longSide];
  const scale = PREVIEW_PAGE_PX / Math.max(width, height);

  pagePreview.style.width = `${(width * scale).toFixed(1)}px`;
  pagePreview.style.height = `${(height * scale).toFixed(1)}px`;

  const margins = {
    top: pdf.marginTop,
    right: pdf.marginRight,
    bottom: pdf.marginBottom,
    left: pdf.marginLeft,
  };

  for (const [side, millimeters] of Object.entries(margins)) {
    pagePreview.style.setProperty(
      `--margin-${side}`,
      `${(millimeters * scale).toFixed(1)}px`,
    );
  }
}

/*
 * ---------------------------------------------------------
 * TOAST
 * ---------------------------------------------------------
 */

let toastTimer: number | undefined;

function showToast(message: string, tone: "success" | "error" = "success"): void {
  toastText.textContent = message;
  toast.dataset.tone = tone;
  toast.classList.add("is-visible");

  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(
    () => toast.classList.remove("is-visible"),
    tone === "error" ? 4000 : 1600,
  );
}

/*
 * ---------------------------------------------------------
 * HELP TOOLTIPS
 * ---------------------------------------------------------
 *
 * Every setting row names a longer explanation and a tip
 * (data-help / data-tip, both translation keys). They open in
 * one shared tooltip when the mouse rests on the row's icon
 * and text, when its ? button gets keyboard focus, or when the
 * ? is clicked or tapped - a click pins the tooltip open so it
 * can be read without holding the mouse still. Escape, a click
 * anywhere else, or clicking the ? again closes it.
 */

let tooltipAnchor: HTMLButtonElement | null = null;
let tooltipPinned = false;
let tooltipTimer: number | undefined;

function scheduleTooltip(action: () => void, delay: number): void {
  window.clearTimeout(tooltipTimer);
  tooltipTimer = window.setTimeout(action, delay);
}

function showTooltip(button: HTMLButtonElement): void {
  window.clearTimeout(tooltipTimer);

  const setting = button.closest<HTMLElement>(".setting");
  const helpKey = setting?.dataset.help;
  const tipKey = setting?.dataset.tip;

  if (!helpKey) {
    return;
  }

  if (tooltipAnchor && tooltipAnchor !== button) {
    releaseTooltipAnchor();
    tooltipPinned = false;
  }

  tooltipText.textContent = t(helpKey);
  tooltipTipText.textContent = tipKey ? t(tipKey) : "";
  tooltipTip.hidden = !tipKey;
  tooltip.hidden = false;

  tooltipAnchor = button;
  button.setAttribute("aria-expanded", "true");
  button.setAttribute("aria-describedby", tooltip.id);

  positionTooltip();
}

function releaseTooltipAnchor(): void {
  tooltipAnchor?.setAttribute("aria-expanded", "false");
  tooltipAnchor?.removeAttribute("aria-describedby");
  tooltipAnchor = null;
}

function hideTooltip(): void {
  window.clearTimeout(tooltipTimer);
  tooltip.hidden = true;
  tooltipPinned = false;
  releaseTooltipAnchor();
}

/*
 * Places the tooltip just under the row's title and
 * description, so it never covers the setting's own text
 * (above the title when there's no room below), kept inside
 * the window, with the arrow lined up with the ? button.
 */
function positionTooltip(): void {
  if (!tooltipAnchor || tooltip.hidden) {
    return;
  }

  const gap = 10;
  const edge = 12;
  const anchor = tooltipAnchor.getBoundingClientRect();
  const text = (
    tooltipAnchor.closest(".setting-text") ?? tooltipAnchor
  ).getBoundingClientRect();
  const anchorCenter = anchor.left + anchor.width / 2;
  const width = tooltip.offsetWidth;
  const height = tooltip.offsetHeight;

  const left = Math.max(
    edge,
    Math.min(anchorCenter - 28, window.innerWidth - width - edge),
  );

  let top = text.bottom + gap;
  let placement = "below";

  if (
    top + height > window.innerHeight - edge &&
    anchor.top - gap - height >= edge
  ) {
    top = anchor.top - gap - height;
    placement = "above";
  }

  tooltip.style.left = `${Math.round(left)}px`;
  tooltip.style.top = `${Math.round(top)}px`;
  tooltip.dataset.placement = placement;
  tooltip.style.setProperty(
    "--arrow-left",
    `${Math.round(anchorCenter - left)}px`,
  );
}

for (const setting of settingsRoot.querySelectorAll<HTMLElement>(
  ".setting[data-help]",
)) {
  const head = setting.querySelector<HTMLElement>(".setting-head");
  const button = setting.querySelector<HTMLButtonElement>(".help-button");

  if (!head || !button) {
    continue;
  }

  button.setAttribute("aria-expanded", "false");

  head.addEventListener("mouseenter", () => {
    if (tooltipPinned) {
      return;
    }

    if (tooltipAnchor === button) {
      window.clearTimeout(tooltipTimer);
      return;
    }

    // Moving straight from one row to the next swaps the
    // tooltip at once instead of waiting all over again.
    scheduleTooltip(
      () => showTooltip(button),
      tooltipAnchor ? 0 : TOOLTIP_SHOW_DELAY_MS,
    );
  });

  head.addEventListener("mouseleave", () => {
    if (!tooltipPinned) {
      scheduleTooltip(hideTooltip, TOOLTIP_HIDE_DELAY_MS);
    }
  });

  button.addEventListener("click", () => {
    if (tooltipPinned && tooltipAnchor === button) {
      hideTooltip();
      return;
    }

    showTooltip(button);
    tooltipPinned = true;
  });

  button.addEventListener("focus", () => {
    if (!tooltipPinned) {
      showTooltip(button);
    }
  });

  button.addEventListener("blur", () => {
    if (tooltipAnchor === button && !tooltip.matches(":hover")) {
      scheduleTooltip(hideTooltip, TOOLTIP_HIDE_DELAY_MS);
    }
  });
}

tooltip.addEventListener("mouseenter", () => {
  window.clearTimeout(tooltipTimer);
});

tooltip.addEventListener("mouseleave", () => {
  if (!tooltipPinned) {
    scheduleTooltip(hideTooltip, TOOLTIP_HIDE_DELAY_MS);
  }
});

document.addEventListener("pointerdown", (event) => {
  const target = event.target as Node;

  if (
    tooltip.hidden ||
    tooltip.contains(target) ||
    tooltipAnchor?.contains(target)
  ) {
    return;
  }

  hideTooltip();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !tooltip.hidden) {
    hideTooltip();
  }
});

window.addEventListener("resize", positionTooltip);

/*
 * ---------------------------------------------------------
 * SEARCH
 * ---------------------------------------------------------
 *
 * Narrows the page down to the settings whose title,
 * description, choices or help text contain every word typed
 * (ignoring case and accents). Matching a section's own name
 * keeps that whole section.
 */

function normalizeForSearch(text: string): string {
  return text.toLocaleLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
}

function containsAll(text: string, words: string[]): boolean {
  return words.every((word) => text.includes(word));
}

function searchableText(setting: HTMLElement): string {
  const { help, tip } = setting.dataset;

  return normalizeForSearch(
    [setting.textContent ?? "", help ? t(help) : "", tip ? t(tip) : ""].join(
      " ",
    ),
  );
}

function applySearch(): void {
  const query = searchInput.value.trim();
  const words = normalizeForSearch(query).split(/\s+/).filter(Boolean);
  let matches = 0;

  hideTooltip();

  for (const section of sections) {
    const header = section.querySelector(".card-header");
    const sectionMatches =
      words.length > 0 &&
      containsAll(normalizeForSearch(header?.textContent ?? ""), words);
    let visibleRows = 0;

    for (const setting of section.querySelectorAll<HTMLElement>(".setting")) {
      const visible =
        words.length === 0 ||
        sectionMatches ||
        containsAll(searchableText(setting), words);

      setting.classList.toggle("is-filtered", !visible);

      if (visible) {
        visibleRows += 1;
      }
    }

    section.classList.toggle("is-filtered", visibleRows === 0);
    matches += visibleRows;
  }

  searchEmpty.hidden = matches > 0;
  searchEmptyText.textContent =
    matches > 0 ? "" : t("options.search.empty", { query });

  updateNav();
}

function clearSearch(): void {
  searchInput.value = "";
  applySearch();
}

searchInput.addEventListener("input", applySearch);

searchInput.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && searchInput.value !== "") {
    clearSearch();
  }
});

searchClearButton.addEventListener("click", () => {
  clearSearch();
  searchInput.focus();
});

/*
 * ---------------------------------------------------------
 * SECTION LINKS
 * ---------------------------------------------------------
 *
 * Highlights the link for the section being read. The links
 * themselves are plain #anchors; CSS smooth-scrolls to them.
 */

let navFrame = 0;

function updateNav(): void {
  const visibleSections = sections.filter(
    (section) => !section.classList.contains("is-filtered"),
  );
  let current = visibleSections[0];

  for (const section of visibleSections) {
    if (section.getBoundingClientRect().top <= NAV_ACTIVE_OFFSET_PX) {
      current = section;
    }
  }

  // The last sections can be too short to ever reach the top,
  // so the very bottom of the page belongs to the last one.
  const scrolledToBottom =
    window.scrollY > 0 &&
    window.innerHeight + window.scrollY >=
      document.documentElement.scrollHeight - 2;

  if (scrolledToBottom && visibleSections.length > 0) {
    current = visibleSections[visibleSections.length - 1];
  }

  for (const link of navLinks) {
    const section = document.getElementById(link.hash.slice(1));
    const isCurrent = section !== null && section === current;
    const wasCurrent = link.getAttribute("aria-current") === "true";

    if (isCurrent) {
      link.setAttribute("aria-current", "true");
    } else {
      link.removeAttribute("aria-current");
    }

    link.classList.toggle(
      "is-dimmed",
      section?.classList.contains("is-filtered") ?? false,
    );

    if (isCurrent && !wasCurrent) {
      revealNavLink(link);
    }
  }
}

/*
 * On narrow screens the links are one sideways-scrolling row;
 * keep the current one in view. (Not scrollIntoView(), which
 * could also scroll the page and cut short a smooth scroll.)
 */
function revealNavLink(link: HTMLAnchorElement): void {
  const nav = link.parentElement;

  if (!nav || nav.scrollWidth <= nav.clientWidth) {
    return;
  }

  nav.scrollTo({
    left: link.offsetLeft - (nav.clientWidth - link.offsetWidth) / 2,
    behavior: "smooth",
  });
}

function requestNavUpdate(): void {
  if (navFrame) {
    return;
  }

  navFrame = requestAnimationFrame(() => {
    navFrame = 0;
    updateNav();
  });
}

window.addEventListener(
  "scroll",
  () => {
    positionTooltip();
    requestNavUpdate();
  },
  { passive: true },
);

window.addEventListener("resize", requestNavUpdate);

/*
 * ---------------------------------------------------------
 * RESTORE DEFAULTS
 * ---------------------------------------------------------
 *
 * Asks first, inline. Restores every setting on this page,
 * language included - the way back for someone who switched
 * to a language they can't read. The GitHub connection isn't
 * a setting and stays as it is.
 */

function closeResetConfirm(): void {
  resetConfirm.hidden = true;
  resetButton.hidden = false;
  resetButton.focus();
}

resetButton.addEventListener("click", () => {
  resetButton.hidden = true;
  resetConfirm.hidden = false;
  resetCancelButton.focus();
});

resetCancelButton.addEventListener("click", closeResetConfirm);

resetYesButton.addEventListener("click", async () => {
  applySettingsToForm(DEFAULT_SETTINGS);
  closeResetConfirm();

  if (await saveNow({ announce: false })) {
    await initI18n();
    renderTranslations();
    showToast(t("options.reset.done"));
  }
});

/*
 * ---------------------------------------------------------
 * DOWNLOADS SETTINGS SHORTCUT
 * ---------------------------------------------------------
 *
 * Opens the browser's own download-location settings page in
 * a new tab. This is a plain navigation shortcut, not a new
 * capability - extensions cannot read or change this setting
 * programmatically (see askWhereToSave in settings.ts for
 * why), so this just saves the person a trip through the
 * browser's own settings menu to find it themselves. Lives
 * here in the options page rather than the popup, since it's
 * a one-time/occasional setup step, not something reached for
 * on every export.
 * chrome://settings/downloads works in Chrome; Firefox uses
 * about:preferences#general (its downloads section lives on
 * the General pane, there is no dedicated downloads:// URL).
 */
openDownloadSettingsButton.addEventListener("click", () => {
  const isFirefox = navigator.userAgent.includes("Firefox");

  const url = isFirefox
    ? "about:preferences#general"
    : "chrome://settings/downloads";

  chrome.tabs.create({ url });
});

/*
 * ---------------------------------------------------------
 * GITHUB CONNECTION
 * ---------------------------------------------------------
 */

type GithubState =
  | { kind: "disconnected" }
  | { kind: "connected"; login: string }
  | { kind: "error"; message: string };

let githubState: GithubState = { kind: "disconnected" };

/* True from clicking Connect until sign-in finishes or is cancelled */
let githubConnecting = false;

function renderGithub(): void {
  const connected = githubState.kind === "connected";

  switch (githubState.kind) {
    case "connected":
      githubStatusLabel.textContent = t("options.github.statusConnected", {
        login: githubState.login,
      });
      break;
    case "error":
      githubStatusLabel.textContent = githubState.message;
      break;
    default:
      githubStatusLabel.textContent = t("options.github.statusDisconnected");
  }

  githubStatusLabel.classList.toggle("is-connected", connected);
  githubStatusLabel.classList.toggle("is-error", githubState.kind === "error");

  githubConnectButton.hidden = connected;
  githubConnectButton.disabled = githubConnecting;
  githubConnectLabel.textContent = t(
    githubConnecting ? "options.github.connecting" : "options.github.connect",
  );
  githubDisconnectButton.hidden = !connected;
}

function setGithubState(state: GithubState, connecting = false): void {
  githubState = state;
  githubConnecting = connecting;
  renderGithub();
}

async function refreshGithubStatus(): Promise<void> {
  try {
    const response = await chrome.runtime.sendMessage({
      type: "GITHUB_GET_STATUS",
    });

    setGithubState(
      response?.success && response.data?.connected
        ? { kind: "connected", login: response.data.login }
        : { kind: "disconnected" },
    );
  } catch (error) {
    devError("AI Exporter: GitHub status check failed", error);
    setGithubState({ kind: "disconnected" });
  }
}

/*
 * -----------------------------------------------------------
 * DEVICE CODE OVERLAY
 * -----------------------------------------------------------
 *
 * This is the one moment in the whole extension that gets a
 * full-screen takeover: the person is about to alt-tab to a
 * GitHub tab, so the code needs to be the single, unmissable
 * thing on screen while they do that.
 */

function openGithubOverlay(userCode: string): void {
  githubOverlayCode.textContent = userCode;
  githubOverlayError.style.display = "none";
  githubOverlaySpinner.style.display = "block";
  githubOverlay.classList.add("open");
}

function closeGithubOverlay(): void {
  githubOverlay.classList.remove("open");
}

function showGithubOverlayError(message: string): void {
  githubOverlayError.textContent = message;
  githubOverlayError.style.display = "block";
  githubOverlaySpinner.style.display = "none";
}

githubOverlayCancelButton.addEventListener("click", () => {
  /*
   * This only dismisses the overlay - it doesn't cancel the
   * poll running in background.ts (there's no GitHub API to
   * cancel a device code once issued anyway; it simply
   * expires on its own after expires_in seconds). If the
   * person does go on to authorize after dismissing, the
   * token is still stored when the poll resolves, and
   * refreshGithubStatus() picks it up the next time this
   * page opens.
   */
  closeGithubOverlay();
  setGithubState(githubState);
});

githubConnectButton.addEventListener("click", async () => {
  setGithubState(githubState, true);

  try {
    const response = await chrome.runtime.sendMessage({
      type: "GITHUB_START_AUTH",
    });

    if (!response?.success) {
      throw new Error(response?.error ?? t("options.error.githubStartFailed"));
    }

    const { userCode, verificationUri } = response.data;

    openGithubOverlay(userCode);

    window.open(verificationUri, "_blank", "noopener,noreferrer");
  } catch (error) {
    devError("AI Exporter: GitHub auth start failed", error);

    setGithubState({
      kind: "error",
      message:
        error instanceof Error
          ? error.message
          : t("options.error.githubStartFailed"),
    });
  }
});

githubDisconnectButton.addEventListener("click", async () => {
  githubDisconnectButton.disabled = true;

  try {
    await chrome.runtime.sendMessage({ type: "GITHUB_DISCONNECT" });
  } finally {
    githubDisconnectButton.disabled = false;
    setGithubState({ kind: "disconnected" });
  }
});

/*
 * The device-flow poll happening in background.ts finishes
 * independently of this page being open. Listen for its
 * result so the UI updates live if the person authorizes
 * while this options page is still open; if they authorize
 * after closing it, refreshGithubStatus() on next open will
 * pick up the already-stored token instead.
 */
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "GITHUB_AUTH_COMPLETE") {
    return;
  }

  if (message.success) {
    closeGithubOverlay();
    void refreshGithubStatus();
  } else {
    showGithubOverlayError(
      message.error ?? t("options.error.githubSigninFailed"),
    );
    setGithubState(githubState);
  }
});

/*
 * ---------------------------------------------------------
 * START
 * ---------------------------------------------------------
 */

async function init(): Promise<void> {
  await initI18n();
  renderTranslations();

  savedSettings = withDefaults(await loadSettings());
  applySettingsToForm(savedSettings);
  savedJson = JSON.stringify(readSettingsFromForm());

  updateNav();
}

init().then(() => {
  void refreshGithubStatus();
});
