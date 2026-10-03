import { defineConfig } from "vite";

export default defineConfig({
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
      },
      output: {
        entryFileNames: "[name].js",
      },
    },
  },
});
