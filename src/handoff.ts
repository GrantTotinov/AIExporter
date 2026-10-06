/*
 * =========================================================
 * AI Exporter - handoff.ts
 * =========================================================
 *
 * "Continue in another AI": the chat as one prompt to paste into
 * another assistant - ChatGPT to Claude, DeepSeek to Gemini... -
 * which picks it up where it left off. People hit a message limit,
 * want a second opinion, or move to a model that's better at the
 * task; retyping the context is what they'd otherwise do.
 *
 * The prompt says what it is, then gives the messages as plain
 * text with their names. Thinking is left out: the other assistant
 * needs what was said, not how it was reached. A chat too long
 * for one prompt keeps its first question - what it's about - and
 * as many of its latest messages as fit, saying what was left out.
 */
import type { Message } from "./export-builders.ts";
import { bracketNotes } from "./source-notes.ts";

export interface HandoffText {
  /* What the prompt opens with, before the conversation */
  intro: string;
  start: string;
  end: string;
  /* Where messages were left out, {{count}} of them */
  omitted: string;
  user: string;
  assistant: string;
}

/* Long enough for a long chat, short enough for any model's window */
export const MAX_HANDOFF_LENGTH = 60_000;

function block(message: Message, text: HandoffText): string {
  const name = message.role === "user" ? text.user : text.assistant;

  return `${name}:\n${bracketNotes(message.content, message.sources ?? []).trim()}`;
}

export function buildHandoffPrompt(
  messages: Message[],
  text: HandoffText,
  maxLength = MAX_HANDOFF_LENGTH,
): string {
  const blocks = messages
    .filter((message) => message.content.trim() !== "")
    .map((message) => block(message, text));
  const frame = (body: string[]) =>
    [text.intro, "", text.start, "", body.join("\n\n"), "", text.end].join("\n");

  if (frame(blocks).length <= maxLength || blocks.length <= 2) {
    return frame(blocks);
  }

  // The first message, then the latest ones that fit
  const kept: string[] = [];
  let length = frame([blocks[0], text.omitted.replace("{{count}}", "0000")]).length;

  for (let index = blocks.length - 1; index > 0; index--) {
    if (length + blocks[index].length + 2 > maxLength) {
      break;
    }

    kept.unshift(blocks[index]);
    length += blocks[index].length + 2;
  }

  const left = blocks.length - 1 - kept.length;

  return frame([
    blocks[0],
    ...(left > 0 ? [`[${text.omitted.replace("{{count}}", String(left))}]`] : []),
    ...kept,
  ]);
}
