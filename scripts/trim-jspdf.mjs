/*
 * Removes code from jsPDF that AI Exporter never runs and that
 * an extension store can't accept. vite.config.ts applies it to
 * jsPDF's module while bundling, so node_modules stays as npm
 * installed it.
 *
 *   - output("pdfobjectnewwindow") opens a window and adds a
 *     <script> loaded from cdnjs.cloudflare.com. That is remotely
 *     hosted code, which Manifest V3 forbids: the Chrome Web
 *     Store rejected AI Exporter for exactly this snippet
 *     (violation "Blue Argon"). AI Exporter only ever calls
 *     output("blob").
 *   - jsPDF.html() and addSvgAsImage() import html2canvas,
 *     DOMPurify and canvg (which brings core-js and its
 *     Function("return this")). AI Exporter uses neither method
 *     (svg-pdf.ts draws formulas itself), so the three would only
 *     add ~380 kB of dead code for a reviewer to read.
 *
 * If a jsPDF update changes any of that code so it can't be
 * found, trimJsPdf() throws and the build stops, rather than
 * quietly shipping it again. Look at what changed in jsPDF, then
 * adjust the patterns below.
 */

const PDFOBJECT_CASE = /case\s*["']pdfobjectnewwindow["']\s*:/;
const NEXT_CASE = /case\s*["']pdfjsnewwindow["']\s*:/;

const OPTIONAL_LIBRARY_IMPORTS = {
  html2canvas: /import\(\s*["']html2canvas["']\s*\)/g,
  dompurify: /import\(\s*["']dompurify["']\s*\)/g,
  canvg: /import\(\s*["']canvg["']\s*\)/g,
};

/*
 * What must not be left in jsPDF afterwards: the CDN address,
 * the script file name, and any import() of the three libraries.
 */
const LEFTOVERS = /cdnjs\.cloudflare\.com|pdfobject\.min\.js|import\(\s*["'](?:html2canvas|dompurify|canvg)["']/;

/*
 * jsPDF's browser module, minified or not. Vite resolves "jspdf"
 * to dist/jspdf.es.min.js.
 */
const JSPDF_MODULE = /[\\/]node_modules[\\/]jspdf[\\/]dist[\\/]jspdf\.es(?:\.min)?\.js$/;

export function trimJsPdf(code) {
  const start = code.search(PDFOBJECT_CASE);
  const end = code.search(NEXT_CASE);

  if (start === -1 || end <= start) {
    throw new Error(
      `jsPDF's output("pdfobjectnewwindow") code, which loads a script from cdnjs.cloudflare.com, wasn't found where scripts/trim-jspdf.mjs expects it.`,
    );
  }

  const label = code.slice(start).match(PDFOBJECT_CASE)[0];
  let trimmed =
    code.slice(0, start) +
    label +
    `throw new Error("AI Exporter leaves out jsPDF's pdfobjectnewwindow output.");` +
    code.slice(end);

  for (const [library, pattern] of Object.entries(OPTIONAL_LIBRARY_IMPORTS)) {
    const found = trimmed.match(pattern)?.length ?? 0;

    if (found !== 1) {
      throw new Error(
        `Expected jsPDF to import("${library}") once, found it ${found} times. Check scripts/trim-jspdf.mjs against the installed jsPDF.`,
      );
    }

    trimmed = trimmed.replace(
      pattern,
      `Promise.reject(new Error("AI Exporter leaves out ${library}."))`,
    );
  }

  if (LEFTOVERS.test(trimmed)) {
    throw new Error(
      "jsPDF still loads remote or optional code after scripts/trim-jspdf.mjs ran.",
    );
  }

  return trimmed;
}

/*
 * The Vite plugin. It also fails the build if jsPDF ever comes
 * from a file it doesn't recognise (a UMD build, say), since then
 * nothing would have been removed.
 */
export function trimJsPdfPlugin() {
  let trimmedModule = false;

  return {
    name: "ai-exporter:trim-jspdf",
    apply: "build",
    enforce: "pre",

    buildStart() {
      trimmedModule = false;
    },

    transform(code, id) {
      if (!JSPDF_MODULE.test(id.split("?")[0])) {
        return null;
      }

      try {
        const trimmed = trimJsPdf(code);

        trimmedModule = true;

        return { code: trimmed, map: null };
      } catch (error) {
        this.error(error instanceof Error ? error.message : String(error));
      }
    },

    buildEnd(error) {
      if (!error && !trimmedModule) {
        this.error(
          `jsPDF wasn't bundled from dist/jspdf.es.min.js, so scripts/trim-jspdf.mjs couldn't remove its cdnjs.cloudflare.com script. Check how Vite resolves "jspdf".`,
        );
      }
    },
  };
}
