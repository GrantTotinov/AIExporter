/*
 * =========================================================
 * AI Exporter - svg-pdf.ts
 * =========================================================
 *
 * Draws the SVG MathJax produces (see math-render.ts) into a jsPDF
 * document as real vector paths, so formulas stay sharp at any
 * zoom and add almost nothing to the file size - instead of being
 * rasterized to a picture first.
 *
 * It isn't a general SVG renderer, just the subset MathJax's SVG
 * output uses: nested <g> groups with transforms, glyph <path>s,
 * <rect> (fraction bars, radical overlines, boxes), <line>,
 * <polygon> and <ellipse> (\cancel, \boxed, table rules, \enclose),
 * <text> (characters outside the TeX fonts, like Cyrillic inside
 * \text{...}), and nested <svg> viewports - which MathJax uses to
 * clip the stretched pieces of tall brackets and long arrows.
 */
import type jsPDF from "jspdf";
import type { RenderedMath, SvgNode } from "./math-render.ts";

export type Rgb = [number, number, number];
type Matrix = [number, number, number, number, number, number];

export interface MathTextStyle {
  bold: boolean;
  italic: boolean;
  monospace: boolean;
}

export interface DrawMathOptions {
  color: Rgb;
  /*
   * Draws a run of text (a <text> element) with its baseline at
   * (x, y), `size` in mm (an em) - the caller picks the font, since
   * it knows which embedded fonts cover which characters.
   */
  drawText: (
    text: string,
    x: number,
    y: number,
    size: number,
    style: MathTextStyle,
    color: Rgb,
  ) => void;
}

interface DrawState {
  matrix: Matrix;
  fill: Rgb | null;
  stroke: Rgb | null;
  strokeWidth: number;
}

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/* How much the matrix scales lengths, for stroke widths and text. */
function scaleOf(m: Matrix): number {
  return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
}

function numbers(value: string | undefined): number[] {
  return (value?.match(/[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) ?? []).map(
    Number,
  );
}

function num(value: string | undefined, fallback = 0): number {
  const parsed = parseFloat(value ?? "");
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function parseTransform(value: string | undefined): Matrix {
  let matrix = IDENTITY;

  for (const [, name, args] of (value ?? "").matchAll(/(\w+)\s*\(([^)]*)\)/g)) {
    const a = numbers(args);
    let step: Matrix | null = null;

    switch (name) {
      case "translate":
        step = [1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0];
        break;
      case "scale":
        step = [a[0] ?? 1, 0, 0, a[1] ?? a[0] ?? 1, 0, 0];
        break;
      case "matrix":
        if (a.length === 6) {
          step = a as Matrix;
        }
        break;
      case "rotate": {
        const angle = ((a[0] ?? 0) * Math.PI) / 180;
        const [cx, cy] = [a[1] ?? 0, a[2] ?? 0];
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        step = multiply(
          multiply([1, 0, 0, 1, cx, cy], [cos, sin, -sin, cos, 0, 0]),
          [1, 0, 0, 1, -cx, -cy],
        );
        break;
      }
    }

    if (step) {
      matrix = multiply(matrix, step);
    }
  }

  return matrix;
}

/*
 * The colors MathJax writes: \color{red} keeps the name as given,
 * \color[rgb]{...} / \color[HTML]{...} become "#rrggbb". The names
 * are xcolor's base set, which is what LaTeX itself accepts without
 * extra options.
 */
const NAMED_COLORS: Record<string, Rgb> = {
  black: [0, 0, 0],
  white: [255, 255, 255],
  red: [255, 0, 0],
  green: [0, 128, 0],
  blue: [0, 0, 255],
  cyan: [0, 255, 255],
  magenta: [255, 0, 255],
  yellow: [255, 255, 0],
  orange: [255, 128, 0],
  purple: [191, 0, 64],
  violet: [128, 0, 128],
  brown: [191, 128, 64],
  pink: [255, 191, 191],
  lime: [191, 255, 0],
  olive: [128, 128, 0],
  teal: [0, 128, 128],
  gray: [128, 128, 128],
  grey: [128, 128, 128],
  darkgray: [64, 64, 64],
  lightgray: [191, 191, 191],
};

function parseColor(
  value: string | undefined,
  inherited: Rgb | null,
  current: Rgb,
): Rgb | null {
  if (value === undefined) {
    return inherited;
  }

  const color = value.trim().toLowerCase();

  if (color === "none" || color === "transparent") {
    return null;
  }

  if (color === "currentcolor") {
    return current;
  }

  const hex = color.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/)?.[1];

  if (hex) {
    const full =
      hex.length === 3
        ? hex
            .split("")
            .map((digit) => digit + digit)
            .join("")
        : hex;
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as Rgb;
  }

  const rgb = color.match(/^rgba?\(([^)]*)\)$/)?.[1];

  if (rgb) {
    const [r, g, b] = numbers(rgb);
    return [r ?? 0, g ?? 0, b ?? 0];
  }

  return NAMED_COLORS[color] ?? current;
}

/*
 * Converts SVG path data to absolute move/line/cubic segments.
 * Quadratic curves become cubics (jsPDF, like PDF itself, only
 * draws cubics); an elliptical arc - which MathJax never emits for
 * glyphs - falls back to a straight line to its end point.
 */
type Segment =
  | { op: "M" | "L"; x: number; y: number }
  | { op: "C"; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { op: "Z" };

const ARG_COUNTS: Record<string, number> = {
  M: 2,
  L: 2,
  H: 1,
  V: 1,
  C: 6,
  S: 4,
  Q: 4,
  T: 2,
  A: 7,
  Z: 0,
};

export function parsePath(d: string): Segment[] {
  const tokens =
    d.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) ?? [];
  const segments: Segment[] = [];
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  // The previous curve's last control point, for S and T.
  let lastCubic: [number, number] | null = null;
  let lastQuad: [number, number] | null = null;
  let command = "";
  let i = 0;

  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i])) {
      command = tokens[i];
      i++;
    } else if (command === "") {
      break;
    }

    const upper = command.toUpperCase();
    const count = ARG_COUNTS[upper];

    if (count === undefined) {
      break;
    }

    const relative = command !== upper;
    const args = tokens.slice(i, i + count).map(Number);

    if (args.length < count || args.some((value) => !Number.isFinite(value))) {
      break;
    }

    i += count;

    const ox = relative ? x : 0;
    const oy = relative ? y : 0;
    let cubic: [number, number] | null = null;
    let quad: [number, number] | null = null;

    switch (upper) {
      case "M":
        x = ox + args[0];
        y = oy + args[1];
        startX = x;
        startY = y;
        segments.push({ op: "M", x, y });
        // Extra coordinate pairs after a moveto are linetos.
        command = relative ? "l" : "L";
        break;
      case "L":
        x = ox + args[0];
        y = oy + args[1];
        segments.push({ op: "L", x, y });
        break;
      case "H":
        x = ox + args[0];
        segments.push({ op: "L", x, y });
        break;
      case "V":
        y = oy + args[0];
        segments.push({ op: "L", x, y });
        break;
      case "C":
      case "S": {
        const [x1, y1]: [number, number] =
          upper === "C"
            ? [ox + args[0], oy + args[1]]
            : lastCubic
              ? [2 * x - lastCubic[0], 2 * y - lastCubic[1]]
              : [x, y];
        const rest = upper === "C" ? args.slice(2) : args;
        const x2 = ox + rest[0];
        const y2 = oy + rest[1];
        x = ox + rest[2];
        y = oy + rest[3];
        segments.push({ op: "C", x1, y1, x2, y2, x, y });
        cubic = [x2, y2];
        break;
      }
      case "Q":
      case "T": {
        const previous: [number, number] | null = lastQuad;
        const control: [number, number] =
          upper === "Q"
            ? [ox + args[0], oy + args[1]]
            : previous
              ? [2 * x - previous[0], 2 * y - previous[1]]
              : [x, y];
        const qx: number = control[0];
        const qy: number = control[1];
        const rest = upper === "Q" ? args.slice(2) : args;
        const endX = ox + rest[0];
        const endY = oy + rest[1];
        segments.push({
          op: "C",
          x1: x + (2 / 3) * (qx - x),
          y1: y + (2 / 3) * (qy - y),
          x2: endX + (2 / 3) * (qx - endX),
          y2: endY + (2 / 3) * (qy - endY),
          x: endX,
          y: endY,
        });
        x = endX;
        y = endY;
        quad = [qx, qy];
        break;
      }
      case "A":
        x = ox + args[5];
        y = oy + args[6];
        segments.push({ op: "L", x, y });
        break;
      case "Z":
        x = startX;
        y = startY;
        segments.push({ op: "Z" });
        break;
    }

    lastCubic = cubic;
    lastQuad = quad;
  }

  return segments;
}

const KAPPA = 0.5522847498;

function ellipseSegments(cx: number, cy: number, rx: number, ry: number): Segment[] {
  const kx = rx * KAPPA;
  const ky = ry * KAPPA;

  return [
    { op: "M", x: cx + rx, y: cy },
    { op: "C", x1: cx + rx, y1: cy + ky, x2: cx + kx, y2: cy + ry, x: cx, y: cy + ry },
    { op: "C", x1: cx - kx, y1: cy + ry, x2: cx - rx, y2: cy + ky, x: cx - rx, y: cy },
    { op: "C", x1: cx - rx, y1: cy - ky, x2: cx - kx, y2: cy - ry, x: cx, y: cy - ry },
    { op: "C", x1: cx + kx, y1: cy - ry, x2: cx + rx, y2: cy - ky, x: cx + rx, y: cy },
    { op: "Z" },
  ];
}

function rectSegments(x: number, y: number, width: number, height: number): Segment[] {
  return [
    { op: "M", x, y },
    { op: "L", x: x + width, y },
    { op: "L", x: x + width, y: y + height },
    { op: "L", x, y: y + height },
    { op: "Z" },
  ];
}

function polygonSegments(points: string | undefined, closed: boolean): Segment[] {
  const values = numbers(points);
  const segments: Segment[] = [];

  for (let i = 0; i + 1 < values.length; i += 2) {
    segments.push({ op: i === 0 ? "M" : "L", x: values[i], y: values[i + 1] });
  }

  if (closed && segments.length > 0) {
    segments.push({ op: "Z" });
  }

  return segments;
}

/*
 * Builds the path in jsPDF's current path; returns false when there
 * was nothing to draw (jsPDF throws on painting an empty path).
 */
function tracePath(doc: jsPDF, segments: Segment[], matrix: Matrix): boolean {
  let started = false;

  for (const segment of segments) {
    if (segment.op === "Z") {
      if (started) {
        doc.close();
      }
      continue;
    }

    if (segment.op === "M") {
      doc.moveTo(...apply(matrix, segment.x, segment.y));
      started = true;
      continue;
    }

    if (!started) {
      continue;
    }

    if (segment.op === "L") {
      doc.lineTo(...apply(matrix, segment.x, segment.y));
    } else if (segment.op === "C") {
      doc.curveTo(
        ...apply(matrix, segment.x1, segment.y1),
        ...apply(matrix, segment.x2, segment.y2),
        ...apply(matrix, segment.x, segment.y),
      );
    }
  }

  return started;
}

function paint(
  doc: jsPDF,
  segments: Segment[],
  state: DrawState,
  canFill: boolean,
): void {
  const strokeWidth = state.strokeWidth * scaleOf(state.matrix);
  const fill = canFill ? state.fill : null;
  const stroke = strokeWidth > 0 ? state.stroke : null;

  if (!fill && !stroke) {
    return;
  }

  if (!tracePath(doc, segments, state.matrix)) {
    return;
  }

  if (fill) {
    doc.setFillColor(...fill);
  }

  if (stroke) {
    doc.setDrawColor(...stroke);
    doc.setLineWidth(strokeWidth);
  }

  if (fill && stroke) {
    doc.fillStroke();
  } else if (fill) {
    doc.fill();
  } else {
    doc.stroke();
  }
}

/* The style of a <text> element, from MathJax's variant and font attributes. */
export function mathTextStyle(attrs: Record<string, string>): MathTextStyle {
  const variant = attrs["data-variant"] ?? "";
  const family = attrs["font-family"] ?? "";

  return {
    bold: variant.includes("bold") || attrs["font-weight"] === "bold",
    italic: variant.includes("italic") || attrs["font-style"] === "italic",
    monospace: variant.includes("monospace") || family.includes("monospace"),
  };
}

function drawNode(
  doc: jsPDF,
  node: SvgNode,
  parent: DrawState,
  options: DrawMathOptions,
): void {
  const { attrs } = node;
  const state: DrawState = {
    matrix: multiply(parent.matrix, parseTransform(attrs.transform)),
    fill: parseColor(attrs.fill, parent.fill, options.color),
    stroke: parseColor(attrs.stroke, parent.stroke, options.color),
    strokeWidth:
      attrs["stroke-width"] !== undefined
        ? num(attrs["stroke-width"])
        : parent.strokeWidth,
  };

  switch (node.tag) {
    case "g":
    case "a":
      for (const child of node.children) {
        drawNode(doc, child, state, options);
      }
      break;
    case "svg":
      drawViewport(doc, node, state, options);
      break;
    case "path":
      paint(doc, parsePath(attrs.d ?? ""), state, true);
      break;
    case "rect":
      paint(
        doc,
        rectSegments(
          num(attrs.x),
          num(attrs.y),
          num(attrs.width),
          num(attrs.height),
        ),
        state,
        true,
      );
      break;
    case "line":
      paint(
        doc,
        [
          { op: "M", x: num(attrs.x1), y: num(attrs.y1) },
          { op: "L", x: num(attrs.x2), y: num(attrs.y2) },
        ],
        { ...state, stroke: state.stroke ?? options.color },
        false,
      );
      break;
    case "polygon":
    case "polyline":
      paint(
        doc,
        polygonSegments(attrs.points, node.tag === "polygon"),
        state,
        node.tag === "polygon",
      );
      break;
    case "ellipse":
    case "circle":
      paint(
        doc,
        ellipseSegments(
          num(attrs.cx),
          num(attrs.cy),
          num(attrs.rx ?? attrs.r),
          num(attrs.ry ?? attrs.r),
        ),
        state,
        true,
      );
      break;
    case "text": {
      const text = node.text ?? "";

      if (text.trim() !== "" && state.fill) {
        const [x, y] = apply(state.matrix, num(attrs.x), num(attrs.y));
        const size = num(attrs["font-size"], 1000) * scaleOf(state.matrix);
        options.drawText(text, x, y, size, mathTextStyle(attrs), state.fill);
      }
      break;
    }
    // <title>, <defs>, <image>, <use> (never written with
    // fontCache "none") - nothing to draw.
  }
}

/*
 * A nested <svg> maps its viewBox onto the box (x, y, width,
 * height) and clips to that box. One without a size (the
 * equation-label columns of a tagged table) is drawn unclipped in
 * its parent's coordinates.
 */
function drawViewport(
  doc: jsPDF,
  node: SvgNode,
  state: DrawState,
  options: DrawMathOptions,
): void {
  const { attrs } = node;
  const width = num(attrs.width, NaN);
  const height = num(attrs.height, NaN);
  const viewBox = numbers(attrs.viewBox);
  const sized =
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width > 0 &&
    height > 0;

  if (!sized) {
    for (const child of node.children) {
      drawNode(doc, child, state, options);
    }
    return;
  }

  const x = num(attrs.x);
  const y = num(attrs.y);
  let inner = multiply(state.matrix, [1, 0, 0, 1, x, y]);

  if (viewBox.length === 4 && viewBox[2] > 0 && viewBox[3] > 0) {
    inner = multiply(inner, [
      width / viewBox[2],
      0,
      0,
      height / viewBox[3],
      -viewBox[0] * (width / viewBox[2]),
      -viewBox[1] * (height / viewBox[3]),
    ]);
  }

  doc.saveGraphicsState();
  tracePath(doc, rectSegments(x, y, width, height), state.matrix);
  doc.clip();
  doc.discardPath();

  for (const child of node.children) {
    drawNode(doc, child, { ...state, matrix: inner }, options);
  }

  doc.restoreGraphicsState();
}

/*
 * Draws a formula with the left end of its baseline at (x,
 * baseline), `unit` mm per viewBox unit (an em is 1000 units).
 * Leaves the document's line width as it found it; fill and draw
 * colors are always set by the caller before use elsewhere.
 */
export function drawMath(
  doc: jsPDF,
  math: RenderedMath,
  x: number,
  baseline: number,
  unit: number,
  options: DrawMathOptions,
): void {
  const [minX] = math.viewBox;
  const lineWidth = doc.getLineWidth();
  const matrix: Matrix = [unit, 0, 0, unit, x - minX * unit, baseline];

  for (const child of math.root.children) {
    drawNode(
      doc,
      child,
      { matrix, fill: options.color, stroke: options.color, strokeWidth: 0 },
      options,
    );
  }

  doc.setLineWidth(lineWidth);
}
