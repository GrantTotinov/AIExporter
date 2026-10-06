/*
 * =========================================================
 * AI Exporter - archive.ts
 * =========================================================
 *
 * The "Open a data export" page: the ZIP ChatGPT or Claude emails
 * on request (see chat-archive.ts), opened here, in the browser.
 *
 *   1. The person picks or drops the export.
 *   2. Every chat in it is listed, newest first, and can be searched
 *      word by word - titles and every message - and read.
 *   3. The ticked chats download in one ZIP, each in the file type
 *      picked, the way "Save many chats" saves them.
 *
 * Nothing is uploaded: the file is read with the File API, and the
 * ZIP is built in the page.
 */
import { loadSettings } from "./settings.ts";
import { applyTranslations, initI18n, t } from "./i18n.ts";
import { formatLabel } from "./format-labels.ts";
import {
  EXPORT_FORMATS,
  buildContentForFormat,
  buildMarkdownFromMessages,
  type ExportFormat,
} from "./export-builders.ts";
import {
  buildDocumentBlob,
  fileExtension,
  isDocumentFormat,
} from "./file-export.ts";
import { conversationFileBase, localDate, uniqueName } from "./bulk-export.ts";
import { createZipBlob, type ZipEntry } from "./zip.ts";
import {
  parseConversationsJson,
  readConversationsJson,
  searchConversations,
  type ArchivedConversation,
} from "./chat-archive.ts";

function byId<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const fileInput = byId<HTMLInputElement>("archive-file");
const dropZone = byId<HTMLLabelElement>("drop-zone");
const status = byId<HTMLParagraphElement>("archive-status");
const chatsCard = byId<HTMLElement>("chats-card");
const formatCard = byId<HTMLElement>("format-card");
const searchInput = byId<HTMLInputElement>("search");
const selectAll = byId<HTMLInputElement>("select-all");
const listCount = byId<HTMLSpanElement>("list-count");
const chatList = byId<HTMLUListElement>("chat-list");
const formatHint = byId<HTMLSpanElement>("format-hint");
const progressCard = byId<HTMLElement>("progress-card");
const progressCount = byId<HTMLParagraphElement>("progress-count");
const bottomBar = byId<HTMLDivElement>("bottom-bar");
const summaryTitle = byId<HTMLElement>("summary-title");
const summaryText = byId<HTMLSpanElement>("summary-text");
const exportButton = byId<HTMLButtonElement>("export");
const preview = byId<HTMLDialogElement>("preview");
const previewTitle = byId<HTMLHeadingElement>("preview-title");
const previewBody = byId<HTMLDivElement>("preview-body");
const formatInputs = Array.from(
  document.querySelectorAll<HTMLInputElement>('input[name="format"]'),
);

/* Long lists show this many rows; a search narrows them down */
const MAX_ROWS = 500;

let conversations: ArchivedConversation[] = [];
let shown: ArchivedConversation[] = [];
const selected = new Set<string>();
let running = false;

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

function titleOf(conversation: ArchivedConversation): string {
  return conversation.title || t("popup.chat.untitled");
}

function showStatus(message: string, error = false): void {
  status.hidden = false;
  status.textContent = message;
  status.classList.toggle("is-error", error);
}

function getSelectedFormat(): ExportFormat {
  const value = formatInputs.find((input) => input.checked)?.value;

  return EXPORT_FORMATS.find((format) => format === value) ?? "pdf";
}

function updateSummary(): void {
  const count = selected.size;

  selectAll.checked = shown.length > 0 && shown.every((item) => selected.has(item.id));
  selectAll.indeterminate = !selectAll.checked && shown.some((item) => selected.has(item.id));
  summaryTitle.textContent = t("bulk.summary.count", { count });
  summaryText.textContent =
    count === 0 ? t("bulk.summary.none") : t("archive.summary", { format: formatLabel(getSelectedFormat()) });
  exportButton.disabled = running || count === 0;
  formatHint.textContent = t(`popup.formatHint.${getSelectedFormat()}`);
}

/*
 * The words of the search marked in a piece of text - built from
 * text nodes, never markup.
 */
function highlighted(text: string, words: string[]): DocumentFragment {
  const fragment = document.createDocumentFragment();

  if (words.length === 0) {
    fragment.append(text);
    return fragment;
  }

  const pattern = new RegExp(
    `(${words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
    "gi",
  );
  let last = 0;

  for (const match of text.matchAll(pattern)) {
    fragment.append(text.slice(last, match.index));

    const mark = document.createElement("mark");

    mark.textContent = match[0];
    fragment.append(mark);
    last = match.index + match[0].length;
  }

  fragment.append(text.slice(last));

  return fragment;
}

function searchWords(): string[] {
  return searchInput.value.toLowerCase().split(/\s+/).filter(Boolean);
}

function openPreview(conversation: ArchivedConversation): void {
  const words = searchWords();

  previewTitle.textContent = titleOf(conversation);
  previewBody.replaceChildren(
    ...conversation.messages.map((message) => {
      const block = document.createElement("p");
      const role = document.createElement("span");

      block.className = "preview-message";
      role.className = "preview-role";
      role.textContent = message.role === "user" ? t("handoff.user") : t("handoff.assistant");
      block.append(role, highlighted(message.content, words));

      return block;
    }),
  );
  preview.showModal();
  previewBody.querySelector("mark")?.scrollIntoView?.({ block: "center" });
}

function renderList(): void {
  shown = searchConversations(conversations, searchInput.value);

  const fragment = document.createDocumentFragment();
  const words = searchWords();

  for (const conversation of shown.slice(0, MAX_ROWS)) {
    const row = document.createElement("li");
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    const title = document.createElement("span");
    const source = document.createElement("span");
    const open = document.createElement("button");
    const time = conversation.updatedAt ?? conversation.createdAt;

    row.className = "chat-row";
    row.classList.toggle("is-selected", selected.has(conversation.id));
    label.style.cssText = "display:contents";
    checkbox.type = "checkbox";
    checkbox.checked = selected.has(conversation.id);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        selected.add(conversation.id);
      } else {
        selected.delete(conversation.id);
      }

      row.classList.toggle("is-selected", checkbox.checked);
      updateSummary();
    });
    title.className = "chat-row-title";
    title.classList.toggle("is-untitled", !conversation.title);
    title.append(highlighted(titleOf(conversation), words));
    title.title = titleOf(conversation);
    source.className = "chat-row-source";
    source.textContent = conversation.source === "chatgpt" ? "ChatGPT" : "Claude";
    open.type = "button";
    open.className = "chat-row-open";
    open.textContent = t("archive.read");
    open.addEventListener("click", () => openPreview(conversation));
    label.append(checkbox, title);
    row.append(label, source);

    if (time !== null) {
      const date = document.createElement("time");

      date.className = "chat-row-date";
      date.dateTime = new Date(time).toISOString();
      date.textContent = dateFormat.format(time);
      row.append(date);
    }

    row.append(open);
    fragment.append(row);
  }

  chatList.replaceChildren(fragment);
  listCount.textContent =
    shown.length > MAX_ROWS
      ? t("archive.countMore", { count: MAX_ROWS, total: shown.length })
      : t("archive.count", { count: shown.length, total: conversations.length });
  updateSummary();
}

async function openFile(file: File | undefined): Promise<void> {
  if (!file || running) {
    return;
  }

  showStatus(t("archive.reading"));

  try {
    conversations = parseConversationsJson(await readConversationsJson(file));
    selected.clear();
    searchInput.value = "";

    const chatgpt = conversations.filter((item) => item.source === "chatgpt").length;

    showStatus(
      t("archive.loaded", {
        count: conversations.length,
        site: chatgpt >= conversations.length - chatgpt ? "ChatGPT" : "Claude",
      }),
    );
    chatsCard.hidden = false;
    formatCard.hidden = false;
    bottomBar.hidden = false;
    renderList();
  } catch (error) {
    showStatus(error instanceof Error ? error.message : String(error), true);
  }
}

async function conversationFiles(
  conversation: ArchivedConversation,
  format: ExportFormat,
  folder: string,
  name: string,
): Promise<ZipEntry[]> {
  const settings = await loadSettings();

  if (isDocumentFormat(format)) {
    const blob = await buildDocumentBlob(
      format,
      conversation.messages,
      [],
      settings,
      conversation.title,
      conversation.url,
    );

    return [
      {
        path: `${folder}/${name}.${fileExtension(format, blob)}`,
        bytes: new Uint8Array(await blob.arrayBuffer()),
      },
    ];
  }

  const markdown = await buildMarkdownFromMessages(conversation.messages, {
    tabTitle: conversation.title,
    tabUrl: conversation.url,
    properties: format === "md",
    notes: format === "md" ? "footnotes" : "brackets",
  });
  const { content } = buildContentForFormat(format, markdown, conversation.messages, settings);

  return [{ path: `${folder}/${name}.${format}`, bytes: new TextEncoder().encode(content) }];
}

async function exportSelected(): Promise<void> {
  const targets = conversations.filter((item) => selected.has(item.id));

  if (running || targets.length === 0) {
    return;
  }

  running = true;
  updateSummary();
  progressCard.hidden = false;

  try {
    const settings = await loadSettings();
    const format = getSelectedFormat();
    const folder = `${targets[0].source}-export-${localDate(Date.now())}`;
    const entries: ZipEntry[] = [{ path: `${folder}/`, bytes: new Uint8Array() }];
    const used = new Set<string>();

    for (const [index, conversation] of targets.entries()) {
      progressCount.textContent = t("archive.progress", {
        count: index + 1,
        total: targets.length,
        title: titleOf(conversation),
      });

      const name = uniqueName(
        conversationFileBase(conversation, settings.fileNameTemplate, conversation.source),
        used,
      );

      entries.push(...(await conversationFiles(conversation, format, folder, name)));
    }

    const url = URL.createObjectURL(createZipBlob(entries));

    await chrome.downloads.download({
      url,
      filename: `${folder}.zip`,
      saveAs: settings.askWhereToSave,
    });
    // The page stays open, so the address can wait for the download.
    setTimeout(() => URL.revokeObjectURL(url), 120_000);
    showStatus(t("archive.saved", { count: targets.length }));
  } catch (error) {
    showStatus(error instanceof Error ? error.message : String(error), true);
  } finally {
    running = false;
    progressCard.hidden = true;
    updateSummary();
  }
}

fileInput.addEventListener("change", () => void openFile(fileInput.files?.[0]));

dropZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropZone.classList.add("is-over");
});

dropZone.addEventListener("dragleave", () => dropZone.classList.remove("is-over"));

dropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropZone.classList.remove("is-over");
  void openFile(event.dataTransfer?.files[0]);
});

let searchTimer: ReturnType<typeof setTimeout> | undefined;

searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(renderList, 150);
});

selectAll.addEventListener("change", () => {
  for (const conversation of shown) {
    if (selectAll.checked) {
      selected.add(conversation.id);
    } else {
      selected.delete(conversation.id);
    }
  }

  renderList();
});

for (const input of formatInputs) {
  input.addEventListener("change", updateSummary);
}

exportButton.addEventListener("click", () => void exportSelected());
byId<HTMLButtonElement>("preview-close").addEventListener("click", () => preview.close());

async function init(): Promise<void> {
  const settings = await loadSettings();

  if (settings.theme !== "system") {
    document.documentElement.dataset.theme = settings.theme;
  }

  await initI18n();
  applyTranslations();
  document.title = `${t("archive.title")} - AI Exporter`;
  updateSummary();
}

void init();
