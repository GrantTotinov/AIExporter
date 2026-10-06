import { loadSettings } from "./settings.ts";
import { initI18n, applyTranslations, getLocale, t } from "./i18n.ts";
import { stripMarkdown } from "./markdown-strip.ts";
import { stripNotes } from "./source-notes.ts";
import { encodeBlobBase64 } from "./zip.ts";
import {
  buildDocumentBlob,
  fileExtension,
  isDocumentFormat,
} from "./file-export.ts";
import { buildClipboardContent } from "./clipboard-export.ts";
import { buildNotionPage, notionPageTitle } from "./notion-blocks.ts";
import type { NotionPageOption } from "./notion.ts";
import {
  EXPORT_FORMATS,
  SITE_ONLY_TITLE,
  buildContentForFormat,
  buildFilename,
  buildMarkdownFromMessages,
  createExportZipBlob,
  type ExportFormat,
  type ExportImageFile,
  type Message,
} from "./export-builders.ts";
import { buildHandoffPrompt } from "./handoff.ts";
import { buildCitations, type Citations } from "./citation.ts";
import {
  CHAT_SITES,
  CHAT_SITE_NAMES,
  CHAT_SITE_START_URLS,
  PAGE_READ_SITES,
  getChatSite,
  isChatConversationUrl,
  stripChatSiteSuffix,
  type ChatSite,
} from "./chat-sites.ts";
import {
  UPDATE_NOTICE_KEY,
  UPDATE_STATE_KEY,
  type UpdateState,
  type UpdateView,
  getRunningVersion,
  getUpdateView,
  loadUpdateState,
  storeInstallsUpdates,
} from "./updates.ts";

async function applyStoredTheme(): Promise<void> {
  const settings = await loadSettings();

  if (settings.theme === "system") {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = settings.theme;
  }
}

void applyStoredTheme();

const PROJECT_REPOSITORY = "GrantTotinov/AIExporter";
const COFFEE_URL = "https://buymeacoffee.com/granttotinov";
const NEW_REPOSITORY_URL = "https://github.com/new";

/*
 * What the popup remembers between uses, in chrome.storage.local:
 * the file type picked last and the GitHub repo saved to last.
 */
const EXPORT_FORMAT_KEY = "popupExportFormat";
const GITHUB_REPO_KEY = "popupGithubRepo";
const NOTION_PAGE_KEY = "popupNotionPage";

/* Where a saved Notion page may be opened from the popup */
const NOTION_URL_PATTERN = /^https:\/\/(?:[a-z0-9-]+\.)*notion\.(?:so|site|com)\//;

const TOAST_MS = 2500;
/* Errors stay up longer: there's more to read, and it matters */
const ERROR_TOAST_MS = 6000;
/*
 * Error messages from the content script and background.ts are
 * shown as they are when they're short ("Sign in to Gemini to
 * export this conversation."). Longer ones are technical, and a
 * plain explanation of what to do replaces them.
 */
const MAX_ERROR_LENGTH = 90;

const SVG_NS = "http://www.w3.org/2000/svg";

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


const FORMAT_ICONS: Record<ExportFormat, string> = {
  pdf: "i-file-text",
  docx: "i-file-word",
  html: "i-code",
  md: "i-hash",
  txt: "i-text",
  json: "i-braces",
  csv: "i-table",
  png: "i-image",
  xlsx: "i-sheet",
};

/* The fields of a GitHub repo the popup uses (see github.ts) */
interface GithubRepoOption {
  full_name: string;
  private?: boolean;
}

/*
 * ---------------------------------------------------------
 * DOM REFERENCES
 * ---------------------------------------------------------
 */

/* Main screen */
const mainView = document.getElementById("main-view") as HTMLDivElement;
const optionsLink = document.getElementById(
  "options-link",
) as HTMLButtonElement;
const chatCard = document.getElementById("chat-card") as HTMLElement;
const chatCardIcon = chatCard.querySelector(
  "#chat-card-icon use",
) as SVGUseElement;
const chatReady = document.getElementById("chat-ready") as HTMLDivElement;
const chatSiteLabel = document.getElementById(
  "chat-site-label",
) as HTMLParagraphElement;
const chatTitle = document.getElementById("chat-title") as HTMLParagraphElement;
const chatOpenHint = document.getElementById(
  "chat-open-hint",
) as HTMLDivElement;
const chatOpenText = document.getElementById(
  "chat-open-text",
) as HTMLParagraphElement;
const chatUnsupported = document.getElementById(
  "chat-unsupported",
) as HTMLDivElement;
const siteLinksRow = document.getElementById("site-links") as HTMLDivElement;
const siteLinks = Array.from(
  siteLinksRow.querySelectorAll<HTMLButtonElement>("[data-site-url]"),
);
const exportButton = document.getElementById("export") as HTMLButtonElement;
const copyButton = document.getElementById("copy") as HTMLButtonElement;
const bulkExportButton = document.getElementById(
  "bulk-export",
) as HTMLButtonElement;
const googleDocsButton = document.getElementById(
  "to-google-docs",
) as HTMLButtonElement;
const continueButton = document.getElementById(
  "continue-chat",
) as HTMLButtonElement;
const continuePanel = document.getElementById(
  "continue-panel",
) as HTMLDivElement;
const continueTargets = document.getElementById(
  "continue-targets",
) as HTMLDivElement;
const citeButton = document.getElementById("cite-chat") as HTMLButtonElement;
const citePanel = document.getElementById("cite-panel") as HTMLDivElement;
const githubStarButton = document.getElementById(
  "github-star",
) as HTMLButtonElement;
const githubStarLabel = document.getElementById(
  "github-star-label",
) as HTMLSpanElement;
const buyCoffeeButton = document.getElementById(
  "buy-coffee",
) as HTMLButtonElement;

/* Update banner (top) and version/update status (footer) */
const updateBanner = document.getElementById("update-banner") as HTMLDivElement;
const updateBannerTitle = document.getElementById(
  "update-banner-title",
) as HTMLParagraphElement;
const updateBannerMessage = document.getElementById(
  "update-banner-message",
) as HTMLParagraphElement;
const updateApplyButton = document.getElementById(
  "update-apply",
) as HTMLButtonElement;
const appVersionLabel = document.getElementById(
  "app-version",
) as HTMLSpanElement;
const updateStatusButton = document.getElementById(
  "update-status",
) as HTMLButtonElement;
const updateStatusText = document.getElementById(
  "update-status-text",
) as HTMLSpanElement;

/* "Save as a file" screen: pick messages and a file type */
const exportView = document.getElementById("export-view") as HTMLElement;
const selectorCancelButton = document.getElementById(
  "selector-cancel",
) as HTMLButtonElement;
const exportTitle = document.getElementById(
  "export-title",
) as HTMLHeadingElement;
const exportSubtitle = document.getElementById(
  "export-subtitle",
) as HTMLParagraphElement;
const selectorCount = document.getElementById(
  "selector-count",
) as HTMLSpanElement;
const selectAllCheckbox = document.getElementById(
  "selector-select-all",
) as HTMLInputElement;
const selectorFilterQuestionsButton = document.getElementById(
  "selector-filter-questions",
) as HTMLButtonElement;
const selectorFilterAnswersButton = document.getElementById(
  "selector-filter-answers",
) as HTMLButtonElement;
const selectorFilterInvertButton = document.getElementById(
  "selector-filter-invert",
) as HTMLButtonElement;
const selectorList = document.getElementById("selector-list") as HTMLDivElement;
const selectorExpandToggle = document.getElementById(
  "selector-expand-toggle",
) as HTMLInputElement;
const formatInputs = Array.from(
  document.querySelectorAll<HTMLInputElement>('input[name="format"]'),
);
const formatHintIcon = document.getElementById(
  "format-hint-icon",
) as unknown as SVGUseElement;
const formatHintText = document.getElementById(
  "format-hint-text",
) as HTMLSpanElement;
const selectorExportButton = document.getElementById(
  "selector-export",
) as HTMLButtonElement;
const selectorExportLabel = document.getElementById(
  "selector-export-label",
) as HTMLSpanElement;
const selectorGithubButton = document.getElementById(
  "selector-github-button",
) as HTMLButtonElement;
const selectorNotionButton = document.getElementById(
  "selector-notion-button",
) as HTMLButtonElement;

/* "Save to GitHub" screen */
const githubView = document.getElementById("github-view") as HTMLElement;
const githubPanelCancelButton = document.getElementById(
  "github-panel-cancel",
) as HTMLButtonElement;
const githubTitle = document.getElementById(
  "github-title",
) as HTMLHeadingElement;
const githubState = document.getElementById("github-state") as HTMLDivElement;
const githubStateSpinner = document.getElementById(
  "github-state-spinner",
) as HTMLSpanElement;
const githubStateIcon = document.getElementById(
  "github-state-icon",
) as unknown as SVGSVGElement;
const githubStateIconUse = document.getElementById(
  "github-state-icon-use",
) as unknown as SVGUseElement;
const githubStateTitle = document.getElementById(
  "github-state-title",
) as HTMLParagraphElement;
const githubStateText = document.getElementById(
  "github-state-text",
) as HTMLParagraphElement;
const githubStateAction = document.getElementById(
  "github-state-action",
) as HTMLButtonElement;
const githubStateActionIcon = document.getElementById(
  "github-state-action-icon",
) as unknown as SVGUseElement;
const githubStateActionLabel = document.getElementById(
  "github-state-action-label",
) as HTMLSpanElement;
const githubStateSecondary = document.getElementById(
  "github-state-secondary",
) as HTMLButtonElement;
const githubForm = document.getElementById("github-form") as HTMLDivElement;
const githubRepoSelect = document.getElementById(
  "github-repo-select",
) as HTMLSelectElement;
const githubVisibility = document.getElementById(
  "github-visibility",
) as HTMLParagraphElement;
const githubVisibilityIcon = document.getElementById(
  "github-visibility-icon",
) as unknown as SVGUseElement;
const githubVisibilityText = document.getElementById(
  "github-visibility-text",
) as HTMLSpanElement;
const githubFileName = document.getElementById(
  "github-file-name",
) as HTMLSpanElement;
const githubFooter = document.getElementById("github-footer") as HTMLElement;
const githubPanelSaveButton = document.getElementById(
  "github-panel-save",
) as HTMLButtonElement;
const githubSaveLabel = document.getElementById(
  "github-save-label",
) as HTMLSpanElement;

/* Confirmation before saving into a public repository */
const githubConfirm = document.getElementById(
  "github-confirm",
) as HTMLDialogElement;
const githubConfirmCancelButton = document.getElementById(
  "github-confirm-cancel",
) as HTMLButtonElement;
const githubConfirmExportButton = document.getElementById(
  "github-confirm-export",
) as HTMLButtonElement;

/* "Save to Notion" screen */
const notionView = document.getElementById("notion-view") as HTMLElement;
const notionPanelCancelButton = document.getElementById(
  "notion-panel-cancel",
) as HTMLButtonElement;
const notionTitle = document.getElementById(
  "notion-title",
) as HTMLHeadingElement;
const notionState = document.getElementById("notion-state") as HTMLDivElement;
const notionStateSpinner = document.getElementById(
  "notion-state-spinner",
) as HTMLSpanElement;
const notionStateIcon = document.getElementById(
  "notion-state-icon",
) as unknown as SVGSVGElement;
const notionStateIconUse = document.getElementById(
  "notion-state-icon-use",
) as unknown as SVGUseElement;
const notionStateTitle = document.getElementById(
  "notion-state-title",
) as HTMLParagraphElement;
const notionStateText = document.getElementById(
  "notion-state-text",
) as HTMLParagraphElement;
const notionStateAction = document.getElementById(
  "notion-state-action",
) as HTMLButtonElement;
const notionStateActionIcon = document.getElementById(
  "notion-state-action-icon",
) as unknown as SVGUseElement;
const notionStateActionLabel = document.getElementById(
  "notion-state-action-label",
) as HTMLSpanElement;
const notionStateSecondary = document.getElementById(
  "notion-state-secondary",
) as HTMLButtonElement;
const notionForm = document.getElementById("notion-form") as HTMLDivElement;
const notionPageSelect = document.getElementById(
  "notion-page-select",
) as HTMLSelectElement;
const notionPageName = document.getElementById(
  "notion-page-name",
) as HTMLSpanElement;
const notionFooter = document.getElementById("notion-footer") as HTMLElement;
const notionPanelSaveButton = document.getElementById(
  "notion-panel-save",
) as HTMLButtonElement;
const notionSaveLabel = document.getElementById(
  "notion-save-label",
) as HTMLSpanElement;

/* Toast (on-screen feedback for button actions) */
const toast = document.getElementById("toast") as HTMLDivElement;
const toastText = document.getElementById("toast-text") as HTMLSpanElement;

/*
 * ---------------------------------------------------------
 * STATE
 * ---------------------------------------------------------
 */

/*
 * What the current tab is:
 *   loading     - not known yet (the first few milliseconds)
 *   ready       - a conversation on a supported site
 *   open-chat   - a supported site, but not a conversation
 *   unsupported - any other page
 */
type ChatState = "loading" | "ready" | "open-chat" | "unsupported";

let chatState: ChatState = "loading";
/* The chat site the active tab is on */
let chatSite: ChatSite | null = null;
/* A conversation is loading, or a file is being made or saved */
let busy = false;
let starring = false;
let installingUpdate = false;
let selectedCount = 0;

/* The conversation loaded for the export screens */
let currentMessages: Message[] = [];
let currentImages: ExportImageFile[] = [];
let currentTabTitle: string | undefined;
let currentTabUrl: string | undefined;
let currentTabId: number | undefined;
/* Settings.fileNameTemplate, as read when the chat was loaded */
let currentFileNameTemplate = "";
let lastShiftAnchorIndex: number | null = null;

let githubRepos: GithubRepoOption[] = [];
/* Ignores a repo list that arrives after the person left */
let githubLoadId = 0;
let githubStateActionHandler: (() => void) | null = null;
let githubStateSecondaryHandler: (() => void) | null = null;

let notionPages: NotionPageOption[] = [];
/* Ignores a page list that arrives after the person left */
let notionLoadId = 0;
let notionStateActionHandler: (() => void) | null = null;
let notionStateSecondaryHandler: (() => void) | null = null;

/*
 * ---------------------------------------------------------
 * SCREENS
 * ---------------------------------------------------------
 *
 * The popup has four screens: the main one, "Save as a file"
 * (pick the messages and a file type), "Save to GitHub" and
 * "Save to Notion".
 * One shows at a time. The last two take the popup's full
 * height (body.is-full), so a long message list scrolls inside
 * them while their buttons stay in view.
 */
type ScreenName = "main" | "export" | "github" | "notion";

const screens: Record<ScreenName, HTMLElement> = {
  main: mainView,
  export: exportView,
  github: githubView,
  notion: notionView,
};

let currentScreen: ScreenName = "main";

function showScreen(name: ScreenName): void {
  for (const [screenName, screen] of Object.entries(screens)) {
    screen.hidden = screenName !== name;
  }

  document.body.classList.toggle("is-full", name !== "main");
  currentScreen = name;

  /* Keyboard and screen reader users land on the new screen */
  const focusTarget =
    name === "export"
      ? exportTitle
      : name === "github"
        ? githubTitle
        : name === "notion"
          ? notionTitle
          : exportButton;

  focusTarget.focus({ preventScroll: true });
}

selectorCancelButton.addEventListener("click", () => {
  showScreen("main");
});

githubPanelCancelButton.addEventListener("click", () => {
  githubLoadId++;
  showScreen("export");
});

notionPanelCancelButton.addEventListener("click", () => {
  notionLoadId++;
  showScreen("export");
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || busy || githubConfirm.open) {
    return;
  }

  if (currentScreen === "github" || currentScreen === "notion") {
    event.preventDefault();
    githubLoadId++;
    notionLoadId++;
    showScreen("export");
  } else if (currentScreen === "export") {
    event.preventDefault();
    showScreen("main");
  }
});

optionsLink.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

/*
 * ---------------------------------------------------------
 * TOAST
 * ---------------------------------------------------------
 */
let toastTimeoutId: number | undefined;

function showToast(
  message: string,
  tone: "success" | "error" = "success",
): void {
  toastText.textContent = message;
  toast.dataset.tone = tone;
  toast.classList.add("is-visible");

  window.clearTimeout(toastTimeoutId);

  toastTimeoutId = window.setTimeout(
    () => {
      toast.classList.remove("is-visible");
    },
    tone === "error" ? ERROR_TOAST_MS : TOAST_MS,
  );
}

function errorMessage(error: unknown, fallbackKey: string): string {
  const message = error instanceof Error ? error.message : String(error);

  return message && message.length <= MAX_ERROR_LENGTH
    ? message
    : t(fallbackKey);
}

function showErrorToast(error: unknown, fallbackKey: string): void {
  showToast(errorMessage(error, fallbackKey), "error");
}

function isMac(): boolean {
  return navigator.userAgent.includes("Mac");
}

/*
 * ---------------------------------------------------------
 * BUTTON STATE
 * ---------------------------------------------------------
 *
 * One place decides which buttons can be pressed, from the
 * current tab, the selection and whatever is in progress -
 * a second click mid-load used to start a second, overlapping
 * fetch.
 */
function updateButtons(): void {
  const chatAvailable = chatState === "loading" || chatState === "ready";

  exportButton.disabled = busy || !chatAvailable;
  copyButton.disabled = busy || !chatAvailable;
  googleDocsButton.disabled = busy || !chatAvailable;
  continueButton.disabled = busy || !chatAvailable;
  citeButton.disabled = busy || !chatAvailable;

  for (const target of continueTargets.querySelectorAll("button")) {
    target.disabled = busy || !chatAvailable;
  }

  for (const copy of citePanel.querySelectorAll("button")) {
    copy.disabled = busy;
  }
  // Any page of a chat site lists the person's chats, not only a
  // conversation - but a site read from the page has only its open one.
  bulkExportButton.disabled =
    busy ||
    chatState === "unsupported" ||
    (chatSite !== null && PAGE_READ_SITES.includes(chatSite));
  selectorExportButton.disabled = busy || selectedCount === 0;
  selectorGithubButton.disabled = busy || selectedCount === 0;
  selectorNotionButton.disabled = busy || selectedCount === 0;
  githubPanelSaveButton.disabled = busy || githubRepoSelect.value === "";
  notionPanelSaveButton.disabled = busy || notionPageSelect.value === "";
  selectorCancelButton.disabled = busy;
  githubPanelCancelButton.disabled = busy;
  notionPanelCancelButton.disabled = busy;
  githubStarButton.disabled = busy || starring;
  buyCoffeeButton.disabled = busy;
  updateApplyButton.disabled = busy || installingUpdate;
}

function setBusy(value: boolean): void {
  busy = value;
  updateButtons();
}

/*
 * Lets the browser paint a "Preparing…" label before work that
 * can keep the page busy for a while (building a long PDF).
 */
function waitForPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => setTimeout(resolve, 0));
  });
}

/*
 * ---------------------------------------------------------
 * PROGRESS ON THE MAIN SCREEN'S BUTTONS
 * ---------------------------------------------------------
 *
 * While a conversation loads, the button that was pressed
 * shows a spinner and, in place of its description, what's
 * happening ("Reading the chat… 120 messages so far"). The
 * other buttons are disabled meanwhile.
 */
let progressButton: HTMLButtonElement | null = null;

function startProgress(button: HTMLButtonElement, message: string): void {
  progressButton = button;
  button.classList.add("is-busy");
  setProgressMessage(message);
  setBusy(true);
}

function setProgressMessage(message: string): void {
  const description =
    progressButton?.querySelector<HTMLElement>(".action-desc");

  if (description) {
    description.textContent = message;
  }
}

function stopProgress(): void {
  if (progressButton) {
    progressButton.classList.remove("is-busy");

    const description =
      progressButton.querySelector<HTMLElement>(".action-desc");

    if (description?.dataset.i18n) {
      description.textContent = t(description.dataset.i18n);
    }

    progressButton = null;
  }

  setBusy(false);
}

/*
 * The content script sends EXPORT_PROGRESS messages while it
 * pages through the conversation, so long conversations don't
 * look frozen.
 */
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "EXPORT_PROGRESS" || !progressButton) {
    return;
  }

  setProgressMessage(
    t("popup.loading.progress", { count: Number(message.collected) || 0 }),
  );
});

/*
 * ---------------------------------------------------------
 * THE CURRENT CHAT
 * ---------------------------------------------------------
 *
 * The card at the top says which conversation the buttons will
 * save, or - on another page - what to do first, instead of
 * letting an export fail with an error.
 */
async function getActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });

  return tab;
}


function chatTitleFor(tabTitle: string | undefined): string {
  const title = stripChatSiteSuffix(tabTitle ?? "");

  return title && !SITE_ONLY_TITLE.test(title)
    ? title
    : t("popup.chat.untitled");
}

function renderChatCard(tab: chrome.tabs.Tab | undefined): void {
  const site = getChatSite(tab?.url);

  chatSite = site;

  chatState =
    site === null
      ? "unsupported"
      : isChatConversationUrl(tab?.url)
        ? "ready"
        : "open-chat";

  chatCard.dataset.state = chatState;
  chatReady.hidden = chatState !== "ready";
  chatOpenHint.hidden = chatState !== "open-chat";
  chatUnsupported.hidden = chatState !== "unsupported";
  siteLinksRow.hidden = chatState !== "unsupported";
  chatCardIcon.setAttribute(
    "href",
    chatState === "ready" ? "#i-chat" : "#i-compass",
  );

  if (site !== null) {
    const siteName = CHAT_SITE_NAMES[site];

    chatSiteLabel.textContent = t("popup.chat.label", { site: siteName });
    chatTitle.textContent = chatTitleFor(tab?.title);
    chatOpenText.textContent = t("popup.chat.openText", { site: siteName });
  }

  updateButtons();
}

for (const link of siteLinks) {
  link.addEventListener("click", () => {
    void chrome.tabs.create({ url: link.dataset.siteUrl });
  });
}

function labelSiteLinks(): void {
  for (const link of siteLinks) {
    const label = t("popup.chat.openSite", {
      site: link.dataset.siteName ?? "",
    });

    link.setAttribute("aria-label", label);
    link.title = label;
  }
}

/*
 * Every chat site's pages get the content script (see the top of
 * chat-sites.ts), but Chrome only adds it to pages loaded after
 * AI Exporter was installed or updated. A tab that was already
 * open has nothing that answers the ping, and reloading it brings
 * one in.
 */
const RELOAD_SETTLE_MS = 2000;
const CONTENT_SCRIPT_WAIT_MS = 15_000;
const CONTENT_SCRIPT_POLL_MS = 500;

async function hasContentScript(tabId: number): Promise<boolean> {
  try {
    const answer = await chrome.tabs.sendMessage(tabId, {
      type: "AIEXPORTER_PING",
    });

    return answer?.ok === true;
  } catch {
    /* Nothing in the tab answers. */
    return false;
  }
}

/* Until the tab's (re)loaded page has the content script, or time runs out. */
async function waitForContentScript(tabId: number): Promise<void> {
  const deadline = Date.now() + CONTENT_SCRIPT_WAIT_MS;

  while (!(await hasContentScript(tabId)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, CONTENT_SCRIPT_POLL_MS));
  }
}

async function ensureContentScript(tabId: number, site: ChatSite): Promise<void> {
  if (await hasContentScript(tabId)) {
    return;
  }

  devWarn("AI Exporter: no content script, reloading tab");

  setProgressMessage(
    t("popup.loading.reconnecting", { site: CHAT_SITE_NAMES[site] }),
  );

  await chrome.tabs.reload(tabId);

  /*
   * Gives the page time to start up - ChatGPT's own signed-in
   * requests are what pageBridge.js copies its headers from.
   */
  await new Promise((resolve) => setTimeout(resolve, RELOAD_SETTLE_MS));
  await waitForContentScript(tabId);

  setProgressMessage(t("popup.loading.default"));
}

/*
 * ---------------------------------------------------------
 * LOAD CONVERSATION MESSAGES
 * ---------------------------------------------------------
 *
 * Fetches the raw message list from the content script, with
 * no formatting applied. `trigger` - the button that was
 * pressed - shows the progress the whole time, and every other
 * button stays disabled until it's done.
 */
async function loadConversationMessages(
  trigger: HTMLButtonElement,
  downloadImagesLocally: boolean,
): Promise<{
  messages: Message[];
  images: ExportImageFile[];
  tabTitle: string | undefined;
  tabUrl: string | undefined;
  tabId: number | undefined;
}> {
  startProgress(trigger, t("popup.loading.default"));

  try {
    const tab = await getActiveTab();

    if (!tab?.id) {
      throw new Error(t("popup.error.noActiveTab"));
    }

    const site = getChatSite(tab.url);

    if (!site) {
      throw new Error(t("popup.error.openSupportedSite"));
    }

    devLog("AI Exporter: requesting conversation");

    await ensureContentScript(tab.id, site);

    let response;

    try {
      response = await chrome.tabs.sendMessage(tab.id, {
        type: "LOAD_CONVERSATION",
        downloadImagesLocally,
      });
    } catch (sendError) {
      /*
       * The page went away in between - reloaded, say - and its
       * content script with it. The page that loads next gets a
       * new one.
       */
      devWarn("AI Exporter: lost the content script, asking again", sendError);

      setProgressMessage(
        t("popup.loading.reconnecting", { site: CHAT_SITE_NAMES[site] }),
      );

      await waitForContentScript(tab.id);

      setProgressMessage(t("popup.loading.default"));

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
    stopProgress();
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
 * for saving a file. The chat goes on the clipboard as Markdown
 * and as formatted text, so it pastes well into a Markdown editor
 * and into Word, Google Docs or an email alike (see
 * clipboard-export.ts).
 */
copyButton.addEventListener("click", async () => {
  devLog("AI Exporter: copy clicked");

  try {
    const { messages, tabTitle, tabUrl } = await loadConversationMessages(
      copyButton,
      false,
    );

    const { text, html } = await buildClipboardContent(messages, {
      tabTitle,
      tabUrl,
    });

    const copyResponse = await chrome.runtime.sendMessage({
      type: "COPY_TO_CLIPBOARD",
      data: text,
      html,
    });

    devLog("AI Exporter: clipboard response", copyResponse);

    if (!copyResponse?.success) {
      throw new Error(
        copyResponse?.error ?? t("popup.error.copyMarkdownFailed"),
      );
    }

    showToast(
      t("popup.toast.copied", {
        shortcut: isMac() ? "⌘V" : t("popup.pasteShortcut"),
      }),
    );
  } catch (error) {
    devError("AI Exporter: copy failed", error);
    showErrorToast(error, "popup.toast.copyFailed");
  }
});

/*
 * The copy button names the keyboard shortcut that does the same
 * without opening the popup (see background.ts) - the keys the
 * browser gave it, if any.
 */
async function showCopyShortcut(): Promise<void> {
  try {
    const commands = (await chrome.commands?.getAll()) ?? [];
    const shortcut = commands.find(
      (command) => command.name === "copy-chat",
    )?.shortcut;

    if (shortcut) {
      copyButton.title = t("popup.copyShortcut", { shortcut });
    }
  } catch (error) {
    devWarn("AI Exporter: couldn't read the keyboard shortcuts", error);
  }
}

/*
 * ---------------------------------------------------------
 * GOOGLE DOCS, CONTINUE IN ANOTHER AI, CITE
 * ---------------------------------------------------------
 *
 * Google Docs: the chat is copied as formatted text (the same as
 * "Copy the whole chat") and a new Google Doc opens to paste it
 * into - no Google account access needed. Continue in: the chat is
 * copied as one prompt (see handoff.ts) and the chosen assistant
 * opens. A new tab closes the popup, so it opens a moment after
 * the toast saying what to do.
 */
const OPEN_TAB_DELAY_MS = 1400;

function pasteShortcut(): string {
  return isMac() ? "⌘V" : t("popup.pasteShortcut");
}

async function copyToClipboard(text: string, html?: string): Promise<void> {
  const response = await chrome.runtime.sendMessage({
    type: "COPY_TO_CLIPBOARD",
    data: text,
    ...(html ? { html } : {}),
  });

  if (!response?.success) {
    throw new Error(response?.error ?? t("popup.error.copyMarkdownFailed"));
  }
}

function openTabSoon(url: string): void {
  setTimeout(() => {
    void chrome.tabs.create({ url });
  }, OPEN_TAB_DELAY_MS);
}

/* The page that opens ChatGPT's and Claude's data exports (archive.ts) */
document.getElementById("open-archive")?.addEventListener("click", () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL("archive.html") });
  window.close();
});

googleDocsButton.addEventListener("click", async () => {
  try {
    const { messages, tabTitle, tabUrl } = await loadConversationMessages(
      googleDocsButton,
      false,
    );
    const { text, html } = await buildClipboardContent(messages, {
      tabTitle,
      tabUrl,
    });

    await copyToClipboard(text, html);
    showToast(t("popup.toast.googleDocs", { shortcut: pasteShortcut() }));
    openTabSoon("https://docs.new/");
  } catch (error) {
    devError("AI Exporter: Google Docs handoff failed", error);
    showErrorToast(error, "popup.toast.copyFailed");
  }
});

function togglePanel(button: HTMLButtonElement, panel: HTMLElement): boolean {
  const open = panel.hidden === true;

  for (const [otherButton, otherPanel] of [
    [continueButton, continuePanel],
    [citeButton, citePanel],
  ] as const) {
    otherPanel.hidden = true;
    otherButton.setAttribute("aria-expanded", "false");
  }

  panel.hidden = !open;
  button.setAttribute("aria-expanded", String(open));

  return open;
}

for (const site of CHAT_SITES) {
  const target = document.createElement("button");

  target.type = "button";
  target.className = "site-link";
  target.textContent = CHAT_SITE_NAMES[site];
  target.addEventListener("click", async () => {
    try {
      const { messages, tabTitle, tabUrl } = await loadConversationMessages(
        target,
        false,
      );
      const from = getChatSite(tabUrl);
      const title = chatTitleFor(tabTitle);
      const prompt = buildHandoffPrompt(messages, {
        intro: t("handoff.intro", {
          site: from ? CHAT_SITE_NAMES[from] : "AI",
          title,
        }),
        start: t("handoff.start"),
        end: t("handoff.end"),
        omitted: t("handoff.omitted"),
        user: t("handoff.user"),
        assistant: t("handoff.assistant"),
      });

      await copyToClipboard(prompt);
      showToast(
        t("popup.toast.continue", {
          site: CHAT_SITE_NAMES[site],
          shortcut: pasteShortcut(),
        }),
      );
      openTabSoon(CHAT_SITE_START_URLS[site]);
    } catch (error) {
      devError("AI Exporter: continue in another AI failed", error);
      showErrorToast(error, "popup.toast.copyFailed");
    }
  });
  continueTargets.append(target);
}

continueButton.addEventListener("click", () => {
  togglePanel(continueButton, continuePanel);
  updateButtons();
});

let citations: Citations | null = null;

citeButton.addEventListener("click", async () => {
  if (!togglePanel(citeButton, citePanel)) {
    return;
  }

  try {
    const { messages, tabUrl } = await loadConversationMessages(citeButton, false);

    citations = buildCitations(messages, tabUrl);

    for (const style of ["apa", "mla", "chicago"] as const) {
      const text = document.getElementById(`cite-${style}`);

      if (text) {
        text.textContent = citations[style];
      }
    }
  } catch (error) {
    togglePanel(citeButton, citePanel);
    devError("AI Exporter: citation failed", error);
    showErrorToast(error, "popup.toast.copyFailed");
  }
});

for (const copy of citePanel.querySelectorAll<HTMLButtonElement>(".citation-copy")) {
  copy.addEventListener("click", async () => {
    const style = copy.dataset.style as keyof Citations | undefined;

    if (!citations || !style) {
      return;
    }

    try {
      await copyToClipboard(citations[style]);
      showToast(t("popup.toast.citeCopied"));
    } catch (error) {
      showErrorToast(error, "popup.toast.copyFailed");
    }
  });
}

/*
 * ---------------------------------------------------------
 * "SAVE AS A FILE" SCREEN
 * ---------------------------------------------------------
 *
 * Opened by the main screen's first button, every time. It
 * loads the whole conversation and lists it, so the person can
 * leave messages out (Select all, the Questions/Answers quick
 * picks, Shift+Click to tick a range, and a switch to read
 * messages in full), then picks a file type and downloads it,
 * or moves on to saving it to GitHub.
 */
function messageCheckboxes(): HTMLInputElement[] {
  return Array.from(
    selectorList.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
  );
}

function getSelectedMessages(): Message[] {
  return messageCheckboxes()
    .filter((box) => box.checked)
    .map((box) => currentMessages[Number(box.dataset.index)])
    .filter((message): message is Message => Boolean(message));
}

function updateSelectorCount(): void {
  const checkboxes = messageCheckboxes();
  const total = checkboxes.length;

  selectedCount = checkboxes.filter((box) => box.checked).length;

  selectorCount.textContent =
    selectedCount === 0
      ? t("popup.selector.noneSelected")
      : t("popup.selector.count", { checked: selectedCount, total });
  selectorCount.classList.toggle("is-warning", selectedCount === 0);

  selectAllCheckbox.checked = total > 0 && selectedCount === total;
  selectAllCheckbox.indeterminate = selectedCount > 0 && selectedCount < total;

  updateFormatHint();
  updateButtons();
}

function createIcon(name: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  const use = document.createElementNS(SVG_NS, "use");

  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  use.setAttribute("href", `#${name}`);
  svg.append(use);

  return svg;
}

/*
 * The list shows a message as it reads, not as Markdown: no
 * ## or ** marks, and links and images without their
 * addresses.
 */
function previewText(content: string): string {
  const imageLabel = `[${t("popup.selector.image")}]`;

  const text = stripMarkdown(
    stripNotes(content)
      .replace(/!\[[^\]]*\]\((?:<[^>]+>|[^)]+)\)/g, () => imageLabel)
      .replace(/\[([^\]]*)\]\((?:<[^>]+>|[^)]+)\)/g, "$1"),
  );

  return text || t("popup.selector.noText");
}

function renderSelectorList(messages: Message[]): void {
  const site = getChatSite(currentTabUrl);
  const assistantName = site
    ? CHAT_SITE_NAMES[site]
    : t("popup.selector.assistant");
  const rows = document.createDocumentFragment();

  messages.forEach((message, index) => {
    const isUser = message.role === "user";

    const row = document.createElement("label");
    row.className = "message";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.dataset.index = String(index);

    const avatar = document.createElement("span");
    avatar.className = `avatar avatar--${isUser ? "user" : "assistant"}`;
    avatar.append(createIcon(isUser ? "i-user" : "i-sparkle"));

    const role = document.createElement("span");
    role.className = "message-role";
    role.textContent = isUser ? t("popup.selector.you") : assistantName;

    // <bdi> lets a Hebrew or Arabic message read right to left
    // without flipping the role label in front of it.
    const preview = document.createElement("bdi");
    preview.textContent = previewText(message.content);

    const text = document.createElement("span");
    text.className = "message-text";
    text.append(role, preview);

    row.append(checkbox, avatar, text);
    rows.append(row);
  });

  selectorList.replaceChildren(rows);
  selectorList.scrollTop = 0;
  lastShiftAnchorIndex = null;

  applyExpandState();
  updateSelectorCount();
}

/* Shift+Click ticks or unticks every message in between */
selectorList.addEventListener("click", (event) => {
  const checkbox = event.target;

  if (!(checkbox instanceof HTMLInputElement)) {
    return;
  }

  const index = Number(checkbox.dataset.index);

  if (event.shiftKey && lastShiftAnchorIndex !== null) {
    const start = Math.min(lastShiftAnchorIndex, index);
    const end = Math.max(lastShiftAnchorIndex, index);
    const checkboxes = messageCheckboxes();

    for (let i = start; i <= end; i++) {
      const box = checkboxes[i];

      if (box) {
        box.checked = checkbox.checked;
      }
    }
  }

  lastShiftAnchorIndex = index;
  updateSelectorCount();
});

/*
 * "Show full messages": every message shows its whole text
 * (the list scrolls) instead of its first two lines.
 */
function applyExpandState(): void {
  selectorList.classList.toggle("is-expanded", selectorExpandToggle.checked);
}

selectorExpandToggle.addEventListener("change", applyExpandState);

function setCheckboxes(
  isChecked: (message: Message | undefined) => boolean,
): void {
  for (const box of messageCheckboxes()) {
    box.checked = isChecked(currentMessages[Number(box.dataset.index)]);
  }

  updateSelectorCount();
}

selectAllCheckbox.addEventListener("change", () => {
  const checked = selectAllCheckbox.checked;

  setCheckboxes(() => checked);
});

selectorFilterQuestionsButton.addEventListener("click", () => {
  setCheckboxes((message) => message?.role === "user");
});

selectorFilterAnswersButton.addEventListener("click", () => {
  setCheckboxes((message) => message?.role === "assistant");
});

selectorFilterInvertButton.addEventListener("click", () => {
  for (const box of messageCheckboxes()) {
    box.checked = !box.checked;
  }

  updateSelectorCount();
});

/*
 * File type. Picked as radio buttons with a line below that
 * says, in plain words, what the chosen one is good for. The
 * choice is remembered for next time; PDF until then.
 */
function getSelectedFormat(): ExportFormat {
  const value = formatInputs.find((input) => input.checked)?.value;

  return EXPORT_FORMATS.find((format) => format === value) ?? "pdf";
}

function setSelectedFormat(format: ExportFormat): void {
  for (const input of formatInputs) {
    input.checked = input.value === format;
  }
}

function updateFormatHint(): void {
  const format = getSelectedFormat();
  const zipped =
    !isDocumentFormat(format) &&
    getSelectedImageFiles(getSelectedMessages()).length > 0;

  formatHintIcon.setAttribute(
    "href",
    `#${zipped ? "i-archive" : FORMAT_ICONS[format]}`,
  );
  formatHintText.textContent = zipped
    ? `${t(`popup.formatHint.${format}`)} ${t("popup.formatHint.zip")}`
    : t(`popup.formatHint.${format}`);

  if (!selectorExportButton.classList.contains("is-busy")) {
    selectorExportLabel.textContent = t(`popup.download.${format}`);
  }
}

for (const input of formatInputs) {
  input.addEventListener("change", () => {
    updateFormatHint();

    void chrome.storage.local
      .set({ [EXPORT_FORMAT_KEY]: getSelectedFormat() })
      .catch((error: unknown) => {
        devWarn("AI Exporter: couldn't remember the file type", error);
      });
  });
}

async function restoreExportFormat(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(EXPORT_FORMAT_KEY);
    const value = stored[EXPORT_FORMAT_KEY];

    setSelectedFormat(
      EXPORT_FORMATS.find((format) => format === value) ?? "pdf",
    );
  } catch (error) {
    devWarn("AI Exporter: couldn't read the last file type", error);
  }

  updateFormatHint();
}

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

/*
 * "Save many chats" opens the bulk export page in a tab of its
 * own - an export of many chats takes a while, and the popup
 * closes as soon as it loses focus. The page talks to this tab's
 * content script, which lists and loads the chats.
 */
bulkExportButton.addEventListener("click", async () => {
  const tab = await getActiveTab();
  const site = getChatSite(tab?.url);

  if (!tab?.id || !site) {
    return;
  }

  // A tab without a content script is reloaded by the page (see bulk.ts).
  const params = new URLSearchParams({ tab: String(tab.id), site });

  await chrome.tabs.create({
    url: chrome.runtime.getURL(`bulk.html?${params.toString()}`),
    index: tab.index + 1,
  });
  window.close();
});

/*
 * The main "Save as a file" button: always opens this screen,
 * every time - it never skips straight to a download.
 */
exportButton.addEventListener("click", async () => {
  devLog("AI Exporter: export clicked, opening selector");

  try {
    const settings = await loadSettings();
    const { messages, images, tabTitle, tabUrl, tabId } =
      await loadConversationMessages(
        exportButton,
        settings.downloadImagesLocally,
      );

    currentMessages = messages;
    currentImages = images;
    currentTabTitle = tabTitle;
    currentTabUrl = tabUrl;
    currentTabId = tabId;
    currentFileNameTemplate = settings.fileNameTemplate ?? "";

    exportSubtitle.textContent = chatTitleFor(tabTitle);
    selectorExpandToggle.checked = false;

    renderSelectorList(messages);
    showScreen("export");
  } catch (error) {
    devError("AI Exporter: failed to load messages for export", error);
    showErrorToast(error, "popup.error.loadConversationFailed");
  }
});

/*
 * ---------------------------------------------------------
 * DOWNLOAD
 * ---------------------------------------------------------
 */
selectorExportButton.addEventListener("click", async () => {
  const chosen = getSelectedMessages();

  if (chosen.length === 0) {
    return;
  }

  const format = getSelectedFormat();

  selectorExportButton.classList.add("is-busy");
  selectorExportLabel.textContent = t("popup.download.preparing");
  setBusy(true);

  try {
    await waitForPaint();

    const settings = await loadSettings();
    const now = new Date();
    const filename = buildFilename(
      currentTabTitle,
      currentTabUrl,
      format,
      settings.fileNameTemplate,
      now,
    );
    let downloadFilename = filename;
    let blob: Blob;

    if (isDocumentFormat(format)) {
      /*
       * PDF, Word and HTML files embed their images in the
       * document itself (see file-export.ts), so there's no
       * separate images/ folder to bundle into a ZIP the way the
       * other formats do - the download always stands alone.
       */
      blob = await buildDocumentBlob(
        format,
        chosen,
        getSelectedImageFiles(chosen),
        settings,
        currentTabTitle,
        currentTabUrl,
      );

      // A chat too long for one picture comes as a ZIP of them.
      if (fileExtension(format, blob) === "zip") {
        downloadFilename = buildFilename(
          currentTabTitle,
          currentTabUrl,
          "zip",
          settings.fileNameTemplate,
          now,
        );
      }
    } else {
      const markdown = await buildMarkdownFromMessages(chosen, {
        tabTitle: currentTabTitle,
        tabUrl: currentTabUrl,
        properties: format === "md",
        notes: format === "md" ? "footnotes" : "brackets",
      });

      const { content, mimeType } = buildContentForFormat(
        format,
        markdown,
        chosen,
        settings,
      );

      const selectedImages = getSelectedImageFiles(chosen);

      if (selectedImages.length > 0) {
        downloadFilename = buildFilename(
          currentTabTitle,
          currentTabUrl,
          "zip",
          settings.fileNameTemplate,
          now,
        );
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
      throw new Error(
        downloadResponse?.error ?? t("popup.toast.downloadFailed"),
      );
    }

    devLog("AI Exporter: download started", downloadResponse.data.downloadId);

    showToast(t("popup.toast.downloadStarted"));
  } catch (error) {
    devError("AI Exporter: download failed", error);
    showErrorToast(error, "popup.toast.downloadFailed");
  } finally {
    selectorExportButton.classList.remove("is-busy");
    updateFormatHint();
    setBusy(false);
  }
});

/*
 * ---------------------------------------------------------
 * "SAVE TO GITHUB" SCREEN
 * ---------------------------------------------------------
 *
 * Saves Markdown for text-only conversations and a ZIP when
 * the selected messages include image files, into the
 * exports/ folder of a repo the person picks. Without a
 * connected account, or with no repos, the screen says what to
 * do instead of showing an empty list.
 */
type GithubState =
  | { kind: "loading" }
  | { kind: "not-connected" }
  | { kind: "error"; message: string }
  | { kind: "empty" }
  | { kind: "saved"; filename: string; repo: string; url: string | null };

interface GithubStateAction {
  icon: string;
  label: string;
  run: () => void;
}

function openTab(url: string): void {
  void chrome.tabs.create({ url });
}

function githubStateContent(state: GithubState): {
  icon: string;
  title: string;
  text: string;
  action?: GithubStateAction;
  secondary?: { label: string; run: () => void };
} {
  switch (state.kind) {
    case "loading":
      return { icon: "", title: t("popup.github.loadingRepos"), text: "" };
    case "not-connected":
      return {
        icon: "i-github",
        title: t("popup.github.notConnectedTitle"),
        text: t("popup.github.notConnectedText"),
        action: {
          icon: "i-settings",
          label: t("popup.github.openSettings"),
          run: () => openTab(chrome.runtime.getURL("options.html#github")),
        },
      };
    case "error":
      return {
        icon: "i-alert",
        title: t("popup.github.failedTitle"),
        text: state.message || t("popup.github.failedToLoad"),
        action: {
          icon: "i-retry",
          label: t("popup.github.retry"),
          run: () => void loadGithubRepos(),
        },
      };
    case "empty":
      return {
        icon: "i-github",
        title: t("popup.github.noReposTitle"),
        text: t("popup.github.noRepos"),
        action: {
          icon: "i-plus",
          label: t("popup.github.createRepo"),
          run: () => openTab(NEW_REPOSITORY_URL),
        },
      };
    case "saved": {
      const { url } = state;

      return {
        icon: "i-check-circle",
        title: t("popup.github.savedTitle"),
        text: t("popup.github.savedText", {
          file: state.filename,
          repo: state.repo,
        }),
        action: url
          ? {
              icon: "i-external",
              label: t("popup.github.view"),
              run: () => openTab(url),
            }
          : undefined,
        secondary: {
          label: t("popup.github.done"),
          run: () => showScreen("main"),
        },
      };
    }
  }
}

function showGithubState(state: GithubState): void {
  const content = githubStateContent(state);
  const loading = state.kind === "loading";

  githubState.hidden = false;
  githubForm.hidden = true;
  githubFooter.hidden = true;
  githubState.dataset.tone =
    state.kind === "error" ? "error" : state.kind === "saved" ? "success" : "";

  githubStateSpinner.hidden = !loading;
  githubStateIcon.toggleAttribute("hidden", loading);
  githubStateIconUse.setAttribute("href", `#${content.icon}`);
  githubStateTitle.textContent = content.title;
  githubStateText.textContent = content.text;
  githubStateText.hidden = content.text === "";

  githubStateAction.hidden = !content.action;
  githubStateActionHandler = content.action?.run ?? null;

  if (content.action) {
    githubStateActionIcon.setAttribute("href", `#${content.action.icon}`);
    githubStateActionLabel.textContent = content.action.label;
  }

  githubStateSecondary.hidden = !content.secondary;
  githubStateSecondaryHandler = content.secondary?.run ?? null;
  githubStateSecondary.textContent = content.secondary?.label ?? "";
}

githubStateAction.addEventListener("click", () => {
  githubStateActionHandler?.();
});

githubStateSecondary.addEventListener("click", () => {
  githubStateSecondaryHandler?.();
});

function selectedRepo(): GithubRepoOption | undefined {
  return githubRepos.find((repo) => repo.full_name === githubRepoSelect.value);
}

/* Markdown, or a ZIP when the selected messages have images */
function githubExportFilename(): string {
  const zipped = getSelectedImageFiles(getSelectedMessages()).length > 0;

  return buildFilename(
    currentTabTitle,
    currentTabUrl,
    zipped ? "zip" : "md",
    currentFileNameTemplate,
  );
}

/*
 * A public repo is readable by anyone on the internet, so the
 * screen says which kind the chosen one is. A repo whose
 * visibility isn't known counts as public.
 */
function updateGithubVisibility(): void {
  const isPublic = selectedRepo()?.private !== true;

  githubVisibility.dataset.visibility = isPublic ? "public" : "private";
  githubVisibilityIcon.setAttribute("href", isPublic ? "#i-globe" : "#i-lock");
  githubVisibilityText.textContent = t(
    isPublic ? "popup.github.public" : "popup.github.private",
  );
}

githubRepoSelect.addEventListener("change", () => {
  updateGithubVisibility();
  updateButtons();
});

async function rememberedRepo(): Promise<string | undefined> {
  try {
    const stored = await chrome.storage.local.get(GITHUB_REPO_KEY);
    const value = stored[GITHUB_REPO_KEY];

    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

async function loadGithubRepos(): Promise<void> {
  const loadId = ++githubLoadId;
  const isStale = (): boolean =>
    loadId !== githubLoadId || currentScreen !== "github";

  githubRepos = [];
  githubRepoSelect.replaceChildren();
  showGithubState({ kind: "loading" });

  try {
    const statusResponse = await chrome.runtime.sendMessage({
      type: "GITHUB_GET_STATUS",
    });

    if (isStale()) {
      return;
    }

    if (!statusResponse?.success || !statusResponse.data?.connected) {
      showGithubState({ kind: "not-connected" });

      return;
    }

    const reposResponse = await chrome.runtime.sendMessage({
      type: "GITHUB_LIST_REPOS",
    });

    if (isStale()) {
      return;
    }

    if (!reposResponse?.success) {
      showGithubState({
        kind: "error",
        message: errorMessage(
          reposResponse?.error ?? "",
          "popup.github.failedToLoad",
        ),
      });

      return;
    }

    const repos = reposResponse.data as GithubRepoOption[];

    if (repos.length === 0) {
      showGithubState({ kind: "empty" });

      return;
    }

    const lastRepo = await rememberedRepo();

    if (isStale()) {
      return;
    }

    githubRepos = repos;
    githubRepoSelect.replaceChildren(
      ...repos.map((repo) => new Option(repo.full_name, repo.full_name)),
    );

    if (lastRepo && repos.some((repo) => repo.full_name === lastRepo)) {
      githubRepoSelect.value = lastRepo;
    }

    updateGithubVisibility();
    githubFileName.textContent = `exports/${githubExportFilename()}`;

    githubState.hidden = true;
    githubForm.hidden = false;
    githubFooter.hidden = false;
    updateButtons();
  } catch (error) {
    devError("AI Exporter: loading GitHub repos failed", error);

    if (!isStale()) {
      showGithubState({
        kind: "error",
        message: errorMessage(error, "popup.github.failedToLoad"),
      });
    }
  }
}

selectorGithubButton.addEventListener("click", () => {
  if (getSelectedMessages().length === 0) {
    return;
  }

  showScreen("github");
  void loadGithubRepos();
});

async function saveToGitHub(): Promise<void> {
  const fullName = githubRepoSelect.value;
  const chosen = getSelectedMessages();

  if (!fullName || chosen.length === 0) {
    return;
  }

  githubPanelSaveButton.classList.add("is-busy");
  githubSaveLabel.textContent = t("popup.github.saving");
  setBusy(true);

  try {
    const markdown = await buildMarkdownFromMessages(chosen, {
      tabTitle: currentTabTitle,
      tabUrl: currentTabUrl,
      properties: true,
    });
    const now = new Date();
    const markdownFilename = buildFilename(
      currentTabTitle,
      currentTabUrl,
      "md",
      currentFileNameTemplate,
      now,
    );
    const selectedImages = getSelectedImageFiles(chosen);
    let filename = markdownFilename;
    let content = markdown;
    let binary = false;

    if (selectedImages.length > 0) {
      filename = buildFilename(
        currentTabTitle,
        currentTabUrl,
        "zip",
        currentFileNameTemplate,
        now,
      );
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

    const htmlUrl = saveResponse.data?.htmlUrl;

    showGithubState({
      kind: "saved",
      filename: `exports/${filename}`,
      repo: fullName,
      url:
        typeof htmlUrl === "string" && htmlUrl.startsWith("https://github.com/")
          ? htmlUrl
          : null,
    });
    githubStateAction.focus({ preventScroll: true });

    void chrome.storage.local
      .set({ [GITHUB_REPO_KEY]: fullName })
      .catch(() => undefined);

    openExportSuccess();
  } catch (error) {
    devError("AI Exporter: GitHub save failed", error);
    showErrorToast(error, "popup.toast.githubSaveFailed");
  } finally {
    githubPanelSaveButton.classList.remove("is-busy");
    githubSaveLabel.textContent = t("popup.github.save");
    setBusy(false);
  }
}

githubPanelSaveButton.addEventListener("click", () => {
  const repo = selectedRepo();

  if (!repo) {
    return;
  }

  if (repo.private === true) {
    void saveToGitHub();

    return;
  }

  githubConfirm.showModal();
  githubConfirmCancelButton.focus();
});

githubConfirmCancelButton.addEventListener("click", () => {
  githubConfirm.close();
});

githubConfirmExportButton.addEventListener("click", () => {
  githubConfirm.close();
  void saveToGitHub();
});

/* A click on the dimmed backdrop around the dialog cancels it */
githubConfirm.addEventListener("click", (event) => {
  if (event.target === githubConfirm) {
    githubConfirm.close();
  }
});

/*
 * ---------------------------------------------------------
 * "SAVE TO NOTION" SCREEN
 * ---------------------------------------------------------
 *
 * Creates a new Notion page with the selected messages (see
 * notion-blocks.ts) inside a page the person picks - one of the
 * pages they shared with AI Exporter when connecting. Like the
 * GitHub screen, it says what to do instead of showing an empty
 * list when there's no connection or no page to pick.
 */
type NotionState =
  | { kind: "loading" }
  | { kind: "not-connected" }
  | { kind: "error"; message: string }
  | { kind: "empty" }
  | { kind: "saved"; parent: string; url: string | null };

function notionStateContent(state: NotionState): {
  icon: string;
  title: string;
  text: string;
  action?: GithubStateAction;
  secondary?: { label: string; run: () => void };
} {
  switch (state.kind) {
    case "loading":
      return { icon: "", title: t("popup.notion.loadingPages"), text: "" };
    case "not-connected":
      return {
        icon: "i-notion",
        title: t("popup.notion.notConnectedTitle"),
        text: t("popup.notion.notConnectedText"),
        action: {
          icon: "i-settings",
          label: t("popup.notion.openSettings"),
          run: () => openTab(chrome.runtime.getURL("options.html#notion")),
        },
      };
    case "error":
      return {
        icon: "i-alert",
        title: t("popup.notion.failedTitle"),
        text: state.message || t("popup.github.failedToLoad"),
        action: {
          icon: "i-retry",
          label: t("popup.github.retry"),
          run: () => void loadNotionPages(),
        },
      };
    case "empty":
      return {
        icon: "i-notion",
        title: t("popup.notion.noPagesTitle"),
        text: t("popup.notion.noPages"),
        action: {
          icon: "i-settings",
          label: t("popup.notion.openSettings"),
          run: () => openTab(chrome.runtime.getURL("options.html#notion")),
        },
      };
    case "saved": {
      const { url } = state;

      return {
        icon: "i-check-circle",
        title: t("popup.notion.savedTitle"),
        text: t("popup.notion.savedText", { parent: state.parent }),
        action: url
          ? {
              icon: "i-external",
              label: t("popup.notion.view"),
              run: () => openTab(url),
            }
          : undefined,
        secondary: {
          label: t("popup.github.done"),
          run: () => showScreen("main"),
        },
      };
    }
  }
}

function showNotionState(state: NotionState): void {
  const content = notionStateContent(state);
  const loading = state.kind === "loading";

  notionState.hidden = false;
  notionForm.hidden = true;
  notionFooter.hidden = true;
  notionState.dataset.tone =
    state.kind === "error" ? "error" : state.kind === "saved" ? "success" : "";

  notionStateSpinner.hidden = !loading;
  notionStateIcon.toggleAttribute("hidden", loading);
  notionStateIconUse.setAttribute("href", `#${content.icon}`);
  notionStateTitle.textContent = content.title;
  notionStateText.textContent = content.text;
  notionStateText.hidden = content.text === "";

  notionStateAction.hidden = !content.action;
  notionStateActionHandler = content.action?.run ?? null;

  if (content.action) {
    notionStateActionIcon.setAttribute("href", `#${content.action.icon}`);
    notionStateActionLabel.textContent = content.action.label;
  }

  notionStateSecondary.hidden = !content.secondary;
  notionStateSecondaryHandler = content.secondary?.run ?? null;
  notionStateSecondary.textContent = content.secondary?.label ?? "";
}

notionStateAction.addEventListener("click", () => {
  notionStateActionHandler?.();
});

notionStateSecondary.addEventListener("click", () => {
  notionStateSecondaryHandler?.();
});

async function rememberedNotionPage(): Promise<string | undefined> {
  try {
    const stored = await chrome.storage.local.get(NOTION_PAGE_KEY);
    const value = stored[NOTION_PAGE_KEY];

    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

async function loadNotionPages(): Promise<void> {
  const loadId = ++notionLoadId;
  const isStale = (): boolean =>
    loadId !== notionLoadId || currentScreen !== "notion";

  notionPages = [];
  notionPageSelect.replaceChildren();
  showNotionState({ kind: "loading" });

  try {
    const statusResponse = await chrome.runtime.sendMessage({
      type: "NOTION_GET_STATUS",
    });

    if (isStale()) {
      return;
    }

    if (!statusResponse?.success || !statusResponse.data?.connected) {
      showNotionState({ kind: "not-connected" });

      return;
    }

    const pagesResponse = await chrome.runtime.sendMessage({
      type: "NOTION_LIST_PAGES",
    });

    if (isStale()) {
      return;
    }

    if (!pagesResponse?.success) {
      showNotionState({
        kind: "error",
        message: errorMessage(
          pagesResponse?.error ?? "",
          "popup.github.failedToLoad",
        ),
      });

      return;
    }

    const pages = pagesResponse.data as NotionPageOption[];

    if (pages.length === 0) {
      showNotionState({ kind: "empty" });

      return;
    }

    const lastPage = await rememberedNotionPage();

    if (isStale()) {
      return;
    }

    notionPages = pages;
    notionPageSelect.replaceChildren(
      ...pages.map(
        (page) =>
          new Option(page.icon ? `${page.icon} ${page.title}` : page.title, page.id),
      ),
    );

    if (lastPage && pages.some((page) => page.id === lastPage)) {
      notionPageSelect.value = lastPage;
    }

    notionPageName.textContent = notionPageTitle(currentTabTitle, currentTabUrl);

    notionState.hidden = true;
    notionForm.hidden = false;
    notionFooter.hidden = false;
    updateButtons();
  } catch (error) {
    devError("AI Exporter: loading Notion pages failed", error);

    if (!isStale()) {
      showNotionState({
        kind: "error",
        message: errorMessage(error, "popup.github.failedToLoad"),
      });
    }
  }
}

selectorNotionButton.addEventListener("click", () => {
  if (getSelectedMessages().length === 0) {
    return;
  }

  showScreen("notion");
  void loadNotionPages();
});

notionPageSelect.addEventListener("change", () => {
  updateButtons();
});

async function saveToNotion(): Promise<void> {
  const parentId = notionPageSelect.value;
  const parent = notionPages.find((page) => page.id === parentId);
  const chosen = getSelectedMessages();

  if (!parent || chosen.length === 0) {
    return;
  }

  notionPanelSaveButton.classList.add("is-busy");
  notionSaveLabel.textContent = t("popup.github.saving");
  setBusy(true);

  try {
    await waitForPaint();

    const settings = await loadSettings();
    const page = buildNotionPage(chosen, settings, {
      tabTitle: currentTabTitle,
      tabUrl: currentTabUrl,
    });
    const saveResponse = await chrome.runtime.sendMessage({
      type: "NOTION_SAVE_PAGE",
      parentId,
      title: page.title,
      blocks: page.blocks,
    });

    if (!saveResponse?.success) {
      throw new Error(saveResponse?.error ?? t("popup.toast.notionSaveFailed"));
    }

    const url = saveResponse.data?.url;

    showNotionState({
      kind: "saved",
      parent: parent.title,
      url:
        typeof url === "string" && NOTION_URL_PATTERN.test(url) ? url : null,
    });
    notionStateAction.focus({ preventScroll: true });

    void chrome.storage.local
      .set({ [NOTION_PAGE_KEY]: parentId })
      .catch(() => undefined);

    openExportSuccess();
  } catch (error) {
    devError("AI Exporter: Notion save failed", error);
    showErrorToast(error, "popup.toast.notionSaveFailed");
  } finally {
    notionPanelSaveButton.classList.remove("is-busy");
    notionSaveLabel.textContent = t("popup.notion.save");
    setBusy(false);
  }
}

notionPanelSaveButton.addEventListener("click", () => {
  void saveToNotion();
});

/*
 * ---------------------------------------------------------
 * EXPORT SUCCESS OVERLAY (shown on the chat page)
 * ---------------------------------------------------------
 *
 * The success overlay is NOT rendered in the popup - Chrome
 * closes the popup automatically the moment focus moves
 * anywhere outside it, which happens routinely right when a
 * download finishes (e.g. a native Save As dialog stealing
 * focus, or the person just clicking back onto the page).
 * Instead, this sends a message to content.ts running on the
 * active chat tab, which injects and shows the overlay
 * directly on the page, where it survives the popup closing.
 */
function openExportSuccess(): void {
  void (async () => {
    const tab = await getActiveTab();

    if (!tab?.id) {
      return;
    }

    chrome.tabs
      .sendMessage(tab.id, { type: "SHOW_EXPORT_SUCCESS" })
      .catch(() => {
        /*
         * Content script may not be running in this tab (e.g.
         * the person navigated away from the chat after
         * starting the export) - nothing to show it on, so
         * just drop it silently. The file was still saved
         * successfully either way.
         */
      });
  })();
}

/*
 * Note: the download success overlay is NOT triggered from here.
 * background.ts sends SHOW_EXPORT_SUCCESS to the chat tab
 * directly once a tracked download actually completes (see the
 * DOWNLOAD_START handler and the comment above
 * trackedDownloadIds in background.ts) - the popup is usually
 * long closed by then (Firefox closes it the instant the native
 * Save As dialog steals focus), so a popup-local listener for
 * DOWNLOAD_COMPLETE can't be relied on to still be around to
 * relay it.
 */

/*
 * ---------------------------------------------------------
 * SUPPORT: GITHUB STAR, BUY ME A COFFEE
 * ---------------------------------------------------------
 */
async function starProjectDirectly(): Promise<boolean> {
  try {
    const response = await chrome.runtime.sendMessage({
      type: "GITHUB_STAR_PROJECT",
    });

    return response?.success === true;
  } catch (error) {
    devWarn("AI Exporter: direct GitHub star failed", error);

    return false;
  }
}

githubStarButton.addEventListener("click", async () => {
  starring = true;
  githubStarLabel.textContent = t("popup.star.opening");
  updateButtons();

  try {
    if (await starProjectDirectly()) {
      showToast(t("popup.toast.starThanks"));

      return;
    }

    await chrome.tabs.create({
      url: `https://github.com/${PROJECT_REPOSITORY}`,
    });

    showToast(t("popup.toast.openedGithub"));
  } finally {
    starring = false;
    githubStarLabel.textContent = t("popup.support.star");
    updateButtons();
  }
});

buyCoffeeButton.addEventListener("click", () => {
  void chrome.tabs.create({ url: COFFEE_URL });
});

/*
 * ---------------------------------------------------------
 * VERSION AND UPDATES
 * ---------------------------------------------------------
 *
 * The footer shows the running version and whether it's the
 * newest one. The banner at the top only appears when there's
 * something to act on: an update that's downloaded and waiting
 * for a reload, or - in Firefox, which can't be told to update
 * from here - a newer version on the store.
 *
 * background.ts does the actual checking and installing (see
 * updates.ts) and keeps the outcome in storage. This renders
 * it, live through storage.onChanged, so an update that
 * finishes downloading while the popup is open shows up right
 * away.
 */
const runningVersion = getRunningVersion();
const installsUpdates = storeInstallsUpdates();

let updateState: UpdateState = {};
let updateCheckRunning = false;
let showUpdateCheckProgress = false;

appVersionLabel.textContent = `v${runningVersion}`;

/* "5 minutes ago", "yesterday" - in the popup's language. */
function formatTimeAgo(timestamp: number): string {
  const formatter = new Intl.RelativeTimeFormat(getLocale(), {
    numeric: "auto",
  });
  const seconds = Math.round((timestamp - Date.now()) / 1000);
  const units = [
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ] as const;

  for (const [unit, unitSeconds] of units) {
    if (Math.abs(seconds) >= unitSeconds) {
      return formatter.format(Math.round(seconds / unitSeconds), unit);
    }
  }

  return formatter.format(0, "second");
}

/* The shortcut that opens Firefox's Add-ons Manager. */
function addonsManagerShortcut(): string {
  return isMac() ? "⌘⇧A" : "Ctrl+Shift+A";
}

function updateStatusLabel(view: UpdateView): string {
  switch (view.kind) {
    case "ready":
      return t("popup.update.statusReady");
    case "downloading":
      return t("popup.update.downloading", { version: view.version });
    case "available":
      return t("popup.update.statusAvailable", { version: view.version });
    case "current":
      return t("popup.update.upToDate");
    default:
      return t("popup.update.check");
  }
}

function renderUpdateStatus(): void {
  const view = getUpdateView(updateState, runningVersion, installsUpdates);

  if (view.kind === "ready") {
    updateBannerTitle.textContent = t("popup.update.readyTitle", {
      version: view.version,
    });
    updateBannerMessage.textContent = t("popup.update.readyMessage");
    updateApplyButton.hidden = false;
    updateBanner.hidden = false;
  } else if (view.kind === "available" && !installsUpdates) {
    updateBannerTitle.textContent = t("popup.update.availableTitle", {
      version: view.version,
    });
    updateBannerMessage.textContent = t("popup.update.firefoxHint", {
      shortcut: addonsManagerShortcut(),
    });
    updateApplyButton.hidden = true;
    updateBanner.hidden = false;
  } else {
    updateBanner.hidden = true;
  }

  if (!installingUpdate) {
    updateApplyButton.textContent = t("popup.update.installNow");
  }

  updateStatusButton.dataset.state = showUpdateCheckProgress
    ? "checking"
    : view.kind;
  updateStatusText.textContent = showUpdateCheckProgress
    ? t("popup.update.checking")
    : updateStatusLabel(view);
  updateStatusButton.title =
    view.kind === "current" && !showUpdateCheckProgress
      ? t("popup.update.lastChecked", { time: formatTimeAgo(view.checkedAt) })
      : "";
}

/*
 * Only for a check the person asked for - the automatic one
 * when the popup opens says nothing beyond the footer and
 * banner. An update found shows up there as well.
 */
function reportUpdateCheck(result: string | undefined): void {
  const view = getUpdateView(updateState, runningVersion, installsUpdates);

  if (view.kind !== "current" && view.kind !== "unknown") {
    return;
  }

  if (
    result === "no_update" ||
    (result === "throttled" && view.kind === "current")
  ) {
    showToast(t("popup.update.upToDateToast"));
  } else if (result === "throttled") {
    showToast(t("popup.update.throttled"));
  } else {
    showToast(t("popup.update.checkFailed"), "error");
  }
}

/*
 * background.ts only goes to the store when its last answer is
 * a few hours old, unless `force` is set. The "Checking..."
 * state only shows when the person asked, or when there's no
 * earlier answer to show meanwhile - otherwise every popup
 * would open with a flash of it.
 */
async function checkForUpdates(force: boolean): Promise<void> {
  if (updateCheckRunning) {
    return;
  }

  updateCheckRunning = true;
  showUpdateCheckProgress =
    force ||
    getUpdateView(updateState, runningVersion, installsUpdates).kind ===
      "unknown";
  renderUpdateStatus();

  let result: string | undefined;

  try {
    const response = await chrome.runtime.sendMessage({
      type: "UPDATE_CHECK",
      force,
    });

    if (response?.success) {
      updateState = response.data.state;
      result = response.data.result;
    }
  } catch (error) {
    devWarn("AI Exporter: update check failed", error);
  } finally {
    updateCheckRunning = false;
    showUpdateCheckProgress = false;
    renderUpdateStatus();
  }

  if (force) {
    reportUpdateCheck(result);
  }
}

/*
 * background.ts leaves the version it just updated to under
 * UPDATE_NOTICE_KEY, and the first popup after the update
 * says so, once.
 */
async function showUpdateNotice(): Promise<void> {
  const stored = await chrome.storage.local.get(UPDATE_NOTICE_KEY);
  const notice = stored[UPDATE_NOTICE_KEY];

  if (notice === undefined) {
    return;
  }

  await chrome.storage.local.remove(UPDATE_NOTICE_KEY);

  if (notice === runningVersion) {
    showToast(t("popup.update.updatedToast", { version: runningVersion }));
  }
}

async function initUpdateStatus(): Promise<void> {
  appVersionLabel.title = t("popup.update.versionTitle", {
    version: runningVersion,
  });
  updateState = await loadUpdateState();
  renderUpdateStatus();

  await showUpdateNotice();
  await checkForUpdates(false);
}

updateStatusButton.addEventListener("click", () => {
  void checkForUpdates(true);
});

updateApplyButton.addEventListener("click", async () => {
  installingUpdate = true;
  updateApplyButton.textContent = t("popup.update.installing");
  updateButtons();

  try {
    const response = await chrome.runtime.sendMessage({
      type: "UPDATE_APPLY",
    });

    if (response?.data?.reloading) {
      /* The reload closes this popup in a moment. */
      return;
    }

    showToast(t("popup.update.installLater"));
  } catch {
    /*
     * The reload can take this popup down before the answer
     * arrives - that's the update going ahead.
     */
    return;
  }

  installingUpdate = false;
  updateButtons();
  renderUpdateStatus();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  const change = changes[UPDATE_STATE_KEY];

  if (areaName !== "local" || !change) {
    return;
  }

  updateState = (change.newValue as UpdateState | undefined) ?? {};
  renderUpdateStatus();
});

/*
 * ---------------------------------------------------------
 * STARTUP
 * ---------------------------------------------------------
 *
 * initI18n()'s underlying chrome.storage.sync.get() resolves
 * right after the popup opens, well before a person can click
 * anything - every string set later (toasts, progress, button
 * labels) happens inside event handlers, after it. What the
 * popup shows about the current tab and updates waits for it.
 */
const activeTab = getActiveTab().catch((error: unknown) => {
  devWarn("AI Exporter: couldn't read the active tab", error);

  return undefined;
});

void initI18n().then(async () => {
  applyTranslations();
  labelSiteLinks();
  void restoreExportFormat();
  void showCopyShortcut();
  void initUpdateStatus();
  renderChatCard(await activeTab);
});
