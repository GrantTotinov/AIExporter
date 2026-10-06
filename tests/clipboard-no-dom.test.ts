import { describe, expect, it } from "vitest";
import { buildClipboardHtml } from "../src/html-export";
import { DEFAULT_SETTINGS } from "../src/settings";

/*
 * No jsdom here: Chrome builds the chat the copy shortcut copies in
 * its background service worker, which has no DOM to decode HTML
 * entities with (see markdown-parse.ts).
 */
describe("the copied chat without a DOM", () => {
  it("is built all the same, its entities decoded", () => {
    expect(typeof document).toBe("undefined");

    const html = buildClipboardHtml(
      [
        {
          id: "1",
          role: "assistant",
          order: 0,
          content: "Tom &amp; Jerry &mdash; &#65;&#x42; &unknown; &#0; 1 &lt; 2",
        },
      ],
      DEFAULT_SETTINGS,
      "https://chatgpt.com/c/1",
    );

    expect(html).toBe(
      "<h2>Assistant</h2>\n<p dir=\"auto\">Tom &amp; Jerry — AB &amp;unknown; � 1 &lt; 2</p>",
    );
  });
});
