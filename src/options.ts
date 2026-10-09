import {
  type Settings,
  type PdfSettings,
  DEFAULT_SETTINGS,
  DEFAULT_PDF_SETTINGS,
  loadSettings,
  saveSettings,
} from "./settings.ts";
import { initI18n, applyTranslations, getLocale, t } from "./i18n.ts";
import { NOTION_HOST_PERMISSION } from "./notion.ts";
import { GITHUB_HOST_PERMISSIONS, type GitHubRepo } from "./github.ts";
import { formatLabel } from "./format-labels.ts";
import { CHAT_SITE_NAMES, isChatSite } from "./chat-sites.ts";
import {
  BACKUP_CONFIG_KEY,
  BACKUP_FORMATS,
  BACKUP_STATUS_KEY,
  DEFAULT_BACKUP_CONFIG,
  backupConfig,
  backupStatus,
  type BackupConfig,
  type BackupStatus,
} from "./auto-backup.ts";
import {
  FILE_NAME_PRESETS,
  STANDARD_FILE_NAME,
  fileNamePreset,
  renderFileName,
  type FileNamePreset,
} from "./file-names.ts";

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

const fileNameStyleInput = document.getElementById(
  "fileNameStyle",
) as HTMLSelectElement;
const fileNameCustomRow = document.getElementById(
  "fileNameCustomRow",
) as HTMLDivElement;
const fileNameTemplateInput = document.getElementById(
  "fileNameTemplate",
) as HTMLInputElement;
const fileNameExampleName = document.getElementById(
  "fileNameExampleName",
) as HTMLElement;
const fileNameTokenButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>(".token-button[data-token]"),
);

const downloadImagesLocallyInput = document.getElementById(
  "downloadImagesLocally",
) as HTMLInputElement;

const includeSourcesInput = document.getElementById(
  "includeSources",
) as HTMLInputElement;

const includeThinkingInput = document.getElementById(
  "includeThinking",
) as HTMLInputElement;

const includeMessageDetailsInput = document.getElementById(
  "includeMessageDetails",
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

const shortcutLabels = Array.from(
  document.querySelectorAll<HTMLElement>(".shortcut[data-command]"),
);

const openShortcutSettingsButton = document.getElementById(
  "open-shortcut-settings",
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

const notionStatusLabel = document.getElementById(
  "notion-status",
) as HTMLSpanElement;

const notionDisconnectButton = document.getElementById(
  "notion-disconnect",
) as HTMLButtonElement;

const notionKeyPanel = document.getElementById("notion-key") as HTMLDivElement;

const notionTokenInput = document.getElementById(
  "notion-token",
) as HTMLInputElement;

const notionTokenSaveButton = document.getElementById(
  "notion-token-save",
) as HTMLButtonElement;

const notionKeyError = document.getElementById(
  "notion-key-error",
) as HTMLParagraphElement;

const backupCard = document.getElementById("backup") as HTMLElement;
const backupEnabledInput = document.getElementById(
  "backupEnabled",
) as HTMLInputElement;
const backupDetails = document.getElementById("backup-details") as HTMLDivElement;
const backupEveryInput = document.getElementById("backupEvery") as HTMLSelectElement;
const backupTargetInput = document.getElementById(
  "backupTarget",
) as HTMLSelectElement;
const backupRepoRow = document.getElementById("backupRepoRow") as HTMLDivElement;
const backupRepoInput = document.getElementById("backupRepo") as HTMLSelectElement;
const backupRepoNote = document.getElementById(
  "backupRepoNote",
) as HTMLParagraphElement;
const backupFormatInput = document.getElementById(
  "backupFormat",
) as HTMLSelectElement;
const backupFormatDesc = document.getElementById(
  "backupFormat-desc",
) as HTMLParagraphElement;
const backupStatusRow = document.getElementById("backupStatusRow") as HTMLDivElement;
const backupStatusText = document.getElementById(
  "backupStatus",
) as HTMLParagraphElement;
const backupProblems = document.getElementById("backupProblems") as HTMLUListElement;
const backupRunButton = document.getElementById("backupRun") as HTMLButtonElement;
const backupRunLabel = document.getElementById("backupRunLabel") as HTMLSpanElement;

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

/*
 * The file name pattern the form stands for: a ready-made one, or
 * the person's own ("" - the standard name - while theirs is
 * still empty).
 */
function readFileNameTemplate(): string {
  const style = fileNameStyleInput.value;

  if (style === "custom") {
    return fileNameTemplateInput.value.trim();
  }

  return (
    FILE_NAME_PRESETS[style as FileNamePreset] ?? STANDARD_FILE_NAME
  );
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
    fileNameTemplate: readFileNameTemplate(),
    includeSources: includeSourcesInput.checked,
    includeThinking: includeThinkingInput.checked,
    includeMessageDetails: includeMessageDetailsInput.checked,
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
  applyFileNameTemplateToForm(settings.fileNameTemplate);
  downloadImagesLocallyInput.checked = settings.downloadImagesLocally;
  includeSourcesInput.checked = settings.includeSources;
  includeThinkingInput.checked = settings.includeThinking;
  includeMessageDetailsInput.checked = settings.includeMessageDetails;
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

  if (target === fileNameTemplateInput) {
    updateFileNameExample();
  }

  if (target.type === "number" || target.type === "text") {
    scheduleSave(TYPING_SAVE_DELAY_MS);
  }
});

settingsRoot.addEventListener("change", (event) => {
  const target = event.target;

  // Saved apart from the settings (see AUTOMATIC BACKUP below)
  if (backupCard.contains(target as Node)) {
    return;
  }

  if (target === languageInput) {
    void changeLanguage();
    return;
  }

  if (target === fileNameStyleInput) {
    onFileNameStyleChange();
    scheduleSave(CHANGE_SAVE_DELAY_MS);
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
  updateFileNameExample();
  document.title = t("options.title");
  versionLabel.textContent = t("options.about.version", {
    version: chrome.runtime.getManifest().version,
  });
  renderGithub();
  renderNotion();
  renderBackup();
  void renderShortcuts();
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

/*
 * ---------------------------------------------------------
 * FILE NAMES
 * ---------------------------------------------------------
 *
 * A ready-made pattern is picked from the list; "My own
 * pattern…" opens a text box for one with {title}, {site},
 * {date} and {time}, which the buttons under it type in. The
 * example under the list shows what a chat called (in the
 * page's language) "Trip ideas" would be saved as, today.
 */
function applyFileNameTemplateToForm(template: string): void {
  const preset = fileNamePreset(template ?? "");

  fileNameStyleInput.value = preset ?? "custom";

  if (preset === null) {
    fileNameTemplateInput.value = template;
  }

  updateFileNameRow();
}

function updateFileNameExample(): void {
  const name = renderFileName(readFileNameTemplate(), {
    title: t("options.fileName.sampleTitle"),
    site: "chatgpt",
    date: new Date(),
  });

  fileNameExampleName.textContent = `${name}.pdf`;
}

function updateFileNameRow(): void {
  fileNameCustomRow.hidden = fileNameStyleInput.value !== "custom";
  updateFileNameExample();
}

/*
 * Switching to "My own pattern…" starts from the pattern picked
 * before (or "{date} {title}" after the standard name), so there
 * is something to change rather than an empty box.
 */
let lastFileNameStyle = "standard";

function onFileNameStyleChange(): void {
  if (
    fileNameStyleInput.value === "custom" &&
    fileNameTemplateInput.value.trim() === ""
  ) {
    fileNameTemplateInput.value =
      lastFileNameStyle === "standard"
        ? FILE_NAME_PRESETS.dateTitle
        : (FILE_NAME_PRESETS[lastFileNameStyle as FileNamePreset] ??
          FILE_NAME_PRESETS.dateTitle);
  }

  lastFileNameStyle = fileNameStyleInput.value;
  updateFileNameRow();

  if (fileNameStyleInput.value === "custom") {
    fileNameTemplateInput.focus();
    fileNameTemplateInput.setSelectionRange(
      fileNameTemplateInput.value.length,
      fileNameTemplateInput.value.length,
    );
  }
}

fileNameStyleInput.addEventListener("focus", () => {
  lastFileNameStyle = fileNameStyleInput.value;
});

/*
 * Types a token in at the cursor (or at the end), with a space
 * on either side unless something that separates is already
 * there.
 */
for (const button of fileNameTokenButtons) {
  // Keeps the cursor where it was in the text box.
  button.addEventListener("mousedown", (event) => event.preventDefault());

  button.addEventListener("click", () => {
    const input = fileNameTemplateInput;
    const token = `{${button.dataset.token}}`;
    const focused = document.activeElement === input;
    const start = focused ? (input.selectionStart ?? input.value.length) : input.value.length;
    const end = focused ? (input.selectionEnd ?? start) : start;
    const before = input.value.slice(0, start);
    const after = input.value.slice(end);
    const spaceBefore = before !== "" && !/[\s\-_.([]$/.test(before) ? " " : "";
    const spaceAfter = after !== "" && !/^[\s\-_.)\]]/.test(after) ? " " : "";
    const value = `${before}${spaceBefore}${token}${spaceAfter}${after}`;

    if (value.length > input.maxLength && input.maxLength > 0) {
      return;
    }

    const caret = before.length + spaceBefore.length + token.length;

    input.value = value;
    input.focus();
    input.setSelectionRange(caret, caret);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
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

function showToast(
  message: string,
  tone: "success" | "error" = "success",
  durationMs = tone === "error" ? 4000 : 1600,
): void {
  toastText.textContent = message;
  toast.dataset.tone = tone;
  toast.classList.add("is-visible");

  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(
    () => toast.classList.remove("is-visible"),
    durationMs,
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
      // A row hidden for now (its switch is off) isn't a match.
      const visible =
        words.length === 0 ||
        (!setting.closest("[hidden]") &&
          (sectionMatches || containsAll(searchableText(setting), words)));

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
 * KEYBOARD SHORTCUTS
 * ---------------------------------------------------------
 *
 * The keys the browser gave AI Exporter's commands (the manifests'
 * "commands"): the suggested ones unless the person picked others -
 * or none, when another extension had them first. They're read
 * again whenever the page comes back into view, since they're
 * changed on a page of the browser's own.
 */
async function renderShortcuts(): Promise<void> {
  let commands: chrome.commands.Command[];

  try {
    commands = (await chrome.commands?.getAll()) ?? [];
  } catch (error) {
    devError("AI Exporter: couldn't read the keyboard shortcuts", error);
    return;
  }

  if (commands.length === 0) {
    // Nothing to go by: the suggested keys in the page stay.
    return;
  }

  for (const label of shortcutLabels) {
    const shortcut =
      commands.find((command) => command.name === label.dataset.command)
        ?.shortcut ?? "";

    label.textContent = shortcut || t("options.shortcuts.notSet");
    label.classList.toggle("is-unset", !shortcut);
  }
}

window.addEventListener("focus", () => {
  void renderShortcuts();
});

/*
 * Only the browser can change an extension's shortcuts. Chrome has
 * a page for it that an extension may open; Firefox opens its own
 * from commands.openShortcutSettings() (Firefox 137 and later) - an
 * older one only lets the person get there, so it says how.
 */
openShortcutSettingsButton.addEventListener("click", () => {
  const commands = chrome.commands as
    | (typeof chrome.commands & { openShortcutSettings?: () => Promise<void> })
    | undefined;

  if (typeof commands?.openShortcutSettings === "function") {
    void commands.openShortcutSettings();
  } else if (navigator.userAgent.includes("Firefox")) {
    // Long enough to read the way there
    showToast(
      t("options.shortcuts.firefoxHint", {
        shortcut: navigator.userAgent.includes("Mac") ? "⌘⇧A" : "Ctrl+Shift+A",
      }),
      "error",
      8000,
    );
  } else {
    void chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
  }
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
  renderBackupRepos();
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

/*
 * github.com and api.github.com are optional permissions (see
 * github.ts). The browser asks for them right in the click, since
 * Firefox only shows that prompt in direct response to one; once
 * allowed, it doesn't ask again.
 */
function requestGithubAccess(): Promise<boolean> {
  return chrome.permissions
    .request({ origins: GITHUB_HOST_PERMISSIONS })
    .catch(() => false);
}

githubConnectButton.addEventListener("click", async () => {
  const access = requestGithubAccess();

  setGithubState(githubState, true);

  try {
    if (!(await access)) {
      throw new Error(t("options.github.permissionDenied"));
    }

    /*
     * A connection that only lacked the permission, given back
     * just now, works again without signing in to GitHub anew.
     */
    const status = await chrome.runtime.sendMessage({
      type: "GITHUB_GET_STATUS",
    });

    if (status?.success && status.data?.connected) {
      setGithubState({ kind: "connected", login: status.data.login });
      return;
    }

    const response = await chrome.runtime.sendMessage({
      type: "GITHUB_START_AUTH",
    });

    if (!response?.success) {
      throw new Error(response?.error ?? t("options.error.githubStartFailed"));
    }

    const { userCode, verificationUri } = response.data;

    openGithubOverlay(userCode);

    /*
     * A tab rather than window.open(): after the permission prompt
     * the click can be too long ago for the browser to allow a
     * new window.
     */
    void chrome.tabs.create({ url: verificationUri });
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
 * NOTION CONNECTION
 * ---------------------------------------------------------
 *
 * Connects with an internal integration's secret, pasted in (see
 * notion.ts for why - signing in through Notion's own page would
 * need a server-side piece this extension doesn't have). The
 * browser first asks the person to allow access to api.notion.com
 * - asked right in the click, since Firefox only shows that
 * prompt in direct response to one.
 */
type NotionUiState =
  | { kind: "disconnected" }
  | { kind: "connected"; workspace: string }
  | { kind: "error"; message: string };

let notionState: NotionUiState = { kind: "disconnected" };
let notionConnecting = false;

function renderNotion(): void {
  const connected = notionState.kind === "connected";

  switch (notionState.kind) {
    case "connected":
      notionStatusLabel.textContent = notionState.workspace
        ? t("options.notion.statusConnected", {
            workspace: notionState.workspace,
          })
        : t("options.notion.statusConnectedNoName");
      break;
    case "error":
      notionStatusLabel.textContent = notionState.message;
      break;
    default:
      notionStatusLabel.textContent = t("options.notion.statusDisconnected");
  }

  notionStatusLabel.classList.toggle("is-connected", connected);
  notionStatusLabel.classList.toggle("is-error", notionState.kind === "error");

  notionDisconnectButton.hidden = !connected;
  notionKeyPanel.hidden = connected;
  notionTokenSaveButton.disabled = notionConnecting;
}

function setNotionState(state: NotionUiState, connecting = false): void {
  notionState = state;
  notionConnecting = connecting;
  renderNotion();
}

function showNotionKeyError(message: string): void {
  notionKeyError.textContent = message;
  notionKeyError.hidden = message === "";
}

async function refreshNotionStatus(): Promise<void> {
  try {
    const response = await chrome.runtime.sendMessage({
      type: "NOTION_GET_STATUS",
    });

    setNotionState(
      response?.success && response.data?.connected
        ? { kind: "connected", workspace: response.data.workspaceName ?? "" }
        : { kind: "disconnected" },
    );
  } catch (error) {
    devError("AI Exporter: Notion status check failed", error);
    setNotionState({ kind: "disconnected" });
  }
}

function requestNotionAccess(): Promise<boolean> {
  return chrome.permissions
    .request({ origins: [NOTION_HOST_PERMISSION] })
    .catch(() => false);
}

async function connectNotionKey(): Promise<void> {
  const token = notionTokenInput.value.trim();

  if (token === "") {
    showNotionKeyError(t("notion.error.tokenFormat"));
    notionTokenInput.focus();
    return;
  }

  const access = requestNotionAccess();

  showNotionKeyError("");
  setNotionState(notionState, true);

  try {
    if (!(await access)) {
      throw new Error(t("options.notion.permissionDenied"));
    }

    const response = await chrome.runtime.sendMessage({
      type: "NOTION_CONNECT_TOKEN",
      token,
    });

    if (!response?.success) {
      throw new Error(response?.error ?? t("notion.error.tokenRejected"));
    }

    notionTokenInput.value = "";
    await refreshNotionStatus();
  } catch (error) {
    devError("AI Exporter: Notion key rejected", error);
    setNotionState(notionState);
    showNotionKeyError(
      error instanceof Error ? error.message : t("notion.error.tokenRejected"),
    );
  }
}

notionTokenSaveButton.addEventListener("click", () => {
  void connectNotionKey();
});

notionTokenInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void connectNotionKey();
  }
});

notionDisconnectButton.addEventListener("click", async () => {
  notionDisconnectButton.disabled = true;

  try {
    await chrome.runtime.sendMessage({ type: "NOTION_DISCONNECT" });
  } finally {
    notionDisconnectButton.disabled = false;
    setNotionState({ kind: "disconnected" });
  }
});

/*
 * ---------------------------------------------------------
 * AUTOMATIC BACKUP
 * ---------------------------------------------------------
 *
 * See auto-backup.ts. Kept in chrome.storage.local, apart from the
 * settings above: a backup belongs to this computer, and "Restore
 * default settings" leaves it as it is. Only private GitHub
 * repositories are offered - a public one would publish every chat.
 */
let backup: BackupConfig = DEFAULT_BACKUP_CONFIG;
let backupState: BackupStatus = { sites: {} };
/* null until loaded; reset when GitHub is disconnected */
let backupRepos: GitHubRepo[] | null = null;
let backupReposLoading = false;
let backupReposFailed = false;
let backupRunning = false;

function readBackupForm(): BackupConfig {
  return backupConfig({
    enabled: backupEnabledInput.checked,
    every: backupEveryInput.value,
    target: backupTargetInput.value,
    // Until the list is in, the select is empty: the chosen one stays.
    repo: backupRepos ? backupRepoInput.value : backup.repo,
    format: backupFormatInput.value,
  });
}

function renderBackup(): void {
  backupEnabledInput.checked = backup.enabled;
  backupDetails.hidden = !backup.enabled;
  backupEveryInput.value = backup.every;
  backupTargetInput.value = backup.target;
  backupFormatInput.replaceChildren(
    ...BACKUP_FORMATS.map((format) => new Option(formatLabel(format), format)),
  );
  backupFormatInput.value = backup.format;
  backupFormatDesc.textContent = t(`popup.formatHint.${backup.format}`);
  renderBackupRepos();
  renderBackupStatus();
}

function renderBackupRepos(): void {
  const connected = githubState.kind === "connected";
  const select = backupRepoInput.parentElement as HTMLElement;

  backupRepoRow.hidden = backup.target !== "github";

  if (!connected) {
    backupRepos = null;
    backupReposFailed = false;
  } else if (backup.target === "github" && backupRepos === null && !backupReposLoading) {
    void loadBackupRepos();
  }

  select.hidden = !connected || !backupRepos?.length;
  backupRepoNote.classList.toggle("is-error", connected && backupReposFailed);

  if (!connected) {
    const link = document.createElement("a");

    link.href = "#github";
    link.textContent = t("options.backup.repo.connectLink");
    backupRepoNote.replaceChildren(`${t("options.backup.repo.connect")} `, link);
    return;
  }

  backupRepoNote.textContent = t(
    backupReposFailed
      ? "options.backup.repo.failed"
      : backupRepos === null
        ? "options.backup.repo.loading"
        : backupRepos.length === 0
          ? "options.backup.repo.none"
          : "options.backup.repo.private",
  );

  if (backupRepoInput.options[0]?.value === "") {
    backupRepoInput.options[0].text = t("options.backup.repo.choose");
  }
}

async function loadBackupRepos(): Promise<void> {
  backupReposLoading = true;
  backupReposFailed = false;

  try {
    const response = await chrome.runtime.sendMessage({ type: "GITHUB_LIST_REPOS" });

    if (!response?.success) {
      throw new Error(response?.error ?? "GITHUB_LIST_REPOS failed");
    }

    backupRepos = (response.data as GitHubRepo[]).filter(
      (repo) => repo.private === true,
    );
    backupRepoInput.replaceChildren(
      new Option(t("options.backup.repo.choose"), ""),
      ...backupRepos.map((repo) => new Option(repo.full_name, repo.full_name)),
    );
    backupRepoInput.value = backupRepos.some((repo) => repo.full_name === backup.repo)
      ? backup.repo
      : "";
  } catch (error) {
    devError("AI Exporter: couldn't list the GitHub repositories", error);
    backupReposFailed = true;
  } finally {
    backupReposLoading = false;
    renderBackupRepos();
  }
}

/*
 * Shown while the backup is off too once there's something to say -
 * such as why it was turned off (see SaveAsError in background.ts).
 */
function renderBackupStatus(): void {
  const status = backupState;

  backupStatusRow.hidden = !backup.enabled && status.at === undefined && !status.error;

  const when =
    status.at === undefined
      ? ""
      : new Intl.DateTimeFormat(getLocale(), {
          dateStyle: "medium",
          timeStyle: "short",
        }).format(status.at);

  // "Nothing new" only when nothing was left out either
  backupStatusText.textContent =
    status.at === undefined
      ? t("options.backup.status.never")
      : status.saved || status.failed || status.error
        ? t("options.backup.status.saved", { when, count: status.saved ?? 0 })
        : t("options.backup.status.nothingNew", { when });

  const problems = [
    ...(status.error ? [status.error] : []),
    ...(status.failed ? [t("options.backup.status.failed", { count: status.failed })] : []),
    ...Object.entries(status.sites).flatMap(([site, last]) =>
      last?.error && isChatSite(site)
        ? [t("options.backup.status.site", { site: CHAT_SITE_NAMES[site], error: last.error })]
        : [],
    ),
  ];

  backupProblems.replaceChildren(
    ...problems.map((problem) => {
      const item = document.createElement("li");

      item.textContent = problem;
      return item;
    }),
  );
  backupProblems.hidden = problems.length === 0;
  backupRunButton.disabled = backupRunning;
  backupRunLabel.textContent = t(
    backupRunning ? "options.backup.running" : "options.backup.run",
  );
}

/*
 * A change also clears what stopped the last backup: it may be what
 * the person just put right (a repository chosen, the backup turned
 * back on after a Save As dialog).
 */
backupCard.addEventListener("change", async () => {
  const config = readBackupForm();

  try {
    await chrome.storage.local.set({ [BACKUP_CONFIG_KEY]: config });
    backup = config;

    if (backupState.error) {
      backupState = { ...backupState, error: undefined };
      await chrome.storage.local.set({ [BACKUP_STATUS_KEY]: backupState });
    }

    renderBackup();
    showToast(t("options.saved"));
  } catch (error) {
    devError("AI Exporter: saving the backup settings failed", error);
    showToast(t("options.saveFailed"), "error");
  }
});

backupRunButton.addEventListener("click", async () => {
  backupRunning = true;
  renderBackupStatus();

  try {
    const response = await chrome.runtime.sendMessage({ type: "BACKUP_RUN" });

    if (!response?.success) {
      throw new Error(response?.error ?? t("options.saveFailed"));
    }
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error), "error", 8000);
  } finally {
    backupRunning = false;
    renderBackupStatus();
  }
});

/* The backup's progress, and the background turning it off */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") {
    return;
  }

  if (changes[BACKUP_STATUS_KEY]) {
    backupState = backupStatus(changes[BACKUP_STATUS_KEY].newValue);
    renderBackupStatus();
  }

  if (changes[BACKUP_CONFIG_KEY]) {
    backup = backupConfig(changes[BACKUP_CONFIG_KEY].newValue);
    renderBackup();
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

  const stored = await chrome.storage.local.get([BACKUP_CONFIG_KEY, BACKUP_STATUS_KEY]);

  backup = backupConfig(stored[BACKUP_CONFIG_KEY]);
  backupState = backupStatus(stored[BACKUP_STATUS_KEY]);
  renderBackup();

  updateNav();
}

init().then(() => {
  void refreshGithubStatus();
  void refreshNotionStatus();
});
