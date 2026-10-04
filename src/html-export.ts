/*
 * =========================================================
 * AI Exporter - html-export.ts
 * =========================================================
 *
 * Renders a conversation as one self-contained web page: styles
 * inline, code blocks syntax-colored (see code-highlight.ts),
 * formulas typeset by MathJax as inline SVG, and downloaded
 * images embedded as data: URLs - so the single .html file opens
 * the same in any browser, offline, attached to an email or put
 * on a shared drive. It has no scripts: some mail and file viewers
 * refuse pages that do, and nothing here needs one. It follows
 * the reader's light or dark mode, and prints cleanly.
 */
import type { Settings } from "./settings.ts";
import { CHAT_SITE_NAMES, getChatSite } from "./chat-sites.ts";
import { highlightCode, resolveLanguage } from "./code-highlight.ts";
import {
  parseInline,
  type Block,
  type InlineRun,
  type InlineStyle,
} from "./markdown-parse.ts";
import type { RenderedMath } from "./math-render.ts";
import type { MathSpan } from "./math.ts";
import {
  ROLE_LABELS,
  escapeXml,
  prepareConversation,
  renderFormulas,
  svgMarkup,
  type PreparedMessage,
} from "./export-document.ts";
import {
  applyContentSettings,
  type ExportImageFile,
  type Message,
} from "./export-builders.ts";
import {
  isSafeSourceUrl,
  sourceHost,
  sourceLabel,
  type MessageSource,
} from "./source-notes.ts";

/* Links that may be followed from the page: no javascript: or data: */
const SAFE_LINK_RE = /^(?:https?:|mailto:)/i;

const STYLES = `
:root {
  color-scheme: light dark;
  --bg: #ffffff;
  --text: #1f2328;
  --muted: #656d76;
  --border: #d0d7de;
  --soft: #f6f8fa;
  --user-bg: #eef4ff;
  --user-border: #c8d9ff;
  --user-label: #1f5bc7;
  --assistant-label: #8250df;
  --link: #0969da;
  --code-bg: #f6f8fa;
  --code-text: #1f2328;
  --tok-keyword: #cf222e;
  --tok-literal: #0550ae;
  --tok-string: #0a3069;
  --tok-comment: #6e7781;
  --tok-function: #8250df;
  --tok-type: #953800;
  --tok-tag: #116329;
  --tok-inserted: #116329;
  --tok-inserted-bg: #dafbe1;
  --tok-deleted: #82071e;
  --tok-deleted-bg: #ffebe9;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117;
    --text: #e6edf3;
    --muted: #8d96a0;
    --border: #30363d;
    --soft: #161b22;
    --user-bg: #121d2f;
    --user-border: #1f3a64;
    --user-label: #6ea8fe;
    --assistant-label: #c297ff;
    --link: #4493f8;
    --code-bg: #161b22;
    --code-text: #e6edf3;
    --tok-keyword: #ff7b72;
    --tok-literal: #79c0ff;
    --tok-string: #a5d6ff;
    --tok-comment: #8b949e;
    --tok-function: #d2a8ff;
    --tok-type: #ffa657;
    --tok-tag: #7ee787;
    --tok-inserted: #aff5b4;
    --tok-inserted-bg: #033a16;
    --tok-deleted: #ffdcd7;
    --tok-deleted-bg: #67060c;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans", Helvetica, Arial, sans-serif;
  overflow-wrap: break-word;
}
main { max-width: 820px; margin: 0 auto; padding: 40px 20px 64px; }
.doc-header { margin-bottom: 32px; padding-bottom: 20px; border-bottom: 1px solid var(--border); }
.doc-title { margin: 0 0 8px; font-size: 28px; line-height: 1.25; }
.doc-meta { margin: 0; color: var(--muted); font-size: 14px; }
.doc-meta a { color: var(--link); }
.message { margin: 0 0 28px; }
.message--user { padding: 14px 18px; border: 1px solid var(--user-border); border-radius: 12px; background: var(--user-bg); }
.message > :last-child { margin-bottom: 0; }
.role { margin: 0 0 8px; font-size: 13px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
.message--user .role { color: var(--user-label); }
.message--assistant .role { color: var(--assistant-label); }
.message-rule { margin: 0 0 28px; border: 0; border-top: 1px solid var(--border); }
p, ul, ol, blockquote, table, pre, figure { margin: 0 0 14px; }
h3, h4, h5, h6 { margin: 22px 0 10px; line-height: 1.3; }
h3 { font-size: 22px; } h4 { font-size: 19px; } h5 { font-size: 17px; } h6 { font-size: 16px; }
ul, ol { padding-inline-start: 28px; }
li { margin: 4px 0; }
a { color: var(--link); }
hr { border: 0; border-top: 1px solid var(--border); margin: 20px 0; }
blockquote { padding: 2px 16px; border-inline-start: 4px solid var(--border); color: var(--muted); }
code { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace; font-size: .9em; }
:not(pre) > code { padding: .15em .35em; border-radius: 6px; background: var(--soft); }
.code { margin: 0 0 14px; border: 1px solid var(--border); border-radius: 10px; background: var(--code-bg); overflow: hidden; }
.code-lang { padding: 6px 14px; border-bottom: 1px solid var(--border); color: var(--muted); font: 600 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.code pre { margin: 0; padding: 12px 14px; overflow-x: auto; color: var(--code-text); line-height: 1.5; tab-size: 4; }
.code pre code { font-size: 13.5px; white-space: pre; }
.tok-keyword { color: var(--tok-keyword); }
.tok-literal, .tok-number, .tok-property, .tok-attribute { color: var(--tok-literal); }
.tok-string { color: var(--tok-string); }
.tok-comment, .tok-meta { color: var(--tok-comment); font-style: italic; }
.tok-function { color: var(--tok-function); }
.tok-type, .tok-variable { color: var(--tok-type); }
.tok-tag { color: var(--tok-tag); }
.tok-inserted { color: var(--tok-inserted); background: var(--tok-inserted-bg); }
.tok-deleted { color: var(--tok-deleted); background: var(--tok-deleted-bg); }
.table-wrap { overflow-x: auto; margin: 0 0 14px; }
table { border-collapse: collapse; margin: 0; }
th, td { padding: 6px 12px; border: 1px solid var(--border); text-align: start; vertical-align: top; }
th { background: var(--soft); font-weight: 600; }
.math-display { margin: 0 0 14px; overflow-x: auto; text-align: center; }
.math-source { white-space: pre-wrap; }
figure img { display: block; max-width: 100%; height: auto; border-radius: 8px; }
.thinking { margin: 0 0 16px; padding: 10px 16px; border-inline-start: 3px solid var(--border); border-radius: 8px; background: var(--soft); color: var(--muted); font-size: 15px; }
.thinking > summary { margin: 0 0 6px; color: var(--muted); font-size: 13px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; cursor: pointer; }
.thinking:not([open]) > summary { margin: 0; }
.thinking > :last-child { margin-bottom: 0; }
sup.note { line-height: 0; font-size: .72em; white-space: nowrap; }
sup.note a { padding: 0 1px; text-decoration: none; }
.sources { margin: 4px 0 0; padding-top: 10px; border-top: 1px solid var(--border); font-size: 14px; }
.sources-title { margin: 0 0 6px; color: var(--muted); font-size: 13px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
.sources ol { margin: 0; padding-inline-start: 28px; }
.source-host { color: var(--muted); }
footer { margin-top: 40px; color: var(--muted); font-size: 12px; text-align: center; }
@media print {
  :root { color-scheme: light; }
  body { font-size: 11pt; }
  main { max-width: none; padding: 0; }
  .message--user { break-inside: avoid; }
  .code, figure, tr { break-inside: avoid; }
  .code pre code { white-space: pre-wrap; }
  a { text-decoration: none; }
}
`;

export interface HtmlSource {
  tabTitle: string | undefined;
  tabUrl: string | undefined;
}

export async function buildHtmlDocument(
  messages: Message[],
  images: ExportImageFile[],
  settings: Settings,
  source: HtmlSource,
): Promise<string> {
  const conversation = prepareConversation(
    applyContentSettings(messages, settings),
    images,
    source.tabTitle,
    source.tabUrl,
  );
  const rendered = await renderFormulas(conversation.formulas);
  const site = getChatSite(source.tabUrl);
  const siteName = site ? CHAT_SITE_NAMES[site] : "";
  const title = conversation.title || siteName || "Conversation";

  const meta: string[] = [];

  if (siteName) {
    meta.push(escapeXml(siteName));
  }

  meta.push(`${messages.length} ${messages.length === 1 ? "message" : "messages"}`);

  if (settings.includeTimestamp) {
    meta.push(`Exported ${escapeXml(new Date().toLocaleString())}`);
  }

  if (source.tabUrl && SAFE_LINK_RE.test(source.tabUrl)) {
    meta.push(
      `<a href="${escapeXml(source.tabUrl)}">${escapeXml(source.tabUrl)}</a>`,
    );
  }

  const body = conversation.messages
    .map((message, index) => {
      const rule =
        index > 0 && settings.messageSeparator === "rule"
          ? '<hr class="message-rule">\n'
          : "";

      return (
        rule +
        renderMessage(
          message,
          settings.headingStyle !== "none",
          conversation.formulas,
          rendered,
        )
      );
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="und">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="AI Exporter">
<title>${escapeXml(title)}</title>
<style>${STYLES}</style>
</head>
<body>
<main>
<header class="doc-header">
<h1 class="doc-title" dir="auto">${escapeXml(title)}</h1>
<p class="doc-meta">${meta.join(" · ")}</p>
</header>
${body}
<footer>Saved with AI Exporter</footer>
</main>
</body>
</html>
`;
}

function renderMessage(
  message: PreparedMessage,
  showRole: boolean,
  formulas: MathSpan[],
  rendered: (RenderedMath | null)[],
): string {
  const inline = (text: string, style?: InlineStyle) =>
    renderSegments(text, formulas, rendered, style, message.sources);
  const parts: string[] = [];

  if (showRole) {
    parts.push(`<p class="role">${ROLE_LABELS[message.role]}</p>`);
  }

  // Open: thinking is only in the file when the person asked for it.
  if (message.thinking.length > 0) {
    parts.push(
      '<details class="thinking" open><summary>Thinking</summary>\n' +
        message.thinking.map((block) => renderBlock(block, inline)).join("\n") +
        "\n</details>",
    );
  }

  for (const block of message.blocks) {
    parts.push(renderBlock(block, inline));
  }

  for (const image of message.images) {
    parts.push(
      `<figure><img src="data:${escapeXml(image.mimeType)};base64,${image.base64}" alt="" loading="lazy"></figure>`,
    );
  }

  if (message.sources.length > 0) {
    parts.push(renderSources(message.sources));
  }

  return `<section class="message message--${message.role}">\n${parts.join("\n")}\n</section>`;
}

/* The reply's sources, numbered as its notes cite them */
function renderSources(sources: MessageSource[]): string {
  const items = sources
    .map((source) => {
      const label = escapeXml(sourceLabel(source));
      const host = sourceHost(source.url);
      const title = isSafeSourceUrl(source.url)
        ? `<a href="${escapeXml(source.url)}">${label}</a>`
        : label;

      return `<li dir="auto">${title}${
        host && host !== sourceLabel(source)
          ? ` <span class="source-host">· ${escapeXml(host)}</span>`
          : ""
      }</li>`;
    })
    .join("");

  return `<div class="sources"><p class="sources-title">Sources</p><ol>${items}</ol></div>`;
}

/* A note: its numbers raised, each linking to its source's page */
function renderNote(numbers: number[], sources: MessageSource[]): string {
  const links = numbers.map((number) => {
    const source = sources[number - 1];

    if (!source || !isSafeSourceUrl(source.url)) {
      return String(number);
    }

    return `<a href="${escapeXml(source.url)}" title="${escapeXml(sourceLabel(source))}">${number}</a>`;
  });

  return `<sup class="note">[${links.join(", ")}]</sup>`;
}

type InlineRenderer = (text: string, style?: InlineStyle) => string;

function renderBlock(block: Block, inline: InlineRenderer): string {
  switch (block.type) {
    case "heading": {
      // The page title is <h1> and the role labels sit above a
      // message's own headings, so "#" in a reply becomes <h3>.
      const level = Math.min(block.level + 2, 6);

      return `<h${level} dir="auto">${inline(block.text)}</h${level}>`;
    }
    case "paragraph":
      return `<p dir="auto">${inline(block.text)}</p>`;
    case "blockquote":
      return `<blockquote dir="auto"><p>${inline(block.text)}</p></blockquote>`;
    case "list": {
      const tag = block.ordered ? "ol" : "ul";
      const items = block.items
        .map((item) => `<li dir="auto">${inline(item)}</li>`)
        .join("");

      return `<${tag}>${items}</${tag}>`;
    }
    case "table": {
      const head = block.header
        .map((cell) => `<th dir="auto">${inline(cell)}</th>`)
        .join("");
      const rows = block.rows
        .map(
          (row) =>
            `<tr>${block.header
              .map((_, column) => `<td dir="auto">${inline(row[column] ?? "")}</td>`)
              .join("")}</tr>`,
        )
        .join("\n");

      return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>\n${rows}\n</tbody></table></div>`;
    }
    case "code":
      return renderCode(block.code, block.lang);
    case "hr":
      return "<hr>";
  }
}

function renderCode(code: string, lang?: string): string {
  const lines = highlightCode(code, lang).map((tokens) =>
    tokens
      .map((token) =>
        token.kind === "plain"
          ? escapeXml(token.text)
          : `<span class="tok-${token.kind}">${escapeXml(token.text)}</span>`,
      )
      .join(""),
  );
  const label =
    resolveLanguage(lang) ?? lang?.trim().split(/[\s{},]/).find(Boolean);

  return (
    '<div class="code" dir="ltr">' +
    (label ? `<div class="code-lang">${escapeXml(label)}</div>` : "") +
    `<pre><code>${lines.join("\n")}</code></pre></div>`
  );
}

/* Hard line breaks inside a paragraph arrive as "\n" (see joinLines) */
function renderSegments(
  text: string,
  formulas: MathSpan[],
  rendered: (RenderedMath | null)[],
  style: InlineStyle | undefined,
  sources: MessageSource[],
): string {
  return text
    .split("\n")
    .map((segment) =>
      parseInline(segment, style)
        .map((run) => renderRun(run, formulas, rendered, sources))
        .join(""),
    )
    .join("<br>");
}

function renderRun(
  run: InlineRun,
  formulas: MathSpan[],
  rendered: (RenderedMath | null)[],
  sources: MessageSource[],
): string {
  let html: string;

  if (run.notes) {
    return renderNote(run.notes, sources);
  }

  if (run.math !== undefined) {
    const formula = formulas[run.math];
    const svg = rendered[run.math];

    if (!formula) {
      return "";
    }

    if (!svg) {
      html = `<code class="math-source">${escapeXml(formula.tex)}</code>`;
    } else if (formula.display) {
      // A display formula is its own block; a <div> inside the
      // surrounding <p> would end the paragraph, so it's a block
      // styled <span>.
      return `<span class="math-display" style="display:block" role="img" aria-label="${escapeXml(formula.tex)}">${svgMarkup(svg)}</span>`;
    } else {
      html = `<span class="math" role="img" aria-label="${escapeXml(formula.tex)}">${svgMarkup(svg)}</span>`;
    }
  } else {
    html = escapeXml(run.text);

    if (run.code) {
      html = `<code>${html}</code>`;
    }
  }

  if (run.italic) {
    html = `<em>${html}</em>`;
  }

  if (run.bold) {
    html = `<strong>${html}</strong>`;
  }

  if (run.link && SAFE_LINK_RE.test(run.link)) {
    html = `<a href="${escapeXml(run.link)}">${html}</a>`;
  }

  return html;
}
