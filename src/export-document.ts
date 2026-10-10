/*
 * =========================================================
 * AI Exporter - export-document.ts
 * =========================================================
 *
 * What the HTML, Word and Notion exports share: each message
 * cleaned up and parsed into blocks the same way the PDF export
 * does it (see markdown-parse.ts), its formulas pulled out for
 * typesetting, and its downloaded images looked up - so all four
 * rich formats read a conversation identically.
 */
import { getChatSite, roleLabel, stripChatSiteSuffix } from "./chat-sites.ts";
import { extractMath, type MathSpan } from "./math.ts";
import type { RenderedMath, SvgNode } from "./math-render.ts";
import {
  fenceUserContent,
  parseBlocks,
  preprocessRawContent,
  type Block,
} from "./markdown-parse.ts";
import {
  SITE_ONLY_TITLE,
  type ExportImageFile,
  type Message,
} from "./export-builders.ts";
import { normalizeNotes, type MessageSource } from "./source-notes.ts";
import { messageDetails } from "./message-details.ts";

export interface PreparedMessage {
  role: Message["role"];
  /* The name over it: "User", or the AI's ("ChatGPT") */
  label: string;
  blocks: Block[];
  /* The message's downloaded images, shown after its text. */
  images: ExportImageFile[];
  /* The reasoning shown ahead of a reply, when it's exported. */
  thinking: Block[];
  /* The pages its notes cite, shown as a numbered list after it. */
  sources: MessageSource[];
  /*
   * When it was sent and the model that wrote it, shown next to its
   * name ("2026-10-03 14:05 · gpt-4o"); "" when not exported.
   */
  details: string;
  /* The same two on their own, for formats that mark them up */
  time?: number;
  model?: string;
}

export interface PreparedConversation {
  /* The chat's title, or "" when the tab only shows the site's name. */
  title: string;
  messages: PreparedMessage[];
  /*
   * Every formula in the replies, in order; a math run's `math`
   * index (see parseInline) points into this list.
   */
  formulas: MathSpan[];
}

export function documentTitle(tabTitle: string | undefined): string {
  const title = stripChatSiteSuffix(tabTitle ?? "").trim();

  return SITE_ONLY_TITLE.test(title) ? "" : title;
}

/*
 * As in the PDF export, only replies' formulas are typeset - no
 * chat site renders math in what the person typed - and a user
 * message's pasted code or terminal output is fenced so it keeps
 * its line breaks and indentation. The messages come with the
 * settings applied already (see applyContentSettings): a reply
 * only has thinking, sources, a time or a model here when they're
 * to be exported.
 */
export function prepareConversation(
  messages: Message[],
  images: ExportImageFile[],
  tabTitle: string | undefined,
  tabUrl: string | undefined,
): PreparedConversation {
  const site = getChatSite(tabUrl);
  const formulas: MathSpan[] = [];
  const imagesByPath = new Map(images.map((image) => [image.path, image]));

  return {
    title: documentTitle(tabTitle),
    formulas,
    messages: messages.map((message) => {
      const isUser = message.role === "user";
      const sources = message.sources ?? [];
      const content = preprocessRawContent(
        normalizeNotes(
          isUser
            ? message.content
            : extractMath(message.content, site, formulas),
          sources.length,
        ),
      );
      const thinking =
        !isUser && message.thinking
          ? parseBlocks(
              preprocessRawContent(
                extractMath(message.thinking, site, formulas),
              ),
            )
          : [];

      return {
        role: message.role,
        label: roleLabel(message.role, tabUrl),
        blocks: parseBlocks(isUser ? fenceUserContent(content) : content, isUser),
        images: (message.imagePaths ?? [])
          .map((path) => imagesByPath.get(path))
          .filter((image): image is ExportImageFile => Boolean(image)),
        thinking,
        sources,
        details: messageDetails(message),
        ...(message.time !== undefined ? { time: message.time } : {}),
        ...(message.model ? { model: message.model } : {}),
      };
    }),
  };
}

/*
 * Typesets the formulas with MathJax, which is only loaded when
 * there are any. A formula MathJax can't typeset - or a failed
 * load - comes back as null, and the caller shows its source.
 */
export async function renderFormulas(
  formulas: MathSpan[],
): Promise<(RenderedMath | null)[]> {
  if (formulas.length === 0) {
    return [];
  }

  try {
    const { renderTex } = await import("./math-render.ts");

    return formulas.map((formula) => renderTex(formula.tex, formula.display));
  } catch {
    return formulas.map(() => null);
  }
}

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/*
 * A typeset formula as standalone SVG markup. MathJax draws in
 * currentColor, so in HTML a formula takes the color of the text
 * around it; `color` pins it for an SVG rendered on its own (an
 * image in a Word document).
 */
export function svgMarkup(rendered: RenderedMath, color?: string): string {
  function write(node: SvgNode): string {
    const attrs = Object.entries(node.attrs)
      .map(([name, value]) => ` ${name}="${escapeXml(value)}"`)
      .join("");
    const inner =
      (node.text ? escapeXml(node.text) : "") +
      node.children.map(write).join("");

    return `<${node.tag}${attrs}>${inner}</${node.tag}>`;
  }

  const root: SvgNode = {
    ...rendered.root,
    attrs: {
      xmlns: "http://www.w3.org/2000/svg",
      ...rendered.root.attrs,
      ...(color ? { color } : {}),
    },
  };

  return write(root);
}

/*
 * A formula's size in ems, from its viewBox (thousandths of an em,
 * baseline at y = 0): its width, its height and how far it reaches
 * below the baseline.
 */
export function formulaMetrics(rendered: RenderedMath): {
  width: number;
  height: number;
  depth: number;
} {
  const [, minY, width, height] = rendered.viewBox;

  return {
    width: width / 1000,
    height: height / 1000,
    depth: Math.max(0, (minY + height) / 1000),
  };
}
