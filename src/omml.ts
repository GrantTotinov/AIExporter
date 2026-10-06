/*
 * =========================================================
 * AI Exporter - omml.ts
 * =========================================================
 *
 * Turns a formula's MathML (from MathJax, see texToMathML in
 * math-render.ts) into Office Math (OMML) - the equations Word
 * writes itself, so a formula in an exported .docx can be edited,
 * searched and copied like one typed in Word. LibreOffice, Google
 * Docs and Pages read them too.
 *
 * MathML and OMML describe the same structures - fractions,
 * scripts, roots, big operators with limits, accents, fences,
 * matrices - so the mapping is element for element; what OMML
 * lacks (spacing, phantoms, colors) is left out. A big operator
 * (∑, ∫...) takes the element after it as the expression it
 * applies to, as Word's own equations do.
 *
 * Needs DOMParser (the popup and the bulk page have it). Returns
 * null for anything it can't read, and docx-export.ts places the
 * formula as a picture instead.
 */

const M = "http://schemas.openxmlformats.org/officeDocument/2006/math";

/* Operators Word draws as n-ary, with their limits above and below */
const NARY = /^[∑∏∐∫-∳⋀-⋃⨀-⨆⨉⨌-⨑]$/;
const INTEGRAL = /^[∫-∳⨌-⨑]$/;

/* What an over-script that's an accent is drawn as in Word */
const ACCENTS: Record<string, string> = {
  "^": "̂",
  "ˆ": "̂",
  "~": "̃",
  "˜": "̃",
  "→": "⃗",
  "⃗": "⃗",
  "˙": "̇",
  ".": "̇",
  "¨": "̈",
  "´": "́",
  "`": "̀",
  "ˋ": "̀",
  "ˇ": "̌",
  "˘": "̆",
};
const BARS = /^[¯―‾_−-]$/;

/* Invisible operators (function application, invisible times...) */
const INVISIBLE = /[⁡-⁤]/g;

function xmlText(text: string): string {
  return text
    .replace(INVISIBLE, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const MATH_FONT =
  '<w:rPr><w:rFonts w:ascii="Cambria Math" w:hAnsi="Cambria Math"/></w:rPr>';

function run(text: string, style?: "p" | "b" | "bi" | "i", plain = false): string {
  const clean = xmlText(text);

  if (!clean) {
    return "";
  }

  const properties = plain
    ? "<m:rPr><m:nor/></m:rPr>"
    : style
      ? `<m:rPr><m:sty m:val="${style}"/></m:rPr>`
      : "";

  return `<m:r>${properties}${MATH_FONT}<m:t xml:space="preserve">${clean}</m:t></m:r>`;
}

function elements(node: Element): Element[] {
  return Array.from(node.children);
}

function tag(node: Element): string {
  return node.localName.toLowerCase();
}

function textOf(node: Element): string {
  return (node.textContent ?? "").replace(INVISIBLE, "").trim();
}

function variantStyle(node: Element, letters: string): "p" | "b" | "bi" | "i" | undefined {
  const variant = node.getAttribute("mathvariant") ?? "";

  if (variant === "bold") {
    return "b";
  }

  if (variant === "bold-italic") {
    return "bi";
  }

  if (variant === "normal") {
    return "p";
  }

  // A name - sin, log, lim - is upright; a single letter italic.
  return [...letters].length > 1 ? "p" : undefined;
}

function argument(name: string, node: Element | undefined): string {
  return `<m:${name}>${node ? convert(node) : ""}</m:${name}>`;
}

/* A big operator: ∑, ∫... written as an <mo> */
function naryOperator(node: Element | undefined): string | null {
  if (!node || tag(node) !== "mo") {
    return null;
  }

  const symbol = textOf(node);

  return NARY.test(symbol) ? symbol : null;
}

function nary(
  symbol: string,
  lower: Element | undefined,
  upper: Element | undefined,
  body: Element | undefined,
  limitsBelow: boolean,
): string {
  const properties = [
    `<m:chr m:val="${xmlText(symbol)}"/>`,
    `<m:limLoc m:val="${limitsBelow && !INTEGRAL.test(symbol) ? "undOvr" : "subSup"}"/>`,
    ...(lower ? [] : ['<m:subHide m:val="1"/>']),
    ...(upper ? [] : ['<m:supHide m:val="1"/>']),
  ].join("");

  return (
    `<m:nary><m:naryPr>${properties}</m:naryPr>` +
    argument("sub", lower) +
    argument("sup", upper) +
    argument("e", body) +
    "</m:nary>"
  );
}

/*
 * The children of a row, a big operator taking the element after
 * it as the expression it applies to.
 */
function row(children: Element[]): string {
  let out = "";

  for (let index = 0; index < children.length; index++) {
    const child = children[index];
    const name = tag(child);
    const parts = elements(child);
    const operator =
      name === "mo"
        ? naryOperator(child)
        : ["munderover", "munder", "mover", "msubsup", "msub", "msup"].includes(name)
          ? naryOperator(parts[0])
          : null;

    if (operator) {
      const body = children[index + 1];
      const below = name === "munderover" || name === "munder";
      const lower =
        name === "munderover" || name === "munder" || name === "msubsup" || name === "msub"
          ? parts[1]
          : undefined;
      const upper =
        name === "munderover" || name === "msubsup"
          ? parts[2]
          : name === "mover" || name === "msup"
            ? parts[1]
            : undefined;

      out += nary(operator, lower, upper, body, below || name === "mover");
      index += body ? 1 : 0;
      continue;
    }

    out += convert(child);
  }

  return out;
}

/* \\left( ... \\right): a row opened and closed by stretchy fences */
function fenced(node: Element): string | null {
  const children = elements(node);
  const first = children[0];
  const last = children[children.length - 1];

  if (
    children.length < 2 ||
    tag(first) !== "mo" ||
    tag(last) !== "mo" ||
    first.getAttribute("data-mjx-texclass") !== "OPEN" ||
    last.getAttribute("data-mjx-texclass") !== "CLOSE"
  ) {
    return null;
  }

  const open = textOf(first);
  const close = textOf(last);

  return (
    `<m:d><m:dPr><m:begChr m:val="${xmlText(open)}"/><m:endChr m:val="${xmlText(close)}"/></m:dPr>` +
    `<m:e>${row(children.slice(1, -1))}</m:e></m:d>`
  );
}

function over(base: Element, script: Element): string {
  const symbol = tag(script) === "mo" ? textOf(script) : "";

  if (BARS.test(symbol) && script.getAttribute("accent") !== "false") {
    return `<m:bar><m:barPr><m:pos m:val="top"/></m:barPr><m:e>${convert(base)}</m:e></m:bar>`;
  }

  const accent = ACCENTS[symbol];

  if (accent && script.getAttribute("accent") !== "false") {
    return `<m:acc><m:accPr><m:chr m:val="${accent}"/></m:accPr><m:e>${convert(base)}</m:e></m:acc>`;
  }

  return `<m:limUpp>${argument("e", base)}${argument("lim", script)}</m:limUpp>`;
}

function under(base: Element, script: Element): string {
  const symbol = tag(script) === "mo" ? textOf(script) : "";

  if (BARS.test(symbol)) {
    return `<m:bar><m:barPr><m:pos m:val="bot"/></m:barPr><m:e>${convert(base)}</m:e></m:bar>`;
  }

  return `<m:limLow>${argument("e", base)}${argument("lim", script)}</m:limLow>`;
}

function convert(node: Element): string {
  const parts = elements(node);

  switch (tag(node)) {
    case "mi": {
      const text = textOf(node);

      return run(text, variantStyle(node, text));
    }
    case "mn":
    case "mo":
    case "ms":
      return run(textOf(node), node.getAttribute("mathvariant") === "bold" ? "b" : undefined);
    case "mtext":
      return run(node.textContent ?? "", undefined, true);
    case "mspace":
      return Number.parseFloat(node.getAttribute("width") ?? "0") >= 0.5 ? run(" ") : "";
    case "mphantom":
    case "none":
    case "mprescripts":
    case "annotation":
    case "annotation-xml":
      return "";
    case "semantics":
      return parts[0] ? convert(parts[0]) : "";
    case "mfrac": {
      const noBar = node.getAttribute("linethickness") === "0";

      return (
        `<m:f>${noBar ? '<m:fPr><m:type m:val="noBar"/></m:fPr>' : ""}` +
        `${argument("num", parts[0])}${argument("den", parts[1])}</m:f>`
      );
    }
    case "msup":
      return `<m:sSup>${argument("e", parts[0])}${argument("sup", parts[1])}</m:sSup>`;
    case "msub":
      return `<m:sSub>${argument("e", parts[0])}${argument("sub", parts[1])}</m:sSub>`;
    case "msubsup":
      return (
        `<m:sSubSup>${argument("e", parts[0])}${argument("sub", parts[1])}` +
        `${argument("sup", parts[2])}</m:sSubSup>`
      );
    case "msqrt":
      return `<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e>${row(parts)}</m:e></m:rad>`;
    case "mroot":
      return `<m:rad>${argument("deg", parts[1])}${argument("e", parts[0])}</m:rad>`;
    case "mover":
      return parts.length >= 2 ? over(parts[0], parts[1]) : row(parts);
    case "munder":
      return parts.length >= 2 ? under(parts[0], parts[1]) : row(parts);
    case "munderover":
      return parts.length >= 3
        ? `<m:limUpp><m:e>${under(parts[0], parts[1])}</m:e>${argument("lim", parts[2])}</m:limUpp>`
        : row(parts);
    case "mtable":
      return (
        "<m:m>" +
        parts
          .filter((rowNode) => tag(rowNode) === "mtr" || tag(rowNode) === "mlabeledtr")
          .map(
            (rowNode) =>
              `<m:mr>${elements(rowNode)
                .filter((cell) => tag(cell) === "mtd")
                .map((cell) => `<m:e>${row(elements(cell))}</m:e>`)
                .join("")}</m:mr>`,
          )
          .join("") +
        "</m:m>"
      );
    case "mrow":
      return fenced(node) ?? row(parts);
    default:
      // math, mstyle, mpadded, menclose, merror's neighbors...
      return row(parts);
  }
}

/*
 * The formula as an inline <m:oMath>, or - displayed on its own
 * line - an <m:oMathPara> holding one.
 */
export function mathMlToOmml(mathMl: string, display: boolean): string | null {
  try {
    const parsed = new DOMParser().parseFromString(mathMl, "application/xml");
    const root = parsed.documentElement;

    if (!root || tag(root) !== "math" || parsed.getElementsByTagName("parsererror").length > 0) {
      return null;
    }

    const body = convert(root);

    if (!body) {
      return null;
    }

    const math = `<m:oMath>${body}</m:oMath>`;

    return display ? `<m:oMathPara>${math}</m:oMathPara>` : math;
  } catch {
    return null;
  }
}

export const OMML_NAMESPACE = `xmlns:m="${M}"`;
