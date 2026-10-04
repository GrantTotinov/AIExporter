/*
 * npm run archive
 *
 * Zips the built extension in dist/ for upload to the Chrome Web
 * Store or Firefox Add-ons - run `npm run build:chrome` or
 * `npm run build:firefox` first. The zip is named after the
 * version and browser in the built manifest, e.g.
 * AIExporter-2.3.0-chrome.zip, so a Chrome build can't be uploaded
 * to Firefox by mistake (or vice versa).
 *
 * Plain Node with no dependencies, so it works the same on every
 * OS. Both stores need manifest.json at the root of the zip and
 * forward slashes in its paths, which is what this writes.
 *
 * It won't zip a build that breaks the stores' rules for
 * Manifest V3 (code loaded from another server, eval(), a
 * manifest naming a missing file...) - see
 * scripts/check-store-rules.mjs.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import { checkDist, formatProblems } from "./check-store-rules.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "dist");
const manifestPath = join(dist, "manifest.json");

if (!existsSync(manifestPath)) {
  console.error(
    "dist/manifest.json not found. Run `npm run build:chrome` or `npm run build:firefox` first.",
  );
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const browser = manifest.browser_specific_settings?.gecko ? "firefox" : "chrome";

/*
 * Firefox only hands an update to installs with the same add-on
 * ID, and Firefox Add-ons lists AI Exporter under the ID it was
 * first published with, back when it was GPTChatDownloader. A
 * build under any other ID can't be uploaded as a new version of
 * that listing, and couldn't update anyone who installed it.
 */
const FIREFOX_ADDON_ID = "gptchatdownloader@granttotinov.com";

if (
  browser === "firefox" &&
  manifest.browser_specific_settings.gecko.id !== FIREFOX_ADDON_ID
) {
  console.error(
    `dist/manifest.json has the Firefox add-on ID "${manifest.browser_specific_settings.gecko.id}", but Firefox Add-ons lists AI Exporter as "${FIREFOX_ADDON_ID}". Existing installs only update to a build with that same ID.`,
  );
  process.exit(1);
}
const packageVersion = JSON.parse(
  readFileSync(join(root, "package.json"), "utf8"),
).version;

if (manifest.version !== packageVersion) {
  console.warn(
    `Warning: dist/manifest.json is version ${manifest.version} but package.json is ${packageVersion}. Rebuild if dist is out of date.`,
  );
}

const storeProblems = checkDist(dist, [
  { label: "dist/manifest.json", manifest },
]);

if (storeProblems.length > 0) {
  console.error(
    `dist/ wasn't zipped - the extension stores would reject it:\n${formatProblems(storeProblems)}`,
  );
  process.exit(1);
}

/*
 * ---------------------------------------------------------
 * FILES
 * ---------------------------------------------------------
 */

const IGNORED_FILES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

function listFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => !IGNORED_FILES.has(entry.name))
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .flatMap((entry) => {
      const path = join(directory, entry.name);

      return entry.isDirectory() ? listFiles(path) : [path];
    });
}

/*
 * ---------------------------------------------------------
 * ZIP
 * ---------------------------------------------------------
 *
 * Each file is deflated, or stored as-is when deflating wouldn't
 * make it smaller (the PNG icons, say).
 */

const CRC32_TABLE = new Uint32Array(256).map((_, index) => {
  let value = index;

  for (let bit = 0; bit < 8; bit++) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }

  return value >>> 0;
});

function crc32(bytes) {
  let value = 0xffffffff;

  for (const byte of bytes) {
    value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }

  return (value ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  return {
    time:
      (date.getHours() << 11) |
      (date.getMinutes() << 5) |
      Math.floor(date.getSeconds() / 2),
    day:
      ((Math.max(date.getFullYear(), 1980) - 1980) << 9) |
      ((date.getMonth() + 1) << 5) |
      date.getDate(),
  };
}

const files = listFiles(dist);
const localParts = [];
const centralParts = [];
let offset = 0;

for (const file of files) {
  const name = Buffer.from(relative(dist, file).split(sep).join("/"), "utf8");
  const data = readFileSync(file);
  const deflated = deflateRawSync(data, { level: 9 });
  const compressed = deflated.length < data.length;
  const body = compressed ? deflated : data;
  const checksum = crc32(data);
  const { time, day } = dosDateTime(statSync(file).mtime);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6); // file names are UTF-8
  local.writeUInt16LE(compressed ? 8 : 0, 8);
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(day, 12);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(compressed ? 8 : 0, 10);
  central.writeUInt16LE(time, 12);
  central.writeUInt16LE(day, 14);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(offset, 42);

  localParts.push(local, name, body);
  centralParts.push(central, name);
  offset += local.length + name.length + body.length;
}

const centralSize = centralParts.reduce((size, part) => size + part.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralSize, 12);
end.writeUInt32LE(offset, 16);

const archive = Buffer.concat([...localParts, ...centralParts, end]);
const output = `AIExporter-${manifest.version}-${browser}.zip`;

writeFileSync(join(root, output), archive);

console.log(
  `Created ${output} (${files.length} files, ${Math.round(archive.length / 1024)} KB)`,
);
