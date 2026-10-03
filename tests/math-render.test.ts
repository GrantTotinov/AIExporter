import { describe, expect, it, vi } from "vitest";
import { renderTex, type SvgNode } from "../src/math-render";
import { parsePath, parseTransform } from "../src/svg-pdf";

function findAll(node: SvgNode, tag: string): SvgNode[] {
  return [
    ...(node.tag === tag ? [node] : []),
    ...node.children.flatMap((child) => findAll(child, tag)),
  ];
}

describe("renderTex", () => {
  it("typesets a formula into glyph paths with its size", () => {
    const math = renderTex("\\frac{a}{b}", true);

    expect(math).not.toBeNull();

    const [, minY, width, height] = math!.viewBox;

    expect(width).toBeGreaterThan(0);
    expect(minY).toBeLessThan(0);
    expect(minY + height).toBeGreaterThan(0);
    expect(findAll(math!.root, "path").length).toBeGreaterThanOrEqual(2);
    expect(findAll(math!.root, "rect")).toHaveLength(1);
  });

  it("returns null for a formula with a syntax error", () => {
    expect(renderTex("\\frac{1}{", false)).toBeNull();
  });

  it("sets an equation label right after the equation", () => {
    const math = renderTex(
      "\\begin{equation} E = mc^2 \\tag{1} \\end{equation}",
      true,
    );

    expect(math).not.toBeNull();
    expect(math!.root.attrs.width).not.toBe("100%");
  });

  it("measures text outside the TeX fonts with the caller's font", () => {
    const measure = vi.fn(() => 2);
    const math = renderTex("\\text{Жаба}", false, measure);
    const texts = findAll(math!.root, "text");

    expect(measure).toHaveBeenCalled();
    expect(texts.length).toBeGreaterThan(0);
    // 2em per character instead of MathJax's 0.6em guess.
    expect(math!.viewBox[2]).toBeGreaterThan(4 * 1000);
  });
});

describe("parsePath", () => {
  it("makes every command absolute and quadratics cubic", () => {
    expect(parsePath("M10 20 l5 0 H30 V40 Q30 50 40 50 Z")).toEqual([
      { op: "M", x: 10, y: 20 },
      { op: "L", x: 15, y: 20 },
      { op: "L", x: 30, y: 20 },
      { op: "L", x: 30, y: 40 },
      {
        op: "C",
        x1: 30,
        y1: 40 + (2 / 3) * 10,
        x2: 40 + (2 / 3) * -10,
        y2: 50,
        x: 40,
        y: 50,
      },
      { op: "Z" },
    ]);
  });

  it("reads numbers written without separators, as MathJax does", () => {
    expect(parsePath("M-1.5-2L.5.25")).toEqual([
      { op: "M", x: -1.5, y: -2 },
      { op: "L", x: 0.5, y: 0.25 },
    ]);
  });

  it("reflects the previous control point for T", () => {
    const segments = parsePath("M0 0Q10 10 20 0T40 0");

    expect(segments[2]).toMatchObject({ op: "C", x: 40, y: 0 });
    // The reflected control point (30, -10) pulls the curve down.
    expect((segments[2] as { y1: number }).y1).toBeLessThan(0);
  });
});

describe("parseTransform", () => {
  it("composes transforms left to right", () => {
    expect(parseTransform("translate(10,5) scale(2,-1)")).toEqual([
      2, 0, 0, -1, 10, 5,
    ]);
  });

  it("ignores missing or unknown transforms", () => {
    expect(parseTransform(undefined)).toEqual([1, 0, 0, 1, 0, 0]);
    expect(parseTransform("skewX(30)")).toEqual([1, 0, 0, 1, 0, 0]);
  });
});
