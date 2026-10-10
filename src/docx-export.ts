/*
 * =========================================================
 * AI Exporter - docx-export.ts
 * =========================================================
 *
 * Writes a conversation as a Word document (.docx) - the format
 * people who don't work with code know how to open and edit. A
 * .docx is a ZIP of XML files (Office Open XML); this builds the
 * few parts Word, LibreOffice, Google Docs and Pages need, and
 * zips them with zip.ts, rather than pulling in a library several
 * times the size of everything else here.
 *
 * Each role label is a "Heading 1", so Word's navigation pane
 * lists the messages; a reply's own headings come below it. Code
 * keeps its syntax colors (see code-highlight.ts), lists and
 * tables are real Word lists and tables, links stay clickable,
 * and right-to-left paragraphs are marked as such. Formulas are
 * Word's own equations (OMML, see omml.ts) - editable, searchable
 * and copyable like one typed in Word; one that can't be converted
 * is typeset by MathJax and placed as a sharp, high-resolution
 * picture, and without a canvas to draw that on, its TeX source is
 * shown instead. Downloaded images are embedded, scaled to fit the
 * page.
 */
import type { Settings } from "./settings.ts";
import { CHAT_SITE_NAMES, getChatSite } from "./chat-sites.ts";
import { highlightCode, type TokenKind } from "./code-highlight.ts";
import {
  parseInline,
  tableHasHeader,
  type Block,
  type InlineRun,
} from "./markdown-parse.ts";
import type { RenderedMath } from "./math-render.ts";
import type { MathSpan } from "./math.ts";
import { OMML_NAMESPACE, mathMlToOmml } from "./omml.ts";
import { hasRtl, isRtlParagraph } from "./bidi.ts";
import { createZipBlob, decodeBase64, type ZipEntry } from "./zip.ts";
import {
  escapeXml,
  formulaMetrics,
  prepareConversation,
  renderFormulas,
  svgMarkup,
} from "./export-document.ts";
import {
  applyContentSettings,
  type ExportImageFile,
  type Message,
} from "./export-builders.ts";
import {
  sourceHost,
  sourceLabel,
  type MessageSource,
} from "./source-notes.ts";

export const DOCX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const SAFE_LINK_RE = /^(?:https?:|mailto:)/i;

/* A4, with 2 cm margins - in twentieths of a point ("twips") */
const PAGE_WIDTH = 11906;
const PAGE_HEIGHT = 16838;
const PAGE_MARGIN = 1134;
const CONTENT_WIDTH = PAGE_WIDTH - 2 * PAGE_MARGIN;
const EMU_PER_TWIP = 635;
const EMU_PER_PX = 9525;
const BODY_PT = 11;
/* Formulas are drawn this many times larger than shown, to stay sharp */
const MATH_SUPERSAMPLE = 4;

const CODE_COLORS: Record<TokenKind, string> = {
  plain: "282828",
  keyword: "CF222E",
  literal: "0550AE",
  string: "0A3069",
  comment: "6E7781",
  number: "0550AE",
  function: "8250DF",
  type: "953800",
  property: "0550AE",
  variable: "953800",
  meta: "6E7781",
  tag: "116329",
  attribute: "0550AE",
  inserted: "116329",
  deleted: "82071E",
};

const ROLE_COLORS: Record<Message["role"], string> = {
  user: "1F5BC7",
  assistant: "8250DF",
};

const NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" ' +
  OMML_NAMESPACE;

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/*
 * Characters XML 1.0 doesn't allow at all - a stray control
 * character copied from a terminal would otherwise make Word
 * refuse to open the whole document.
 */
const INVALID_XML_RE =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function xmlText(text: string): string {
  return escapeXml(text.replace(INVALID_XML_RE, ""));
}

interface Picture {
  bytes: Uint8Array;
  extension: "png" | "jpeg" | "gif";
  /* Displayed size, in EMUs */
  width: number;
  height: number;
  description: string;
}

/*
 * ---------------------------------------------------------
 * IMAGES
 * ---------------------------------------------------------
 */
function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

/*
 * The pixel size of a PNG, JPEG or GIF, read from its header - no
 * DOM needed - or null when the bytes aren't one of those.
 */
export function imagePixelSize(
  bytes: Uint8Array,
): { width: number; height: number; extension: Picture["extension"] } | null {
  if (
    bytes.length > 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return {
      width: readUint32(bytes, 16),
      height: readUint32(bytes, 20),
      extension: "png",
    };
  }

  if (
    bytes.length > 10 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46
  ) {
    return {
      width: bytes[6] | (bytes[7] << 8),
      height: bytes[8] | (bytes[9] << 8),
      extension: "gif",
    };
  }

  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;

    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset++;
        continue;
      }

      const marker = bytes[offset + 1];
      const length = (bytes[offset + 2] << 8) | bytes[offset + 3];

      // Start-of-frame markers (not DHT, JPG or DAC) hold the size.
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        return {
          height: (bytes[offset + 5] << 8) | bytes[offset + 6],
          width: (bytes[offset + 7] << 8) | bytes[offset + 8],
          extension: "jpeg",
        };
      }

      offset += 2 + length;
    }
  }

  return null;
}

function canvasContext(): CanvasRenderingContext2D | null {
  try {
    return document.createElement("canvas").getContext("2d");
  } catch {
    return null;
  }
}

/*
 * Draws an image Word can't show (WebP, SVG...) onto a canvas and
 * reads it back as a PNG. `size` sets the drawn size in pixels;
 * the image's own size otherwise.
 */
async function rasterize(
  sourceUrl: string,
  size?: { width: number; height: number },
): Promise<{ bytes: Uint8Array; width: number; height: number } | null> {
  const context = canvasContext();

  if (!context) {
    return null;
  }

  try {
    const image = new Image();

    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(
        () => reject(new Error("image load timed out")),
        10_000,
      );

      image.onload = () => {
        window.clearTimeout(timeout);
        resolve();
      };
      image.onerror = () => {
        window.clearTimeout(timeout);
        reject(new Error("image decode failed"));
      };
      image.src = sourceUrl;
    });

    const width = Math.max(1, Math.round(size?.width ?? image.naturalWidth));
    const height = Math.max(1, Math.round(size?.height ?? image.naturalHeight));
    const canvas = context.canvas;

    canvas.width = width;
    canvas.height = height;
    context.drawImage(image, 0, 0, width, height);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/png"),
    );

    if (!blob) {
      return null;
    }

    return { bytes: new Uint8Array(await blob.arrayBuffer()), width, height };
  } catch {
    return null;
  }
}

async function pictureFromImage(
  image: ExportImageFile,
): Promise<Picture | null> {
  const original = decodeBase64(image.base64);
  let bytes = original;
  let info = imagePixelSize(original);

  if (!info) {
    const png = await rasterize(`data:${image.mimeType};base64,${image.base64}`);

    if (!png) {
      return null;
    }

    bytes = png.bytes;
    info = { width: png.width, height: png.height, extension: "png" };
  }

  if (info.width === 0 || info.height === 0) {
    return null;
  }

  // Shown at 96 dpi, but never wider than the page.
  const maxWidth = CONTENT_WIDTH * EMU_PER_TWIP;
  const scale = Math.min(1, maxWidth / (info.width * EMU_PER_PX));

  return {
    bytes,
    extension: info.extension,
    width: Math.round(info.width * EMU_PER_PX * scale),
    height: Math.round(info.height * EMU_PER_PX * scale),
    description: "",
  };
}

interface MathPicture extends Picture {
  /* How far below the text baseline it reaches, in half-points */
  lower: number;
}

/*
 * Each formula as a Word equation (see omml.ts), or null where it
 * can't be one. MathJax - a large module - is only loaded when the
 * conversation has formulas.
 */
async function formulaEquations(formulas: MathSpan[]): Promise<(string | null)[]> {
  if (formulas.length === 0) {
    return [];
  }

  try {
    const { texToMathML } = await import("./math-render.ts");

    return formulas.map((formula) => {
      const mathMl = texToMathML(formula.tex, formula.display);

      return mathMl ? mathMlToOmml(mathMl, formula.display) : null;
    });
  } catch {
    return formulas.map(() => null);
  }
}

async function pictureFromFormula(
  rendered: RenderedMath,
  formula: MathSpan,
): Promise<MathPicture | null> {
  const metrics = formulaMetrics(rendered);
  const fontPt = formula.display ? BODY_PT * 1.15 : BODY_PT;
  const pxPerEm = (fontPt * 96) / 72;
  const width = metrics.width * pxPerEm;
  const height = metrics.height * pxPerEm;

  if (!(width > 0 && height > 0)) {
    return null;
  }

  // Sized in pixels for the canvas, rather than MathJax's ex units,
  // which an <img> would resolve against a default font.
  const markup = svgMarkup(
    {
      ...rendered,
      root: {
        ...rendered.root,
        attrs: {
          ...rendered.root.attrs,
          width: `${width * MATH_SUPERSAMPLE}`,
          height: `${height * MATH_SUPERSAMPLE}`,
          style: "",
        },
      },
    },
    "#141414",
  );
  const png = await rasterize(
    `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`,
    { width: width * MATH_SUPERSAMPLE, height: height * MATH_SUPERSAMPLE },
  );

  if (!png) {
    return null;
  }

  return {
    bytes: png.bytes,
    extension: "png",
    width: Math.round(width * EMU_PER_PX),
    height: Math.round(height * EMU_PER_PX),
    description: formula.tex,
    lower: Math.round(metrics.depth * fontPt * 2),
  };
}

/*
 * ---------------------------------------------------------
 * DOCUMENT BUILDER
 * ---------------------------------------------------------
 */
interface RunStyle {
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  color?: string;
  size?: number;
  /* Raised and small, like a footnote's number */
  superscript?: boolean;
}

class DocxWriter {
  private relationships: string[] = [];
  private media: ZipEntry[] = [];
  private nextRelationship = 1;
  private nextPicture = 1;
  /* w:num ids; 1 is the shared bullet list */
  private numbering: string[] = [
    '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>',
  ];
  private nextNumbering = 2;

  constructor() {
    this.relationship(
      "http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles",
      "styles.xml",
    );
    this.relationship(
      "http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering",
      "numbering.xml",
    );
    this.relationship(
      "http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings",
      "settings.xml",
    );
  }

  private relationship(type: string, target: string, external = false): string {
    const id = `rId${this.nextRelationship++}`;

    this.relationships.push(
      `<Relationship Id="${id}" Type="${type}" Target="${escapeXml(target)}"${
        external ? ' TargetMode="External"' : ""
      }/>`,
    );

    return id;
  }

  hyperlink(url: string): string {
    return this.relationship(
      "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink",
      url,
      true,
    );
  }

  /* A new numbered list - nested `level` deep - counting from 1 */
  orderedList(level = 0): number {
    const id = this.nextNumbering++;

    this.numbering.push(
      `<w:num w:numId="${id}"><w:abstractNumId w:val="1"/>` +
        `<w:lvlOverride w:ilvl="${level}"><w:startOverride w:val="1"/></w:lvlOverride></w:num>`,
    );

    return id;
  }

  /* An inline picture run */
  picture(picture: Picture, runProperties = ""): string {
    const index = this.nextPicture++;
    const name = `image${index}.${picture.extension}`;
    const id = this.relationship(
      "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image",
      `media/${name}`,
    );

    this.media.push({ path: `word/media/${name}`, bytes: picture.bytes });

    const description = picture.description
      ? ` descr="${xmlText(picture.description)}"`
      : "";

    return (
      `<w:r>${runProperties ? `<w:rPr>${runProperties}</w:rPr>` : ""}<w:drawing>` +
      '<wp:inline distT="0" distB="0" distL="0" distR="0">' +
      `<wp:extent cx="${picture.width}" cy="${picture.height}"/>` +
      `<wp:docPr id="${index}" name="Picture ${index}"${description}/>` +
      '<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
      '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
      `<pic:pic><pic:nvPicPr><pic:cNvPr id="${index}" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr>` +
      `<pic:blipFill><a:blip r:embed="${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
      `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${picture.width}" cy="${picture.height}"/></a:xfrm>` +
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>' +
      "</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>"
    );
  }

  files(): { relationships: string; numbering: string; media: ZipEntry[] } {
    return {
      relationships:
        XML_HEADER +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        this.relationships.join("") +
        "</Relationships>",
      numbering: buildNumberingXml(this.numbering),
      media: this.media,
    };
  }
}

function runProperties(style: RunStyle, text: string): string {
  let properties = "";

  if (style.code) {
    properties += '<w:rStyle w:val="CodeChar"/>';
  }

  if (style.bold) {
    properties += "<w:b/><w:bCs/>";
  }

  if (style.italic) {
    properties += "<w:i/><w:iCs/>";
  }

  if (style.color) {
    properties += `<w:color w:val="${style.color}"/>`;
  }

  if (style.size) {
    properties += `<w:sz w:val="${style.size}"/><w:szCs w:val="${style.size}"/>`;
  }

  if (style.superscript) {
    properties += '<w:vertAlign w:val="superscript"/>';
  }

  if (hasRtl(text)) {
    properties += "<w:rtl/>";
  }

  return properties;
}

function textRun(text: string, style: RunStyle = {}): string {
  if (text === "") {
    return "";
  }

  // The spaces around right-to-left words stay out of their <w:rtl/>
  // run: Word would draw them on the run's far side ("مرحبًا(Marhaban)").
  const [, before, words, after] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text) ?? [];

  if (hasRtl(text) && (before || after)) {
    return textRun(before, style) + textRun(words, style) + textRun(after, style);
  }

  const properties = runProperties(style, text);

  return (
    `<w:r>${properties ? `<w:rPr>${properties}</w:rPr>` : ""}` +
    `<w:t xml:space="preserve">${xmlText(text)}</w:t></w:r>`
  );
}

/*
 * Word insists on the schema's order of paragraph properties:
 * `extra` holds what comes before <w:bidi/> (numbering), `spacing`
 * what comes after it.
 */
function paragraph(
  content: string,
  options: {
    style?: string;
    rtl?: boolean;
    extra?: string;
    spacing?: string;
  } = {},
): string {
  const properties =
    (options.style ? `<w:pStyle w:val="${options.style}"/>` : "") +
    (options.extra ?? "") +
    (options.rtl ? "<w:bidi/>" : "") +
    (options.spacing ?? "");

  return `<w:p>${properties ? `<w:pPr>${properties}</w:pPr>` : ""}${content}</w:p>`;
}

function expandTabs(line: string, tabSize = 4): string {
  let out = "";

  for (const char of line) {
    out += char === "\t" ? " ".repeat(tabSize - (out.length % tabSize)) : char;
  }

  return out;
}

export interface DocxSource {
  tabTitle: string | undefined;
  tabUrl: string | undefined;
}

export async function buildDocxBlob(
  messages: Message[],
  images: ExportImageFile[],
  settings: Settings,
  source: DocxSource,
): Promise<Blob> {
  const conversation = prepareConversation(
    applyContentSettings(messages, settings),
    images,
    source.tabTitle,
    source.tabUrl,
  );
  const formulas = conversation.formulas;
  const equations = await formulaEquations(formulas);
  // Pictures only for the formulas Word's equations can't hold
  const rendered = await renderFormulas(
    formulas.filter((_, index) => !equations[index]),
  );
  let nextRendered = 0;
  const mathPictures = await Promise.all(
    formulas.map((formula, index) => {
      if (equations[index]) {
        return null;
      }

      const svg = rendered[nextRendered++];

      return svg ? pictureFromFormula(svg, formula) : null;
    }),
  );
  const writer = new DocxWriter();
  const site = getChatSite(source.tabUrl);
  const siteName = site ? CHAT_SITE_NAMES[site] : "";
  const title = conversation.title || siteName || "Conversation";
  const body: string[] = [];
  /* The sources the message being written cites */
  let currentSources: MessageSource[] = [];

  /*
   * A note: "[1, 3]" raised like a footnote's number, each number
   * a link to its source's page.
   */
  function noteXml(numbers: number[]): string {
    const raised: RunStyle = { superscript: true };
    const parts = [textRun("[", raised)];

    numbers.forEach((number, index) => {
      if (index > 0) {
        parts.push(textRun(", ", raised));
      }

      const source = currentSources[number - 1];

      parts.push(
        source && SAFE_LINK_RE.test(source.url)
          ? `<w:hyperlink r:id="${writer.hyperlink(source.url)}" w:history="1">` +
              '<w:r><w:rPr><w:rStyle w:val="Hyperlink"/><w:u w:val="none"/><w:vertAlign w:val="superscript"/></w:rPr>' +
              `<w:t xml:space="preserve">${number}</w:t></w:r></w:hyperlink>`
          : textRun(String(number), raised),
      );
    });

    parts.push(textRun("]", raised));

    return parts.join("");
  }

  function runsXml(runs: InlineRun[], base: RunStyle = {}): string {
    return runs
      .map((run) => {
        if (run.notes) {
          return noteXml(run.notes);
        }

        if (run.math !== undefined) {
          const formula = formulas[run.math];
          const picture = mathPictures[run.math];
          const equation = equations[run.math];

          if (!formula) {
            return "";
          }

          if (equation) {
            return equation;
          }

          if (!picture) {
            return textRun(formula.tex, { ...base, code: true });
          }

          return writer.picture(
            picture,
            !formula.display && picture.lower > 0
              ? `<w:position w:val="${-picture.lower}"/>`
              : "",
          );
        }

        const style: RunStyle = {
          ...base,
          bold: base.bold || run.bold,
          italic: base.italic || run.italic,
          code: run.code,
        };

        if (run.link && SAFE_LINK_RE.test(run.link)) {
          const properties =
            '<w:rStyle w:val="Hyperlink"/>' +
            runProperties({ ...style, code: false }, run.text);

          return (
            `<w:hyperlink r:id="${writer.hyperlink(run.link)}" w:history="1">` +
            `<w:r><w:rPr>${properties}</w:rPr><w:t xml:space="preserve">${xmlText(run.text)}</w:t></w:r>` +
            "</w:hyperlink>"
          );
        }

        return textRun(run.text, style);
      })
      .join("");
  }

  /*
   * Inline Markdown with hard line breaks ("\n", see joinLines). A
   * display formula is lifted into a centered paragraph of its own.
   */
  /* `rtl`: the direction a table cell gets from its table */
  function inlineParagraphs(
    text: string,
    options: { style?: string; extra?: string; base?: RunStyle; rtl?: boolean } = {},
  ): string[] {
    const out: string[] = [];
    let current: string[] = [];
    const rtl = options.rtl ?? isRtlParagraph(text);

    const flush = (): void => {
      if (current.length > 0) {
        out.push(paragraph(current.join(""), { ...options, rtl }));
        current = [];
      }
    };

    text.split("\n").forEach((segment, index) => {
      if (index > 0 && current.length > 0) {
        current.push("<w:r><w:br/></w:r>");
      }

      for (const run of parseInline(segment)) {
        if (run.math !== undefined && formulas[run.math]?.display) {
          flush();
          out.push(
            paragraph(runsXml([run]), {
              style: "MathDisplay",
              extra: options.extra,
            }),
          );
        } else {
          current.push(runsXml([run], options.base));
        }
      }
    });

    flush();

    return out.length > 0 ? out : [paragraph("", options)];
  }

  function codeBlock(code: string, lang?: string): string[] {
    const lines = highlightCode(code, lang);

    const all = lines.length > 0 ? lines : [[]];

    // One paragraph per line; Word draws the shared border once
    // around them all. Space is kept above the first and below the
    // last.
    return all.map((tokens, index) =>
      paragraph(
        tokens
          .map((token) =>
            textRun(expandTabs(token.text), { color: CODE_COLORS[token.kind] }),
          )
          .join(""),
        {
          style: "Code",
          spacing:
            index === 0 || index === all.length - 1
              ? `<w:spacing w:before="${index === 0 ? 60 : 0}" w:after="${
                  index === all.length - 1 ? 200 : 0
                }"/>`
              : "",
        },
      ),
    );
  }

  function table(block: Extract<Block, { type: "table" }>): string {
    const columns = Math.max(1, block.header.length);
    const columnWidth = Math.floor(CONTENT_WIDTH / columns);
    // Cells read in the table's direction, as on the chat page (see
    // renderTable in pdf-export.ts).
    const rtl = isRtlParagraph(
      (tableHasHeader(block.header) ? block.header : (block.rows[0] ?? [])).join(" "),
    );
    const cell = (text: string, header: boolean): string =>
      `<w:tc><w:tcPr><w:tcW w:w="${columnWidth}" w:type="dxa"/>` +
      (header ? '<w:shd w:val="clear" w:color="auto" w:fill="F2F4F7"/>' : "") +
      "</w:tcPr>" +
      inlineParagraphs(text, {
        style: "TableText",
        base: header ? { bold: true } : {},
        rtl,
      }).join("") +
      "</w:tc>";
    const row = (cells: string[], header: boolean): string =>
      `<w:tr>${header ? "<w:trPr><w:tblHeader/></w:trPr>" : ""}` +
      Array.from({ length: columns }, (_, index) =>
        cell(cells[index] ?? "", header),
      ).join("") +
      "</w:tr>";

    return (
      '<w:tbl><w:tblPr><w:tblStyle w:val="ChatTable"/>' +
      `<w:tblW w:w="${columnWidth * columns}" w:type="dxa"/>` +
      '<w:tblLayout w:type="fixed"/><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr>' +
      `<w:tblGrid>${`<w:gridCol w:w="${columnWidth}"/>`.repeat(columns)}</w:tblGrid>` +
      (tableHasHeader(block.header) ? row(block.header, true) : "") +
      block.rows.map((cells) => row(cells, false)).join("") +
      // Word needs a paragraph between two tables, and after the
      // last one in a cell or document.
      "</w:tbl>" +
      paragraph("", { style: "Spacer" })
    );
  }

  function blockXml(block: Block): string[] {
    switch (block.type) {
      case "heading":
        return inlineParagraphs(block.text, {
          style: `Heading${Math.min(block.level + 1, 4)}`,
        });
      case "paragraph":
        // Small print is small and gray.
        return inlineParagraphs(
          block.text,
          block.small ? { base: { color: "656D76", size: 19 } } : {},
        );
      case "blockquote":
        return inlineParagraphs(block.text, { style: "Quote" });
      case "list": {
        // The numbered list open at each depth; a nested one ends with
        // the item it's in.
        const numbered: (number | undefined)[] = [];

        return block.items.flatMap((item, index) => {
          const nesting = block.nesting?.[index] ?? {
            level: 0,
            ordered: block.ordered,
          };
          const level = Math.min(nesting.level, MAX_LIST_LEVEL);

          numbered.length = Math.min(numbered.length, level + 1);

          if (!nesting.ordered) {
            numbered[level] = undefined;
          } else {
            numbered[level] ??= writer.orderedList(level);
          }

          return inlineParagraphs(item, {
            style: "ListParagraph",
            extra: `<w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${
              nesting.ordered ? numbered[level] : 1
            }"/></w:numPr>`,
          });
        });
      }
      case "table":
        return [table(block)];
      case "code":
        return codeBlock(block.code, block.lang);
      case "hr":
        return [paragraph("", { style: "Rule" })];
    }
  }

  /*
   * The reasoning ahead of a reply: smaller, gray and set in from
   * a line on its left, so it reads as the notes it is rather than
   * as the answer. Code and tables keep their own look.
   */
  function thinkingXml(blocks: Block[]): string[] {
    const out = [paragraph(textRun("Thinking"), { style: "ThinkingLabel" })];

    for (const block of blocks) {
      switch (block.type) {
        case "heading":
          out.push(
            ...inlineParagraphs(block.text, {
              style: "Thinking",
              base: { bold: true },
            }),
          );
          break;
        case "paragraph":
        case "blockquote":
          out.push(...inlineParagraphs(block.text, { style: "Thinking" }));
          break;
        case "list":
          block.items.forEach((item, index) => {
            out.push(
              ...inlineParagraphs(
                `${block.ordered ? `${index + 1}.` : "•"} ${item}`,
                { style: "Thinking" },
              ),
            );
          });
          break;
        case "hr":
          break;
        default:
          out.push(...blockXml(block));
      }
    }

    // A little room between the thinking and the answer under it
    out.push(paragraph("", { style: "Spacer" }));

    return out;
  }

  /* The reply's sources, numbered as its notes cite them */
  function sourcesXml(sources: MessageSource[]): string[] {
    const numId = writer.orderedList();
    const items = sources.map((source) => {
      const label = sourceLabel(source);
      const host = sourceHost(source.url);
      const title = SAFE_LINK_RE.test(source.url)
        ? runsXml([{ text: label, link: source.url }])
        : textRun(label);

      return paragraph(
        title +
          (host && host !== label
            ? textRun(` · ${host}`, { color: "656D76" })
            : ""),
        {
          style: "SourceItem",
          rtl: isRtlParagraph(label),
          extra: `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr>`,
        },
      );
    });

    return [paragraph(textRun("Sources"), { style: "ThinkingLabel" }), ...items];
  }

  /* Title and source */
  body.push(
    paragraph(textRun(title), { style: "Title", rtl: isRtlParagraph(title) }),
  );

  const meta = [siteName, `${messages.length} ${messages.length === 1 ? "message" : "messages"}`]
    .filter(Boolean)
    .concat(settings.includeTimestamp ? [`Exported ${new Date().toLocaleString()}`] : []);

  body.push(paragraph(textRun(meta.join(" · ")), { style: "Subtitle" }));

  if (source.tabUrl && SAFE_LINK_RE.test(source.tabUrl)) {
    body.push(
      paragraph(
        runsXml([{ text: source.tabUrl, link: source.tabUrl }]),
        { style: "Subtitle" },
      ),
    );
  }

  for (const [index, message] of conversation.messages.entries()) {
    if (index > 0 && settings.messageSeparator === "rule") {
      body.push(paragraph("", { style: "Rule" }));
    }

    if (settings.headingStyle !== "none") {
      body.push(
        paragraph(
          textRun(message.label, {
            color: ROLE_COLORS[message.role],
          }),
          { style: "Heading1" },
        ),
      );
    }

    // When it was sent and by which model, in small gray type
    if (message.details) {
      body.push(paragraph(textRun(message.details), { style: "MessageDetails" }));
    }

    currentSources = message.sources;

    if (message.thinking.length > 0) {
      body.push(...thinkingXml(message.thinking));
    }

    for (const block of message.blocks) {
      body.push(...blockXml(block));
    }

    for (const image of message.images) {
      const picture = await pictureFromImage(image);

      if (picture) {
        body.push(paragraph(writer.picture(picture), { style: "Picture" }));
      }
    }

    if (message.sources.length > 0) {
      body.push(...sourcesXml(message.sources));
    }
  }

  const documentXml =
    XML_HEADER +
    `<w:document ${NS}><w:body>${body.join("")}` +
    `<w:sectPr><w:pgSz w:w="${PAGE_WIDTH}" w:h="${PAGE_HEIGHT}"/>` +
    `<w:pgMar w:top="${PAGE_MARGIN}" w:right="${PAGE_MARGIN}" w:bottom="${PAGE_MARGIN}" w:left="${PAGE_MARGIN}" w:header="709" w:footer="709" w:gutter="0"/>` +
    "</w:sectPr></w:body></w:document>";

  const { relationships, numbering, media } = writer.files();
  const encoder = new TextEncoder();
  const text = (path: string, content: string): ZipEntry => ({
    path,
    bytes: encoder.encode(content),
  });

  return new Blob(
    [
      createZipBlob([
        text("[Content_Types].xml", CONTENT_TYPES_XML),
        text("_rels/.rels", ROOT_RELS_XML),
        text("docProps/core.xml", coreXml(title)),
        text("docProps/app.xml", APP_XML),
        text("word/document.xml", documentXml),
        text("word/styles.xml", STYLES_XML),
        text("word/numbering.xml", numbering),
        text("word/settings.xml", SETTINGS_XML),
        text("word/_rels/document.xml.rels", relationships),
        ...media,
      ]),
    ],
    { type: DOCX_MIME_TYPE },
  );
}

/*
 * ---------------------------------------------------------
 * FIXED PARTS
 * ---------------------------------------------------------
 */
const CONTENT_TYPES_XML =
  XML_HEADER +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Default Extension="png" ContentType="image/png"/>' +
  '<Default Extension="jpeg" ContentType="image/jpeg"/>' +
  '<Default Extension="gif" ContentType="image/gif"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
  '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' +
  '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>' +
  '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
  '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
  "</Types>";

const ROOT_RELS_XML =
  XML_HEADER +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
  '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
  "</Relationships>";

const APP_XML =
  XML_HEADER +
  '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">' +
  "<Application>AI Exporter</Application></Properties>";

function coreXml(title: string): string {
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");

  return (
    XML_HEADER +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${xmlText(title)}</dc:title><dc:creator>AI Exporter</dc:creator>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>` +
    "</cp:coreProperties>"
  );
}

const SETTINGS_XML =
  XML_HEADER +
  '<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  '<w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/>' +
  '<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat>' +
  "</w:settings>";

/* Nested list items go up to this deep (Word's nine levels) */
const MAX_LIST_LEVEL = 8;

/*
 * Bullets and numbers for every depth of nesting, each a step further
 * in: a bullet per depth (\u2022, \u25e6, \u25aa, then round again) and a number
 * counting its own list.
 */
function buildNumberingXml(nums: string[]): string {
  const levels = (format: "bullet" | "decimal"): string =>
    Array.from({ length: MAX_LIST_LEVEL + 1 }, (_, depth) => {
      const text =
        format === "bullet" ? ["\u2022", "\u25e6", "\u25aa"][depth % 3] : `%${depth + 1}.`;

      return (
        `<w:lvl w:ilvl="${depth}"><w:start w:val="1"/>` +
        `<w:numFmt w:val="${format}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/>` +
        `<w:pPr><w:ind w:left="${720 * (depth + 1)}" w:hanging="360"/></w:pPr>` +
        (format === "bullet"
          ? '<w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:hint="default"/></w:rPr>'
          : "") +
        "</w:lvl>"
      );
    }).join("");

  return (
    XML_HEADER +
    '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>' +
    levels("bullet") +
    "</w:abstractNum>" +
    '<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>' +
    levels("decimal") +
    "</w:abstractNum>" +
    nums.join("") +
    "</w:numbering>"
  );
}

const BORDER = 'w:val="single" w:sz="4" w:space="0" w:color="D0D7DE"';
/* The border's w:space (in points) pads the text inside it */
const CODE_BORDER = 'w:val="single" w:sz="4" w:space="5" w:color="D0D7DE"';

function paragraphStyle(
  id: string,
  name: string,
  paragraphProperties: string,
  runProperties: string,
  next = "Normal",
): string {
  return (
    `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/>` +
    `<w:basedOn w:val="Normal"/><w:next w:val="${next}"/><w:qFormat/>` +
    `<w:pPr>${paragraphProperties}</w:pPr><w:rPr>${runProperties}</w:rPr></w:style>`
  );
}

const STYLES_XML =
  XML_HEADER +
  '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  "<w:docDefaults><w:rPrDefault><w:rPr>" +
  '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Arial"/>' +
  `<w:sz w:val="${BODY_PT * 2}"/><w:szCs w:val="${BODY_PT * 2}"/><w:lang w:val="en-US"/>` +
  "</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr>" +
  '<w:spacing w:after="140" w:line="276" w:lineRule="auto"/>' +
  "</w:pPr></w:pPrDefault></w:docDefaults>" +
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/>' +
  '<w:rPr><w:color w:val="1F2328"/></w:rPr></w:style>' +
  '<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/></w:style>' +
  paragraphStyle(
    "Title",
    "Title",
    '<w:spacing w:after="80"/><w:contextualSpacing/>',
    '<w:b/><w:bCs/><w:sz w:val="44"/><w:szCs w:val="44"/>',
  ) +
  paragraphStyle(
    "Subtitle",
    "Subtitle",
    '<w:spacing w:after="40"/>',
    '<w:color w:val="656D76"/><w:sz w:val="19"/><w:szCs w:val="19"/>',
  ) +
  paragraphStyle(
    "Heading1",
    "heading 1",
    `<w:keepNext/><w:keepLines/><w:spacing w:before="360" w:after="100"/><w:outlineLvl w:val="0"/>`,
    '<w:b/><w:bCs/><w:caps/><w:spacing w:val="10"/><w:sz w:val="22"/><w:szCs w:val="22"/>',
  ) +
  paragraphStyle(
    "Heading2",
    "heading 2",
    '<w:keepNext/><w:keepLines/><w:spacing w:before="240" w:after="100"/><w:outlineLvl w:val="1"/>',
    '<w:b/><w:bCs/><w:sz w:val="32"/><w:szCs w:val="32"/>',
  ) +
  paragraphStyle(
    "Heading3",
    "heading 3",
    '<w:keepNext/><w:keepLines/><w:spacing w:before="200" w:after="80"/><w:outlineLvl w:val="2"/>',
    '<w:b/><w:bCs/><w:sz w:val="27"/><w:szCs w:val="27"/>',
  ) +
  paragraphStyle(
    "Heading4",
    "heading 4",
    '<w:keepNext/><w:keepLines/><w:spacing w:before="160" w:after="60"/><w:outlineLvl w:val="3"/>',
    '<w:b/><w:bCs/><w:sz w:val="24"/><w:szCs w:val="24"/>',
  ) +
  paragraphStyle(
    "Quote",
    "Quote",
    `<w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="D0D7DE"/></w:pBdr><w:ind w:left="240"/>`,
    '<w:color w:val="57606A"/>',
  ) +
  paragraphStyle(
    "ListParagraph",
    "List Paragraph",
    '<w:spacing w:after="60"/><w:ind w:left="720"/>',
    "",
  ) +
  paragraphStyle(
    "Code",
    "Code",
    `<w:pBdr><w:top ${CODE_BORDER}/><w:left ${CODE_BORDER}/><w:bottom ${CODE_BORDER}/><w:right ${CODE_BORDER}/></w:pBdr>` +
      '<w:shd w:val="clear" w:color="auto" w:fill="F6F8FA"/><w:bidi w:val="0"/>' +
      '<w:spacing w:after="0" w:line="240" w:lineRule="auto"/><w:ind w:left="170" w:right="170"/>',
    '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Consolas" w:cs="Consolas"/><w:noProof/><w:sz w:val="19"/><w:szCs w:val="19"/>',
    "Code",
  ) +
  paragraphStyle("TableText", "Table Text", '<w:spacing w:after="0"/>', "") +
  paragraphStyle(
    "MessageDetails",
    "Message Details",
    '<w:keepNext/><w:spacing w:before="0" w:after="100"/>',
    '<w:color w:val="656D76"/><w:sz w:val="18"/><w:szCs w:val="18"/>',
  ) +
  paragraphStyle(
    "Spacer",
    "Spacer",
    '<w:spacing w:after="0" w:line="120" w:lineRule="exact"/>',
    '<w:sz w:val="4"/>',
  ) +
  paragraphStyle(
    "Rule",
    "Rule",
    `<w:pBdr><w:bottom ${BORDER}/></w:pBdr><w:spacing w:after="240"/>`,
    '<w:sz w:val="8"/>',
  ) +
  paragraphStyle("MathDisplay", "Display Formula", '<w:jc w:val="center"/>', "") +
  paragraphStyle("Picture", "Picture", '<w:keepLines/>', "") +
  paragraphStyle(
    "ThinkingLabel",
    "Section Label",
    '<w:keepNext/><w:spacing w:before="160" w:after="60"/>',
    '<w:b/><w:bCs/><w:caps/><w:color w:val="656D76"/><w:spacing w:val="10"/><w:sz w:val="17"/><w:szCs w:val="17"/>',
  ) +
  paragraphStyle(
    "Thinking",
    "Thinking",
    '<w:pBdr><w:left w:val="single" w:sz="12" w:space="8" w:color="D0D7DE"/></w:pBdr><w:spacing w:after="80"/><w:ind w:left="240"/>',
    '<w:color w:val="57606A"/><w:sz w:val="20"/><w:szCs w:val="20"/>',
  ) +
  paragraphStyle(
    "SourceItem",
    "Source",
    '<w:spacing w:after="40"/><w:ind w:left="720"/>',
    '<w:sz w:val="19"/><w:szCs w:val="19"/>',
  ) +
  '<w:style w:type="character" w:styleId="CodeChar"><w:name w:val="Inline Code"/><w:uiPriority w:val="1"/><w:qFormat/>' +
  '<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Consolas" w:cs="Consolas"/><w:noProof/><w:sz w:val="20"/><w:szCs w:val="20"/>' +
  '<w:shd w:val="clear" w:color="auto" w:fill="EFF1F3"/></w:rPr></w:style>' +
  '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/>' +
  '<w:rPr><w:color w:val="0969DA"/><w:u w:val="single"/></w:rPr></w:style>' +
  '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/>' +
  '<w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>' +
  '<w:style w:type="table" w:styleId="ChatTable"><w:name w:val="Chat Table"/><w:basedOn w:val="TableNormal"/><w:uiPriority w:val="59"/>' +
  `<w:tblPr><w:tblBorders><w:top ${BORDER}/><w:left ${BORDER}/><w:bottom ${BORDER}/><w:right ${BORDER}/><w:insideH ${BORDER}/><w:insideV ${BORDER}/></w:tblBorders>` +
  '<w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>' +
  "</w:styles>";
