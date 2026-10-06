import { describe, expect, it } from "vitest";
import {
  buildClaudeConversationPath,
  convertClaudeMessages,
  getClaudeChatOrganizationIds,
  getClaudeConversationId,
  getClaudeOrganizationIdFromCookie,
  resolveClaudeActiveBranch,
  type ClaudeChatMessage,
  type ClaudeContentBlock,
  type ClaudeExportMessage,
} from "../src/claude-conversation";
import { bracketNotes } from "../src/source-notes";

/*
 * Fixtures follow the shape claude.ai's own
 * /api/organizations/{org}/chat_conversations/{id}
 * ?tree=True&rendering_mode=messages&render_all_tools=true
 * response uses - trimmed to the fields the export reads.
 */

const ORG_ID = "4f0e1c2d-3b4a-4c5d-8e6f-7a8b9c0d1e2f";
const CONVERSATION_ID = "0b2f7a52-1c3d-4e5f-8a9b-0c1d2e3f4a5b";
const ROOT_PARENT = "00000000-0000-4000-8000-000000000000";

function text(value: string): ClaudeContentBlock {
  return { type: "text", text: value };
}

function artifact(input: Record<string, unknown>): ClaudeContentBlock {
  return { type: "tool_use", name: "artifacts", input };
}

const ARTIFACT_RESULT: ClaudeContentBlock = {
  type: "tool_result",
  name: "artifacts",
};

let nextId = 0;

function message(
  sender: string,
  content: ClaudeContentBlock[],
  extra: Partial<ClaudeChatMessage> = {},
): ClaudeChatMessage {
  nextId++;

  return {
    uuid: `00000000-0000-4000-8000-${String(nextId).padStart(12, "0")}`,
    sender,
    content,
    ...extra,
  };
}

function texts(messages: ClaudeExportMessage[]): string[][] {
  return messages.map((exported) =>
    exported.parts.map((part) =>
      part.kind === "text" ? part.text : `<image ${part.image.url}>`,
    ),
  );
}

describe("getClaudeConversationId", () => {
  it("reads the conversation UUID from a /chat/ URL path", () => {
    expect(getClaudeConversationId(`/chat/${CONVERSATION_ID}`)).toBe(
      CONVERSATION_ID,
    );
    expect(getClaudeConversationId(`/chat/${CONVERSATION_ID}/`)).toBe(
      CONVERSATION_ID,
    );
  });

  it("returns null on pages that aren't a conversation", () => {
    expect(getClaudeConversationId("/new")).toBeNull();
    expect(getClaudeConversationId("/recents")).toBeNull();
    expect(getClaudeConversationId(`/project/${CONVERSATION_ID}`)).toBeNull();
    expect(getClaudeConversationId("/chat/not-a-uuid")).toBeNull();
    expect(
      getClaudeConversationId(`/chat/${CONVERSATION_ID.replace(/-/g, "")}----`),
    ).toBeNull();
  });
});

describe("getClaudeOrganizationIdFromCookie", () => {
  it("finds lastActiveOrg among the page's cookies", () => {
    expect(
      getClaudeOrganizationIdFromCookie(
        `anthropic-device-id=abc; lastActiveOrg=${ORG_ID}; theme=dark`,
      ),
    ).toBe(ORG_ID);
    expect(getClaudeOrganizationIdFromCookie(`lastActiveOrg=${ORG_ID}`)).toBe(
      ORG_ID,
    );
  });

  it("ignores a missing or malformed value", () => {
    expect(getClaudeOrganizationIdFromCookie("")).toBeNull();
    expect(getClaudeOrganizationIdFromCookie("theme=dark")).toBeNull();
    expect(
      getClaudeOrganizationIdFromCookie("lastActiveOrg=../../api/evil"),
    ).toBeNull();
    expect(
      getClaudeOrganizationIdFromCookie(`notlastActiveOrg=${ORG_ID}`),
    ).toBeNull();
  });
});

describe("getClaudeChatOrganizationIds", () => {
  it("keeps organizations with the chat capability, in order", () => {
    const chatOrg = "11111111-1111-4111-8111-111111111111";
    const apiOnlyOrg = "22222222-2222-4222-8222-222222222222";
    const teamOrg = "33333333-3333-4333-8333-333333333333";

    expect(
      getClaudeChatOrganizationIds([
        { uuid: chatOrg, capabilities: ["chat", "claude_pro"] },
        { uuid: apiOnlyOrg, capabilities: ["api"] },
        { uuid: teamOrg, capabilities: ["chat", "raven"] },
      ]),
    ).toEqual([chatOrg, teamOrg]);
  });

  it("keeps an organization whose capabilities aren't listed", () => {
    expect(getClaudeChatOrganizationIds([{ uuid: ORG_ID }])).toEqual([ORG_ID]);
  });

  it("drops malformed entries and non-array responses", () => {
    expect(
      getClaudeChatOrganizationIds([
        null,
        "x",
        { uuid: "not-a-uuid", capabilities: ["chat"] },
      ]),
    ).toEqual([]);
    expect(getClaudeChatOrganizationIds({ error: "unauthorized" })).toEqual(
      [],
    );
  });
});

describe("buildClaudeConversationPath", () => {
  it("asks for every branch, as typed content blocks, with tool calls", () => {
    expect(buildClaudeConversationPath(ORG_ID, CONVERSATION_ID)).toBe(
      `/api/organizations/${ORG_ID}/chat_conversations/${CONVERSATION_ID}` +
        "?tree=True&rendering_mode=messages&render_all_tools=true",
    );
  });
});

describe("resolveClaudeActiveBranch", () => {
  /*
   *  q1 - a1 - q2 (original prompt) - a2
   *          \
   *            q2' (edited prompt) - a2' (first reply)
   *                                \
   *                                  a2'' (retried reply)
   */
  const q1 = message("human", [text("q1")], {
    index: 0,
    parent_message_uuid: ROOT_PARENT,
    created_at: "2026-09-01T10:00:00Z",
  });
  const a1 = message("assistant", [text("a1")], {
    index: 1,
    parent_message_uuid: q1.uuid,
    created_at: "2026-09-01T10:00:10Z",
  });
  const q2 = message("human", [text("q2 original")], {
    index: 2,
    parent_message_uuid: a1.uuid,
    created_at: "2026-09-01T10:01:00Z",
  });
  const a2 = message("assistant", [text("a2")], {
    index: 3,
    parent_message_uuid: q2.uuid,
    created_at: "2026-09-01T10:01:10Z",
  });
  const q2Edited = message("human", [text("q2 edited")], {
    index: 2,
    parent_message_uuid: a1.uuid,
    created_at: "2026-09-01T10:05:00Z",
  });
  const a2First = message("assistant", [text("a2 first try")], {
    index: 3,
    parent_message_uuid: q2Edited.uuid,
    created_at: "2026-09-01T10:05:10Z",
  });
  const a2Retry = message("assistant", [text("a2 retried")], {
    index: 3,
    parent_message_uuid: q2Edited.uuid,
    created_at: "2026-09-01T10:07:10Z",
  });
  const allMessages = [q1, a1, q2, a2, q2Edited, a2First, a2Retry];

  function branchTexts(messages: ClaudeChatMessage[]): string[] {
    return messages.map((entry) => entry.content?.[0]?.text ?? "");
  }

  it("follows parent pointers up from current_leaf_message_uuid", () => {
    expect(
      branchTexts(
        resolveClaudeActiveBranch({
          current_leaf_message_uuid: a2First.uuid,
          chat_messages: allMessages,
        }),
      ),
    ).toEqual(["q1", "a1", "q2 edited", "a2 first try"]);
  });

  it("picks the original branch when that's the one on screen", () => {
    expect(
      branchTexts(
        resolveClaudeActiveBranch({
          current_leaf_message_uuid: a2.uuid,
          chat_messages: [...allMessages].reverse(),
        }),
      ),
    ).toEqual(["q1", "a1", "q2 original", "a2"]);
  });

  it("falls back to the newest message when the current leaf is missing or unknown", () => {
    for (const current_leaf_message_uuid of [
      undefined,
      null,
      "99999999-9999-4999-8999-999999999999",
    ]) {
      expect(
        branchTexts(
          resolveClaudeActiveBranch({
            current_leaf_message_uuid,
            chat_messages: allMessages,
          }),
        ),
      ).toEqual(["q1", "a1", "q2 edited", "a2 retried"]);
    }
  });

  it("orders by index when there are no parent pointers at all", () => {
    const linear = [
      message("assistant", [text("second")], { index: 1 }),
      message("human", [text("first")], { index: 0 }),
      message("human", [text("third")], { index: 2 }),
    ];

    expect(branchTexts(resolveClaudeActiveBranch({ chat_messages: linear })))
      .toEqual(["first", "second", "third"]);
  });

  it("stops on a parent-pointer cycle instead of looping forever", () => {
    const first = message("human", [text("first")]);
    const second = message("assistant", [text("second")], {
      parent_message_uuid: first.uuid,
    });
    first.parent_message_uuid = second.uuid;

    expect(
      branchTexts(
        resolveClaudeActiveBranch({
          current_leaf_message_uuid: second.uuid,
          chat_messages: [first, second],
        }),
      ),
    ).toEqual(["first", "second"]);
  });

  it("returns nothing for an empty or missing message list", () => {
    expect(resolveClaudeActiveBranch({ chat_messages: [] })).toEqual([]);
    expect(resolveClaudeActiveBranch({})).toEqual([]);
  });
});

describe("convertClaudeMessages", () => {
  it("maps senders to roles and keeps message ids", () => {
    const question = message("human", [text("Hello")]);
    const answer = message("assistant", [text("Hi! How can I help?")]);

    expect(convertClaudeMessages([question, answer])).toEqual([
      { id: question.uuid, role: "user", parts: [{ kind: "text", text: "Hello" }] },
      {
        id: answer.uuid,
        role: "assistant",
        parts: [{ kind: "text", text: "Hi! How can I help?" }],
      },
    ]);
  });

  it("keeps when each message was sent", () => {
    const question = message("human", [text("Hello")], {
      created_at: "2026-09-01T10:00:00.123456Z",
    });
    const answer = message("assistant", [text("Hi!")], { created_at: "not a date" });

    const [asked, answered] = convertClaudeMessages([question, answer]);

    expect(asked.time).toBe(Date.UTC(2026, 8, 1, 10, 0, 0, 123));
    expect(answered).not.toHaveProperty("time");
  });

  it("skips unknown senders, messages without an id, and empty messages", () => {
    expect(
      convertClaudeMessages([
        message("system", [text("hidden")]),
        { sender: "human", content: [text("no id")] },
        message("assistant", []),
        message("assistant", [text("   \n  ")]),
      ]),
    ).toEqual([]);
  });

  it("leaves tool calls and tool results out, and keeps the thinking apart", () => {
    const answer = message("assistant", [
      {
        type: "thinking",
        thinking: "The user wants the docs.",
      } as ClaudeContentBlock,
      text("Let me look that up."),
      {
        type: "tool_use",
        name: "web_search",
        input: { query: "vitest environment options" },
      },
      { type: "tool_result", name: "web_search" },
      text("Here's what I found."),
    ]);
    const [exported] = convertClaudeMessages([answer]);

    expect(texts([exported])).toEqual([
      ["Let me look that up.", "Here's what I found."],
    ]);
    expect(exported.thinking).toBe("The user wants the docs.");
    expect(exported.sources).toBeUndefined();
  });

  it("turns web search citations into notes, titled from the search results", () => {
    const answer = message("assistant", [
      {
        type: "tool_result",
        name: "web_search",
        content: [
          {
            type: "knowledge",
            title: "Vitest docs",
            url: "https://vitest.dev/config/",
            metadata: { site_domain: "vitest.dev" },
          },
          { type: "knowledge", title: "Unused result", url: "https://other.example/" },
        ],
      },
      text("According to "),
      {
        type: "text",
        text: "the docs, jsdom is opt-in. ",
        citations: [
          {
            uuid: "c1",
            start_index: 0,
            end_index: 25,
            details: { type: "web_search_citation", url: "https://vitest.dev/config/" },
          },
        ],
      },
      text("Done."),
    ]);
    const [exported] = convertClaudeMessages([answer]);
    const [content] = texts([exported])[0];

    expect(bracketNotes(content, exported.sources ?? [])).toBe(
      "According to the docs, jsdom is opt-in[1]. Done.",
    );
    expect(exported.sources).toEqual([
      { title: "Vitest docs", url: "https://vitest.dev/config/" },
    ]);
  });

  it("reads the API's citation shape too, a note at the end of each block", () => {
    const answer = message("assistant", [
      {
        type: "web_search_tool_result",
        content: [{ type: "web_search_result", title: "Rome", url: "https://rome.example/" }],
      },
      {
        type: "text",
        text: "Rome is old.\n",
        citations: [
          { type: "web_search_result_location", url: "https://rome.example/", title: "" },
          { type: "web_search_result_location", url: "https://more.example/", title: "More" },
        ],
      },
    ]);
    const [exported] = convertClaudeMessages([answer]);

    expect(bracketNotes(texts([exported])[0][0], exported.sources ?? [])).toBe(
      "Rome is old.[1][2]",
    );
    expect(exported.sources).toEqual([
      { title: "Rome", url: "https://rome.example/" },
      { title: "More", url: "https://more.example/" },
    ]);
  });

  it("joins consecutive text blocks (split around citations) as one passage", () => {
    const answer = message("assistant", [
      text("According to "),
      text("the release notes"),
      text(", the flag is on by default.\n\nSecond paragraph."),
    ]);

    expect(texts(convertClaudeMessages([answer]))).toEqual([
      [
        "According to the release notes, the flag is on by default.\n\nSecond paragraph.",
      ],
    ]);
  });

  it("keeps the text of voice notes", () => {
    const note = message("human", [
      { type: "voice_note", text: "Remind me what we decided." },
    ]);

    expect(texts(convertClaudeMessages([note]))).toEqual([
      ["Remind me what we decided."],
    ]);
  });

  it("puts uploaded images and attachments before the message text", () => {
    const question = message("human", [text("What's in these?")], {
      files_v2: [
        {
          file_kind: "image",
          file_uuid: "f1",
          file_name: "photo.png",
          preview_url: `/api/${ORG_ID}/files/f1/preview`,
          thumbnail_url: `/api/${ORG_ID}/files/f1/thumbnail`,
        },
        { file_kind: "document", file_uuid: "f2", file_name: "report.pdf" },
      ],
      attachments: [
        { file_name: "notes.txt" },
        { file_name: "" },
      ],
    });

    expect(convertClaudeMessages([question])[0].parts).toEqual([
      {
        kind: "image",
        image: {
          url: `/api/${ORG_ID}/files/f1/preview`,
          fileName: "photo.png",
        },
      },
      { kind: "text", text: "[Attachment: report.pdf]" },
      { kind: "text", text: "[Attachment: notes.txt]" },
      { kind: "text", text: "[Attachment: pasted text]" },
      { kind: "text", text: "What's in these?" },
    ]);
  });

  it("reads files from files_v2, falling back to files, never both", () => {
    const image = {
      file_kind: "image",
      file_uuid: "f1",
      file_name: "a.png",
      preview_url: "/api/x/files/f1/preview",
    };

    expect(
      convertClaudeMessages([
        message("human", [], { files_v2: [image], files: [image] }),
      ])[0].parts,
    ).toHaveLength(1);
    expect(
      convertClaudeMessages([message("human", [], { files_v2: [], files: [image] })])[0]
        .parts,
    ).toHaveLength(1);
  });

  it("uses the best image URL available, or null when there is none", () => {
    const [onlyAsset, none] = convertClaudeMessages([
      message("human", [], {
        files: [
          {
            file_kind: "image",
            file_name: "a.webp",
            thumbnail_asset: { url: "/api/x/files/f1/thumbnail" },
          },
        ],
      }),
      message("human", [], { files: [{ file_kind: "image" }] }),
    ]);

    expect(onlyAsset.parts).toEqual([
      {
        kind: "image",
        image: { url: "/api/x/files/f1/thumbnail", fileName: "a.webp" },
      },
    ]);
    expect(none.parts).toEqual([
      { kind: "image", image: { url: null, fileName: "file" } },
    ]);
  });

  describe("artifacts", () => {
    const create = artifact({
      id: "fibonacci",
      command: "create",
      type: "application/vnd.ant.code",
      language: "python",
      title: "Fibonacci",
      content: "def fib(n):\n    return n\n",
    });

    it("exports a created artifact as a titled code block, in place", () => {
      const answer = message("assistant", [
        text("Here's a function:"),
        create,
        ARTIFACT_RESULT,
        text("Let me know if you need more."),
      ]);

      expect(texts(convertClaudeMessages([answer]))).toEqual([
        [
          "Here's a function:",
          "**Artifact: Fibonacci**\n\n```python\ndef fib(n):\n    return n\n```",
          "Let me know if you need more.",
        ],
      ]);
    });

    it("replays later edits, so each reply shows the version it produced", () => {
      const first = message("assistant", [create]);
      const question = message("human", [text("Make it recursive")]);
      const second = message("assistant", [
        artifact({
          id: "fibonacci",
          command: "update",
          old_str: "return n",
          new_str: "return n if n < 2 else fib(n - 1) + fib(n - 2)",
        }),
        text("Done."),
      ]);

      const [firstExport, , secondExport] = convertClaudeMessages([
        first,
        question,
        second,
      ]);

      expect(firstExport.parts[0]).toEqual({
        kind: "text",
        text: "**Artifact: Fibonacci**\n\n```python\ndef fib(n):\n    return n\n```",
      });
      expect(secondExport.parts).toEqual([
        {
          kind: "text",
          text:
            "**Artifact: Fibonacci**\n\n```python\ndef fib(n):\n" +
            "    return n if n < 2 else fib(n - 1) + fib(n - 2)\n```",
        },
        { kind: "text", text: "Done." },
      ]);
    });

    it("applies new_str literally, even with $-patterns in it", () => {
      const [, edited] = convertClaudeMessages([
        message("assistant", [create]),
        message("assistant", [
          artifact({
            id: "fibonacci",
            command: "update",
            old_str: "return n",
            new_str: "return '$&' + '$1'",
          }),
        ]),
      ]);

      expect(edited.parts[0]).toEqual({
        kind: "text",
        text: "**Artifact: Fibonacci**\n\n```python\ndef fib(n):\n    return '$&' + '$1'\n```",
      });
    });

    it("shows several edits in one reply once, as the final version", () => {
      const [, edited] = convertClaudeMessages([
        message("assistant", [create]),
        message("assistant", [
          text("Two changes:"),
          artifact({
            id: "fibonacci",
            command: "update",
            old_str: "fib(n)",
            new_str: "fib(n: int)",
          }),
          ARTIFACT_RESULT,
          text("and"),
          artifact({
            id: "fibonacci",
            command: "update",
            old_str: "return n",
            new_str: "return n  # base case",
          }),
          ARTIFACT_RESULT,
        ]),
      ]);

      expect(texts([edited])).toEqual([
        [
          "Two changes:",
          "**Artifact: Fibonacci**\n\n```python\ndef fib(n: int):\n    return n  # base case\n```",
          "and",
        ],
      ]);
    });

    it("keeps the content unchanged when an edit's old_str isn't found", () => {
      const [, edited] = convertClaudeMessages([
        message("assistant", [create]),
        message("assistant", [
          artifact({
            id: "fibonacci",
            command: "update",
            old_str: "not in the code",
            new_str: "anything",
          }),
        ]),
      ]);

      expect(edited.parts[0]).toEqual({
        kind: "text",
        text: "**Artifact: Fibonacci**\n\n```python\ndef fib(n):\n    return n\n```",
      });
    });

    it("ignores an edit to an artifact the branch never created", () => {
      expect(
        convertClaudeMessages([
          message("assistant", [
            artifact({
              id: "unknown",
              command: "update",
              old_str: "a",
              new_str: "b",
            }),
          ]),
        ]),
      ).toEqual([]);
    });

    it("rewrites replace the content and keep the earlier title and language", () => {
      const [, rewritten] = convertClaudeMessages([
        message("assistant", [create]),
        message("assistant", [
          artifact({
            id: "fibonacci",
            command: "rewrite",
            content: "def fib(n):\n    a, b = 0, 1\n    return a\n",
          }),
        ]),
      ]);

      expect(rewritten.parts[0]).toEqual({
        kind: "text",
        text: "**Artifact: Fibonacci**\n\n```python\ndef fib(n):\n    a, b = 0, 1\n    return a\n```",
      });
    });

    it("keeps a document artifact as Markdown instead of a code block", () => {
      const [doc] = convertClaudeMessages([
        message("assistant", [
          artifact({
            id: "essay",
            command: "create",
            type: "text/markdown",
            title: "Essay",
            content: "# On Exports\n\nAll **bold** claims.",
          }),
        ]),
      ]);

      expect(doc.parts[0]).toEqual({
        kind: "text",
        text: "**Artifact: Essay**\n\n# On Exports\n\nAll **bold** claims.",
      });
    });

    it("labels code by artifact type when no language is given", () => {
      const [page] = convertClaudeMessages([
        message("assistant", [
          artifact({
            id: "landing",
            command: "create",
            type: "text/html",
            title: "",
            content: "<h1>Hi</h1>",
          }),
        ]),
      ]);

      expect(page.parts[0]).toEqual({
        kind: "text",
        text: "**Artifact: landing**\n\n```html\n<h1>Hi</h1>\n```",
      });
    });

    it("uses a longer fence when the code itself contains a fence", () => {
      const [readme] = convertClaudeMessages([
        message("assistant", [
          artifact({
            id: "readme",
            command: "create",
            type: "application/vnd.ant.code",
            language: "markdown",
            title: "README",
            content: "Install:\n\n```bash\nnpm install\n```",
          }),
        ]),
      ]);

      expect(readme.parts[0]).toEqual({
        kind: "text",
        text: "**Artifact: README**\n\n````markdown\nInstall:\n\n```bash\nnpm install\n```\n````",
      });
    });

    it("skips an artifact with no content", () => {
      expect(
        convertClaudeMessages([
          message("assistant", [
            artifact({ id: "empty", command: "create", content: "" }),
          ]),
        ]),
      ).toEqual([]);
    });
  });

  describe("replies without content blocks", () => {
    it("falls back to the text field, dropping thinking and expanding artifacts", () => {
      const legacy = message("assistant", [], {
        content: undefined,
        text:
          "<antThinking>The user wants a script.</antThinking>Sure, here it is:\n\n" +
          '<antArtifact identifier="hello" type="application/vnd.ant.code" language="python" title="Hello">\n' +
          'print("hi")\n' +
          "</antArtifact>\n\nRun it with python.",
      });

      expect(texts(convertClaudeMessages([legacy]))).toEqual([
        [
          'Sure, here it is:\n\n**Artifact: Hello**\n\n```python\nprint("hi")\n```\n\nRun it with python.',
        ],
      ]);
    });

    it("doesn't fall back while content blocks exist, whatever text holds", () => {
      const toolOnly = message(
        "assistant",
        [{ type: "tool_use", name: "web_search", input: { query: "x" } }],
        {
          text: "```\nThis block is not supported on your current device yet.\n```",
        },
      );

      expect(convertClaudeMessages([toolOnly])).toEqual([]);
    });
  });
});
