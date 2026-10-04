/* Types for scripts/trim-jspdf.mjs, used by vite.config.ts and the tests. */
import type { Plugin } from "vite";

export function trimJsPdf(code: string): string;

export function trimJsPdfPlugin(): Plugin;
