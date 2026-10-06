import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkDist,
  findCodeProblems,
  findHtmlProblems,
  findManifestProblems,
} from "../scripts/check-store-rules.mjs";
import { trimJsPdf } from "../scripts/trim-jspdf.mjs";

function readText(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

/*
 * The code the Chrome Web Store quoted when it rejected
 * AI Exporter (violation "Blue Argon"), as it was in popup.js.
 */
const REJECTED_SNIPPET =
  "case `pdfobjectnewwindow`: if (Object.prototype.toString.call(X) === `[object Window]`) { var i = `https://cdnjs.cloudflare.com/ajax/libs/pdfobject/2.1.1/pdfobject.min.js`, a = !t.pdfObjectUrl; a || (i = t.pdfObjectUrl); var o = X.open(); if (o !== null) { var s = Ct(o), c = s.document.createElement(`script`), l = this; c.src = i, a && (c.integrity = `sha512-4ze/a9/4jqu+tX9dfOqJYSvyYd5M6qum/3HpCLr+/Jqf0whc37VUbkpNGHR7/8pSnCFw47T1fmIpwBV7UySh3g==`, c.crossOrigin = `anonymous`), c.onload = function() { o.PDFObject.embed(l.output(`dataurlstring`), t) }, s.body.appendChild(c) } return o }";

/* content.ts adding the extension's own pageBridge.js, minified. */
const PAGE_BRIDGE_INJECTION =
  "let e=document.createElement(`script`);e.src=chrome.runtime.getURL(`pageBridge.js`),e.dataset.aiExporter=`page-bridge`,(document.head||document.documentElement).appendChild(e)";

describe("trimJsPdf", () => {
  const minified = readText("../node_modules/jspdf/dist/jspdf.es.min.js");

  /*
   * jsPDF's credit comments also cite .js files on other sites;
   * minifying the bundle drops those, and `npm run build` checks
   * the real bundle. These tests look at what trimJsPdf() removes.
   */
  it("takes the cdnjs.cloudflare.com script and the optional libraries out of jsPDF", () => {
    const before = findCodeProblems(minified).join("\n");
    const trimmed = trimJsPdf(minified);
    const after = findCodeProblems(trimmed).join("\n");

    expect(before).toContain("cdnjs.cloudflare.com");
    expect(before).toContain("a <script> element that doesn't load a file of the extension");
    expect(after).not.toContain("cdnjs.cloudflare.com");
    expect(after).not.toContain("<script> element");
    expect(trimmed).not.toContain("pdfobject.min.js");
    expect(trimmed).not.toMatch(/import\(\s*["'](?:html2canvas|dompurify|canvg)["']/);
    expect(trimmed).toContain('case"pdfjsnewwindow"');
  });

  it("works on jsPDF's unminified module too", () => {
    const trimmed = trimJsPdf(readText("../node_modules/jspdf/dist/jspdf.es.js"));

    expect(trimmed).not.toContain("cdnjs.cloudflare.com");
    expect(trimmed).not.toMatch(/import\(\s*["'](?:html2canvas|dompurify|canvg)["']/);
    expect(trimmed).toContain('case "pdfjsnewwindow"');
  });

  it("stops the build when jsPDF's code has changed", () => {
    expect(() => trimJsPdf("export default {};")).toThrow(/pdfobjectnewwindow/);

    const twoImports = minified.replace(
      'import("canvg")',
      'import("canvg"),import("canvg")',
    );

    expect(() => trimJsPdf(twoImports)).toThrow(/import\("canvg"\) once, found it 2 times/);
  });
});

describe("findCodeProblems", () => {
  it("flags the code the Chrome Web Store rejected", () => {
    const problems = findCodeProblems(REJECTED_SNIPPET);

    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining("the address of a server that hosts code"),
        expect.stringContaining("a <script> element that doesn't load a file of the extension"),
      ]),
    );
  });

  it("accepts a <script> that loads a file of the extension", () => {
    expect(findCodeProblems(PAGE_BRIDGE_INJECTION)).toEqual([]);
  });

  it.each([
    ["eval", 'eval("1+1")'],
    ["Function", "var g=Function(`return this`)()"],
    ["new Function", 'new Function("a", "return a")'],
    ["importScripts", 'self.importScripts("x.js")'],
    ["remote import()", 'import("https://example.com/module.js")'],
    ["a timer with code as text", 'setTimeout("alert(1)", 10)'],
    ["an unencrypted request", 'fetch("http://example.com/data")'],
    ["a remote script address", 'const src = "https://example.com/lib.min.js?v=2";'],
    ["a code CDN", "const base = `https://cdn.jsdelivr.net/npm/${name}`;"],
  ])("flags %s", (_, code) => {
    expect(findCodeProblems(code)).not.toEqual([]);
  });

  it.each([
    ["names that only contain eval or Function", "retrieval(x);isFunction(y);obj.eval(z);"],
    ["Function without a call", "x instanceof Function;typeof Function"],
    ["JSON and XML namespace addresses", '"https://api.example.com/data.json";"http://www.w3.org/2000/svg"'],
    ["https requests", 'fetch("https://api.github.com/user")'],
    ["timers given a function", "setTimeout(() => run(), 10)"],
  ])("doesn't flag %s", (_, code) => {
    expect(findCodeProblems(code)).toEqual([]);
  });
});

describe("findHtmlProblems", () => {
  it("accepts a page that loads its script from the package", () => {
    expect(
      findHtmlProblems(
        '<!doctype html><html><head><script type="module" src="/popup.js"></script></head><body><a href="https://github.com/">GitHub</a></body></html>',
      ),
    ).toEqual([]);
  });

  it.each([
    ["an inline script", "<script>alert(1)</script>"],
    ["a remote script", '<script src="https://example.com/x.js"></script>'],
    ["a protocol-relative stylesheet", '<link rel="stylesheet" href="//example.com/x.css">'],
    ["an inline handler", '<button type="button" onclick="run()">Run</button>'],
    ["a javascript: URL", '<a href="javascript:run()">Run</a>'],
  ])("flags %s", (_, html) => {
    expect(findHtmlProblems(html)).not.toEqual([]);
  });
});

describe("findManifestProblems", () => {
  const everyFileExists = () => true;

  it("accepts the Chrome and Firefox manifests", () => {
    for (const file of ["../manifest.chrome.json", "../manifest.firefox.json"]) {
      expect(findManifestProblems(JSON.parse(readText(file)), everyFileExists)).toEqual([]);
    }
  });

  it("flags files the build doesn't contain", () => {
    const manifest = JSON.parse(readText("../manifest.chrome.json"));
    const problems = findManifestProblems(
      manifest,
      (path: string) => path !== "pageBridge.js" && path !== "icons/icon128.png",
    );

    expect(problems).toEqual([
      "web_accessible_resources names pageBridge.js, which isn't in the build",
      "icons names icons/icon128.png, which isn't in the build",
    ]);
  });

  it("holds a Firefox manifest's name to 45 characters", () => {
    const firefox = JSON.parse(readText("../manifest.firefox.json"));
    const chrome = JSON.parse(readText("../manifest.chrome.json"));
    const longName = "x".repeat(46);

    expect(findManifestProblems({ ...firefox, name: longName }, everyFileExists)).toEqual([
      "name is 46 characters, the limit is 45",
    ]);
    expect(findManifestProblems({ ...chrome, name: longName }, everyFileExists)).toEqual([]);
  });

  it("flags what the stores refuse", () => {
    const problems = findManifestProblems(
      {
        manifest_version: 2,
        name: "x".repeat(76),
        description: "y".repeat(133),
        version: "2.03.0",
        content_security_policy: { extension_pages: "script-src 'self' 'unsafe-eval'" },
        permissions: ["storage", "https://example.com/*"],
      },
      everyFileExists,
    );

    expect(problems).toHaveLength(6);
  });

  it("lets WebAssembly compile, which can't run text as code", () => {
    const chrome = JSON.parse(readText("../manifest.chrome.json"));

    expect(chrome.content_security_policy.extension_pages).toContain("'wasm-unsafe-eval'");
    expect(findManifestProblems(chrome, everyFileExists)).toEqual([]);
    expect(
      findManifestProblems(
        {
          ...chrome,
          content_security_policy: {
            extension_pages: "script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'",
          },
        },
        everyFileExists,
      ),
    ).toHaveLength(1);
  });
});

describe("checkDist", () => {
  let directory: string | undefined;

  afterEach(() => {
    if (directory) {
      rmSync(directory, { recursive: true, force: true });
      directory = undefined;
    }
  });

  it("names the file of each problem", () => {
    directory = mkdtempSync(join(tmpdir(), "aiexporter-store-rules-"));
    mkdirSync(join(directory, "assets"));
    writeFileSync(join(directory, "popup.html"), '<script type="module" src="/popup.js"></script>');
    writeFileSync(join(directory, "popup.js"), PAGE_BRIDGE_INJECTION);
    writeFileSync(join(directory, "assets", "pdf.js"), REJECTED_SNIPPET);

    const problems = checkDist(directory, [
      {
        label: "manifest.json",
        manifest: {
          manifest_version: 3,
          name: "AI Exporter",
          version: "2.3.0",
          action: { default_popup: "popup.html" },
          background: { service_worker: "background.js" },
        },
      },
    ]);

    expect(problems.length).toBeGreaterThan(0);
    expect(problems.filter((problem) => !problem.startsWith("assets/pdf.js: "))).toEqual([
      "manifest.json: background names background.js, which isn't in the build",
    ]);
  });
});
