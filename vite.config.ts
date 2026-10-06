import { defineConfig } from "vite";
import { trimJsPdfPlugin } from "./scripts/trim-jspdf.mjs";

export default defineConfig({
  /*
   * Takes the cdnjs.cloudflare.com <script> (remotely hosted
   * code, which got AI Exporter rejected by the Chrome Web Store)
   * and the unused html2canvas/DOMPurify/canvg imports out of
   * jsPDF - see scripts/trim-jspdf.mjs.
   */
  plugins: [trimJsPdfPlugin()],
  build: {
    /*
     * MathJax (src/math-render.ts) is a ~1.8 MB chunk on purpose:
     * the popup only loads it, with a dynamic import(), when a PDF
     * export actually contains math.
     */
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: {
        content: "src/content.ts",
        pageBridge: "src/page-bridge.ts",
        popup: "src/popup.ts",
        background: "src/background.ts",
        offscreen: "src/offscreen.ts",
        options: "src/options.ts",
        bulk: "src/bulk.ts",
        archive: "src/archive.ts",
      },
      output: {
        entryFileNames: "[name].js",
      },
    },
  },
});
