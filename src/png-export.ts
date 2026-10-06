/*
 * =========================================================
 * AI Exporter - png-export.ts
 * =========================================================
 *
 * The chat as one long picture, the way it's shared in WeChat,
 * on Xiaohongshu, X or LinkedIn: the HTML export (html-export.ts),
 * laid out in an invisible frame 820 pixels wide and drawn into a
 * PNG at twice that, so text stays sharp on a phone.
 *
 * The browser draws it itself - the page goes into an SVG image as
 * a <foreignObject>, which a <canvas> paints - so every script,
 * emoji and formula looks as it does in the browser, with no font
 * of AI Exporter's own. Everything the page shows is in it already
 * (pictures as data: URLs, formulas as inline SVG), which is what
 * lets the canvas be read back.
 *
 * Browsers refuse a canvas taller than 32,767 pixels, so a chat
 * longer than 16,000 pixels comes as several pictures in a ZIP,
 * cut between messages where it can be.
 *
 * Needs a DOM: built in the popup and on the "Save many chats"
 * page, never in the background.
 */
import type { Settings } from "./settings.ts";
import { buildHtmlDocument, type HtmlSource } from "./html-export.ts";
import type { ExportImageFile, Message } from "./export-builders.ts";
import { createZipBlob } from "./zip.ts";

const PAGE_WIDTH = 820;
const SCALE = 2;
export const MAX_PART_HEIGHT = 16000;

/*
 * Where to cut a page `total` pixels tall into pictures of at most
 * `max`: at the last message boundary that fits - one in the first
 * third of a picture would leave it mostly empty - or else straight
 * through.
 */
export function pictureParts(
  total: number,
  boundaries: number[],
  max = MAX_PART_HEIGHT,
): [number, number][] {
  const parts: [number, number][] = [];
  const cuts = [...boundaries].sort((a, b) => a - b);
  let start = 0;

  while (total - start > max) {
    const fitting = cuts.filter((cut) => cut > start + max / 3 && cut <= start + max);
    const end = fitting.length > 0 ? fitting[fitting.length - 1] : start + max;

    parts.push([start, end]);
    start = end;
  }

  parts.push([start, total]);

  return parts;
}

function loadFrame(html: string): Promise<HTMLIFrameElement> {
  return new Promise((resolve, reject) => {
    const frame = document.createElement("iframe");

    frame.setAttribute("aria-hidden", "true");
    frame.style.cssText = `position:fixed;left:-20000px;top:0;width:${PAGE_WIDTH}px;height:100px;border:0;visibility:hidden`;
    frame.addEventListener("load", () => resolve(frame), { once: true });
    frame.addEventListener("error", () => reject(new Error("The picture couldn't be laid out.")), {
      once: true,
    });
    frame.srcdoc = html;
    document.body.append(frame);
  });
}

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();

    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("The picture couldn't be drawn."));
    image.src = source;
  });
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("The picture couldn't be saved."))),
      "image/png",
    );
  });
}

async function drawPart(
  markup: string,
  total: number,
  [start, end]: [number, number],
): Promise<Blob> {
  const height = end - start;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PAGE_WIDTH}" height="${height}" ` +
    `viewBox="0 ${start} ${PAGE_WIDTH} ${height}">` +
    `<foreignObject x="0" y="0" width="${PAGE_WIDTH}" height="${total}">${markup}</foreignObject></svg>`;
  const image = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
  const canvas = document.createElement("canvas");

  canvas.width = PAGE_WIDTH * SCALE;
  canvas.height = Math.max(1, Math.round(height * SCALE));

  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("The picture couldn't be drawn.");
  }

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  return canvasBlob(canvas);
}

export async function buildPngBlob(
  messages: Message[],
  images: ExportImageFile[],
  settings: Settings,
  source: HtmlSource,
): Promise<Blob> {
  const html = await buildHtmlDocument(messages, images, settings, source, {
    picture: true,
  });
  const frame = await loadFrame(html);

  try {
    const page = frame.contentDocument;

    if (!page) {
      throw new Error("The picture couldn't be laid out.");
    }

    await Promise.all(
      Array.from(page.images).map((image) => image.decode().catch(() => undefined)),
    );

    const total = Math.ceil(page.documentElement.scrollHeight);
    const boundaries = Array.from(page.querySelectorAll(".message")).map((message) =>
      Math.floor(message.getBoundingClientRect().top - 14),
    );
    // The page's own markup, as the XHTML a <foreignObject> takes
    const markup = new XMLSerializer().serializeToString(page.documentElement);
    const parts = pictureParts(total, boundaries);
    const pictures: Blob[] = [];

    for (const part of parts) {
      pictures.push(await drawPart(markup, total, part));
    }

    if (pictures.length === 1) {
      return pictures[0];
    }

    const digits = String(pictures.length).length;

    return createZipBlob(
      await Promise.all(
        pictures.map(async (picture, index) => ({
          path: `part-${String(index + 1).padStart(Math.max(2, digits), "0")}.png`,
          bytes: new Uint8Array(await picture.arrayBuffer()),
        })),
      ),
    );
  } finally {
    frame.remove();
  }
}
