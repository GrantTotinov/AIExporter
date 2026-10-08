/*
 * node scripts/check-store-rules.mjs
 *
 * Checks the built extension in dist/ against the rules the
 * Chrome Web Store and Firefox Add-ons enforce for Manifest V3
 * extensions, before anything gets uploaded:
 *
 *   - All code ships in the package: no <script> or import()
 *     from another server, no address of a code CDN, no eval()
 *     or Function() turning text into code. The Chrome Web Store
 *     calls a break of this rule "Blue Argon", and rejected
 *     AI Exporter for it over a cdnjs.cloudflare.com script
 *     inside jsPDF (scripts/trim-jspdf.mjs now removes it).
 *   - The pages have no inline <script>, on...= handler or
 *     javascript: URL. Manifest V3 blocks those, so the page
 *     would just stop working.
 *   - The manifests name only files the build contains, stay
 *     within the store's length limits and don't loosen the
 *     content security policy.
 *
 * `npm run build` runs this after every build (checking both
 * manifest.chrome.json and manifest.firefox.json against dist/),
 * and `npm run archive` checks dist/ again, with the manifest it
 * is about to zip. Every problem is printed with the file and the
 * code around it, and the command fails.
 *
 * Plain Node with no dependencies, like scripts/archive.mjs.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * ---------------------------------------------------------
 * CODE (.js)
 * ---------------------------------------------------------
 */

const CODE_RULES = [
  {
    pattern:
      /\b(?:cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com|esm\.sh|cdn\.skypack\.dev|jspm\.io|ajax\.googleapis\.com|code\.jquery\.com|raw\.githubusercontent\.com|polyfill\.io|googletagmanager\.com|google-analytics\.com)\b/g,
    problem: "the address of a server that hosts code",
  },
  {
    pattern: /https?:\/\/[^\s"'`<>]+\.m?js(?![\w.-])/g,
    problem: "the address of a script on another server",
  },
  {
    pattern: /\bimport\s*\(\s*["'`](?:https?:)?\/\//g,
    problem: "import() of code from another server",
  },
  {
    pattern: /\bimportScripts\s*\(/g,
    problem: "importScripts(), which loads code while running",
  },
  {
    pattern: /(?<![\w$.])eval\s*\(/g,
    problem: "eval(), which runs text as code",
  },
  {
    pattern: /(?<![\w$.])Function\s*\(/g,
    problem: "Function(), which runs text as code",
  },
  {
    pattern: /\bset(?:Timeout|Interval)\s*\(\s*["'`]/g,
    problem: "a timer given its code as text",
  },
  {
    pattern:
      /(?:\bfetch\s*\(\s*|\.open\s*\(\s*["'`][A-Za-z]+["'`]\s*,\s*)["'`]http:\/\//g,
    problem: "a request over unencrypted http://",
  },
];

/*
 * A page script may add a <script> element only to load a file
 * from the extension itself - content.ts does that for
 * pageBridge.js on chatgpt.com. Anything else is a script from
 * somewhere else, like jsPDF's from cdnjs.cloudflare.com.
 */
const SCRIPT_ELEMENT = /createElement\s*\(\s*["'`]script["'`]\s*\)/gi;
const PACKAGED_SCRIPT_SRC = /\.src\s*=\s*(?:chrome|browser)\.runtime\.getURL\s*\(/;
const SCRIPT_SRC_DISTANCE = 300;

/*
 * Each problem found in a file, as "what: ...code around it...".
 * At most a few per rule, so one bad library doesn't bury the
 * rest of the report.
 */
const MAX_HITS_PER_RULE = 3;

function excerpt(text, index, length) {
  const start = Math.max(0, index - 60);
  const end = Math.min(text.length, index + length + 80);

  return (
    (start > 0 ? "..." : "") +
    text.slice(start, end).replace(/\s+/g, " ") +
    (end < text.length ? "..." : "")
  );
}

function collect(text, pattern, problem, accept = () => false) {
  const hits = [...text.matchAll(pattern)].filter(
    (match) => !accept(match),
  );
  const problems = hits
    .slice(0, MAX_HITS_PER_RULE)
    .map(
      (match) =>
        `${problem}: ${excerpt(text, match.index, match[0].length)}`,
    );

  if (hits.length > MAX_HITS_PER_RULE) {
    problems.push(
      `${problem}: ${hits.length - MAX_HITS_PER_RULE} more like the above`,
    );
  }

  return problems;
}

export function findCodeProblems(code) {
  const problems = CODE_RULES.flatMap(({ pattern, problem }) =>
    collect(code, pattern, problem),
  );

  problems.push(
    ...collect(
      code,
      SCRIPT_ELEMENT,
      "a <script> element that doesn't load a file of the extension",
      (match) =>
        PACKAGED_SCRIPT_SRC.test(
          code.slice(match.index, match.index + SCRIPT_SRC_DISTANCE),
        ),
    ),
  );

  return problems;
}

/*
 * ---------------------------------------------------------
 * PAGES (.html)
 * ---------------------------------------------------------
 */

const HTML_RULES = [
  {
    pattern:
      /<(?:script|link|iframe|frame|object|embed)\b[^>]*\s(?:src|href|data)\s*=\s*["']?(?:https?:)?\/\//gi,
    problem: "a script, frame or file loaded from another server",
  },
  {
    pattern: /<script\b(?![^>]*\ssrc\s*=)[^>]*>/gi,
    problem: "an inline <script>, which Manifest V3 blocks",
  },
  {
    pattern: /<[a-z][^>]*\son[a-z]+\s*=/gi,
    problem: "an inline on...= handler, which Manifest V3 blocks",
  },
  {
    pattern: /\b(?:href|src|action)\s*=\s*["']?\s*javascript:/gi,
    problem: "a javascript: URL, which Manifest V3 blocks",
  },
];

export function findHtmlProblems(html) {
  return HTML_RULES.flatMap(({ pattern, problem }) =>
    collect(html, pattern, problem),
  );
}

/*
 * ---------------------------------------------------------
 * MANIFEST
 * ---------------------------------------------------------
 *
 * Length limits are the Chrome Web Store's, except that Firefox
 * Add-ons refuses an upload whose name is over 45 characters
 * (addons-linter's manifest schema), so a manifest for Firefox
 * gets that limit.
 *
 * A name or description can be "__MSG_key__", translated in
 * _locales/<locale>/messages.json - the stores show each language
 * its own text, so every translation is held to the limit.
 */
const MAX_NAME_LENGTH = 75;
const MAX_FIREFOX_NAME_LENGTH = 45;
const MAX_DESCRIPTION_LENGTH = 132;
const MESSAGE_REFERENCE = /^__MSG_(\w+)__$/;

/*
 * The messages of every language in a _locales directory, as
 * { locale: { key: { message } } } - or null for a messages.json
 * that isn't valid JSON. Empty when there's no _locales.
 */
export function readLocales(directory) {
  if (!existsSync(directory)) {
    return {};
  }

  return Object.fromEntries(
    readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const file = join(directory, entry.name, "messages.json");

        try {
          return [entry.name, JSON.parse(readFileSync(file, "utf8"))];
        } catch {
          return [entry.name, null];
        }
      }),
  );
}

// Chrome and Firefox look message keys up regardless of case.
function findMessage(messages, key) {
  const name = Object.keys(messages ?? {}).find(
    (candidate) => candidate.toLowerCase() === key.toLowerCase(),
  );

  return name === undefined ? undefined : messages[name]?.message;
}

/*
 * The text of a manifest field in each language, as
 * [{ where, text }], with "where" naming the field (and the
 * language, for a translated one). A problem instead when the
 * field names a message the default language doesn't have.
 */
function fieldTexts(field, value, locales, defaultLocale) {
  const reference = typeof value === "string" ? MESSAGE_REFERENCE.exec(value) : null;

  if (!reference) {
    return { texts: [{ where: field, text: value }] };
  }

  const key = reference[1];

  if (defaultLocale === undefined || findMessage(locales[defaultLocale], key) === undefined) {
    return {
      problem: `${field} is ${value}, but _locales/${defaultLocale ?? "<default_locale>"}/messages.json has no "${key}"`,
    };
  }

  return {
    texts: Object.entries(locales)
      .map(([locale, messages]) => ({
        where: `${field} in _locales/${locale}`,
        text: findMessage(messages, key),
      }))
      .filter(({ text }) => text !== undefined),
  };
}

function referencedFiles(manifest) {
  const files = [];
  const add = (key, value) => {
    if (typeof value === "string") {
      files.push({ key, path: value });
    } else if (Array.isArray(value)) {
      value.forEach((item) => add(key, item));
    } else if (value !== null && typeof value === "object") {
      Object.values(value).forEach((item) => add(key, item));
    }
  };

  add("background", [
    manifest.background?.service_worker,
    manifest.background?.scripts,
    manifest.background?.page,
  ]);
  manifest.content_scripts?.forEach((script) => {
    add("content_scripts", [script.js, script.css]);
  });
  manifest.web_accessible_resources?.forEach((entry) => {
    add(
      "web_accessible_resources",
      (entry.resources ?? []).filter((path) => !path.includes("*")),
    );
  });
  add("action", [manifest.action?.default_popup, manifest.action?.default_icon]);
  add("icons", manifest.icons);
  add("options_page", manifest.options_page);
  add("options_ui", manifest.options_ui?.page);
  add("side_panel", manifest.side_panel?.default_path);
  add("devtools_page", manifest.devtools_page);
  add("sandbox", manifest.sandbox?.pages);
  add("chrome_url_overrides", manifest.chrome_url_overrides);

  return files;
}

function isValidVersion(version) {
  if (typeof version !== "string" || !/^\d+(?:\.\d+){0,3}$/.test(version)) {
    return false;
  }

  return version
    .split(".")
    .every((part) => Number(part) <= 65535 && !/^0\d/.test(part));
}

export function findManifestProblems(manifest, hasFile, locales = {}) {
  const problems = [];

  if (manifest.manifest_version !== 3) {
    problems.push(
      `manifest_version is ${manifest.manifest_version}, not 3`,
    );
  }

  // Chrome won't load an extension with _locales but no
  // default_locale, or a default_locale it can't find.
  const defaultLocale = manifest.default_locale;

  if (Object.keys(locales).length > 0 && defaultLocale === undefined) {
    problems.push("_locales is in the build, but default_locale is missing");
  } else if (defaultLocale !== undefined && !locales[defaultLocale]) {
    problems.push(
      `default_locale is "${defaultLocale}", but _locales/${defaultLocale}/messages.json isn't in the build`,
    );
  }

  for (const [locale, messages] of Object.entries(locales)) {
    if (messages === null) {
      problems.push(`_locales/${locale}/messages.json isn't valid JSON`);
    }
  }

  const maxNameLength = manifest.browser_specific_settings?.gecko
    ? MAX_FIREFOX_NAME_LENGTH
    : MAX_NAME_LENGTH;
  const textFields = [
    { field: "name", value: manifest.name, limit: maxNameLength, required: true },
    { field: "description", value: manifest.description, limit: MAX_DESCRIPTION_LENGTH },
    { field: "action.default_title", value: manifest.action?.default_title },
    ...Object.entries(manifest.commands ?? {}).map(([command, { description }]) => ({
      field: `commands.${command}.description`,
      value: description,
    })),
  ];

  for (const { field, value, limit, required } of textFields) {
    if (typeof value !== "string" || value.length === 0) {
      if (required) {
        problems.push(`${field} is missing`);
      }
      continue;
    }

    const { texts, problem } = fieldTexts(field, value, locales, defaultLocale);

    if (problem) {
      problems.push(problem);
      continue;
    }

    for (const { where, text } of texts) {
      if (limit !== undefined && text.length > limit) {
        problems.push(`${where} is ${text.length} characters, the limit is ${limit}`);
      }
    }
  }

  if (!isValidVersion(manifest.version)) {
    problems.push(
      `version "${manifest.version}" isn't 1 to 4 numbers (0-65535) separated by dots`,
    );
  }

  const csp = manifest.content_security_policy;

  if (typeof csp === "string") {
    problems.push(
      "content_security_policy is a string (Manifest V2 form), not an object",
    );
  } else if (csp !== null && typeof csp === "object") {
    for (const [key, policy] of Object.entries(csp)) {
      // 'wasm-unsafe-eval' only lets WebAssembly compile (HarfBuzz,
      // see src/text-shaping.ts); it can't turn text into code.
      const loosened = String(policy).replace(/'wasm-unsafe-eval'/g, "");

      if (/unsafe-eval|unsafe-inline|https?:/.test(loosened)) {
        problems.push(
          `content_security_policy.${key} allows code from outside the package: ${policy}`,
        );
      }
    }
  }

  for (const permission of manifest.permissions ?? []) {
    if (permission.includes("://") || permission === "<all_urls>") {
      problems.push(
        `permissions lists the site ${permission}, which Manifest V3 expects under host_permissions`,
      );
    }
  }

  for (const { key, path } of referencedFiles(manifest)) {
    if (!hasFile(path.replace(/^\//, ""))) {
      problems.push(`${key} names ${path}, which isn't in the build`);
    }
  }

  return problems;
}

/*
 * ---------------------------------------------------------
 * THE BUILD
 * ---------------------------------------------------------
 *
 * `manifests` is a list of { label, manifest } to check against
 * the files in `distDirectory`. Returns every problem as
 * "where: what", or an empty list.
 */

function listFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);

    return entry.isDirectory() ? listFiles(path) : [path];
  });
}

export function checkDist(distDirectory, manifests) {
  const problems = [];

  for (const file of listFiles(distDirectory)) {
    const name = relative(distDirectory, file).split(sep).join("/");

    if (/\.m?js$/i.test(name)) {
      problems.push(
        ...findCodeProblems(readFileSync(file, "utf8")).map(
          (problem) => `${name}: ${problem}`,
        ),
      );
    } else if (/\.html?$/i.test(name)) {
      problems.push(
        ...findHtmlProblems(readFileSync(file, "utf8")).map(
          (problem) => `${name}: ${problem}`,
        ),
      );
    }
  }

  const locales = readLocales(join(distDirectory, "_locales"));

  for (const { label, manifest } of manifests) {
    problems.push(
      ...findManifestProblems(
        manifest,
        (path) => existsSync(join(distDirectory, path)),
        locales,
      ).map((problem) => `${label}: ${problem}`),
    );
  }

  return problems;
}

export function formatProblems(problems) {
  return problems.map((problem) => `  - ${problem}`).join("\n");
}

/*
 * ---------------------------------------------------------
 * COMMAND LINE
 * ---------------------------------------------------------
 */

const runDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (runDirectly) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const dist = join(root, "dist");

  if (!existsSync(dist)) {
    console.error("dist/ not found. Run `npm run build` first.");
    process.exit(1);
  }

  const manifests = ["manifest.chrome.json", "manifest.firefox.json"].map(
    (file) => ({
      label: file,
      manifest: JSON.parse(readFileSync(join(root, file), "utf8")),
    }),
  );
  const problems = checkDist(dist, manifests);

  if (problems.length > 0) {
    console.error(
      `The build in dist/ would be rejected by the extension stores:\n${formatProblems(problems)}`,
    );
    process.exit(1);
  }

  console.log(
    "Store rules: dist/ has only packaged code, and both manifests match it.",
  );
}
