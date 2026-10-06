/*
 * =========================================================
 * AI Exporter - text-shaping.ts
 * =========================================================
 *
 * Shapes text in the scripts a PDF viewer can't lay out from
 * plain characters - Devanagari, Bengali, Tamil, Thai and the
 * others script-fonts.ts lists as "shaped" - with HarfBuzz
 * (harfbuzzjs, MIT), the shaping engine browsers use themselves.
 * HarfBuzz picks each word's glyphs from the font - reordered
 * vowel signs, conjuncts, marks stacked above and below - and
 * where they go; pdf-export.ts draws them as outlines.
 *
 * harfbuzzjs is WebAssembly (dist/harfbuzz.wasm, which Vite emits
 * next to this chunk). pdf-export.ts loads this module with a
 * dynamic import() only when a conversation has text in one of
 * those scripts, so no other export loads it. Running WebAssembly
 * is what the manifests' 'wasm-unsafe-eval' allows - it can't run
 * text as JavaScript.
 */
import * as hb from "harfbuzzjs";
import { parsePath, type Segment } from "./svg-pdf.ts";

/* A glyph and where it goes, in font units */
export interface ShapedGlyph {
  id: number;
  advance: number;
  dx: number;
  dy: number;
}

export interface ShapedText {
  glyphs: ShapedGlyph[];
  /* The width of the whole text */
  advance: number;
}

export interface Shaper {
  /* Font units per em */
  unitsPerEm: number;
  shape(text: string): ShapedText;
  /* The glyph's outline, y pointing up as in the font */
  outline(glyphId: number): Segment[];
}

export function createShaper(bytes: Uint8Array): Shaper {
  const face = new hb.Face(new hb.Blob(bytes));
  const font = new hb.Font(face);
  const buffer = new hb.Buffer();
  const shapes = new Map<string, ShapedText>();
  const outlines = new Map<number, Segment[]>();

  return {
    unitsPerEm: face.upem,

    shape(text: string): ShapedText {
      const cached = shapes.get(text);

      if (cached) {
        return cached;
      }

      buffer.reset();
      buffer.addText(text);
      buffer.guessSegmentProperties();
      hb.shape(font, buffer);

      const positions = buffer.getGlyphPositions();
      const glyphs = buffer.getGlyphInfos().map((info, index) => ({
        id: info.codepoint,
        advance: positions[index]?.xAdvance ?? 0,
        dx: positions[index]?.xOffset ?? 0,
        dy: positions[index]?.yOffset ?? 0,
      }));
      const shaped = {
        glyphs,
        advance: glyphs.reduce((sum, glyph) => sum + glyph.advance, 0),
      };

      shapes.set(text, shaped);

      return shaped;
    },

    outline(glyphId: number): Segment[] {
      let segments = outlines.get(glyphId);

      if (!segments) {
        segments = parsePath(font.glyphToPath(glyphId));
        outlines.set(glyphId, segments);
      }

      return segments;
    },
  };
}
