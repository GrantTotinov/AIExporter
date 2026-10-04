import { describe, expect, it } from "vitest";
import {
  CHAT_SITES,
  getChatSite,
  isChatConversationUrl,
  isChatSite,
  isInjectedSite,
  stripChatSiteSuffix,
} from "../src/chat-sites";
import { getClaudeConversationId } from "../src/claude-conversation";
import { getGeminiConversationId } from "../src/gemini-conversation";
import { getDeepSeekConversationId } from "../src/deepseek-conversation";
import { getGrokConversationId } from "../src/grok-conversation";
import { getPerplexityThreadSlug } from "../src/perplexity-conversation";

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

  it("recognizes DeepSeek, Grok and Perplexity", () => {
    expect(getChatSite("https://chat.deepseek.com/a/chat/s/abc123")).toBe(
      "deepseek",
    );
    expect(
      getChatSite("https://grok.com/c/0b2f7a52-1c3d-4e5f-8a9b-0c1d2e3f4a5b"),
    ).toBe("grok");
    expect(getChatSite("https://www.perplexity.ai/search/rice-abc")).toBe(
      "perplexity",
    );
    expect(getChatSite("https://perplexity.ai/search/rice-abc")).toBe(
      "perplexity",
    );
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
    expect(getChatSite("https://deepseek.com/")).toBeNull();
    expect(getChatSite("https://chat.deepseek.com.example.com/")).toBeNull();
    expect(getChatSite("http://chat.deepseek.com/a/chat/s/1")).toBeNull();
    expect(getChatSite("https://x.com/i/grok")).toBeNull();
    expect(getChatSite("https://grok.com.example.com/c/1")).toBeNull();
    expect(getChatSite("https://labs.perplexity.ai/")).toBeNull();
    expect(getChatSite("http://www.perplexity.ai/search/1")).toBeNull();
  });

  it("returns null for a missing or malformed URL", () => {
    expect(getChatSite(undefined)).toBeNull();
    expect(getChatSite("")).toBeNull();
    expect(getChatSite("not a url")).toBeNull();
  });
});

describe("isChatSite and isInjectedSite", () => {
  it("knows the six sites by their ids only", () => {
    for (const site of CHAT_SITES) {
      expect(isChatSite(site)).toBe(true);
    }

    expect(isChatSite("ChatGPT")).toBe(false);
    expect(isChatSite("bing")).toBe(false);
    expect(isChatSite("")).toBe(false);
    expect(isChatSite(null)).toBe(false);
    expect(isChatSite("toString")).toBe(false);
  });

  it("leaves the content script of DeepSeek, Grok and Perplexity to the popup", () => {
    expect(CHAT_SITES.filter(isInjectedSite)).toEqual([
      "deepseek",
      "grok",
      "perplexity",
    ]);
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

  it("removes DeepSeek's, Grok's and Perplexity's suffixes", () => {
    expect(stripChatSiteSuffix("Trip ideas - DeepSeek")).toBe("Trip ideas");
    expect(stripChatSiteSuffix("Trip ideas - Grok")).toBe("Trip ideas");
    expect(stripChatSiteSuffix("Trip ideas | Perplexity")).toBe("Trip ideas");
    expect(stripChatSiteSuffix("Trip ideas \u2014 Perplexity AI")).toBe(
      "Trip ideas",
    );
    expect(stripChatSiteSuffix("Grok vs DeepSeek \u00B7 Grok")).toBe(
      "Grok vs DeepSeek",
    );
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

  it.each([
    "/a/chat/s/7f3e2b1a-0c4d-4e5f-8a9b-1c2d3e4f5a6b",
    "/a/chat/s/abc_DEF-123/",
    "/a/chat/s/",
    "/a/chat/",
    "/a/chat/s/abc/def",
    "/a/chat/s/a.b",
    "/sign_in",
    "/",
  ])("agrees with the content script on chat.deepseek.com%s", (pathname) => {
    expect(isChatConversationUrl(`https://chat.deepseek.com${pathname}`)).toBe(
      getDeepSeekConversationId(pathname) !== null,
    );
  });

  it.each([
    `/c/${UUID}`,
    `/c/${UUID}/`,
    `/chat/${UUID}`,
    `/en/c/${UUID}`,
    `/zh-Hans/c/${UUID}`,
    `/c/${UUID}/files`,
    `/project/${UUID}`,
    "/c/not-a-uuid",
    "/c/------------------------------------",
    "/imagine",
    "/",
  ])("agrees with the content script on grok.com%s", (pathname) => {
    expect(isChatConversationUrl(`https://grok.com${pathname}`)).toBe(
      getGrokConversationId(pathname) !== null,
    );
  });

  it.each([
    "/search/how-to-cook-rice-4kT3x7mRQ2yC1x0Pz6Hn8Q",
    "/search/how-to-cook-rice-4kT3x7mRQ2yC1x0Pz6Hn8Q/",
    "/search/%E4%BD%A0%E5%A5%BD-abc",
    "/search/a/b",
    "/search/",
    "/search",
    "/discover",
    "/library",
    "/",
  ])("agrees with the content script on www.perplexity.ai%s", (pathname) => {
    expect(isChatConversationUrl(`https://www.perplexity.ai${pathname}`)).toBe(
      getPerplexityThreadSlug(pathname) !== null,
    );
  });

  it("rejects other sites and missing URLs", () => {
    expect(isChatConversationUrl(`https://example.com/c/${UUID}`)).toBe(false);
    expect(isChatConversationUrl(undefined)).toBe(false);
    expect(isChatConversationUrl("not a url")).toBe(false);
  });
});
