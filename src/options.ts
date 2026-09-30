import {
  type Settings,
  type PdfSettings,
  DEFAULT_SETTINGS,
  DEFAULT_PDF_SETTINGS,
  loadSettings,
  saveSettings,
} from "./settings.ts";
import { initI18n, applyTranslations, setLocale, t } from "./i18n.ts";

const devError = (...args: unknown[]): void => {
  if (import.meta.env.DEV) {
    console.error(...args);
  }
};

const saveButton = document.getElementById("save") as HTMLButtonElement;

const statusLabel = document.getElementById("status") as HTMLSpanElement;

const includeTimestampInput = document.getElementById(
  "includeTimestamp",
) as HTMLInputElement;

const askWhereToSaveInput = document.getElementById(
  "askWhereToSave",
) as HTMLInputElement;

const downloadImagesLocallyInput = document.getElementById(
  "downloadImagesLocally",
) as HTMLInputElement;

const themeInput = document.getElementById("theme") as HTMLSelectElement;

const languageInput = document.getElementById("language") as HTMLSelectElement;

const pdfPageFormatInput = document.getElementById(
  "pdfPageFormat",
) as HTMLSelectElement;
const pdfOrientationInput = document.getElementById(
  "pdfOrientation",
) as HTMLSelectElement;
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
const pdfFontSizeInput = document.getElementById(
  "pdfFontSize",
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
const pdfUserInfoTextInput = document.getElementById(
  "pdfUserInfoText",
) as HTMLInputElement;

function applyTheme(theme: Settings["theme"]): void {
  if (theme === "system") {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = theme;
  }
}

const downloadsSettingsLink = document.getElementById(
  "downloads-settings-link",
) as HTMLAnchorElement;

const githubStatusLabel = document.getElementById(
  "github-status",
) as HTMLParagraphElement;

const githubConnectButton = document.getElementById(
  "github-connect",
) as HTMLButtonElement;

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

function applySettingsToForm(settings: Settings): void {
  setRadioValue("headingStyle", settings.headingStyle);
  setRadioValue("messageSeparator", settings.messageSeparator);

  includeTimestampInput.checked = settings.includeTimestamp;
  askWhereToSaveInput.checked = settings.askWhereToSave;
  downloadImagesLocallyInput.checked = settings.downloadImagesLocally;

  themeInput.value = settings.theme;
  applyTheme(settings.theme);

  languageInput.value = settings.language;

  pdfPageFormatInput.value = settings.pdf.pageFormat;
  pdfOrientationInput.value = settings.pdf.orientation;
  pdfMarginTopInput.value = String(settings.pdf.marginTop);
  pdfMarginRightInput.value = String(settings.pdf.marginRight);
  pdfMarginBottomInput.value = String(settings.pdf.marginBottom);
  pdfMarginLeftInput.value = String(settings.pdf.marginLeft);
  pdfFontSizeInput.value = String(settings.pdf.fontSize);
  pdfIncludeTableOfContentsInput.checked = settings.pdf.includeTableOfContents;
  pdfIncludePageNumbersInput.checked = settings.pdf.includePageNumbers;
  pdfIncludeUserInfoInput.checked = settings.pdf.includeUserInfo;
  pdfUserInfoTextInput.value = settings.pdf.userInfoText;
}

function readPositiveNumber(
  input: HTMLInputElement,
  fallback: number,
  min = 0,
): number {
  const value = Number(input.value);

  return Number.isFinite(value) && value >= min ? value : fallback;
}

function readPdfSettingsFromForm(): PdfSettings {
  return {
    pageFormat: pdfPageFormatInput.value as PdfSettings["pageFormat"],
    orientation: pdfOrientationInput.value as PdfSettings["orientation"],
    marginTop: readPositiveNumber(
      pdfMarginTopInput,
      DEFAULT_PDF_SETTINGS.marginTop,
    ),
    marginRight: readPositiveNumber(
      pdfMarginRightInput,
      DEFAULT_PDF_SETTINGS.marginRight,
    ),
    marginBottom: readPositiveNumber(
      pdfMarginBottomInput,
      DEFAULT_PDF_SETTINGS.marginBottom,
    ),
    marginLeft: readPositiveNumber(
      pdfMarginLeftInput,
      DEFAULT_PDF_SETTINGS.marginLeft,
    ),
    fontSize: readPositiveNumber(
      pdfFontSizeInput,
      DEFAULT_PDF_SETTINGS.fontSize,
      6,
    ),
    includeTableOfContents: pdfIncludeTableOfContentsInput.checked,
    includePageNumbers: pdfIncludePageNumbersInput.checked,
    includeUserInfo: pdfIncludeUserInfoInput.checked,
    userInfoText: pdfUserInfoTextInput.value,
  };
}

function readSettingsFromForm(): Settings {
  return {
    headingStyle: getRadioValue("headingStyle", DEFAULT_SETTINGS.headingStyle),
    messageSeparator: getRadioValue(
      "messageSeparator",
      DEFAULT_SETTINGS.messageSeparator,
    ),
    includeTimestamp: includeTimestampInput.checked,
    askWhereToSave: askWhereToSaveInput.checked,
    downloadImagesLocally: downloadImagesLocallyInput.checked,
    theme: themeInput.value as Settings["theme"],
    language: languageInput.value as Settings["language"],
    pdf: readPdfSettingsFromForm(),
  };
}

async function init(): Promise<void> {
  await initI18n();
  applyTranslations();

  const settings = await loadSettings();

  applySettingsToForm(settings);
}

themeInput.addEventListener("change", () => {
  applyTheme(themeInput.value as Settings["theme"]);
});

/*
 * Applies the newly chosen language to this options page
 * immediately, without waiting for Save - people expect a
 * language switcher to react right away. The choice is still
 * only persisted (and picked up by the popup/content script)
 * once Save Settings is clicked, matching every other
 * preference on this page.
 */
languageInput.addEventListener("change", () => {
  if (languageInput.value === "auto") {
    void initI18n().then(() => applyTranslations());
  } else {
    setLocale(languageInput.value);
    applyTranslations();
  }
});

saveButton.addEventListener("click", async () => {
  const settings = readSettingsFromForm();

  await saveSettings(settings);

  statusLabel.classList.add("visible");

  setTimeout(() => {
    statusLabel.classList.remove("visible");
  }, 1500);
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
downloadsSettingsLink.addEventListener("click", (event) => {
  event.preventDefault();

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

function renderGithubDisconnected(): void {
  githubStatusLabel.textContent = t("options.github.statusDisconnected");
  githubStatusLabel.classList.remove("connected");
  githubConnectButton.hidden = false;
  githubConnectButton.disabled = false;
  githubConnectButton.textContent = t("options.github.connect");
  githubDisconnectButton.hidden = true;
}

function renderGithubConnected(login: string): void {
  githubStatusLabel.textContent = t("options.github.statusConnected", {
    login,
  });
  githubStatusLabel.classList.add("connected");
  githubConnectButton.hidden = true;
  githubDisconnectButton.hidden = false;
}

async function refreshGithubStatus(): Promise<void> {
  const response = await chrome.runtime.sendMessage({
    type: "GITHUB_GET_STATUS",
  });

  if (response?.success && response.data?.connected) {
    renderGithubConnected(response.data.login);
  } else {
    renderGithubDisconnected();
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
  githubConnectButton.disabled = false;
  githubConnectButton.textContent = t("options.github.connect");
});

githubConnectButton.addEventListener("click", async () => {
  githubConnectButton.disabled = true;
  githubConnectButton.textContent = t("options.github.connecting");

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

    githubStatusLabel.textContent =
      error instanceof Error
        ? error.message
        : t("options.error.githubStartFailed");

    githubConnectButton.disabled = false;
    githubConnectButton.textContent = t("options.github.connect");
  }
});

githubDisconnectButton.addEventListener("click", async () => {
  githubDisconnectButton.disabled = true;

  try {
    await chrome.runtime.sendMessage({ type: "GITHUB_DISCONNECT" });
  } finally {
    githubDisconnectButton.disabled = false;
    renderGithubDisconnected();
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
    githubConnectButton.disabled = false;
    githubConnectButton.textContent = t("options.github.connect");
  }
});

init().then(() => {
  void refreshGithubStatus();
});
