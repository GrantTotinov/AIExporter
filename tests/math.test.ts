import { describe, expect, it } from "vitest";
import {
  MATH_CLOSE,
  MATH_OPEN,
  containsMath,
  extractMath,
  normalizeMathMarkdown,
  type MathSpan,
} from "../src/math";

const token = (index: number) => `${MATH_OPEN}${index}${MATH_CLOSE}`;

describe("normalizeMathMarkdown", () => {
  it("turns ChatGPT's \\( \\) and \\[ \\] into $ and $$", () => {
    expect(
      normalizeMathMarkdown(
        String.raw`So \( x = \frac{1}{2} \) and:` +
          "\n\n" +
          String.raw`\[` +
          "\n" +
          String.raw`E = mc^2` +
          "\n" +
          String.raw`\]`,
        "chatgpt",
      ),
    ).toBe("So $x = \\frac{1}{2}$ and:\n\n$$\nE = mc^2\n$$");
  });

  it("puts a display formula that shares a line onto lines of its own", () => {
    expect(
      normalizeMathMarkdown(String.raw`Before \[a+b\] after`, "chatgpt"),
    ).toBe("Before\n$$\na+b\n$$\nafter");
  });

  it("keeps a display formula inside its list item", () => {
    const markdown = [
      "1. Compute:",
      "   \\[",
      "   \\Delta = b^2 - 4ac",
      "   \\]",
      "2. Next",
    ].join("\n");

    expect(normalizeMathMarkdown(markdown, "chatgpt")).toBe(
      [
        "1. Compute:",
        "   $$",
        "   \\Delta = b^2 - 4ac",
        "   $$",
        "2. Next",
      ].join("\n"),
    );
  });

  it("keeps a display formula inside its quote", () => {
    expect(
      normalizeMathMarkdown("> \\[\n> a^2\n> \\]", "chatgpt"),
    ).toBe("> $$\n> a^2\n> $$");
  });

  it("makes Claude's mid-sentence $$...$$ inline math", () => {
    expect(
      normalizeMathMarkdown("Energy is $$E = mc^2$$ here.", "claude"),
    ).toBe("Energy is $E = mc^2$ here.");
    expect(normalizeMathMarkdown("$$\nE = mc^2\n$$", "claude")).toBe(
      "$$\nE = mc^2\n$$",
    );
  });

  it("leaves dollar amounts alone", () => {
    const text = "It costs $5 and $10, or between $5-$10.";

    expect(normalizeMathMarkdown(text, "chatgpt")).toBe(text);
    expect(normalizeMathMarkdown(text, "claude")).toBe(text);
    expect(normalizeMathMarkdown(text, "gemini")).toBe(text);
  });

  it("reads a single $ as math only on Gemini", () => {
    expect(containsMath("Area is $x^2$.", "gemini")).toBe(true);
    expect(containsMath("Area is $x^2$.", "chatgpt")).toBe(false);
    expect(containsMath("Area is $x^2$.", "claude")).toBe(false);
  });

  it("never touches code", () => {
    const markdown = [
      "Use `\\(x\\)` literally:",
      "",
      "```bash",
      'echo "\\(not math\\) $HOME $$"',
      "```",
      "",
      "~~~",
      "\\[ also not math \\]",
      "~~~",
    ].join("\n");

    expect(normalizeMathMarkdown(markdown, "gemini")).toBe(markdown);
  });

  it("converts math between code blocks and keeps their newlines", () => {
    const markdown = "```\ncode\n```\nThen \\(x\\).\n```\nmore\n```";

    expect(normalizeMathMarkdown(markdown, "chatgpt")).toBe(
      "```\ncode\n```\nThen $x$.\n```\nmore\n```",
    );
  });

  it("doesn't let a stray delimiter swallow later paragraphs", () => {
    const markdown = "A stray \\[ here.\n\nLater \\] text.";

    expect(normalizeMathMarkdown(markdown, "chatgpt")).toBe(markdown);
  });

  it("returns text without math unchanged", () => {
    expect(normalizeMathMarkdown("Plain *text*.\r\n", "chatgpt")).toBe(
      "Plain *text*.\r\n",
    );
  });
});

describe("extractMath", () => {
  it("swaps each formula for a numbered placeholder", () => {
    const formulas: MathSpan[] = [];
    const text = extractMath(
      "Let $$a | b$$ hold.\n\n$$\n\\sum_i x_i\n$$",
      "claude",
      formulas,
    );

    expect(text).toBe(`Let ${token(0)} hold.\n\n${token(1)}`);
    expect(formulas).toEqual([
      { tex: "a | b", display: false },
      { tex: "\\sum_i x_i", display: true },
    ]);
  });

  it("numbers formulas across messages", () => {
    const formulas: MathSpan[] = [];
    extractMath("\\(a\\)", "chatgpt", formulas);

    expect(extractMath("\\(b\\)", "chatgpt", formulas)).toBe(token(1));
    expect(formulas.map((formula) => formula.tex)).toEqual(["a", "b"]);
  });
});
