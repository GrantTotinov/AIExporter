import { describe, expect, it } from "vitest";
import {
  buildGeminiReadRequest,
  convertGeminiTurns,
  getGeminiAccountPrefix,
  getGeminiConversationId,
  isGeminiImageUrl,
  parseGeminiTurnsPage,
  readGeminiPageTokens,
  type GeminiExportMessage,
  type GeminiPageTokens,
} from "../src/gemini-conversation";

/*
 * Fixtures follow the shape of a captured hNvQHb response from
 * gemini.google.com - positional arrays, trimmed to the fields
 * the export reads plus a few it must skip over.
 */

const CONVERSATION_ID = "e87b6c6ac16404a5";
const RPC_CONVERSATION_ID = `c_${CONVERSATION_ID}`;

const TOKENS: GeminiPageTokens = {
  at: "AKRzLkFp3w:1790000000000",
  buildLabel: "boq_gemini-web-uiserver_20261001.12_p0",
  sessionId: "-351644736144307804",
  language: "en-US",
};

function fillTo(length: number, fields: Record<number, unknown>): unknown[] {
  const value: unknown[] = Array.from({ length }, () => null);

  for (const [index, field] of Object.entries(fields)) {
    value[Number(index)] = field;
  }

  return value;
}

function candidate(
  id: string,
  text: string,
  fields: Record<number, unknown> = {},
): unknown[] {
  return fillTo(29, {
    0: id,
    1: [text],
    8: [2],
    9: "en",
    12: [null, null, null, null, null, null, null, []],
    ...fields,
  });
}

function reply(drafts: unknown[][], shownId = drafts[0]?.[0]): unknown[] {
  return fillTo(26, {
    0: drafts,
    3: shownId,
    8: "IN",
    9: true,
    21: "3.8 Flash",
    24: 1,
    25: 1,
  });
}

function prompt(text: string, attachments: unknown[] = []): unknown[] {
  return [
    [
      text,
      null,
      null,
      null,
      attachments.length > 0
        ? [[null, null, null, attachments], attachments]
        : [[]],
    ],
    2,
    null,
    1,
    "56fdd199312815e2",
    null,
    null,
    null,
    false,
    null,
    [],
  ];
}

function turn(
  id: string,
  userPrompt: unknown[],
  modelReply: unknown[] | null,
  time = 1790000000,
): unknown[] {
  return [
    [RPC_CONVERSATION_ID, id],
    null,
    userPrompt,
    modelReply,
    [time, 500000000],
  ];
}

function imageFile(name: string, url: string, mimeType: string): unknown[] {
  return fillTo(16, { 1: 1, 2: name, 3: url, 11: mimeType });
}

function otherFile(name: string, mimeType: string): unknown[] {
  return fillTo(12, {
    1: 16,
    2: name,
    7: [
      "https://lh3.googleusercontent.com/thumb",
      `https://lh3.googleusercontent.com/dl/${name}`,
    ],
    11: mimeType,
  });
}

/*
 * Field 7 of a reply's rich content block: one entry per
 * generated image, each in its formats at [0][3] and [0][6].
 */
function generatedImages(...images: unknown[][][]): unknown[] {
  return fillTo(8, {
    7: [
      images.map((formats) => [
        fillTo(7, { 3: formats[0], 6: formats[1] ?? null }),
        [`http://googleusercontent.com/image_generation_content/0`],
      ]),
    ],
  });
}

function batchResponse(result: unknown): string {
  const envelope = JSON.stringify([
    ["wrb.fr", "hNvQHb", JSON.stringify(result), null, null, null, "generic"],
  ]);
  const info = JSON.stringify([
    ["di", 263],
    ["af.httprm", 263, "6293081504517489048", 30],
  ]);
  const end = JSON.stringify([["e", 4, null, null, 39853]]);

  return `)]}'\n\n${envelope.length + 2}\n${envelope}\n${info.length + 2}\n${info}\n${end.length + 2}\n${end}\n`;
}

function errorResponse(code: number): string {
  const envelope = JSON.stringify([
    ["wrb.fr", "hNvQHb", null, null, null, [code], "generic"],
  ]);

  return `)]}'\n\n${envelope.length + 2}\n${envelope}\n`;
}

function texts(messages: GeminiExportMessage[]): string[][] {
  return messages.map((exported) =>
    exported.parts.map((part) =>
      part.kind === "text"
        ? part.text
        : `<image ${part.image.url} ${part.image.fileName}>`,
    ),
  );
}

describe("getGeminiConversationId", () => {
  it("reads the conversation id from /app and Gem URL paths", () => {
    expect(getGeminiConversationId(`/app/${CONVERSATION_ID}`)).toBe(
      CONVERSATION_ID,
    );
    expect(getGeminiConversationId(`/app/${CONVERSATION_ID}/`)).toBe(
      CONVERSATION_ID,
    );
    expect(
      getGeminiConversationId(`/gem/coding-partner/${CONVERSATION_ID}`),
    ).toBe(CONVERSATION_ID);
  });

  it("reads it on a secondary account's /u/{n} paths too", () => {
    expect(getGeminiConversationId(`/u/1/app/${CONVERSATION_ID}`)).toBe(
      CONVERSATION_ID,
    );
    expect(
      getGeminiConversationId(`/u/2/gem/1a2b3c4d/${CONVERSATION_ID}`),
    ).toBe(CONVERSATION_ID);
  });

  it("returns null on pages that aren't a conversation", () => {
    expect(getGeminiConversationId("/")).toBeNull();
    expect(getGeminiConversationId("/app")).toBeNull();
    expect(getGeminiConversationId("/app/")).toBeNull();
    expect(getGeminiConversationId("/u/1/app")).toBeNull();
    expect(getGeminiConversationId("/gem/coding-partner")).toBeNull();
    expect(getGeminiConversationId("/gems/view")).toBeNull();
    expect(getGeminiConversationId(`/share/${CONVERSATION_ID}`)).toBeNull();
    expect(getGeminiConversationId(`/app/${CONVERSATION_ID}/extra`)).toBeNull();
    expect(getGeminiConversationId("/app/not%20an%20id")).toBeNull();
  });
});

describe("getGeminiAccountPrefix", () => {
  it("keeps the /u/{n} account prefix, if any", () => {
    expect(getGeminiAccountPrefix(`/u/1/app/${CONVERSATION_ID}`)).toBe("/u/1");
    expect(getGeminiAccountPrefix(`/u/10/gem/a/${CONVERSATION_ID}`)).toBe(
      "/u/10",
    );
    expect(getGeminiAccountPrefix(`/app/${CONVERSATION_ID}`)).toBe("");
    expect(getGeminiAccountPrefix("/u/1")).toBe("");
  });
});

describe("readGeminiPageTokens", () => {
  it("reads the tokens from the page's WIZ_global_data script", () => {
    expect(
      readGeminiPageTokens(
        `window.WIZ_global_data = {"AEJOSc":false,"FdrFJe":"${TOKENS.sessionId}","Im6cmf":"/_/BardChatUi","SNlM0e":"${TOKENS.at}","TuX5cc":"en-US","cfb2h":"${TOKENS.buildLabel}"};`,
      ),
    ).toEqual(TOKENS);
  });

  it("returns null for a signed-out page, which has no XSRF token", () => {
    expect(
      readGeminiPageTokens(
        `window.WIZ_global_data = {"FdrFJe":"-351644736144307804","Im6cmf":"/_/BardChatUi","TuX5cc":"en-US","cfb2h":"boq_gemini-web-uiserver_20261001.12_p0"};`,
      ),
    ).toBeNull();
    expect(readGeminiPageTokens("")).toBeNull();
  });

  it("leaves out values it can't read", () => {
    expect(
      readGeminiPageTokens(`{"SNlM0e":"token","FdrFJe":"not a number"}`),
    ).toEqual({
      at: "token",
      buildLabel: null,
      sessionId: null,
      language: null,
    });
  });
});

describe("buildGeminiReadRequest", () => {
  function decodeBody(body: string): { args: unknown; at: string | null } {
    const form = new URLSearchParams(body);
    const envelope = JSON.parse(form.get("f.req") ?? "null");

    expect(envelope).toEqual([
      [["hNvQHb", expect.any(String), null, "generic"]],
    ]);

    return { args: JSON.parse(envelope[0][0][1]), at: form.get("at") };
  }

  it("asks for the newest ten turns the way the web app does", () => {
    const request = buildGeminiReadRequest({
      conversationId: CONVERSATION_ID,
      cursor: null,
      tokens: TOKENS,
      accountPrefix: "",
      sourcePath: `/app/${CONVERSATION_ID}`,
      requestId: 123456,
    });

    const url = new URL(request.path, "https://gemini.google.com");

    expect(url.pathname).toBe("/_/BardChatUi/data/batchexecute");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      rpcids: "hNvQHb",
      "source-path": `/app/${CONVERSATION_ID}`,
      bl: TOKENS.buildLabel,
      "f.sid": TOKENS.sessionId,
      hl: "en-US",
      _reqid: "123456",
      rt: "c",
    });
    expect(decodeBody(request.body)).toEqual({
      args: [RPC_CONVERSATION_ID, 10, null, 1, [1], [4], null, 1],
      at: TOKENS.at,
    });
  });

  it("passes the cursor for older pages and keeps the account prefix", () => {
    const request = buildGeminiReadRequest({
      conversationId: CONVERSATION_ID,
      cursor: "next/page+token==",
      tokens: { ...TOKENS, buildLabel: null, sessionId: null, language: null },
      accountPrefix: "/u/1",
      sourcePath: `/u/1/app/${CONVERSATION_ID}`,
      requestId: 7,
    });

    const url = new URL(request.path, "https://gemini.google.com");

    expect(url.pathname).toBe("/u/1/_/BardChatUi/data/batchexecute");
    expect(url.searchParams.has("bl")).toBe(false);
    expect(url.searchParams.has("f.sid")).toBe(false);
    expect(url.searchParams.get("hl")).toBe("en");
    expect(decodeBody(request.body).args).toEqual([
      RPC_CONVERSATION_ID,
      10,
      "next/page+token==",
      1,
      [1],
      [4],
      null,
      1,
    ]);
  });
});

describe("parseGeminiTurnsPage", () => {
  it("reads the turns and the next page's cursor", () => {
    const turns = [
      turn("r_2", prompt("b"), null),
      turn("r_1", prompt("a"), null),
    ];

    expect(
      parseGeminiTurnsPage(batchResponse([turns, "cursor-2", null, []])),
    ).toEqual({
      turns,
      nextCursor: "cursor-2",
    });
  });

  it("has no cursor on the last page", () => {
    expect(
      parseGeminiTurnsPage(
        batchResponse([[turn("r_1", prompt("a"), null)], null, null, []]),
      ),
    ).toEqual({ turns: [turn("r_1", prompt("a"), null)], nextCursor: null });
  });

  it("accepts an answer without the chunk framing", () => {
    const answer = `)]}'\n\n${JSON.stringify(
      [
        [
          "wrb.fr",
          "hNvQHb",
          JSON.stringify([[], null]),
          null,
          null,
          null,
          "generic",
        ],
      ],
      null,
      2,
    )}`;

    expect(parseGeminiTurnsPage(answer)).toEqual({
      turns: [],
      nextCursor: null,
    });
  });

  it("reports a deleted or unknown conversation", () => {
    expect(() => parseGeminiTurnsPage(errorResponse(5))).toThrow(
      "Gemini could not find this conversation.",
    );
  });

  it("reports a refused session", () => {
    expect(() => parseGeminiTurnsPage(errorResponse(7))).toThrow(
      "Gemini denied access to this conversation.",
    );
  });

  it("reports anything else as an unexpected format", () => {
    const unexpected = "Gemini returned an unexpected conversation format.";

    expect(() => parseGeminiTurnsPage(errorResponse(3))).toThrow(unexpected);
    expect(() => parseGeminiTurnsPage("<html>Sign in</html>")).toThrow(
      unexpected,
    );
    expect(() =>
      parseGeminiTurnsPage(`)]}'\n\n[["wrb.fr","otherRpc","[]"]]\n`),
    ).toThrow(unexpected);
    expect(() =>
      parseGeminiTurnsPage(`)]}'\n\n[["wrb.fr","hNvQHb","{not json"]]\n`),
    ).toThrow(unexpected);
    expect(() => parseGeminiTurnsPage(batchResponse({ turns: [] }))).toThrow(
      unexpected,
    );
  });
});

describe("isGeminiImageUrl", () => {
  it("accepts Google's image hosts over HTTPS", () => {
    expect(
      isGeminiImageUrl("https://lh3.googleusercontent.com/gg/abc=s0"),
    ).toBe(true);
    expect(
      isGeminiImageUrl("https://lh5.googleusercontent.com/gg-dl/abc"),
    ).toBe(true);
    expect(isGeminiImageUrl("https://lh3.google.com/u/0/d/abc")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isGeminiImageUrl("http://lh3.googleusercontent.com/gg/abc")).toBe(
      false,
    );
    expect(
      isGeminiImageUrl(
        "http://googleusercontent.com/image_generation_content/0",
      ),
    ).toBe(false);
    expect(isGeminiImageUrl("https://evil.googleusercontent.com/gg/abc")).toBe(
      false,
    );
    expect(
      isGeminiImageUrl("https://lh3.googleusercontent.com.example.com/a"),
    ).toBe(false);
    expect(
      isGeminiImageUrl("https://user:pass@lh3.googleusercontent.com/a"),
    ).toBe(false);
    expect(isGeminiImageUrl("https://lh3.googleusercontent.com:8443/a")).toBe(
      false,
    );
    expect(isGeminiImageUrl("https://images.example.com/a.png")).toBe(false);
    expect(isGeminiImageUrl("not a url")).toBe(false);
    expect(isGeminiImageUrl(null)).toBe(false);
  });
});

describe("convertGeminiTurns", () => {
  it("puts the turns of newest-first pages in conversation order", () => {
    const firstPage = [
      turn(
        "r_3",
        prompt("Third question"),
        reply([candidate("rc_3", "Third answer")]),
      ),
      turn(
        "r_2",
        prompt("Second question"),
        reply([candidate("rc_2", "Second answer")]),
      ),
    ];
    const secondPage = [
      turn(
        "r_1",
        prompt("First question"),
        reply([candidate("rc_1", "First answer")]),
      ),
    ];

    const messages = convertGeminiTurns([...firstPage, ...secondPage]);

    expect(messages.map(({ id, role }) => [id, role])).toEqual([
      ["r_1", "user"],
      ["rc_1", "assistant"],
      ["r_2", "user"],
      ["rc_2", "assistant"],
      ["r_3", "user"],
      ["rc_3", "assistant"],
    ]);
    expect(texts(messages)).toEqual([
      ["First question"],
      ["First answer"],
      ["Second question"],
      ["Second answer"],
      ["Third question"],
      ["Third answer"],
    ]);
  });

  it("exports a turn only once, even if two pages both hold it", () => {
    const repeated = turn(
      "r_1",
      prompt("Hello"),
      reply([candidate("rc_1", "Hi!")]),
    );

    expect(texts(convertGeminiTurns([repeated, repeated]))).toEqual([
      ["Hello"],
      ["Hi!"],
    ]);
  });

  it("exports the draft that was on screen", () => {
    const drafts = [
      candidate("rc_a", "A draft the person didn't pick."),
      candidate("rc_b", "The draft on screen."),
    ];

    expect(
      texts(
        convertGeminiTurns([turn("r_1", prompt("Hi"), reply(drafts, "rc_b"))]),
      ),
    ).toEqual([["Hi"], ["The draft on screen."]]);
    expect(
      texts(
        convertGeminiTurns([
          turn("r_1", prompt("Hi"), reply(drafts, "rc_gone")),
        ]),
      ),
    ).toEqual([["Hi"], ["A draft the person didn't pick."]]);
  });

  it("exports a prompt that has no reply yet", () => {
    expect(
      texts(convertGeminiTurns([turn("r_1", prompt("Still thinking?"), null)])),
    ).toEqual([["Still thinking?"]]);
  });

  it("trims blank lines around the text but keeps it otherwise as written", () => {
    expect(
      texts(
        convertGeminiTurns([
          turn(
            "r_1",
            prompt("\n\n  indented\nlast line   \n"),
            reply([candidate("rc_1", "Answer\n\n")]),
          ),
        ]),
      ),
    ).toEqual([["  indented\nlast line"], ["Answer"]]);
  });

  it("leaves out Gemini's own markup but not the text around it", () => {
    const text = [
      "[cite_start]Tide pools form on rocky shores [cite: 1, 2].",
      "",
      '<Image alt="A tide pool" caption="Tide pool at low tide" src="image_agent_tag_123"/>',
      "",
      "A video explains more.",
      "http://googleusercontent.com/youtube_content/1",
      "",
      "Here is a picture.http://googleusercontent.com/image_generation_content/0",
      "",
      '<FollowUp label="Want more?" query="Tell me more about tide pools."/>',
    ].join("\n");

    expect(
      texts(
        convertGeminiTurns([
          turn("r_1", prompt("Tide pools?"), reply([candidate("rc_1", text)])),
        ]),
      ),
    ).toEqual([
      ["Tide pools?"],
      [
        "Tide pools form on rocky shores.\n\nA video explains more.\n\nHere is a picture.",
      ],
    ]);
  });

  it("keeps that markup inside code blocks", () => {
    const text = [
      "Gemini marks citations like this:",
      "",
      "```markdown",
      "[cite_start]A fact [cite: 1].",
      '<FollowUp label="x" query="y"/>',
      "```",
      "",
      "~~~",
      "http://googleusercontent.com/youtube_content/1",
      "~~~",
    ].join("\n");

    expect(
      texts(
        convertGeminiTurns([
          turn("r_1", prompt("Show me"), reply([candidate("rc_1", text)])),
        ]),
      ),
    ).toEqual([["Show me"], [text]]);
  });

  it("uses a card's own text in place of the link to the card", () => {
    expect(
      texts(
        convertGeminiTurns([
          turn(
            "r_1",
            prompt("Weather?"),
            reply([
              candidate("rc_1", "http://googleusercontent.com/card_content/0", {
                22: ["Sunny, 24 °C."],
              }),
            ]),
          ),
        ]),
      ),
    ).toEqual([["Weather?"], ["Sunny, 24 °C."]]);
  });

  it("puts a Canvas document where the reply shows it", () => {
    const canvas = fillTo(11, {
      0: `${RPC_CONVERSATION_ID}_canvas`,
      1: "doc_1",
      2: "Hello script",
      4: '```python\nprint("hi")\n```',
      9: "hello.py",
      10: 2,
    });

    expect(
      texts(
        convertGeminiTurns([
          turn(
            "r_1",
            prompt("Write hello world in Python"),
            reply([
              candidate(
                "rc_1",
                "I've made a script.\n\nhttp://googleusercontent.com/immersive_entry_chip/0\n\nWant changes?",
                { 30: [canvas] },
              ),
            ]),
          ),
        ]),
      ),
    ).toEqual([
      ["Write hello world in Python"],
      [
        'I\'ve made a script.\n\n**Hello script**\n\n```python\nprint("hi")\n```\n\nWant changes?',
      ],
    ]);
  });

  it("exports a Deep Research report without its citation markers", () => {
    const report = fillTo(11, {
      0: "im_report",
      2: "Tide pool research plan",
      3: "task_1",
      4: "# Tide pools\n\n[cite_start]They host anemones [cite: 3].\n",
    });
    const youtubeCard = fillTo(11, {
      0: `${RPC_CONVERSATION_ID}_video`,
      9: "youtube_74304ce3",
      10: 13,
    });

    expect(
      texts(
        convertGeminiTurns([
          turn(
            "r_1",
            prompt("Research tide pools"),
            reply([
              candidate("rc_1", "I've completed your research.", {
                30: [youtubeCard, report],
              }),
            ]),
          ),
        ]),
      ),
    ).toEqual([
      ["Research tide pools"],
      ["I've completed your research.\n\n# Tide pools\n\nThey host anemones."],
    ]);
  });

  it("lists uploaded files and makes uploaded images image parts", () => {
    const messages = convertGeminiTurns([
      turn(
        "r_1",
        prompt("What's in these?", [
          imageFile(
            "cat.jpg",
            "https://lh3.googleusercontent.com/gg/cat",
            "image/jpeg",
          ),
          otherFile("notes.pdf", "application/pdf"),
          imageFile(
            "evil.png",
            "https://images.example.com/evil.png",
            "image/png",
          ),
        ]),
        reply([candidate("rc_1", "A cat and your notes.")]),
      ),
    ]);

    expect(texts(messages)).toEqual([
      [
        "<image https://lh3.googleusercontent.com/gg/cat cat.jpg>",
        "[Attachment: notes.pdf]",
        "<image null evil.png>",
        "What's in these?",
      ],
      ["A cat and your notes."],
    ]);
  });

  it("reads the second copy of the attachment list if the first is missing", () => {
    const userPrompt = prompt("Read this");
    (userPrompt[0] as unknown[])[4] = [[], [otherFile("data.csv", "text/csv")]];

    expect(texts(convertGeminiTurns([turn("r_1", userPrompt, null)]))).toEqual([
      ["[Attachment: data.csv]", "Read this"],
    ]);
  });

  it("adds generated images after the text, one format of each", () => {
    const pngA = imageFile(
      "a.png",
      "https://lh3.googleusercontent.com/gg/a-png",
      "image/png",
    );
    const jpegA = imageFile(
      "a.jpg",
      "https://lh3.googleusercontent.com/gg/a-jpg",
      "image/jpeg",
    );
    const jpegB = imageFile(
      "b.jpg",
      "https://lh3.googleusercontent.com/gg/b",
      "image/jpeg",
    );

    expect(
      texts(
        convertGeminiTurns([
          turn(
            "r_1",
            prompt("Draw two sea stars"),
            reply([
              candidate(
                "rc_1",
                "Here they are.\nhttp://googleusercontent.com/image_generation_content/0\nhttp://googleusercontent.com/image_generation_content/1",
                { 12: generatedImages([jpegA, pngA], [jpegB]) },
              ),
            ]),
          ),
        ]),
      ),
    ).toEqual([
      ["Draw two sea stars"],
      [
        "Here they are.",
        "<image https://lh3.googleusercontent.com/gg/a-png a.png>",
        "<image https://lh3.googleusercontent.com/gg/b b.jpg>",
      ],
    ]);
  });

  it("finds generated images kept in the sparse field bundle", () => {
    const image = imageFile(
      "star.png",
      "https://lh3.googleusercontent.com/gg/star",
      "image/png",
    );
    const rich = [null, { "8": [[[fillTo(4, { 3: image })]]] }];

    expect(
      texts(
        convertGeminiTurns([
          turn(
            "r_1",
            prompt("Draw a star"),
            reply([candidate("rc_1", "", { 12: rich })]),
          ),
        ]),
      ),
    ).toEqual([
      ["Draw a star"],
      ["<image https://lh3.googleusercontent.com/gg/star star.png>"],
    ]);
  });

  it("shows an image once, where it first appeared", () => {
    const upload = imageFile(
      "photo.jpg",
      "https://lh3.googleusercontent.com/gg/photo",
      "image/jpeg",
    );
    const edited = imageFile(
      "edit.png",
      "https://lh3.googleusercontent.com/gg/edit",
      "image/png",
    );

    const messages = convertGeminiTurns([
      turn(
        "r_2",
        prompt("Make it brighter", [upload]),
        reply([
          candidate("rc_2", "Brighter now.", {
            12: generatedImages([upload], [edited]),
          }),
        ]),
      ),
      turn(
        "r_1",
        prompt("Remove the background", [upload]),
        reply([candidate("rc_1", "Done.", { 12: generatedImages([edited]) })]),
      ),
    ]);

    expect(texts(messages)).toEqual([
      [
        "<image https://lh3.googleusercontent.com/gg/photo photo.jpg>",
        "Remove the background",
      ],
      ["Done.", "<image https://lh3.googleusercontent.com/gg/edit edit.png>"],
      ["Make it brighter"],
      ["Brighter now."],
    ]);
  });

  it("leaves thinking and web image results out", () => {
    const webImage = [
      [
        ["https://encrypted-tbn2.gstatic.com/licensed-image?q=tbn:abc"],
        null,
        2048,
        1558,
      ],
      [["https://www.example.com/source-page"], "", 8],
      null,
      null,
      null,
      null,
      null,
      [
        "http://googleusercontent.com/image_agent_tag_123",
        null,
        "A diagram",
        null,
        null,
        1,
      ],
    ];

    expect(
      texts(
        convertGeminiTurns([
          turn(
            "r_1",
            prompt("Explain"),
            reply([
              candidate("rc_1", "The explanation.", {
                12: [null, [webImage], null, null, null, null, null, []],
                37: [["**Thinking about it**\n\nLong internal monologue."]],
              }),
            ]),
          ),
        ]),
      ),
    ).toEqual([["Explain"], ["The explanation."]]);
  });

  it("skips anything that isn't a turn", () => {
    expect(
      convertGeminiTurns([
        null,
        "r_1",
        42,
        { turn: true },
        [],
        turn("r_1", prompt("Hi"), null),
      ]),
    ).toEqual([
      { id: "r_1", role: "user", parts: [{ kind: "text", text: "Hi" }] },
    ]);
  });
});
