import { describe, expect, it } from "vitest";
import {
  getChatSite,
  isChatConversationUrl,
  stripChatSiteSuffix,
} from "../src/chat-sites";
import { getClaudeConversationId } from "../src/claude-conversation";
import { getGeminiConversationId } from "../src/gemini-conversation";

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

  it("recognizes Gemini conversation URLs", () => {
    expect(getChatSite("https://gemini.google.com/app/e87b6c6ac16404a5")).toBe(
      "gemini",
    );
    expect(
      getChatSite(
        "https://gemini.google.com/u/1/gem/coding-partner/e87b6c6ac16404a5",
      ),
    ).toBe("gemini");
  });

  it("recognizes the sites' other pages too (the content script decides what's exportable)", () => {
    expect(getChatSite("https://claude.ai/new")).toBe("claude");
    expect(getChatSite("https://chatgpt.com/")).toBe("chatgpt");
    expect(getChatSite("https://gemini.google.com/app")).toBe("gemini");
  });

  it("rejects other origins, including look-alikes and plain http", () => {
    expect(getChatSite("https://example.com/chat/123")).toBeNull();
    expect(getChatSite("https://claude.ai.example.com/chat/123")).toBeNull();
    expect(getChatSite("https://api.claude.ai/chat/123")).toBeNull();
    expect(getChatSite("http://claude.ai/chat/123")).toBeNull();
    expect(
      getChatSite("https://gemini.google.com.example.com/app/1"),
    ).toBeNull();
    expect(getChatSite("http://gemini.google.com/app/1")).toBeNull();
    expect(getChatSite("https://www.google.com/gemini")).toBeNull();
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
    expect(stripChatSiteSuffix("Gemini vs Claude - Google Gemini")).toBe(
      "Gemini vs Claude",
    );
  });

  it("removes Gemini's suffix and the invisible mark in front of its titles", () => {
    expect(stripChatSiteSuffix("Trip ideas - Google Gemini")).toBe(
      "Trip ideas",
    );
    expect(stripChatSiteSuffix("\u{200E}Trip ideas - Google Gemini")).toBe(
      "Trip ideas",
    );
    expect(stripChatSiteSuffix("Trip ideas - Gemini")).toBe("Trip ideas");
    expect(stripChatSiteSuffix("\u{200E}Google Gemini")).toBe("Google Gemini");
  });
});

describe("isChatConversationUrl", () => {
  const UUID = "0b2f7a52-1c3d-4e5f-8a9b-0c1d2e3f4a5b";

  it("recognizes ChatGPT conversations, in GPTs and projects too", () => {
    expect(isChatConversationUrl(`https://chatgpt.com/c/${UUID}`)).toBe(true);
    expect(
      isChatConversationUrl(
        `https://chatgpt.com/g/g-abc123-trip-helper/c/${UUID}`,
      ),
    ).toBe(true);
    expect(
      isChatConversationUrl(
        `https://chatgpt.com/g/g-p-6812ab/project/c/${UUID}?model=gpt-5`,
      ),
    ).toBe(true);
  });

  it("rejects ChatGPT pages that aren't a conversation", () => {
    expect(isChatConversationUrl("https://chatgpt.com/")).toBe(false);
    expect(isChatConversationUrl("https://chatgpt.com/gpts")).toBe(false);
    expect(isChatConversationUrl(`https://chatgpt.com/share/${UUID}`)).toBe(
      false,
    );
  });

  it.each([
    `/chat/${UUID}`,
    `/chat/${UUID}/`,
    "/chat/not-a-uuid",
    "/chat/------------------------------------",
    "/new",
    "/recents",
    `/project/${UUID}`,
    "/",
  ])("agrees with the content script on claude.ai%s", (pathname) => {
    expect(isChatConversationUrl(`https://claude.ai${pathname}`)).toBe(
      getClaudeConversationId(pathname) !== null,
    );
  });

  it.each([
    "/app/e87b6c6ac16404a5",
    "/app/e87b6c6ac16404a5/",
    "/u/1/app/e87b6c6ac16404a5",
    "/gem/coding-partner/e87b6c6ac16404a5",
    "/u/2/gem/coding-partner/e87b6c6ac16404a5",
    "/app",
    "/app/",
    "/gems/view",
    "/u/1/app",
    "/",
  ])("agrees with the content script on gemini.google.com%s", (pathname) => {
    expect(isChatConversationUrl(`https://gemini.google.com${pathname}`)).toBe(
      getGeminiConversationId(pathname) !== null,
    );
  });

  it("rejects other sites and missing URLs", () => {
    expect(isChatConversationUrl(`https://example.com/c/${UUID}`)).toBe(false);
    expect(isChatConversationUrl(undefined)).toBe(false);
    expect(isChatConversationUrl("not a url")).toBe(false);
  });
});
