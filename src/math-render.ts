/*
 * =========================================================
 * AI Exporter - math-render.ts
 * =========================================================
 *
 * Typesets LaTeX with MathJax into an SVG tree that svg-pdf.ts
 * draws into the PDF as vector paths. MathJax runs on its own
 * "lite" DOM, so this works anywhere (popup, tests) without
 * touching the page, and its SVG output is self-contained: every
 * glyph is a <path> in the TeX fonts, with no font files to embed.
 *
 * This module is large (the TeX fonts' glyph outlines alone are
 * over a megabyte), so pdf-export.ts only loads it with a dynamic
 * import() when a conversation actually contains math.
 */
import { mathjax } from "mathjax-full/js/mathjax.js";
import { TeX } from "mathjax-full/js/input/tex.js";
import { SVG } from "mathjax-full/js/output/svg.js";
import { liteAdaptor } from "mathjax-full/js/adaptors/liteAdaptor.js";
import type {
  LiteElement,
  LiteNode,
} from "mathjax-full/js/adaptors/lite/Element.js";
import { RegisterHTMLHandler } from "mathjax-full/js/handlers/html.js";
import { SerializedMmlVisitor } from "mathjax-full/js/core/MmlTree/SerializedMmlVisitor.js";
import { STATE } from "mathjax-full/js/core/MathItem.js";
import type { MmlNode } from "mathjax-full/js/core/MmlTree/MmlNode.js";
import { AllPackages } from "mathjax-full/js/input/tex/AllPackages.js";
import { mathTextStyle, type MathTextStyle } from "./svg-pdf.ts";

export interface SvgNode {
  tag: string;
  attrs: Record<string, string>;
  children: SvgNode[];
  /* The text of a <text> element. */
  text?: string;
}

/*
 * viewBox units are thousandths of an em; the baseline is at y = 0,
 * so -minY is the height above the baseline and minY + height the
 * depth below it.
 */
export interface RenderedMath {
  viewBox: [number, number, number, number];
  root: SvgNode;
}

/*
 * Returns the advance width, in ems, of `text` in the font the
 * PDF will draw it with.
 */
export type MeasureText = (text: string, style: MathTextStyle) => number;

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);

/*
 * The lite DOM can't measure text, so MathJax would space
 * characters outside its own fonts (Cyrillic, CJK... in \text{})
 * a flat 0.6em apart. When the caller can measure them in the font
 * the PDF really uses, that width is used instead; the <text>
 * element's font-size (in thousandths of an em) scales it.
 */
let measureText: MeasureText | undefined;
const estimateNodeSize = adaptor.nodeSize.bind(adaptor);

adaptor.nodeSize = (node, em, local) => {
  if (!measureText || adaptor.kind(node) !== "text") {
    return estimateNodeSize(node, em, local);
  }

  const attrs: Record<string, string> = {};

  for (const { name, value } of adaptor.allAttributes(node)) {
    attrs[name] = String(value);
  }

  const scale = (parseFloat(attrs["font-size"] ?? "") || 1000) / 1000;

  return [
    measureText(adaptor.textContent(node), mathTextStyle(attrs)) * scale,
    0.8,
  ];
};

/*
 * Every TeX package MathJax bundles, except "noerrors" (which would
 * hide a syntax error by printing the source in place of the
 * formula - the caller does that itself, in code style) and
 * "bussproofs" (proof trees need an extra layout pass the SVG
 * output can't do on a lite DOM).
 */
const texPackages = AllPackages.filter(
  (name) => name !== "noerrors" && name !== "bussproofs",
);

const document = mathjax.document("", {
  InputJax: new TeX({ packages: texPackages }),
  // "none" writes each glyph's path where it's used, instead of
  // <use> references into a shared <defs> cache.
  OutputJax: new SVG({ fontCache: "none" }),
});

function toSvgNode(node: LiteElement): SvgNode {
  const attrs: Record<string, string> = {};

  for (const { name, value } of adaptor.allAttributes(node)) {
    attrs[name] = String(value);
  }

  const children: SvgNode[] = [];
  let text = "";

  for (const child of adaptor.childNodes(node) as LiteNode[]) {
    if (adaptor.kind(child) === "#text") {
      text += adaptor.value(child);
    } else if (!adaptor.kind(child).startsWith("#")) {
      children.push(toSvgNode(child as LiteElement));
    }
  }

  return {
    tag: adaptor.kind(node),
    attrs,
    children,
    ...(text ? { text } : {}),
  };
}

function hasError(node: SvgNode): boolean {
  return (
    node.attrs["data-mml-node"] === "merror" || node.children.some(hasError)
  );
}

/*
 * An equation label (\tag{1}) makes MathJax lay the formula out
 * across the full width of a page it can't know, with the label
 * pinned to the right edge - an SVG with no fixed size. The label
 * is set right after its equation instead: "E = mc^2   (1)".
 */
function untag(tex: string): string {
  return tex.replace(
    /\\tag(\*?)\s*\{([^{}]*)\}/g,
    (_match, star: string, label: string) =>
      star ? `\\qquad\\text{${label}}` : `\\qquad\\text{(${label})}`,
  );
}

/*
 * Returns null when MathJax can't make sense of the formula (an
 * unbalanced brace, an unknown environment...), so the caller can
 * print the source instead.
 */
export function renderTex(
  tex: string,
  display: boolean,
  measure?: MeasureText,
): RenderedMath | null {
  measureText = measure;

  try {
    const container = document.convert(untag(tex), { display }) as LiteElement;
    const svg = adaptor.firstChild(container) as LiteElement | null;

    if (!svg || adaptor.kind(svg) !== "svg") {
      return null;
    }

    const root = toSvgNode(svg);
    const viewBox = (root.attrs.viewBox ?? "")
      .trim()
      .split(/[\s,]+/)
      .map(Number);

    if (
      viewBox.length !== 4 ||
      viewBox.some((value) => !Number.isFinite(value)) ||
      viewBox[2] <= 0 ||
      hasError(root)
    ) {
      return null;
    }

    return {
      viewBox: viewBox as RenderedMath["viewBox"],
      root,
    };
  } catch {
    return null;
  } finally {
    measureText = undefined;
  }
}

const mathMl = new SerializedMmlVisitor();

/*
 * A formula as MathML, which omml.ts turns into the equations Word
 * edits - the step before MathJax would lay it out. Null when the
 * TeX doesn't parse.
 */
export function texToMathML(tex: string, display: boolean): string | null {
  try {
    const root = document.convert(untag(tex), {
      display,
      end: STATE.CONVERT,
    }) as MmlNode;
    const markup = mathMl.visitTree(root);

    return markup.includes("<merror") ? null : markup;
  } catch {
    return null;
  }
}
