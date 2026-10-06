// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { elementToMarkdown, plainText, readDomConversation } from "../src/dom-conversation";

function html(markup: string): HTMLElement {
  const element = document.createElement("div");

  element.innerHTML = markup;

  return element;
}

describe("elementToMarkdown", () => {
  it("writes headings, emphasis, links, lists and quotes", () => {
    const { markdown } = elementToMarkdown(
      html(`
        <h2>Plan</h2>
        <p>Use <strong>bold</strong>, <em>italic</em>, <del>old</del> and <code>x = 1</code>
           - see <a href="https://docs.example/a">the docs</a>.</p>
        <ul><li>One<ul><li>Nested</li></ul></li><li><p>Two</p></li></ul>
        <ol start="3"><li>Three</li><li>Four</li></ol>
        <blockquote><p>Quoted</p></blockquote>
        <hr>
        <p><a href="javascript:alert(1)">no link</a></p>
      `),
    );

    expect(markdown).toBe(
      [
        "## Plan",
        "Use **bold**, *italic*, ~~old~~ and `x = 1` - see [the docs](https://docs.example/a).",
        "- One\n  - Nested\n- Two",
        "3. Three\n4. Four",
        "> Quoted",
        "---",
        "no link",
      ].join("\n\n"),
    );
  });

  it("writes a code block with its language, from a class, an attribute or its label", () => {
    expect(
      elementToMarkdown(html('<pre><code class="language-ts">const a = 1;\n</code></pre>')).markdown,
    ).toBe("```ts\nconst a = 1;\n```");
    expect(
      elementToMarkdown(
        html(`
          <div data-language="elixir">
            <div><span>elixir</span><button>Copy</button></div>
            <pre><code>IO.puts("hi")</code></pre>
          </div>`),
      ).markdown,
    ).toBe('```elixir\nIO.puts("hi")\n```');
    // Le Chat's code block: label and buttons inside an outer <pre>
    expect(
      elementToMarkdown(
        html(
          '<pre><div><div><span>python</span><button>Copy</button></div><pre><code>print(1)</code></pre></div></pre>',
        ),
      ).markdown,
    ).toBe("```python\nprint(1)\n```");
    // A sentence before a code block is kept as text.
    expect(
      elementToMarkdown(html("<div><p>Here it is:</p><pre><code>ls</code></pre></div>")).markdown,
    ).toBe("Here it is:\n\n```\nls\n```");
  });

  it("writes tables: real ones, Le Chat's HTML in an attribute, and ARIA ones", () => {
    expect(
      elementToMarkdown(
        html("<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1|2</td><td><b>3</b></td></tr></tbody></table>"),
      ).markdown,
    ).toBe("| A | B |\n| --- | --- |\n| 1\\|2 | **3** |");

    const rich = document.createElement("div");

    rich.setAttribute("data-rich-table-inner-html", "<table><tr><th>X</th></tr><tr><td>9</td></tr></table>");
    rich.innerHTML = '<div role="table"><div role="columnheader">X</div><div role="cell">9</div></div>';

    expect(elementToMarkdown(rich).markdown).toBe("| X |\n| --- |\n| 9 |");
    expect(
      elementToMarkdown(
        html(
          '<div role="table"><div role="columnheader">K</div><div role="columnheader">V</div><div role="cell">a</div><div role="cell">1</div></div>',
        ),
      ).markdown,
    ).toBe("| K | V |\n| --- | --- |\n| a | 1 |");
  });

  it("writes formulas as their LaTeX", () => {
    const { markdown } = elementToMarkdown(
      html(`
        <p>Euler: <span class="katex"><span class="katex-mathml"><math><semantics><mrow></mrow>
          <annotation encoding="application/x-tex">e^{i\\pi}+1=0</annotation></semantics></math></span>
          <span class="katex-html" aria-hidden="true">e iπ</span></span></p>
        <span class="katex-display"><span class="katex"><span class="katex-mathml"><math><semantics>
          <annotation encoding="application/x-tex">\\int_0^1 x\\,dx</annotation></semantics></math></span></span></span>
      `),
    );

    expect(markdown).toBe("Euler: \\(e^{i\\pi}+1=0\\)\n\n\\[\\int_0^1 x\\,dx\\]");
  });

  it("marks pictures, leaves icons out and unwraps Meta's link redirects", () => {
    const { markdown, images } = elementToMarkdown(
      html(`
        <p><img src="https://cdn.example/chart.png" alt="Chart"> and
          <img src="https://cdn.example/favicon.ico" width="16" height="16">
          <a href="https://l.meta.ai/?u=https%3A%2F%2Fsite.example%2F&h=x">site</a></p>
      `),
    );

    expect(images).toEqual([{ url: "https://cdn.example/chart.png", alt: "Chart" }]);
    expect(markdown).toBe("0 and [site](https://site.example/)");
  });
});

describe("plainText", () => {
  it("keeps a question's line breaks", () => {
    expect(plainText(html("<span>First line</span><br><span>Second</span><div>Third</div>"))).toBe(
      "First line\nSecond\nThird",
    );
  });
});

describe("readDomConversation", () => {
  it("reads Le Chat's messages and only the answer of a reply", () => {
    document.body.innerHTML = `
      <div data-message-author-role="user" data-message-id="u1">
        <div class="select-none"><div class="select-text"><span>How do I cook rice?</span></div></div>
        <button>Edit</button>
      </div>
      <div data-message-author-role="assistant" data-message-id="a1">
        <div aria-label="Worked for 3s">Worked for 3s</div>
        <div data-message-part-type="reasoning"><p>Thinking...</p></div>
        <div data-message-part-type="answer"><p>Rinse it, then <strong>simmer</strong>.</p>
          <p><img src="https://img.example/rice.png" alt="Rice"></p></div>
      </div>`;

    expect(readDomConversation("mistral", document)).toEqual([
      { id: "u1", role: "user", parts: [{ kind: "text", text: "How do I cook rice?" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [
          { kind: "text", text: "Rinse it, then **simmer**." },
          { kind: "image", image: { url: "https://img.example/rice.png", fileName: "rice.png" } },
        ],
      },
    ]);
  });

  it("reads Meta AI's messages, without its citation pills", () => {
    document.body.innerHTML = `
      <div data-message-id="abc_1_user" data-message-type="user">
        <div data-slot="text" class="text-response">Tell me a fact</div>
      </div>
      <div data-message-id="abc_2_assistant" data-testid="assistant-message">
        <div data-testid="thinking-status">Thought for 2s</div>
        <div class="ur-markdown"><p>Honey never spoils.</p></div>
        <span data-testid="citation-pill">1</span>
      </div>`;

    expect(readDomConversation("meta", document)).toEqual([
      { id: "abc_1_user", role: "user", parts: [{ kind: "text", text: "Tell me a fact" }] },
      { id: "abc_2_assistant", role: "assistant", parts: [{ kind: "text", text: "Honey never spoils." }] },
    ]);
  });

  it("finds nothing on a page without messages", () => {
    document.body.innerHTML = "<main><h1>Welcome</h1></main>";

    expect(readDomConversation("mistral", document)).toEqual([]);
  });
});
