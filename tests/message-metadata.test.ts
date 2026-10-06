import { describe, expect, it } from "vitest";
import {
  messageMetadata,
  modelName,
  timeFromIso,
  timeFromSeconds,
  timeFromSecondsAndNanos,
} from "../src/message-metadata";
import { chatGptModel } from "../src/chatgpt-reply";

describe("timeFromSeconds", () => {
  it("turns Unix seconds into milliseconds", () => {
    expect(timeFromSeconds(1759400000)).toBe(1759400000000);
    expect(timeFromSeconds(1759400000.1234)).toBe(1759400000123);
    expect(timeFromSeconds("1759400000.5")).toBe(1759400000500);
  });

  it("keeps a value that's milliseconds already", () => {
    expect(timeFromSeconds(1759400000123)).toBe(1759400000123);
  });

  it("leaves out what can't be a message's time", () => {
    for (const value of [0, -5, 12, NaN, Infinity, null, undefined, "", "soon", {}]) {
      expect(timeFromSeconds(value)).toBeUndefined();
    }
  });
});

describe("timeFromIso", () => {
  it("reads an ISO date and time with its time zone", () => {
    expect(timeFromIso("2026-10-01T10:00:05.000Z")).toBe(
      Date.UTC(2026, 9, 1, 10, 0, 5),
    );
    expect(timeFromIso("2026-10-01T12:00:05+02:00")).toBe(
      Date.UTC(2026, 9, 1, 10, 0, 5),
    );
  });

  it("reads one without a time zone as UTC, as the servers write it", () => {
    expect(timeFromIso("2026-10-01T10:00:05.071071")).toBe(
      Date.UTC(2026, 9, 1, 10, 0, 5, 71),
    );
    expect(timeFromIso("2026-10-01 10:00")).toBe(Date.UTC(2026, 9, 1, 10, 0));
  });

  it("leaves out anything else", () => {
    for (const value of ["", "yesterday", "10:00", "1759400000", 1759400000, null]) {
      expect(timeFromIso(value)).toBeUndefined();
    }
  });
});

describe("timeFromSecondsAndNanos", () => {
  it("reads Gemini's [seconds, nanoseconds]", () => {
    expect(timeFromSecondsAndNanos([1790000000, 500000000])).toBe(1790000000500);
    expect(timeFromSecondsAndNanos([1790000000])).toBe(1790000000000);
  });

  it("leaves out another shape", () => {
    expect(timeFromSecondsAndNanos(null)).toBeUndefined();
    expect(timeFromSecondsAndNanos(["1790000000", 0])).toBeUndefined();
    expect(timeFromSecondsAndNanos(1790000000)).toBeUndefined();
  });
});

describe("modelName", () => {
  it("keeps a model's name as the site writes it", () => {
    expect(modelName("gpt-4o")).toBe("gpt-4o");
    expect(modelName("  o3  ")).toBe("o3");
    expect(modelName("Gemini 2.5 Flash")).toBe("Gemini 2.5 Flash");
  });

  it("drops names that could bring markup into a file, and placeholders", () => {
    for (const value of ["", "**bold**", "<b>x</b>", "a\nb", "auto", "Default", 4, null]) {
      expect(modelName(value)).toBeUndefined();
    }

    expect(modelName("x".repeat(81))).toBeUndefined();
  });
});

describe("messageMetadata", () => {
  it("leaves out what the site didn't say", () => {
    expect(messageMetadata(undefined)).toEqual({});
    expect(messageMetadata(5000, undefined)).toEqual({ time: 5000 });
    expect(messageMetadata(undefined, "o3")).toEqual({ model: "o3" });
  });
});

describe("chatGptModel", () => {
  it("names the model ChatGPT's router settled on, or else the one asked for", () => {
    expect(
      chatGptModel({ model_slug: "gpt-5", resolved_model_slug: "gpt-5-thinking" }),
    ).toBe("gpt-5-thinking");
    expect(chatGptModel({ model_slug: "gpt-4o", default_model_slug: "auto" })).toBe(
      "gpt-4o",
    );
    expect(chatGptModel({ default_model_slug: "auto" })).toBeUndefined();
    expect(chatGptModel(undefined)).toBeUndefined();
  });
});
