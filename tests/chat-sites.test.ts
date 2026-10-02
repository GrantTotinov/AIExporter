import { describe, expect, it } from "vitest";
import { getChatSite, stripChatSiteSuffix } from "../src/chat-sites";

describe("getChatSite", () => {
  it("recognizes ChatGPT and Claude conversation URLs", () => {
    expect(
      getChatSite("https://chatgpt.com/c/0b2f7a52-1c3d-4e5f-8a9b-0c1d2e3f4a5b"),
    ).toBe("chatgpt");
    expect(
      getChatSite(
        "https://claude.ai/chat/0b2f7a52-1c3d-4e5f-8a9b-0c1d2e3f4a5b",
      ),
    ).toBe("claude");
  });

  it("recognizes the sites' other pages too (the content script decides what's exportable)", () => {
    expect(getChatSite("https://claude.ai/new")).toBe("claude");
    expect(getChatSite("https://chatgpt.com/")).toBe("chatgpt");
  });

  it("rejects other origins, including look-alikes and plain http", () => {
    expect(getChatSite("https://example.com/chat/123")).toBeNull();
    expect(getChatSite("https://claude.ai.example.com/chat/123")).toBeNull();
    expect(getChatSite("https://api.claude.ai/chat/123")).toBeNull();
    expect(getChatSite("http://claude.ai/chat/123")).toBeNull();
    expect(getChatSite("chrome://extensions")).toBeNull();
  });

  it("returns null for a missing or malformed URL", () => {
    expect(getChatSite(undefined)).toBeNull();
    expect(getChatSite("")).toBeNull();
    expect(getChatSite("not a url")).toBeNull();
  });
});

describe("stripChatSiteSuffix", () => {
  it("removes the site name the tab title ends with", () => {
    expect(stripChatSiteSuffix("Trip ideas - ChatGPT")).toBe("Trip ideas");
    expect(stripChatSiteSuffix("Trip ideas - Claude")).toBe("Trip ideas");
    expect(stripChatSiteSuffix("Trip ideas | Claude")).toBe("Trip ideas");
  });

  it("leaves a title without the suffix alone", () => {
    expect(stripChatSiteSuffix("Ask Claude about Rust")).toBe(
      "Ask Claude about Rust",
    );
    expect(stripChatSiteSuffix("  Claude  ")).toBe("Claude");
  });

  it("only removes the trailing site name", () => {
    expect(stripChatSiteSuffix("ChatGPT vs Claude - Claude")).toBe(
      "ChatGPT vs Claude",
    );
  });
});
