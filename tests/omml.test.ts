// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { texToMathML } from "../src/math-render";
import { mathMlToOmml } from "../src/omml";

/* The formula's OMML, with the runs' font properties left out for reading */
function omml(tex: string, display = false): string {
  const mathMl = texToMathML(tex, display);

  expect(mathMl).not.toBeNull();

  return (mathMlToOmml(mathMl ?? "", display) ?? "")
    .replace(/<w:rPr>.*?<\/w:rPr>/g, "")
    .replace(/ xml:space="preserve"/g, "");
}

describe("Word equations", { timeout: 20_000 }, () => {
  it("writes scripts, fractions and roots", () => {
    expect(omml("x^2")).toBe(
      "<m:oMath><m:sSup><m:e><m:r><m:t>x</m:t></m:r></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup></m:oMath>",
    );
    expect(omml("\\frac{a}{b}", true)).toBe(
      "<m:oMathPara><m:oMath><m:f><m:num><m:r><m:t>a</m:t></m:r></m:num><m:den><m:r><m:t>b</m:t></m:r></m:den></m:f></m:oMath></m:oMathPara>",
    );
    expect(omml("\\sqrt[3]{x}")).toContain("<m:rad><m:deg><m:r><m:t>3</m:t></m:r></m:deg><m:e><m:r><m:t>x</m:t></m:r></m:e></m:rad>");
    expect(omml("\\sqrt{2}")).toContain('<m:degHide m:val="1"/>');
    expect(omml("x_{1}^{2}")).toContain("<m:sSubSup>");
    expect(omml("\\binom{n}{k}")).toContain('<m:type m:val="noBar"/>');
  });

  it("gives a big operator its limits and the expression after it", () => {
    const sum = omml("\\sum_{i=1}^{n} i^2", true);

    expect(sum).toContain('<m:chr m:val="∑"/><m:limLoc m:val="undOvr"/>');
    expect(sum).toMatch(/<m:sub>.*i.*=.*1.*<\/m:sub><m:sup>.*n.*<\/m:sup><m:e><m:sSup>/);
    expect(omml("\\int_0^1 x\\,dx")).toContain('<m:chr m:val="∫"/><m:limLoc m:val="subSup"/>');
  });

  it("writes fences, matrices, accents and bars", () => {
    expect(omml("\\left(\\frac{1}{2}\\right)")).toContain(
      '<m:d><m:dPr><m:begChr m:val="("/><m:endChr m:val=")"/></m:dPr><m:e><m:f>',
    );
    expect(omml("\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix}")).toContain(
      "<m:m><m:mr><m:e><m:r><m:t>1</m:t></m:r></m:e><m:e><m:r><m:t>2</m:t></m:r></m:e></m:mr>",
    );
    expect(omml("\\hat{x}")).toContain('<m:acc><m:accPr><m:chr m:val="\u0302"/></m:accPr>');
    expect(omml("\\vec{v}")).toContain('<m:chr m:val="\u20D7"/>');
    expect(omml("\\overline{AB}")).toContain('<m:bar><m:barPr><m:pos m:val="top"/></m:barPr>');
  });

  it("keeps names upright and text as text", () => {
    const formula = omml("\\sin x \\cdot \\mathbf{F} = \\text{force}");

    expect(formula).toContain('<m:r><m:rPr><m:sty m:val="p"/></m:rPr><m:t>sin</m:t></m:r>');
    expect(formula).toContain('<m:rPr><m:sty m:val="b"/></m:rPr><m:t>F</m:t>');
    expect(formula).toContain("<m:r><m:rPr><m:nor/></m:rPr><m:t>force</m:t></m:r>");
    expect(formula).not.toContain("\u2061");
  });

  it("gives up on what isn't MathML", () => {
    expect(mathMlToOmml("<div>no</div>", false)).toBeNull();
    expect(mathMlToOmml("not xml <", false)).toBeNull();
    expect(texToMathML("\\frac{a", false)).toBeNull();
  });
});
