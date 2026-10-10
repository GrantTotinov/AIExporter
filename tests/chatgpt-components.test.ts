import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  convertChatGptComponents,
  convertChatGptReplies,
} from "../src/chatgpt-components";

/* A real reply's text, from tests/fixtures/chatgpt-japan-trip.json */
const fixture = JSON.parse(
  readFileSync("tests/fixtures/chatgpt-japan-trip.json", "utf8"),
);
const REPLIES: Record<string, string> = {
  a1: "bc6e67cd", // itinerary: <Cite>, <AsyncImageGroup>, <text>
  a2: "d515d29d", // JR Pass prices: <Entity>
  a3: "fe8ec6a4", // budget: a <box> card
  a5: "f44ed35b", // calculator: <CodeBlock>s
  a6: "6016558a", // phrases: <WritingBlock>
};
const reply = (id: string): string =>
  fixture.page.messages.find((message: { id: string }) => message.id.startsWith(REPLIES[id]))
    .content.parts[0];

describe("convertChatGptComponents", () => {
  it("turns a <CodeBlock> into a fenced block in its language, as written", () => {
    const markdown = convertChatGptComponents(reply("a5"));

    expect(markdown).toContain(
      [
        "```python",
        "days = 14",
        "hotel_nights = 13",
        "hotel_per_night = 15_000",
        "rail_pass = 50_000",
        "daily_food_usd = 15",
        "yen_per_usd = 150",
        "",
        "food_yen = daily_food_usd * yen_per_usd * days",
      ].join("\n"),
    );
    expect(markdown).toContain(
      'print(f"Daily average: ¥{daily_yen:,.2f} (${daily_yen / yen_per_usd:,.2f})")\n```',
    );
    expect(markdown).toContain(
      "```javascript\nconst days = 14;\nconst hotelNights = 13;\n",
    );
    expect(markdown).toContain(
      "console.log(`Total: ¥${totalYen.toLocaleString()} ($${(totalYen / yenPerUsd).toFixed(2)})`);",
    );
    expect(markdown).not.toContain("CodeBlock");
  });

  it("fences code with more backticks than it holds", () => {
    expect(
      convertChatGptComponents('<CodeBlock language="markdown">\n```js\nx\n```\n</CodeBlock>'),
    ).toBe("````markdown\n```js\nx\n```\n````");
  });

  it("drops web image results and a citation nothing resolved", () => {
    const markdown = convertChatGptComponents(reply("a1"));

    expect(markdown).not.toMatch(/AsyncImageGroup|Shibuya crossing/);
    expect(markdown).toContain("for a two-week trip.\n\n**Trip overview**");
    expect(convertChatGptComponents('Before. <Cite refs={["turn1search0"]}/> After.')).toBe(
      "Before. After.",
    );
  });

  it("puts an <Entity>'s name in its place", () => {
    expect(convertChatGptComponents(reply("a2"))).toContain(
      "Sources: the official Japan Rail Pass price table and JR Group's April 9, 2026 announcement.",
    );
  });

  it("makes a <text> paragraph small print, and keeps inline <text> as text", () => {
    expect(convertChatGptComponents(reply("a1"))).toContain(
      "\n\n<small>Planning note: This version assumes you depart from Osaka. If your return flight is from Tokyo, you will need to adjust the final day and allow time to travel back.</small>\n\n",
    );
    expect(
      convertChatGptComponents('It costs <text color="secondary">about</text> ¥80,000.'),
    ).toBe("It costs about ¥80,000.");
  });

  it("keeps a <WritingBlock>'s lines as paragraphs with their line breaks", () => {
    expect(convertChatGptComponents(reply("a6"))).toContain(
      "<small>Arabic (Modern Standard Arabic)</small>\n\n" +
        "أريد شراء JR Pass مقابل 50,000 ين ياباني.\n\n" +
        "هل يمكنني استخدام JR Pass للسفر بالقطارات السريعة بين طوكيو وأوساكا؟\n\n" +
        "**English translation:**",
    );
    expect(convertChatGptComponents('<WritingBlock id="1">\nLine one\nLine two\n</WritingBlock>')).toBe(
      "Line one  \nLine two",
    );
    // "<WritingBlock/>" closes one too.
    expect(
      convertChatGptComponents('<WritingBlock id="1">\nDear Ana,\n\nSee you soon.\n<WritingBlock/>\nAfter.'),
    ).toBe("Dear Ana,\n\nSee you soon.\n\nAfter.");
  });

  it("lays a card's rows out as a table without a header, dividers dropped", () => {
    expect(convertChatGptComponents(reply("a3"))).toContain(
      [
        "## 3. Summary",
        "",
        "| | |",
        "|---|---|",
        "| Total for 14 days | **¥255,000** |",
        "| Average per day | **¥18,214** |",
        "| Total in USD | **$1,700** |",
        "| Average per day in USD | **$121.43** |",
        "",
        "**Important:** This is a baseline",
      ].join("\n"),
    );
  });

  it("keeps a card's title and loose text around its rows", () => {
    expect(
      convertChatGptComponents(
        "<box>\n<title>Budget</title>\n<row><text>Hotels</text><title>¥195,000</title><badge>13 nights</badge></row>\n<text>Prices may change.</text>\n</box>",
      ),
    ).toBe(
      "**Budget**\n\n| | |\n|---|---|\n| Hotels | **¥195,000** · 13 nights |\n\n<small>Prices may change.</small>",
    );
  });

  it("makes a <Link> a link and drops <AsyncImage> results", () => {
    // The other version of the JR Pass reply, in the whole tree
    const other = fixture.conversation.mapping[
      Object.keys(fixture.conversation.mapping).find((id) => id.startsWith("c4cb61b1")) as string
    ].message.content.parts[0];
    const markdown = convertChatGptComponents(other);

    expect(markdown).toContain("[Official Japan Rail Pass website](https://japanrailpass.net/en/)");
    expect(markdown).not.toMatch(/<(Link|AsyncImage|box|title)\b|Chidorigafuchi cherry blossoms moat/);
    expect(convertChatGptComponents('See <Link url="javascript:alert(1)" title="this"/>.')).toBe("See this.");
  });

  it("unwraps any other component to its text", () => {
    expect(
      convertChatGptComponents(
        'Pick <Choice id="a">the first</Choice> one.<Spacer size={2}/>\n\n<Callout tone="info">\nBring cash.\n</Callout>',
      ),
    ).toBe("Pick the first one.\n\nBring cash.");
    expect(convertChatGptComponents('<chip label={x}>New</chip> item')).toBe("New item");
  });

  it("leaves tags in code, HTML and plain angle brackets alone", () => {
    const text = [
      "Use `<Cite refs={[1]}/>` and `<box>` in code spans.",
      "",
      "```html",
      '<box border><row>keep</row></box>',
      '<text color="secondary">kept</text>',
      "```",
      "",
      "A List<String> is generic, 3 < 4 > 2, and <br> stays.",
    ].join("\n");

    expect(convertChatGptComponents(text)).toBe(text);
  });

  it("only changes ChatGPT's replies", () => {
    const messages = [
      { id: "u", role: "user" as const, order: 0, content: "<Entity value=\"x\"/>" },
      { id: "a", role: "assistant" as const, order: 1, content: "<Entity value=\"x\"/>" },
    ];

    expect(convertChatGptReplies(messages, "chatgpt").map((message) => message.content)).toEqual([
      '<Entity value="x"/>',
      "x",
    ]);
    expect(convertChatGptReplies(messages, "claude")).toBe(messages);
  });
});
