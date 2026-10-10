import { describe, expect, it } from "vitest";
import {
  chatGptThinking,
  convertChatGptCitations,
  type ChatGptMessageLike,
} from "../src/chatgpt-reply";
import { ReplySources } from "../src/reply-sources";
import { NOTE_CLOSE, NOTE_OPEN, bracketNotes } from "../src/source-notes";

const OPEN = String.fromCharCode(0xe200);
const CLOSE = String.fromCharCode(0xe201);
const SEP = String.fromCharCode(0xe202);

const cite = (...refs: string[]) => `${OPEN}cite${refs.map((ref) => `${SEP}${ref}`).join("")}${CLOSE}`;
const note = (...numbers: number[]) => `${NOTE_OPEN}${numbers.join(",")}${NOTE_CLOSE}`;

describe("convertChatGptCitations", () => {
  it("turns ChatGPT's citation markers into notes, in the order they're cited", () => {
    const sources = new ReplySources();
    const text = `Rome was founded in 753 BC. ${cite("turn0search3")} It has 2.8 million people. ${cite("turn0search1", "turn0search3")}`;
    const metadata = {
      content_references: [
        {
          type: "grouped_webpages",
          matched_text: cite("turn0search3"),
          items: [{ title: "History of Rome", url: "https://history.example/rome" }],
        },
        {
          type: "grouped_webpages",
          matched_text: cite("turn0search1", "turn0search3"),
          items: [
            {
              title: "Rome census",
              url: "https://stats.example/rome",
              supporting_websites: [
                { title: "History of Rome", url: "https://history.example/rome" },
              ],
            },
          ],
        },
      ],
    };

    const content = convertChatGptCitations(text, metadata, sources);

    expect(content).toBe(
      `Rome was founded in 753 BC.${note(1)} It has 2.8 million people.${note(2, 1)}`,
    );
    expect(sources.list).toEqual([
      { title: "History of Rome", url: "https://history.example/rome" },
      { title: "Rome census", url: "https://stats.example/rome" },
    ]);
  });

  it("adds ChatGPT's own source list after the cited pages", () => {
    const sources = new ReplySources();

    convertChatGptCitations(
      `Fact ${cite("turn0search0")}`,
      {
        content_references: [
          {
            type: "grouped_webpages",
            matched_text: cite("turn0search0"),
            items: [{ title: "A", url: "https://a.example/" }],
          },
          {
            type: "sources_footnote",
            matched_text: " ",
            sources: [
              { title: "A", url: "https://a.example/" },
              { attribution: "B site", url: "https://b.example/" },
            ],
          },
        ],
      },
      sources,
    );

    expect(sources.list).toEqual([
      { title: "A", url: "https://a.example/" },
      { title: "B site", url: "https://b.example/" },
    ]);
  });

  it("keeps the text of references without sources and drops image carousels", () => {
    const sources = new ReplySources();
    const content = convertChatGptCitations(
      `Try ${OPEN}product${SEP}x${CLOSE} or this. ${OPEN}i${SEP}turn0image0${CLOSE}`,
      {
        content_references: [
          {
            type: "product_entity",
            matched_text: `${OPEN}product${SEP}x${CLOSE}`,
            alt: "[Acme Kettle]()",
          },
          { type: "image_group", matched_text: `${OPEN}i${SEP}turn0image0${CLOSE}` },
        ],
      },
      sources,
    );

    expect(content).toBe("Try Acme Kettle or this.");
    expect(sources.size).toBe(0);
  });

  it("removes markers nothing explains, and makes url tokens links", () => {
    const content = convertChatGptCitations(
      `See ${OPEN}url${SEP}the docs${SEP}https://docs.example/${CLOSE}. Done ${cite("turn9search9")}`,
      {},
      new ReplySources(),
    );

    expect(content).toBe("See [the docs](https://docs.example/). Done");
  });

  it("reads the older 【n†source】 citations by position or number", () => {
    const sources = new ReplySources();
    const text = "Paris is big【11†source】. Lyon too【12†(Wiki)】.";
    const content = convertChatGptCitations(
      text,
      {
        citations: [
          {
            start_ix: text.indexOf("【11"),
            end_ix: text.indexOf("】") + 1,
            metadata: { title: "Paris", url: "https://paris.example/" },
          },
          {
            start_ix: 0,
            end_ix: 3,
            metadata: {
              title: "Lyon",
              url: "https://lyon.example/",
              extra: { cited_message_idx: 12 },
            },
          },
        ],
      },
      sources,
    );

    expect(bracketNotes(content, sources.list)).toBe("Paris is big[1]. Lyon too[2].");
  });
});

describe("chatGptThinking", () => {
  const message = (
    id: string,
    parent: string | null,
    rest: Omit<ChatGptMessageLike, "id"> & { parent?: never },
  ): ChatGptMessageLike & { parent: string | null } => ({ id, parent, ...rest });

  const conversation = [
    message("u1", null, { author: { role: "user" }, content: { content_type: "text", parts: ["Question"] } }),
    message("t1", "u1", {
      author: { role: "assistant" },
      content: {
        content_type: "thoughts",
        thoughts: [
          { summary: "Reading the question", content: "They want a summary." },
          { summary: "", content: "Check the dates." },
        ],
      },
    }),
    message("s1", "t1", {
      author: { role: "assistant" },
      content: { content_type: "code", parts: [] },
      metadata: { reasoning_title: "Searching the web" },
    }),
    message("p1", "s1", {
      author: { role: "assistant" },
      content: { content_type: "text", parts: ["Found two sources."] },
      metadata: { is_thinking_preamble_message: true },
    }),
    message("r1", "p1", {
      author: { role: "assistant" },
      content: { content_type: "reasoning_recap", parts: [] },
    }),
    message("a1", "r1", { author: { role: "assistant" }, content: { content_type: "text", parts: ["Answer"] } }),
  ];

  const byId = new Map<string, ChatGptMessageLike>(
    conversation.map((item) => [item.id as string, item]),
  );
  const parentOf = (item: ChatGptMessageLike) =>
    (item as { parent: string | null }).parent;

  it("gathers the reasoning between the question and the answer, oldest first", () => {
    expect(chatGptThinking(byId.get("a1")!, byId, parentOf)).toBe(
      [
        "**Reading the question**\n\nThey want a summary.",
        "Check the dates.",
        "*Searching the web*",
        "Found two sources.",
      ].join("\n\n"),
    );
  });

  it("finds nothing for a reply without reasoning", () => {
    const plain = new Map([
      ["u", message("u", null, { author: { role: "user" } })],
      ["a", message("a", "u", { author: { role: "assistant" } })],
    ]);

    expect(chatGptThinking(plain.get("a")!, plain, parentOf)).toBe("");
  });

  it("falls back to the reply's turn when there are no parent links", () => {
    const turn = { turn_exchange_id: "turn-1" };
    const loose = new Map<string, ChatGptMessageLike>([
      [
        "t",
        {
          id: "t",
          author: { role: "assistant" },
          create_time: 1,
          metadata: turn,
          content: { content_type: "thoughts", thoughts: [{ summary: "", content: "Hmm." }] },
        },
      ],
      ["a", { id: "a", author: { role: "assistant" }, create_time: 2, metadata: turn }],
    ]);

    expect(chatGptThinking(loose.get("a")!, loose, () => null)).toBe("Hmm.");
  });
});

describe("<Cite> components", () => {
  const results = {
    search_result_groups: [
      {
        entries: [
          { url: "https://a.example/", title: "A", ref_id: { turn_index: 7, ref_type: "search", ref_index: 0 } },
          { url: "https://b.example/", title: "B", ref_id: { turn_index: 7, ref_type: "search", ref_index: 1 } },
        ],
      },
    ],
  };

  it("cites the search results its refs name, from the reply's turn", () => {
    const sources = new ReplySources();
    const text = convertChatGptCitations(
      'Rome. <Cite refs={["turn7search1","turn7search0"]}/> Paris. <Cite refs={["turn7search0"]}/>',
      {},
      sources,
      [results],
    );

    expect(text).toBe(`Rome.${note(1, 2)} Paris.${note(2)}`);
    expect(sources.list).toEqual([
      { title: "B", url: "https://b.example/" },
      { title: "A", url: "https://a.example/" },
    ]);
  });

  it("reads refs from cited items and references too", () => {
    const sources = new ReplySources();
    const metadata = {
      content_references: [
        { matched_text: cite("turn2search4"), items: [{ url: "https://c.example/", title: "C" }] },
        { items: [{ url: "https://d.example/", title: "D", refs: ["turn2search5"] }] },
      ],
    };

    expect(
      convertChatGptCitations('X <Cite refs={["turn2search4"]}/> Y <Cite refs={["turn2search5"]}/>', metadata, sources),
    ).toBe(`X${note(1)} Y${note(2)}`);
  });

  it("drops a ref nothing describes, and a <Cite> left with none", () => {
    const sources = new ReplySources();

    expect(
      convertChatGptCitations(
        'One. <Cite refs={["turn7search0","turn9search9"]}/> Two. <Cite refs={["turn9search9"]}/>',
        {},
        sources,
        [results],
      ),
    ).toBe(`One.${note(1)} Two.`);
    expect(sources.list).toHaveLength(1);
  });

  it("leaves a <Cite> in code alone", () => {
    const text = [
      'Write `<Cite refs={["turn7search0"]}/>` like this:',
      "",
      "```jsx",
      '<Cite refs={["turn7search0"]}/>',
      "```",
      "",
      '<CodeBlock language="jsx">',
      '<Cite refs={["turn7search1"]}/>',
      "</CodeBlock>",
    ].join("\n");
    const sources = new ReplySources();

    expect(convertChatGptCitations(text, {}, sources, [results])).toBe(text);
    expect(sources.list).toEqual([]);
  });
});

describe("UI widget references", () => {
  it("leaves the text a code block widget quotes, and any text a reference with nothing to cite quotes", () => {
    const block = "```text\nTotal: ¥255,000 ($1,700.00)\n```";
    const sources = new ReplySources();
    const metadata = {
      content_references: [
        {
          type: "client_defined_widget",
          category: "code_block",
          matched_text: block,
          data: { content: "Total: ¥255,000 ($1,700.00)", language: "text" },
          refs: [],
          alt: null,
        },
        { type: "unknown_kind", matched_text: "Both scripts", refs: [] },
      ],
    };
    const text = `## Expected output\n\n${block}\n\nBoth scripts agree.`;

    expect(convertChatGptCitations(text, metadata, sources)).toBe(text);
    expect(sources.list).toEqual([]);
  });
});
