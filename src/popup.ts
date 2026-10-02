import { SEPARATOR_TEXT, loadSettings } from "./settings.ts";
import { initI18n, applyTranslations, t } from "./i18n.ts";

async function applyStoredTheme(): Promise<void> {
  const settings = await loadSettings();

  if (settings.theme === "system") {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = settings.theme;
  }
}

void applyStoredTheme();

/*
 * initI18n()'s underlying chrome.storage.sync.get() resolves
 * on the same tick the popup opens, well before a person can
 * click anything - every string below that's set dynamically
 * (toasts, button label swaps, etc.) happens later, inside
 * event handlers, so it's safe to fire this without awaiting
 * it at the top level.
 */
void initI18n().then(() => {
  applyTranslations();
});

import { stripMarkdown } from "./markdown-strip.ts";
import { createZipBlob, decodeBase64, encodeBlobBase64 } from "./zip.ts";
import { buildPdfBlob } from "./pdf-export.ts";

const PROJECT_REPOSITORY = "GrantTotinov/AIExporter";
const COFFEE_URL = "https://buymeacoffee.com/granttotinov";

const devLog = (...args: unknown[]): void => {
  if (import.meta.env.DEV) {
    console.log(...args);
  }
};

const devWarn = (...args: unknown[]): void => {
  if (import.meta.env.DEV) {
    console.warn(...args);
  }
};

const devError = (...args: unknown[]): void => {
  if (import.meta.env.DEV) {
    console.error(...args);
  }
};

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  order: number;
  imagePaths?: string[];
}

interface ExportImageFile {
  path: string;
  mimeType: string;
  base64: string;
  sizeBytes: number;
}

type ExportFormat = "md" | "txt" | "json" | "csv" | "pdf";
type FilenameExtension = ExportFormat | "zip";

/*
 * ---------------------------------------------------------
 * DOM REFERENCES
 * ---------------------------------------------------------
 */

const copyButton = document.getElementById("copy") as HTMLButtonElement;
const exportButton = document.getElementById("export") as HTMLButtonElement;
const optionsLink = document.getElementById(
  "options-link",
) as HTMLAnchorElement;
const githubStarButton = document.getElementById(
  "github-star",
) as HTMLButtonElement;
const buyCoffeeButton = document.getElementById(
  "buy-coffee",
) as HTMLButtonElement;

/* Loading overlay (covers the whole popup while messages load) */
const loadingOverlay = document.getElementById(
  "loading-overlay",
) as HTMLDivElement;
const loadingOverlayMessage = document.getElementById(
  "loading-overlay-message",
) as HTMLParagraphElement;

/* Toast (on-screen feedback for button actions) */
const toast = document.getElementById("toast") as HTMLDivElement;

/* Message selector / export panel */
const selectorOverlay = document.getElementById(
  "selector-overlay",
) as HTMLDivElement;
const selectorPanelMessage = document.getElementById(
  "selector-panel-message",
) as HTMLParagraphElement;
const selectorList = document.getElementById("selector-list") as HTMLDivElement;
const selectorFilterAllButton = document.getElementById(
  "selector-filter-all",
) as HTMLButtonElement;
const selectorFilterQuestionsButton = document.getElementById(
  "selector-filter-questions",
) as HTMLButtonElement;
const selectorFilterAnswersButton = document.getElementById(
  "selector-filter-answers",
) as HTMLButtonElement;
const selectorFilterNoneButton = document.getElementById(
  "selector-filter-none",
) as HTMLButtonElement;
const selectorFilterInvertButton = document.getElementById(
  "selector-filter-invert",
) as HTMLButtonElement;
const selectorExpandToggle = document.getElementById(
  "selector-expand-toggle",
) as HTMLInputElement;
const selectorCount = document.getElementById(
  "selector-count",
) as HTMLSpanElement;
const selectorFormatSelect = document.getElementById(
  "selector-format-select",
) as HTMLSelectElement;
const selectorGithubButton = document.getElementById(
  "selector-github-button",
) as HTMLButtonElement;
const selectorCancelButton = document.getElementById(
  "selector-cancel",
) as HTMLButtonElement;
const selectorExportButton = document.getElementById(
  "selector-export",
) as HTMLButtonElement;

/* GitHub repo picker panel (opened from selectorGithubButton) */
const githubPanel = document.getElementById("github-panel") as HTMLDivElement;
const githubPanelMessage = document.getElementById(
  "github-panel-message",
) as HTMLParagraphElement;
const githubRepoSelect = document.getElementById(
  "github-repo-select",
) as HTMLSelectElement;
const githubPanelSaveButton = document.getElementById(
  "github-panel-save",
) as HTMLButtonElement;
const githubPanelCancelButton = document.getElementById(
  "github-panel-cancel",
) as HTMLButtonElement;

/* GitHub export confirmation modal */
const githubConfirmOverlay = document.getElementById(
  "github-confirm-overlay",
) as HTMLDivElement;
const githubConfirmCancelButton = document.getElementById(
  "github-confirm-cancel",
) as HTMLButtonElement;
const githubConfirmExportButton = document.getElementById(
  "github-confirm-export",
) as HTMLButtonElement;

const allButtons = [
  copyButton,
  exportButton,
  githubStarButton,
  buyCoffeeButton,
  selectorExportButton,
  selectorGithubButton,
  githubPanelSaveButton,
];

optionsLink.addEventListener("click", (event) => {
  event.preventDefault();
  chrome.runtime.openOptionsPage();
});

/*
 * ---------------------------------------------------------
 * TOAST (on-screen feedback, replaces button textContent
 * swaps like "Copied!"/"Downloaded!")
 * ---------------------------------------------------------
 */
let toastTimeoutId: number | undefined;

function showToast(message: string, ms = 2000): void {
  toast.textContent = message;
  toast.classList.add("visible");

  if (toastTimeoutId !== undefined) {
    window.clearTimeout(toastTimeoutId);
  }

  toastTimeoutId = window.setTimeout(() => {
    toast.classList.remove("visible");
  }, ms);
}

/*
 * ---------------------------------------------------------
 * BUSY STATE
 * ---------------------------------------------------------
 */
function setBusy(busy: boolean): void {
  for (const button of allButtons) {
    button.disabled = busy;
  }
}

function resetButtons(): void {
  setBusy(false);
}

/*
 * ---------------------------------------------------------
 * OVERLAY SIZE TRACKING
 * ---------------------------------------------------------
 *
 * The popup's <body> stays sized to its small, normal content
 * (Copy/Export buttons only) until an overlay needs the full
 * 600px Chrome popup height to show a scrollable list/modal.
 * body.overlay-open is what triggers that larger fixed height
 * in CSS. A count (not a boolean) because overlays can stack
 * - e.g. the GitHub confirm modal opens on top of the GitHub
 * repo panel - so the small size should only return once
 * every open overlay has closed, not as soon as the top one
 * does.
 */
let openOverlayCount = 0;

function markOverlayOpened(): void {
  openOverlayCount++;
  document.body.classList.add("overlay-open");
}

function markOverlayClosed(): void {
  openOverlayCount = Math.max(0, openOverlayCount - 1);

  if (openOverlayCount === 0) {
    document.body.classList.remove("overlay-open");
  }
}

/*
 * ---------------------------------------------------------
 * LOADING OVERLAY
 * ---------------------------------------------------------
 *
 * Covers the entire popup with a dimmed, non-interactive
 * layer while the conversation is being fetched from the
 * page. Prevents the person from clicking other buttons
 * mid-load (which previously could kick off a second,
 * overlapping fetch) and makes it visually obvious that
 * something is happening rather than the popup looking
 * unresponsive.
 */
function showLoadingOverlay(message: string): void {
  loadingOverlayMessage.textContent = message;
  loadingOverlay.classList.add("open");
  markOverlayOpened();
  setBusy(true);
}

function hideLoadingOverlay(): void {
  loadingOverlay.classList.remove("open");
  markOverlayClosed();
  setBusy(false);
}

/*
 * ---------------------------------------------------------
 * LIVE PROGRESS
 * ---------------------------------------------------------
 *
 * The content script sends EXPORT_PROGRESS messages while
 * it paginates through the conversation. Reflect that on the
 * loading overlay so long conversations don't look frozen.
 */
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "EXPORT_PROGRESS") {
    return;
  }

  if (!loadingOverlay.classList.contains("open")) {
    return;
  }

  loadingOverlayMessage.textContent = `${t("popup.loading.default")} (${message.collected})`;
});

/*
 * ---------------------------------------------------------
 * FILENAME
 * ---------------------------------------------------------
 *
 * Builds a filesystem-safe filename from the tab title and
 * today's date, e.g. "chatgpt-export-easypay-transfer-help-2026-08-30.md".
 */
function buildFilename(
  tabTitle: string | undefined,
  extension: FilenameExtension,
): string {
  const date = new Date();

  const datePart =
    date.getFullYear() +
    "-" +
    String(date.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(date.getDate()).padStart(2, "0");

  const rawTitle = (tabTitle ?? "conversation")
    .replace(/\s*[-|]\s*ChatGPT\s*$/i, "")
    .trim();

  const safeTitle = rawTitle
    .toLowerCase()
    .replace(/[^a-z0-9\u0400-\u04FF]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

  const titlePart = safeTitle || "conversation";

  return `chatgpt-export-${titlePart}-${datePart}.${extension}`;
}

/*
 * ---------------------------------------------------------
 * JSON / CSV BUILDERS
 * ---------------------------------------------------------
 */
function buildJson(messages: Message[]): string {
  return JSON.stringify(
    messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    null,
    2,
  );
}

function escapeCsvField(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }

  return value;
}

function buildCsv(messages: Message[]): string {
  const header = "role,content";

  const rows = messages.map(
    (message) =>
      `${escapeCsvField(message.role)},${escapeCsvField(message.content)}`,
  );

  return [header, ...rows].join("\r\n");
}

/*
 * ---------------------------------------------------------
 * BUILD MARKDOWN FROM MESSAGES
 * ---------------------------------------------------------
 */
async function buildMarkdownFromMessages(messages: Message[]): Promise<string> {
  const settings = await loadSettings();

  const timestamp = settings.includeTimestamp
    ? `_Exported ${new Date().toLocaleString()}_\n\n`
    : "";

  return (
    timestamp +
    messages
      .map((message) => {
        const roleLabel = message.role === "user" ? "User" : "Assistant";

        let heading: string;

        switch (settings.headingStyle) {
          case "bold":
            heading = `**${roleLabel}:**`;
            break;
          case "none":
            heading = "";
            break;
          case "h2":
          default:
            heading = `## ${roleLabel}`;
            break;
        }

        return heading ? `${heading}\n\n${message.content}` : message.content;
      })
      .join(SEPARATOR_TEXT[settings.messageSeparator])
  );
}

function buildContentForFormat(
  format: ExportFormat,
  markdown: string,
  messages: Message[],
): { content: string; mimeType: string } {
  switch (format) {
    case "txt":
      return {
        content: stripMarkdown(
          markdown.replace(
            /!\[([^\]]*)\]\(([^)]+)\)/g,
            (_match, altText: string, imagePath: string) =>
              `${altText}: ${imagePath}`,
          ),
        ),
        mimeType: "text/plain",
      };
    case "json":
      return { content: buildJson(messages), mimeType: "application/json" };
    case "csv":
      return { content: buildCsv(messages), mimeType: "text/csv" };
    case "md":
    default:
      return { content: markdown, mimeType: "text/markdown" };
  }
}

/*
 * ---------------------------------------------------------
 * LOAD CONVERSATION MESSAGES
 * ---------------------------------------------------------
 *
 * Fetches the raw message list from the content script, with
 * no formatting applied. Shows the loading overlay for the
 * full duration so the person can't click anything else in
 * the popup mid-fetch.
 */
async function loadConversationMessages(
  downloadImagesLocally: boolean,
): Promise<{
  messages: Message[];
  images: ExportImageFile[];
  tabTitle: string | undefined;
  tabUrl: string | undefined;
  tabId: number | undefined;
}> {
  showLoadingOverlay(t("popup.loading.default"));

  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });

    if (!tab.id) {
      throw new Error(t("popup.error.noActiveTab"));
    }

    if (!tab.url?.startsWith("https://chatgpt.com/")) {
      throw new Error(t("popup.error.openChatGpt"));
    }

    devLog("AI Exporter: requesting conversation");

    let response;

    try {
      response = await chrome.tabs.sendMessage(tab.id, {
        type: "LOAD_CONVERSATION",
        downloadImagesLocally,
      });
    } catch (sendError) {
      devWarn(
        "AI Exporter: no content script, reloading tab and retrying",
        sendError,
      );

      loadingOverlayMessage.textContent = t("popup.loading.reconnecting");

      await chrome.tabs.reload(tab.id);

      await new Promise((resolve) => setTimeout(resolve, 2000));

      loadingOverlayMessage.textContent = t("popup.loading.default");

      response = await chrome.tabs.sendMessage(tab.id, {
        type: "LOAD_CONVERSATION",
        downloadImagesLocally,
      });
    }

    if (!response?.success) {
      throw new Error(
        response?.error ?? t("popup.error.loadConversationFailed"),
      );
    }

    const loadResult = response.data as {
      messages: Message[];
      images: ExportImageFile[];
    };
    const messages = loadResult.messages;
    const images = loadResult.images ?? [];

    devLog(`AI Exporter: received ${messages.length} messages`);

    if (messages.length === 0) {
      throw new Error(t("popup.error.noMessagesFound"));
    }

    const sortedMessages = [...messages].sort((a, b) => a.order - b.order);

    return {
      messages: sortedMessages,
      images,
      tabTitle: tab.title,
      tabUrl: tab.url,
      tabId: tab.id,
    };
  } finally {
    hideLoadingOverlay();
  }
}

/*
 * ---------------------------------------------------------
 * COPY TO CLIPBOARD
 * ---------------------------------------------------------
 *
 * Copy always uses the full conversation - no message
 * selection step, matching the one-click "quick copy" role
 * this button has always had. Message selection is reserved
 * for Export.
 */
copyButton.addEventListener("click", async () => {
  devLog("AI Exporter: copy clicked");

  try {
    const { messages } = await loadConversationMessages(false);

    const markdown = await buildMarkdownFromMessages(messages);

    const copyResponse = await chrome.runtime.sendMessage({
      type: "COPY_TO_CLIPBOARD",
      data: markdown,
    });

    devLog("AI Exporter: clipboard response", copyResponse);

    if (!copyResponse?.success) {
      throw new Error(
        copyResponse?.error ?? t("popup.error.copyMarkdownFailed"),
      );
    }

    showToast(t("popup.toast.copied"));
  } catch (error) {
    devError("AI Exporter: copy failed", error);

    const message = error instanceof Error ? error.message : String(error);

    showToast(
      message.length < 60 ? message : t("popup.toast.copyFailed"),
      3000,
    );
  }
});

/*
 * ---------------------------------------------------------
 * MESSAGE SELECTOR / EXPORT PANEL
 * ---------------------------------------------------------
 *
 * Export always opens this panel first, every time. It loads
 * the full conversation, lets the person narrow it down with
 * checkboxes/filters/Shift+Click range select and an "expand"
 * toggle to read full message text, then either downloads the
 * chosen format directly or opens the GitHub repo picker for
 * a Markdown save.
 */
let currentMessages: Message[] = [];
let currentImages: ExportImageFile[] = [];
let currentTabTitle: string | undefined;
let currentTabUrl: string | undefined;
let currentTabId: number | undefined;
let lastShiftAnchorIndex: number | null = null;

function closeSelectorOverlay(): void {
  selectorOverlay.classList.remove("open");
  markOverlayClosed();
}

function getSelectedMessages(): Message[] {
  const checkboxes = Array.from(
    selectorList.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
  );

  return checkboxes
    .filter((box) => box.checked)
    .map((box) => currentMessages[Number(box.dataset.index)])
    .filter((message): message is Message => Boolean(message));
}

function updateSelectorCount(): void {
  const checkboxes = selectorList.querySelectorAll<HTMLInputElement>(
    'input[type="checkbox"]',
  );

  const checked = Array.from(checkboxes).filter((box) => box.checked).length;

  selectorCount.textContent = t("popup.selector.count", {
    checked,
    total: checkboxes.length,
  });

  const hasSelection = checked > 0;
  selectorExportButton.disabled = !hasSelection;
  selectorGithubButton.disabled = !hasSelection;
}

function renderSelectorList(messages: Message[]): void {
  selectorList.innerHTML = "";
  lastShiftAnchorIndex = null;

  messages.forEach((message, index) => {
    const row = document.createElement("label");
    row.className = "selector-row";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.dataset.index = String(index);

    const roleIcon = document.createElement("span");
    roleIcon.className = "selector-role-icon";
    roleIcon.textContent = message.role === "user" ? "🧑" : "🤖";

    const preview = document.createElement("span");
    preview.className = "selector-preview";
    preview.dataset.full = message.content;
    preview.dataset.short =
      message.content.length > 70
        ? `${message.content.slice(0, 70)}…`
        : message.content;
    preview.textContent = preview.dataset.short;

    row.append(checkbox, roleIcon, preview);
    selectorList.appendChild(row);

    checkbox.addEventListener("click", (event) => {
      const mouseEvent = event as MouseEvent;

      if (mouseEvent.shiftKey && lastShiftAnchorIndex !== null) {
        const start = Math.min(lastShiftAnchorIndex, index);
        const end = Math.max(lastShiftAnchorIndex, index);

        const allCheckboxes = selectorList.querySelectorAll<HTMLInputElement>(
          'input[type="checkbox"]',
        );

        for (let i = start; i <= end; i++) {
          const box = allCheckboxes[i];

          if (box) {
            box.checked = checkbox.checked;
          }
        }
      }

      lastShiftAnchorIndex = index;
      updateSelectorCount();
    });
  });

  applyExpandState();
  updateSelectorCount();
}

/*
 * "Expand" toggle: when on, every message preview shows full
 * text (wrapped, scrollable within the list) instead of a
 * truncated one-line preview.
 */
function applyExpandState(): void {
  const previews =
    selectorList.querySelectorAll<HTMLSpanElement>(".selector-preview");

  previews.forEach((preview) => {
    preview.textContent = selectorExpandToggle.checked
      ? (preview.dataset.full ?? "")
      : (preview.dataset.short ?? "");
  });

  selectorList.classList.toggle("expanded", selectorExpandToggle.checked);
}

selectorExpandToggle.addEventListener("change", applyExpandState);

function setAllCheckboxes(checked: boolean): void {
  const checkboxes = selectorList.querySelectorAll<HTMLInputElement>(
    'input[type="checkbox"]',
  );

  checkboxes.forEach((box) => {
    box.checked = checked;
  });

  updateSelectorCount();
}

selectorFilterAllButton.addEventListener("click", () => setAllCheckboxes(true));
selectorFilterNoneButton.addEventListener("click", () =>
  setAllCheckboxes(false),
);

selectorFilterQuestionsButton.addEventListener("click", () => {
  const checkboxes = selectorList.querySelectorAll<HTMLInputElement>(
    'input[type="checkbox"]',
  );

  checkboxes.forEach((box) => {
    const index = Number(box.dataset.index);
    box.checked = currentMessages[index]?.role === "user";
  });

  updateSelectorCount();
});

selectorFilterAnswersButton.addEventListener("click", () => {
  const checkboxes = selectorList.querySelectorAll<HTMLInputElement>(
    'input[type="checkbox"]',
  );

  checkboxes.forEach((box) => {
    const index = Number(box.dataset.index);
    box.checked = currentMessages[index]?.role === "assistant";
  });

  updateSelectorCount();
});

selectorFilterInvertButton.addEventListener("click", () => {
  const checkboxes = selectorList.querySelectorAll<HTMLInputElement>(
    'input[type="checkbox"]',
  );

  checkboxes.forEach((box) => {
    box.checked = !box.checked;
  });

  updateSelectorCount();
});

function getSelectedImageFiles(messages: Message[]): ExportImageFile[] {
  const selectedPaths = new Set(
    messages.flatMap((message) => message.imagePaths ?? []),
  );
  const filesByPath = new Map(
    currentImages.map((image) => [image.path, image]),
  );

  return [...selectedPaths]
    .map((path) => filesByPath.get(path))
    .filter((image): image is ExportImageFile => Boolean(image));
}

function createExportZipBlob(
  content: string,
  documentFilename: string,
  images: ExportImageFile[],
): Blob {
  const rootFolder = documentFilename.replace(/\.[^.]+$/, "");
  const encoder = new TextEncoder();
  const entries = [
    { path: `${rootFolder}/`, bytes: new Uint8Array() },
    {
      path: `${rootFolder}/${documentFilename}`,
      bytes: encoder.encode(content),
    },
    { path: `${rootFolder}/images/`, bytes: new Uint8Array() },
    ...images.map((image) => ({
      path: `${rootFolder}/${image.path}`,
      bytes: decodeBase64(image.base64),
    })),
  ];

  return createZipBlob(entries);
}

selectorCancelButton.addEventListener("click", () => {
  closeSelectorOverlay();
});

/*
 * Main "Export" button: always opens the selector panel,
 * every time - it never skips straight to a download.
 */
exportButton.addEventListener("click", async () => {
  devLog("AI Exporter: export clicked, opening selector");

  try {
    const settings = await loadSettings();
    const { messages, images, tabTitle, tabUrl, tabId } =
      await loadConversationMessages(settings.downloadImagesLocally);

    currentMessages = messages;
    currentImages = images;
    currentTabTitle = tabTitle;
    currentTabUrl = tabUrl;
    currentTabId = tabId;

    selectorPanelMessage.textContent = t("popup.selector.subtitle");
    selectorExpandToggle.checked = false;

    renderSelectorList(messages);

    selectorOverlay.classList.add("open");
    markOverlayOpened();
  } catch (error) {
    devError("AI Exporter: failed to load messages for export", error);

    const message = error instanceof Error ? error.message : String(error);

    showToast(
      message.length < 60 ? message : t("popup.error.loadConversationFailed"),
      3000,
    );
  }
});

/*
 * ---------------------------------------------------------
 * DOWNLOAD FROM SELECTOR
 * ---------------------------------------------------------
 */
selectorExportButton.addEventListener("click", async () => {
  const chosen = getSelectedMessages();

  if (chosen.length === 0) {
    return;
  }

  const format = selectorFormatSelect.value as ExportFormat;

  closeSelectorOverlay();
  setBusy(true);

  try {
    const settings = await loadSettings();
    const filename = buildFilename(currentTabTitle, format);
    let downloadFilename = filename;
    let blob: Blob;

    if (format === "pdf") {
      /*
       * PDF images are embedded inline in the document itself
       * (see pdf-export.ts), so there's no separate images/
       * folder to bundle into a ZIP the way the other formats
       * do - the PDF download always stands alone.
       */
      blob = await buildPdfBlob(
        chosen,
        getSelectedImageFiles(chosen),
        settings,
        currentTabTitle,
        currentTabUrl,
      );
    } else {
      const markdown = await buildMarkdownFromMessages(chosen);

      const { content, mimeType } = buildContentForFormat(
        format,
        markdown,
        chosen,
      );

      const selectedImages = getSelectedImageFiles(chosen);

      if (selectedImages.length > 0) {
        downloadFilename = buildFilename(currentTabTitle, "zip");
        blob = createExportZipBlob(content, filename, selectedImages);
      } else {
        blob = new Blob([content], { type: mimeType });
      }
    }

    /*
     * The actual chrome.downloads.download() call happens in
     * background.ts, not here. A blob: URL only stays readable
     * while the document that created it is alive, and Firefox
     * closes the extension popup as soon as the native "Save As"
     * dialog (saveAs: true) steals focus - so a blob: URL created
     * in the popup goes bad right as Firefox tries to read it,
     * and the download fails right after the person picks a
     * folder. (A data: URL doesn't fix this either - Firefox
     * rejects data: URLs outright for downloads.download with
     * saveAs: true.) The background page has no such lifecycle
     * issue, so the file bytes are handed over as base64 and
     * downloaded from there instead.
     */
    const downloadResponse = await chrome.runtime.sendMessage({
      type: "DOWNLOAD_START",
      filename: downloadFilename,
      mimeType: blob.type || "application/octet-stream",
      content: await encodeBlobBase64(blob),
      saveAs: settings.askWhereToSave,
      tabId: currentTabId,
    });

    if (!downloadResponse?.success) {
      throw new Error(downloadResponse?.error ?? "Download failed.");
    }

    const downloadId = downloadResponse.data.downloadId;

    devLog("AI Exporter: download started", downloadId);

    showToast(t("popup.toast.downloadStarted"));
  } catch (error) {
    devError("AI Exporter: download failed", error);

    const message = error instanceof Error ? error.message : String(error);

    showToast(
      message.length < 60 ? message : t("popup.toast.downloadFailed"),
      3000,
    );
  } finally {
    resetButtons();
  }
});

/*
 * ---------------------------------------------------------
 * SAVE TO GITHUB (from selector)
 * ---------------------------------------------------------
 *
 * Opens the existing repo-picker panel. Saves Markdown for
 * text-only conversations and a ZIP when selected messages
 * include image files.
 */
async function openGithubPanel(): Promise<void> {
  closeSelectorOverlay();
  githubPanel.classList.add("open");
  markOverlayOpened();

  githubPanelMessage.textContent = t("popup.github.loadingRepos");
  githubRepoSelect.innerHTML = "";
  githubRepoSelect.disabled = true;
  githubPanelSaveButton.disabled = true;

  const statusResponse = await chrome.runtime.sendMessage({
    type: "GITHUB_GET_STATUS",
  });

  if (!statusResponse?.success || !statusResponse.data?.connected) {
    githubPanelMessage.innerHTML = t("popup.github.notConnectedHtml");

    const settingsLink = document.getElementById("github-panel-settings-link");

    settingsLink?.addEventListener("click", (event) => {
      event.preventDefault();
      chrome.runtime.openOptionsPage();
    });

    return;
  }

  const reposResponse = await chrome.runtime.sendMessage({
    type: "GITHUB_LIST_REPOS",
  });

  if (!reposResponse?.success) {
    githubPanelMessage.textContent =
      reposResponse?.error ?? t("popup.github.failedToLoad");

    return;
  }

  const repos = reposResponse.data as { full_name: string }[];

  if (repos.length === 0) {
    githubPanelMessage.textContent = t("popup.github.noRepos");

    return;
  }

  githubPanelMessage.textContent = t("popup.github.chooseRepo");

  for (const repo of repos) {
    const option = document.createElement("option");
    option.value = repo.full_name;
    option.textContent = repo.full_name;
    githubRepoSelect.appendChild(option);
  }

  githubRepoSelect.disabled = false;
  githubPanelSaveButton.disabled = false;
}

selectorGithubButton.addEventListener("click", () => {
  const chosen = getSelectedMessages();

  if (chosen.length === 0) {
    return;
  }

  void openGithubPanel();
});

function closeGithubPanel(): void {
  githubPanel.classList.remove("open");
  markOverlayClosed();
}

githubPanelCancelButton.addEventListener("click", () => {
  closeGithubPanel();
});

function closeGithubConfirm(): void {
  githubConfirmOverlay.classList.remove("open");
  githubConfirmExportButton.disabled = false;
  githubConfirmExportButton.textContent = t("popup.githubConfirm.export");
  markOverlayClosed();
}

function openGithubConfirm(): void {
  githubConfirmOverlay.classList.add("open");
  markOverlayOpened();
}

githubConfirmCancelButton.addEventListener("click", () => {
  closeGithubConfirm();
});

githubConfirmOverlay.addEventListener("click", (event) => {
  if (event.target === githubConfirmOverlay) {
    closeGithubConfirm();
  }
});

async function saveToGitHub(): Promise<void> {
  const fullName = githubRepoSelect.value;

  if (!fullName) {
    return;
  }

  const chosen = getSelectedMessages();

  if (chosen.length === 0) {
    return;
  }

  closeGithubConfirm();
  setBusy(true);
  githubPanelSaveButton.textContent = t("popup.github.saving");

  try {
    const markdown = await buildMarkdownFromMessages(chosen);
    const markdownFilename = buildFilename(currentTabTitle, "md");
    const selectedImages = getSelectedImageFiles(chosen);
    let filename = markdownFilename;
    let content = markdown;
    let binary = false;

    if (selectedImages.length > 0) {
      filename = buildFilename(currentTabTitle, "zip");
      const archive = createExportZipBlob(
        markdown,
        markdownFilename,
        selectedImages,
      );
      content = await encodeBlobBase64(archive);
      binary = true;
    }

    const saveResponse = await chrome.runtime.sendMessage({
      type: "GITHUB_SAVE_FILE",
      fullName,
      filename,
      content,
      binary,
    });

    if (!saveResponse?.success) {
      throw new Error(saveResponse?.error ?? t("popup.error.githubSaveFailed"));
    }

    devLog("AI Exporter: saved to GitHub", saveResponse.data);

    closeGithubPanel();
    showToast(t("popup.toast.githubSaved"));
    openExportSuccess();
  } catch (error) {
    devError("AI Exporter: GitHub save failed", error);

    const message = error instanceof Error ? error.message : String(error);

    showToast(
      message.length < 60 ? message : t("popup.toast.githubSaveFailed"),
      3000,
    );
  } finally {
    resetButtons();
    githubPanelSaveButton.textContent = t("popup.github.save");
  }
}

githubPanelSaveButton.addEventListener("click", () => {
  devLog("AI Exporter: GitHub save confirmation requested");

  if (!githubRepoSelect.value) {
    return;
  }

  openGithubConfirm();
});

githubConfirmExportButton.addEventListener("click", () => {
  void saveToGitHub();
});

/*
 * ---------------------------------------------------------
 * EXPORT SUCCESS OVERLAY (shown on the ChatGPT page)
 * ---------------------------------------------------------
 *
 * The success overlay is NOT rendered in the popup anymore -
 * Chrome closes the popup automatically the moment focus
 * moves anywhere outside it, which happens routinely right
 * when a download finishes (e.g. a native Save As dialog
 * stealing focus, or the person just clicking back onto the
 * page). Instead, this sends a message to content.ts running
 * on the active ChatGPT tab, which injects and shows the
 * overlay directly on the page, where it survives the popup
 * closing.
 */
function openExportSuccess(): void {
  void (async () => {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });

    if (!tab.id) {
      return;
    }

    chrome.tabs
      .sendMessage(tab.id, { type: "SHOW_EXPORT_SUCCESS" })
      .catch(() => {
        /*
         * Content script may not be running in this tab (e.g.
         * the person navigated away from chatgpt.com after
         * starting the export) - nothing to show it on, so
         * just drop it silently. The file was still saved
         * successfully either way.
         */
      });
  })();
}

/*
 * Note: the download success overlay is NOT triggered from here
 * anymore. background.ts sends SHOW_EXPORT_SUCCESS to the
 * ChatGPT tab directly once a tracked download actually
 * completes (see the DOWNLOAD_START handler and the comment
 * above trackedDownloadIds in background.ts) - the popup is
 * usually long closed by then (Firefox closes it the instant
 * the native Save As dialog steals focus), so a popup-local
 * listener for DOWNLOAD_COMPLETE can't be relied on to still be
 * around to relay it.
 */

/*
 * ---------------------------------------------------------
 * GITHUB STAR
 * ---------------------------------------------------------
 */
githubStarButton.addEventListener("click", async () => {
  githubStarButton.disabled = true;
  githubStarButton.textContent = t("popup.star.opening");

  try {
    const response = await chrome.runtime.sendMessage({
      type: "GITHUB_STAR_PROJECT",
    });

    if (response?.success) {
      showToast(t("popup.toast.starThanks"));
      githubStarButton.disabled = false;
      githubStarButton.textContent = t("popup.support.star");

      return;
    }
  } catch (error) {
    devWarn("AI Exporter: direct GitHub star failed", error);
  }

  await chrome.tabs.create({
    url: `https://github.com/${PROJECT_REPOSITORY}`,
  });

  showToast(t("popup.toast.openedGithub"));
  githubStarButton.disabled = false;
  githubStarButton.textContent = t("popup.support.star");
});

/*
 * ---------------------------------------------------------
 * BUY ME A COFFEE
 * ---------------------------------------------------------
 */
buyCoffeeButton.addEventListener("click", () => {
  void chrome.tabs.create({ url: COFFEE_URL });
});
