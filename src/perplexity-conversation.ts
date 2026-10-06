/*
 * =========================================================
 * AI Exporter - perplexity-conversation.ts
 * =========================================================
 *
 * Turns a www.perplexity.ai thread, as the web app's own API
 * returns it, into the messages content.ts hands to popup.ts.
 * Requests carry the session cookie:
 *
 *   GET  /rest/thread/{slug or uuid}?with_parent_info=true
 *        &with_schematized_response=true&version=2.18
 *        &source=default&limit=50&offset=0&from_first=true
 *        -> { status, entries: [...], has_next_page }
 *   POST /rest/thread/list_ask_threads?version=2.18&source=default
 *        { limit, offset, ascending: false, search_term: "" }
 *        -> [{ uuid, slug, title, last_query_datetime }]
 *
 * A thread is a list of entries, a question and its answer each:
 * the question at query_str; the answer in `blocks` - its Markdown
 * at markdown_block.answer of the "ask_text_0_markdown" block (or
 * of "ask_text", which has it in chunks too), its web results at
 * web_result_block.web_results (or sources_mode_block, or the
 * plan's search steps), and the steps Pro Search and Research
 * planned at plan_block.goals. Older entries keep it all in
 * `text`: a JSON string of steps whose FINAL step holds the answer
 * - itself a JSON string with "answer" and "web_results". The
 * answer cites its web results as "[1]", counted from 1.
 *
 * Field names follow the web app's API as open-source clients read
 * it; everything is read defensively, since the API is
 * undocumented. Imported only by content.ts, so Rollup inlines it
 * into content.js - see the top of claude-conversation.ts.
 */
import {
  ReplySources,
  replyExtras,
  type ReplySource,
} from "./reply-sources.ts";
import { messageMetadata, timeFromIso } from "./message-metadata.ts";

export interface PerplexityImage {
  url: string | null;
  fileName: string;
}

export type PerplexityMessagePart =
  | { kind: "text"; text: string }
  | { kind: "image"; image: PerplexityImage };

export interface PerplexityExportMessage {
  id: string;
  role: "user" | "assistant";
  parts: PerplexityMessagePart[];
  thinking?: string;
  sources?: ReplySource[];
  /* When it was asked or answered, in milliseconds since the epoch */
  time?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/* The API version the web app's own requests name */
export const PERPLEXITY_API_VERSION = "2.18";

/*
 * ---------------------------------------------------------
 * IDS AND REQUESTS
 * ---------------------------------------------------------
 *
 * Threads live at /search/{slug}, the question's words and an id
 * ("how-to-cook-rice-4kT3x7mRQ2yC1x0Pz6Hn8Q").
 */
const THREAD_PATH_PATTERN = /^\/search\/([^/]{1,512})\/?$/;

export function getPerplexityThreadSlug(pathname: string): string | null {
  const slug = pathname.match(THREAD_PATH_PATTERN)?.[1];

  if (!slug) {
    return null;
  }

  try {
    return decodeURIComponent(slug);
  } catch {
    return slug;
  }
}

export function buildPerplexityThreadPath(
  thread: string,
  offset: number,
  limit: number,
): string {
  const params = new URLSearchParams({
    with_parent_info: "true",
    with_schematized_response: "true",
    version: PERPLEXITY_API_VERSION,
    source: "default",
    limit: String(limit),
    offset: String(offset),
    from_first: "true",
  });

  return `/rest/thread/${encodeURIComponent(thread)}?${params.toString()}`;
}

export function buildPerplexityListRequest(
  limit: number,
  offset: number,
): { path: string; body: string } {
  return {
    path: `/rest/thread/list_ask_threads?${new URLSearchParams({
      version: PERPLEXITY_API_VERSION,
      source: "default",
    }).toString()}`,
    body: JSON.stringify({
      limit,
      offset,
      ascending: false,
      search_term: "",
    }),
  };
}

/* The headers the web app's own API requests carry */
export const PERPLEXITY_HEADERS: Record<string, string> = {
  Accept: "application/json",
  "x-app-apiclient": "default",
  "x-app-apiversion": PERPLEXITY_API_VERSION,
};

export function parsePerplexityThread(data: unknown): {
  entries: unknown[];
  hasNextPage: boolean;
} {
  if (!isRecord(data)) {
    throw new Error("Perplexity returned an unexpected thread format.");
  }

  const entries = Array.isArray(data.entries)
    ? data.entries
    : Array.isArray(data.steps)
      ? data.steps
      : null;

  if (!entries) {
    throw new Error("Perplexity returned an unexpected thread format.");
  }

  return { entries, hasNextPage: data.has_next_page === true };
}

/*
 * ---------------------------------------------------------
 * THREAD LIST
 * ---------------------------------------------------------
 */
export interface PerplexityThreadSummary {
  /* The thread's uuid, which /rest/thread/ takes like its slug */
  id: string;
  slug: string;
  title: string;
  updatedAt: number | null;
}

export function parsePerplexityThreadList(data: unknown): PerplexityThreadSummary[] {
  const list = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data.threads)
      ? data.threads
      : null;

  if (!list) {
    throw new Error("Perplexity returned an unexpected thread list format.");
  }

  return records(list).flatMap((thread): PerplexityThreadSummary[] => {
    const id = stringValue(thread.uuid);
    const slug = stringValue(thread.slug);

    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id) || !slug) {
      return [];
    }

    const updated = Date.parse(stringValue(thread.last_query_datetime));

    return [
      {
        id,
        slug,
        title: (stringValue(thread.title) || stringValue(thread.query_str)).trim(),
        updatedAt: Number.isNaN(updated) ? null : updated,
      },
    ];
  });
}

/*
 * ---------------------------------------------------------
 * ANSWERS
 * ---------------------------------------------------------
 */
interface WebResult {
  url: unknown;
  title: string;
}

function webResults(list: unknown): WebResult[] {
  return records(list)
    .filter((result) => typeof result.url === "string")
    .map((result) => ({
      url: result.url,
      title: stringValue(result.name) || stringValue(result.title),
    }));
}

/*
 * An older entry's answer: `text` is a JSON string of steps, the
 * FINAL one holding the answer as yet another JSON string.
 */
function legacyAnswer(entry: Record<string, unknown>): { text: string; results: WebResult[] } {
  try {
    const steps: unknown = JSON.parse(stringValue(entry.text));
    const final = records(steps).find((step) => step.step_type === "FINAL");
    const content = isRecord(final?.content) ? final.content : {};
    const answer: unknown =
      typeof content.answer === "string" ? JSON.parse(content.answer) : content.answer;

    return isRecord(answer)
      ? { text: stringValue(answer.answer), results: webResults(answer.web_results) }
      : { text: "", results: [] };
  } catch {
    return { text: "", results: [] };
  }
}

/*
 * The answer's Markdown and the web results its "[n]" count, in
 * the order the answer numbers them.
 */
function entryAnswer(entry: Record<string, unknown>): {
  text: string;
  results: WebResult[];
  goals: string[];
} {
  const blocks = records(entry.blocks);
  const withAnswer = blocks.filter(
    (block) =>
      isRecord(block.markdown_block) && stringValue(block.markdown_block.answer),
  );
  const preferred =
    withAnswer.find((block) => block.intended_usage === "ask_text_0_markdown") ??
    withAnswer.find((block) => block.intended_usage === "ask_text") ??
    withAnswer[0];
  let text = preferred && isRecord(preferred.markdown_block)
    ? stringValue(preferred.markdown_block.answer)
    : "";

  const lists = [
    ...blocks.map((block) =>
      webResults(isRecord(block.web_result_block) ? block.web_result_block.web_results : null),
    ),
    ...blocks.map((block) =>
      webResults(isRecord(block.sources_mode_block) ? block.sources_mode_block.web_results : null),
    ),
    ...blocks.flatMap((block) =>
      records(isRecord(block.plan_block) ? block.plan_block.steps : null).map((step) =>
        webResults(
          isRecord(step.web_results_content) ? step.web_results_content.web_results : null,
        ),
      ),
    ),
  ];
  let results = lists.find((list) => list.length > 0) ?? [];

  if (!text) {
    const legacy = legacyAnswer(entry);

    text = legacy.text;
    results = results.length > 0 ? results : legacy.results;
  }

  const goals = blocks.flatMap((block) =>
    records(isRecord(block.plan_block) ? block.plan_block.goals : null)
      .map((goal) => stringValue(goal.description).trim())
      .filter(Boolean),
  );

  return { text, results, goals };
}

/*
 * Citation markers - "[1]", "[1][3]" - outside code, and not the
 * text of a link ("[1](...)") or a reference ("[1]: ..."). A
 * number past the end of the results isn't a citation and stays.
 */
const CITATION_OR_CODE_RE =
  /(```[\s\S]*?(?:```|$)|`[^`\n]+`)|(?<!\])[ \t]*(?:\[\d{1,3}\])+(?![(:])/g;

function answerWithNotes(
  text: string,
  results: WebResult[],
  sources: ReplySources,
): string {
  return text.replace(CITATION_OR_CODE_RE, (match, code?: string) => {
    if (code !== undefined) {
      return match;
    }

    const numbers = [...match.matchAll(/\[(\d{1,3})\]/g)].map((found) => Number(found[1]));

    if (numbers.some((number) => number < 1 || number > results.length)) {
      return match;
    }

    return sources.note(
      numbers.map((number) => sources.add(results[number - 1].url, results[number - 1].title)),
    );
  });
}

/* Reasoning models write their thinking at the top, in <think> */
const THINK_BLOCK_RE = /^\s*<think>([\s\S]*?)<\/think>\s*/;

/* The file name at the end of an address ("report%201.pdf" -> "report 1.pdf") */
function fileNameFromUrl(url: string): string {
  const name = url.split(/[?#]/)[0].split("/").pop() ?? "";

  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

function questionParts(entry: Record<string, unknown>): PerplexityMessagePart[] {
  const parts: PerplexityMessagePart[] = [];

  for (const attachment of Array.isArray(entry.attachments) ? entry.attachments : []) {
    const url = isRecord(attachment)
      ? stringValue(attachment.url) || stringValue(attachment.file_url)
      : stringValue(attachment);
    const fileName =
      (isRecord(attachment) ? stringValue(attachment.name) || stringValue(attachment.file_name) : "") ||
      fileNameFromUrl(url) ||
      "file";

    if (!url) {
      continue;
    }

    parts.push(
      /\.(?:avif|bmp|gif|jpe?g|png|webp)$/i.test(url.split(/[?#]/)[0])
        ? { kind: "image", image: { url: /^https:\/\//.test(url) ? url : null, fileName } }
        : { kind: "text", text: `[Attachment: ${fileName}]` },
    );
  }

  const query = stringValue(entry.query_str).replace(/^(?:[ \t]*\n)+/, "").trimEnd();

  if (query) {
    parts.push({ kind: "text", text: query });
  }

  return parts;
}

/*
 * When the question was asked, from whichever of the date fields
 * the API has used the entry has - the time it was asked before
 * the time its answer was last written.
 */
const ENTRY_TIME_FIELDS = [
  "entry_created_datetime",
  "created_datetime",
  "entry_updated_datetime",
  "updated_datetime",
];

function entryTime(entry: Record<string, unknown>): number | undefined {
  for (const field of ENTRY_TIME_FIELDS) {
    const time = timeFromIso(entry[field]);

    if (time !== undefined) {
      return time;
    }
  }

  return undefined;
}

/*
 * Takes a thread's entries, oldest first, and returns its
 * questions and answers.
 */
export function convertPerplexityEntries(entries: unknown[]): PerplexityExportMessage[] {
  const messages: PerplexityExportMessage[] = [];

  records(entries).forEach((entry, index) => {
    const id =
      stringValue(entry.backend_uuid) || stringValue(entry.uuid) || `entry-${index + 1}`;
    const metadata = messageMetadata(entryTime(entry));
    const question = questionParts(entry);

    if (question.length > 0) {
      messages.push({ id: `${id}-question`, role: "user", parts: question, ...metadata });
    }

    const answer = entryAnswer(entry);
    const think = answer.text.match(THINK_BLOCK_RE);
    const sources = new ReplySources();
    const text = answerWithNotes(
      (think ? answer.text.slice(think[0].length) : answer.text)
        .replace(/^(?:[ \t]*\n)+/, "")
        .trimEnd(),
      answer.results,
      sources,
    );

    // The rest of the results the answer was given, after those it cites
    for (const result of answer.results) {
      sources.add(result.url, result.title);
    }

    const thinking = [
      answer.goals.map((goal) => `- ${goal}`).join("\n"),
      think?.[1].trim() ?? "",
    ]
      .filter(Boolean)
      .join("\n\n");

    if (text) {
      messages.push({
        id,
        role: "assistant",
        parts: [{ kind: "text", text }],
        ...replyExtras(thinking, sources),
        ...metadata,
      });
    }
  });

  return messages;
}
