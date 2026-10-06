import { describe, expect, it } from "vitest";
import {
  conversationModels,
  conversationSpan,
  isoTime,
  messageDetails,
  messageTime,
  propertyTime,
  spreadsheetTime,
} from "../src/message-details";

/* 3 October 2026, 14:05:09 - in whatever time zone the tests run in */
const TIME = new Date(2026, 9, 3, 14, 5, 9).getTime();

describe("message times", () => {
  it("are written in local time, the same way in every language", () => {
    expect(messageTime(TIME)).toBe("2026-10-03 14:05");
    expect(spreadsheetTime(TIME)).toBe("2026-10-03 14:05:09");
    expect(propertyTime(TIME)).toBe("2026-10-03T14:05");
  });

  it("are written in UTC for data", () => {
    expect(isoTime(Date.UTC(2026, 9, 3, 12, 5, 9))).toBe("2026-10-03T12:05:09.000Z");
  });
});

describe("messageDetails", () => {
  it("puts the time and the model on one line", () => {
    expect(messageDetails({ time: TIME, model: "gpt-4o" })).toBe(
      "2026-10-03 14:05 · gpt-4o",
    );
    expect(messageDetails({ time: TIME })).toBe("2026-10-03 14:05");
    expect(messageDetails({ model: "o3" })).toBe("o3");
  });

  it("is empty when there's nothing to say", () => {
    expect(messageDetails({})).toBe("");
  });
});

describe("the whole chat", () => {
  it("spans its first to its last message with a time", () => {
    expect(
      conversationSpan([{ time: TIME + 60_000 }, {}, { time: TIME }, { time: TIME + 5_000 }]),
    ).toEqual({ start: TIME, end: TIME + 60_000 });
    expect(conversationSpan([{}, {}])).toBeNull();
  });

  it("lists each model once, in the order they answered", () => {
    expect(
      conversationModels([{ model: "gpt-4o" }, {}, { model: "o3" }, { model: "gpt-4o" }]),
    ).toEqual(["gpt-4o", "o3"]);
  });
});
