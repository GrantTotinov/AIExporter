/*
 * =========================================================
 * AI Exporter - bulk.ts
 * =========================================================
 *
 * The "Save many chats" page. The popup opens it in a tab of its
 * own, next to the chat site's tab (bulk.html?tab=<id>&site=<site>),
 * because exporting many chats takes a while and the popup closes
 * the moment it loses focus.
 *
 * 1. Asks that tab's content script for every conversation in
 *    the sidebar (LIST_CONVERSATIONS).
 * 2. Lets the person search, filter by date and tick the chats.
 * 3. Loads the ticked chats one at a time (LOAD_CONVERSATION with
 *    their id), turns each into a file of the chosen type, and
 *    downloads them all in one ZIP.
 */
import { loadSettings, type Settings } from "./settings.ts";
import { applyTranslations, getLocale, initI18n, t } from "./i18n.ts";
import { buildDocumentBlob, isDocumentFormat } from "./file-export.ts";
import {
  CHAT_SITE_NAMES,
  getChatSite,
  isChatSite,
  isInjectedSite,
  type ChatSite,
} from "./chat-sites.ts";
import { createZipBlob, decodeBase64, type ZipEntry } from "./zip.ts";
import {
  EXPORT_FORMATS,
  buildContentForFormat,
  buildMarkdownFromMessages,
  type ExportFormat,
  type ExportImageFile,
  type Message,
} from "./export-builders.ts";
import {
  conversationFileBase,
  filterConversations,
  localDate,
  uniqueName,
  type ConversationFilter,
  type DatePreset,
} from "./bulk-export.ts";
import type {
  ConversationListPage,
  ConversationSummary,
} from "./conversation-list.ts";

const devWarn = (...args: unknown[]): void => {
  if (import.meta.env.DEV) {
    console.warn(...args);
  }
};

/* The popup's key, so both remember the same file type. */
const EXPORT_FORMAT_KEY = "popupExportFormat";

/*
 * A pause between chats, and the waits before each retry of one
 * that failed: the sites rate-limit their APIs, and a bulk export
 * shouldn't look like a flood of requests.
 */
const PAUSE_BETWEEN_CHATS_MS = 400;
const RETRY_DELAYS_MS = [2000, 6000];

/*
 * ---------------------------------------------------------
 * DOM REFERENCES
 * ---------------------------------------------------------
 */

const byId = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const pageSubtitle = byId<HTMLParagraphElement>("page-subtitle");
const chatsCard = byId<HTMLElement>("chats-card");
const formatCard = byId<HTMLElement>("format-card");
const searchInput = byId<HTMLInputElement>("search");
const datePresetSelect = byId<HTMLSelectElement>("date-preset");
const customRange = byId<HTMLDivElement>("custom-range");
const dateFromInput = byId<HTMLInputElement>("date-from");
const dateToInput = byId<HTMLInputElement>("date-to");
const listHead = byId<HTMLDivElement>("list-head");
const selectAllCheckbox = byId<HTMLInputElement>("select-all");
const listCount = byId<HTMLSpanElement>("list-count");
const clearSelectionButton = byId<HTMLButtonElement>("clear-selection");
const chatList = byId<HTMLDivElement>("chat-list");
const listMore = byId<HTMLDivElement>("list-more");
const listMoreSpinner = byId<HTMLSpanElement>("list-more-spinner");
const listMoreWarning = document.getElementById(
  "list-more-warning",
) as unknown as SVGSVGElement;
const listMoreText = byId<HTMLSpanElement>("list-more-text");
const stateLoading = byId<HTMLDivElement>("state-loading");
const loadingText = byId<HTMLParagraphElement>("loading-text");
const stateError = byId<HTMLDivElement>("state-error");
const errorText = byId<HTMLParagraphElement>("error-text");
const retryListButton = byId<HTMLButtonElement>("retry-list");
const stateEmpty = byId<HTMLDivElement>("state-empty");
const stateNoMatch = byId<HTMLDivElement>("state-no-match");
const resetFiltersButton = byId<HTMLButtonElement>("reset-filters");
const formatInputs = Array.from(
  document.querySelectorAll<HTMLInputElement>('input[name="format"]'),
);
const formatHint = byId<HTMLSpanElement>("format-hint");
const progressCard = byId<HTMLElement>("progress-card");
const progressCount = byId<HTMLParagraphElement>("progress-count");
const progress = byId<HTMLDivElement>("progress");
const progressBar = byId<HTMLDivElement>("progress-bar");
const progressCurrent = byId<HTMLSpanElement>("progress-current");
const progressPercent = byId<HTMLSpanElement>("progress-percent");
const progressNote = byId<HTMLSpanElement>("progress-note");
const stopButton = byId<HTMLButtonElement>("stop");
const resultCard = byId<HTMLElement>("result-card");
const resultIconWrap = byId<HTMLSpanElement>("result-icon-wrap");
const resultIcon = document.getElementById("result-icon") as unknown as SVGUseElement;
const resultTitle = byId<HTMLHeadingElement>("result-title");
const resultText = byId<HTMLParagraphElement>("result-text");
const failedBlock = byId<HTMLDivElement>("failed-block");
const failedList = byId<HTMLUListElement>("failed-list");
const retryFailedButton = byId<HTMLButtonElement>("retry-failed");
const backToListButton = byId<HTMLButtonElement>("back-to-list");
const bottomBar = byId<HTMLDivElement>("bottom-bar");
const summaryTitle = byId<HTMLElement>("summary-title");
const summaryText = byId<HTMLSpanElement>("summary-text");
const exportButton = byId<HTMLButtonElement>("export");
const exportLabel = byId<HTMLSpanElement>("export-label");

/*
 * ---------------------------------------------------------
 * STATE
 * ---------------------------------------------------------
 */

const params = new URLSearchParams(window.location.search);
const tabId = Number(params.get("tab"));
const siteParam = params.get("site");
const site: ChatSite | null = isChatSite(siteParam) ? siteParam : null;
const siteName = site ? CHAT_SITE_NAMES[site] : "";

let conversations: ConversationSummary[] = [];
let shown: ConversationSummary[] = [];
const selected = new Set<string>();
/* At least the first page is in. */
let listLoaded = false;
/* Bumped by every new load, so an older one stops fetching. */
let listLoadId = 0;
let running = false;
let stopRequested = false;
let lastClickedIndex: number | null = null;
let lastFailed: ConversationSummary[] = [];

/*
 * ---------------------------------------------------------
 * HELPERS
 * ---------------------------------------------------------
 */

async function applyStoredTheme(): Promise<void> {
  const settings = await loadSettings();

  if (settings.theme === "system") {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = settings.theme;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function titleOf(conversation: ConversationSummary): string {
  return conversation.title || t("popup.chat.untitled");
}

const dateFormat = (): Intl.DateTimeFormat =>
  new Intl.DateTimeFormat(getLocale(), { dateStyle: "medium" });

/*
 * The chat site's tab is gone - closed, or navigated away and
 * back so its content script was replaced - when a message to it
 * can't be delivered at all, as opposed to the content script
 * answering with an error.
 */
class TabUnavailableError extends Error {}

/*
 * A DeepSeek, Grok or Perplexity tab loses the content script the
 * popup put in (see the top of chat-sites.ts) when it's reloaded.
 * The popup lent AI Exporter that tab, so while it still shows the
 * same site the script can go in again. False when it can't.
 */
async function addContentScriptAgain(): Promise<boolean> {
  if (!site || !isInjectedSite(site)) {
    return false;
  }

  try {
    const tab = await chrome.tabs.get(tabId);

    if (getChatSite(tab.url) !== site) {
      return false;
    }

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });

    return true;
  } catch (error) {
    devWarn("AI Exporter: couldn't add the content script again", error);
    return false;
  }
}

async function sendToTab<T>(message: Record<string, unknown>): Promise<T> {
  let response: { success?: boolean; data?: T; error?: string } | undefined;

  try {
    response = await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    if (!(await addContentScriptAgain())) {
      throw new TabUnavailableError(errorMessage(error));
    }

    try {
      response = await chrome.tabs.sendMessage(tabId, message);
    } catch (retryError) {
      throw new TabUnavailableError(errorMessage(retryError));
    }
  }

  if (!response?.success) {
    throw new Error(response?.error ?? t("bulk.error.unknown"));
  }

  return response.data as T;
}

function getSelectedFormat(): ExportFormat {
  const value = formatInputs.find((input) => input.checked)?.value;

  return EXPORT_FORMATS.find((format) => format === value) ?? "pdf";
}

/* Only ticked chats the filters show are saved. */
function chatsToSave(): ConversationSummary[] {
  return shown.filter((conversation) => selected.has(conversation.id));
}

/*
 * ---------------------------------------------------------
 * LIST
 * ---------------------------------------------------------
 */

function showListState(
  state: "loading" | "error" | "empty" | "no-match" | "list",
): void {
  stateLoading.hidden = state !== "loading";
  stateError.hidden = state !== "error";
  stateEmpty.hidden = state !== "empty";
  stateNoMatch.hidden = state !== "no-match";
  chatList.hidden = state !== "list";
  listHead.hidden = state !== "list";

  if (state !== "list") {
    listMore.hidden = true;
  }
}

function currentFilter(): ConversationFilter {
  return {
    query: searchInput.value,
    preset: datePresetSelect.value as DatePreset,
    from: dateFromInput.value,
    to: dateToInput.value,
  };
}

function renderList(): void {
  shown = filterConversations(conversations, currentFilter(), Date.now());
  lastClickedIndex = null;

  if (!listLoaded) {
    return;
  }

  if (conversations.length === 0) {
    showListState("empty");
  } else if (shown.length === 0) {
    showListState("no-match");
  } else {
    showListState("list");
  }

  const format = dateFormat();
  const fragment = document.createDocumentFragment();

  shown.forEach((conversation, index) => {
    const row = document.createElement("label");
    row.className = "chat-row";
    row.setAttribute("role", "listitem");
    row.dataset.index = String(index);

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selected.has(conversation.id);
    checkbox.dataset.id = conversation.id;
    row.classList.toggle("is-selected", checkbox.checked);

    const title = document.createElement("span");
    title.className = "chat-row-title";
    title.textContent = titleOf(conversation);
    title.classList.toggle("is-untitled", !conversation.title);
    title.title = titleOf(conversation);

    row.append(checkbox, title);

    const time = conversation.updatedAt ?? conversation.createdAt;

    if (time !== null) {
      const date = document.createElement("time");
      date.className = "chat-row-date";
      date.dateTime = new Date(time).toISOString();
      date.textContent = format.format(time);
      row.append(date);
    }

    fragment.append(row);
  });

  chatList.replaceChildren(fragment);
  updateSelectionUi();
}

function updateSelectionUi(): void {
  const count = chatsToSave().length;

  selectAllCheckbox.checked = shown.length > 0 && count === shown.length;
  selectAllCheckbox.indeterminate = count > 0 && count < shown.length;
  listCount.textContent = t("bulk.count", {
    checked: count,
    total: shown.length,
  });
  clearSelectionButton.disabled = selected.size === 0;

  summaryTitle.textContent = t("bulk.summary.count", { count });
  summaryText.textContent =
    count === 0
      ? t("bulk.summary.none")
      : t("bulk.summary.format", {
          format: formatLabel(getSelectedFormat()),
        });
  exportButton.disabled = running || !listLoaded || count === 0;
  exportLabel.textContent = t("bulk.export");
}

function formatLabel(format: ExportFormat): string {
  return format === "txt"
    ? t("popup.format.txt")
    : {
        pdf: "PDF",
        docx: "Word",
        html: "HTML",
        md: "Markdown",
        json: "JSON",
        csv: "CSV",
      }[format];
}

chatList.addEventListener("click", (event) => {
  const checkbox = (event.target as HTMLElement).closest<HTMLInputElement>(
    'input[type="checkbox"]',
  );

  if (!checkbox) {
    return;
  }

  const row = checkbox.closest<HTMLElement>(".chat-row");
  const index = Number(row?.dataset.index);

  /*
   * Shift-click ticks (or unticks) every chat between this one
   * and the last one clicked, like in a mail app.
   */
  if (
    (event as MouseEvent).shiftKey &&
    lastClickedIndex !== null &&
    !Number.isNaN(index)
  ) {
    const [from, to] = [lastClickedIndex, index].sort((a, b) => a - b);

    for (let i = from; i <= to; i++) {
      const id = shown[i].id;

      if (checkbox.checked) {
        selected.add(id);
      } else {
        selected.delete(id);
      }
    }

    chatList
      .querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
      .forEach((box, boxIndex) => {
        if (boxIndex >= from && boxIndex <= to) {
          box.checked = checkbox.checked;
          box.closest(".chat-row")?.classList.toggle("is-selected", box.checked);
        }
      });
  } else if (checkbox.dataset.id) {
    if (checkbox.checked) {
      selected.add(checkbox.dataset.id);
    } else {
      selected.delete(checkbox.dataset.id);
    }

    row?.classList.toggle("is-selected", checkbox.checked);
  }

  lastClickedIndex = Number.isNaN(index) ? null : index;
  updateSelectionUi();
});

selectAllCheckbox.addEventListener("change", () => {
  for (const conversation of shown) {
    if (selectAllCheckbox.checked) {
      selected.add(conversation.id);
    } else {
      selected.delete(conversation.id);
    }
  }

  renderList();
});

clearSelectionButton.addEventListener("click", () => {
  selected.clear();
  renderList();
});

searchInput.addEventListener("input", renderList);

datePresetSelect.addEventListener("change", () => {
  customRange.hidden = datePresetSelect.value !== "custom";
  renderList();
});

dateFromInput.addEventListener("change", renderList);
dateToInput.addEventListener("change", renderList);

resetFiltersButton.addEventListener("click", () => {
  searchInput.value = "";
  datePresetSelect.value = "all";
  dateFromInput.value = "";
  dateToInput.value = "";
  customRange.hidden = true;
  renderList();
});

/*
 * The list arrives a page at a time, newest chats first, and is
 * shown from the first page on: a big account has thousands of
 * chats, and waiting for all of them before showing any took
 * minutes. The rest keep loading below while the person
 * searches, ticks and even exports.
 */
async function loadList(): Promise<void> {
  const loadId = ++listLoadId;
  const found = new Map<string, ConversationSummary>();
  let cursor: string | null = null;

  listLoaded = false;
  conversations = [];
  listMore.hidden = true;
  showListState("loading");
  loadingText.textContent = t("bulk.loading", { site: siteName });
  updateSelectionUi();

  try {
    if (!site || !Number.isInteger(tabId) || tabId <= 0) {
      throw new TabUnavailableError("missing tab");
    }

    for (;;) {
      const page: ConversationListPage = await sendToTab<ConversationListPage>({
        type: "LIST_CONVERSATIONS_PAGE",
        cursor,
      });

      if (loadId !== listLoadId) {
        return;
      }

      let added = 0;

      for (const conversation of page.conversations) {
        if (!found.has(conversation.id)) {
          found.set(conversation.id, conversation);
          added++;
        }
      }

      conversations = [...found.values()];
      // A page with nothing new means an API that ignores paging.
      cursor = added > 0 ? page.nextCursor : null;
      renderList();

      if (!listLoaded) {
        listLoaded = true;
        renderList();
        searchInput.focus();
      }

      setLoadingMore(cursor === null ? "done" : "loading");

      if (cursor === null) {
        break;
      }
    }
  } catch (error) {
    if (loadId !== listLoadId) {
      return;
    }

    devWarn("AI Exporter: couldn't list conversations", error);

    // The chats already shown stay usable.
    if (listLoaded) {
      setLoadingMore("failed");
      return;
    }

    errorText.textContent =
      error instanceof TabUnavailableError
        ? t("bulk.error.tabGone", { site: siteName || "ChatGPT" })
        : t("bulk.error.listFailed", { site: siteName, error: errorMessage(error) });
    showListState("error");
  }
}

function setLoadingMore(state: "loading" | "done" | "failed"): void {
  listMore.hidden = state === "done" || chatList.hidden;
  listMoreSpinner.hidden = state !== "loading";
  listMoreWarning.toggleAttribute("hidden", state !== "failed");
  listMoreText.textContent =
    state === "failed"
      ? t("bulk.loadMoreFailed", { count: conversations.length })
      : t("bulk.loadingMore", { count: conversations.length });
}

retryListButton.addEventListener("click", () => void loadList());

/*
 * ---------------------------------------------------------
 * FILE TYPE
 * ---------------------------------------------------------
 */

function updateFormatHint(): void {
  formatHint.textContent = t(`popup.formatHint.${getSelectedFormat()}`);
  updateSelectionUi();
}

for (const input of formatInputs) {
  input.addEventListener("change", () => {
    updateFormatHint();
    void chrome.storage.local
      .set({ [EXPORT_FORMAT_KEY]: getSelectedFormat() })
      .catch(() => undefined);
  });
}

async function restoreFormat(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(EXPORT_FORMAT_KEY);
    const value = stored[EXPORT_FORMAT_KEY];
    const input = formatInputs.find((candidate) => candidate.value === value);

    if (input) {
      input.checked = true;
    }
  } catch (error) {
    devWarn("AI Exporter: couldn't read the last file type", error);
  }

  updateFormatHint();
}

/*
 * ---------------------------------------------------------
 * EXPORT
 * ---------------------------------------------------------
 */

interface LoadedConversation {
  messages: Message[];
  images: ExportImageFile[];
}

async function loadConversation(
  conversation: ConversationSummary,
  settings: Settings,
): Promise<LoadedConversation> {
  const data = await sendToTab<LoadedConversation>({
    type: "LOAD_CONVERSATION",
    conversationId: conversation.id,
    downloadImagesLocally: settings.downloadImagesLocally,
  });

  if (!data.messages?.length) {
    throw new Error(t("popup.error.noMessagesFound"));
  }

  return {
    messages: [...data.messages].sort((a, b) => a.order - b.order),
    images: data.images ?? [],
  };
}

/*
 * One chat's files, under `folder` in the ZIP: the document on its
 * own, or - for a text format with downloaded images - a folder
 * holding the document and its images/ folder, the same layout a
 * single-chat export's ZIP has.
 */
async function buildConversationFiles(
  conversation: ConversationSummary,
  loaded: LoadedConversation,
  format: ExportFormat,
  settings: Settings,
  folder: string,
  name: string,
): Promise<ZipEntry[]> {
  const title = titleOf(conversation);

  if (isDocumentFormat(format)) {
    const blob = await buildDocumentBlob(
      format,
      loaded.messages,
      loaded.images,
      settings,
      title,
      conversation.url,
    );

    return [
      {
        path: `${folder}/${name}.${format}`,
        bytes: new Uint8Array(await blob.arrayBuffer()),
      },
    ];
  }

  const markdown = await buildMarkdownFromMessages(loaded.messages, {
    tabTitle: title,
    tabUrl: conversation.url,
    properties: format === "md",
    notes: format === "md" ? "footnotes" : "brackets",
  });
  const { content } = buildContentForFormat(
    format,
    markdown,
    loaded.messages,
    settings,
  );
  const bytes = new TextEncoder().encode(content);

  if (loaded.images.length === 0) {
    return [{ path: `${folder}/${name}.${format}`, bytes }];
  }

  return [
    { path: `${folder}/${name}/`, bytes: new Uint8Array() },
    { path: `${folder}/${name}/${name}.${format}`, bytes },
    { path: `${folder}/${name}/images/`, bytes: new Uint8Array() },
    ...loaded.images.map((image) => ({
      path: `${folder}/${name}/${image.path}`,
      bytes: decodeBase64(image.base64),
    })),
  ];
}

function showProgress(done: number, total: number, current: string): void {
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);

  progressCount.textContent = t("bulk.progress.count", { done, total });
  progressBar.style.width = `${percent}%`;
  progress.setAttribute("aria-valuenow", String(percent));
  progressPercent.textContent = `${percent}%`;
  progressCurrent.textContent = current;
}

function setRunning(value: boolean): void {
  running = value;
  chatsCard.hidden = value;
  formatCard.hidden = value;
  bottomBar.hidden = value;
  progressCard.hidden = !value;
  stopButton.disabled = false;

  if (value) {
    resultCard.hidden = true;
  }

  updateSelectionUi();
}

/*
 * Leaving the page mid-export would throw the finished chats
 * away, so the browser asks first.
 */
window.addEventListener("beforeunload", (event) => {
  if (running) {
    event.preventDefault();
  }
});

stopButton.addEventListener("click", () => {
  stopRequested = true;
  stopButton.disabled = true;
});

async function downloadZip(
  entries: ZipEntry[],
  filename: string,
  settings: Settings,
): Promise<void> {
  const blob = createZipBlob(entries);
  /*
   * Unlike the popup, this page stays open while the browser
   * saves the file, so the blob: URL can be downloaded from here
   * directly instead of being handed to background.ts as base64.
   * It's released once the download is done.
   */
  const url = URL.createObjectURL(blob);
  const downloadId = await chrome.downloads.download({
    url,
    filename,
    saveAs: settings.askWhereToSave,
  });

  const release = (delta: chrome.downloads.DownloadDelta): void => {
    if (
      delta.id === downloadId &&
      (delta.state?.current === "complete" ||
        delta.state?.current === "interrupted")
    ) {
      chrome.downloads.onChanged.removeListener(release);
      URL.revokeObjectURL(url);
    }
  };

  chrome.downloads.onChanged.addListener(release);
}

async function runExport(targets: ConversationSummary[]): Promise<void> {
  if (running || targets.length === 0) {
    return;
  }

  const settings = await loadSettings();
  const format = getSelectedFormat();
  const folder = `${site ?? "chat"}-chats-${localDate(Date.now())}`;
  const entries: ZipEntry[] = [{ path: `${folder}/`, bytes: new Uint8Array() }];
  const usedNames = new Set<string>();
  const failed: { conversation: ConversationSummary; error: string }[] = [];
  let saved = 0;
  let tabGone = false;

  stopRequested = false;
  setRunning(true);
  progressNote.textContent = t("bulk.progress.note", { site: siteName });

  for (const [index, conversation] of targets.entries()) {
    if (stopRequested || tabGone) {
      break;
    }

    showProgress(index, targets.length, titleOf(conversation));

    for (let attempt = 0; ; attempt++) {
      try {
        const loaded = await loadConversation(conversation, settings);
        const name = uniqueName(
          conversationFileBase(conversation, settings.fileNameTemplate, site),
          usedNames,
        );

        entries.push(
          ...(await buildConversationFiles(
            conversation,
            loaded,
            format,
            settings,
            folder,
            name,
          )),
        );
        saved++;
        break;
      } catch (error) {
        if (error instanceof TabUnavailableError) {
          tabGone = true;
        }

        if (
          tabGone ||
          stopRequested ||
          attempt >= RETRY_DELAYS_MS.length
        ) {
          failed.push({ conversation, error: errorMessage(error) });
          break;
        }

        devWarn("AI Exporter: retrying a chat", conversation.id, error);
        await sleep(RETRY_DELAYS_MS[attempt]);
      }
    }

    await sleep(PAUSE_BETWEEN_CHATS_MS);
  }

  const notStarted = targets.slice(saved + failed.length);

  showProgress(saved + failed.length, targets.length, "");

  if (failed.length > 0 || notStarted.length > 0) {
    entries.push({
      path: `${folder}/${t("bulk.notSavedFile")}.txt`,
      bytes: new TextEncoder().encode(
        [
          t("bulk.notSavedHeader"),
          "",
          ...failed.map(
            ({ conversation, error }) =>
              `- ${titleOf(conversation)} (${conversation.url}): ${error}`,
          ),
          ...notStarted.map(
            (conversation) =>
              `- ${titleOf(conversation)} (${conversation.url}): ${t("bulk.notStarted")}`,
          ),
        ].join("\r\n"),
      ),
    });
  }

  let downloadError: string | null = null;

  if (saved > 0) {
    try {
      await downloadZip(entries, `${folder}.zip`, settings);
    } catch (error) {
      downloadError = errorMessage(error);
    }
  }

  lastFailed = [...failed.map((item) => item.conversation), ...notStarted];
  setRunning(false);
  showResult({
    saved,
    total: targets.length,
    failed,
    stopped: stopRequested,
    tabGone,
    downloadError,
  });
}

function showResult(result: {
  saved: number;
  total: number;
  failed: { conversation: ConversationSummary; error: string }[];
  stopped: boolean;
  tabGone: boolean;
  downloadError: string | null;
}): void {
  const allSaved = result.saved === result.total && !result.downloadError;

  chatsCard.hidden = true;
  formatCard.hidden = true;
  bottomBar.hidden = true;
  resultCard.hidden = false;
  resultIconWrap.classList.toggle("is-warning", !allSaved);
  resultIcon.setAttribute("href", allSaved ? "#i-check-circle" : "#i-warning");

  resultTitle.textContent =
    result.saved === 0
      ? t("bulk.result.noneTitle")
      : allSaved
        ? t("bulk.result.doneTitle", { count: result.saved })
        : t("bulk.result.partialTitle", {
            saved: result.saved,
            total: result.total,
          });

  resultText.textContent = result.downloadError
    ? t("bulk.result.downloadFailed", { error: result.downloadError })
    : result.tabGone
      ? t("bulk.error.tabGone", { site: siteName })
      : result.saved === 0
        ? t("bulk.result.noneText")
        : result.stopped
          ? t("bulk.result.stoppedText")
          : t("bulk.result.doneText");

  failedList.replaceChildren(
    ...result.failed.map(({ conversation, error }) => {
      const item = document.createElement("li");
      const reason = document.createElement("span");

      item.textContent = titleOf(conversation);
      reason.className = "failed-reason";
      reason.textContent = error;
      item.append(reason);

      return item;
    }),
  );
  failedBlock.hidden = result.failed.length === 0;
  retryFailedButton.hidden = lastFailed.length === 0 || result.tabGone;
  resultCard.scrollIntoView({ block: "start" });
}

exportButton.addEventListener("click", () => void runExport(chatsToSave()));

retryFailedButton.addEventListener("click", () => void runExport(lastFailed));

backToListButton.addEventListener("click", () => {
  resultCard.hidden = true;
  chatsCard.hidden = false;
  formatCard.hidden = false;
  bottomBar.hidden = false;
  updateSelectionUi();

  // The tab may have been reopened since; start from a fresh list.
  if (!listLoaded || stateError.hidden === false) {
    void loadList();
  }
});

/*
 * ---------------------------------------------------------
 * START
 * ---------------------------------------------------------
 */

async function init(): Promise<void> {
  await Promise.all([applyStoredTheme(), initI18n()]);
  applyTranslations();

  document.title = `${t("bulk.title")} - AI Exporter`;
  pageSubtitle.textContent = t("bulk.subtitle", { site: siteName });

  await restoreFormat();
  await loadList();
}

void init();
