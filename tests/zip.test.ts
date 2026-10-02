import { describe, expect, it } from "vitest";
import {
  copyToArrayBuffer,
  createZipBlob,
  decodeBase64,
  encodeBlobBase64,
  type ZipEntry,
} from "../src/zip";

const LOCAL_FILE_HEADER = 0x04034b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;

async function readStoredEntries(blob: Blob): Promise<ZipEntry[]> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  let offset = 0;

  while (view.getUint32(offset, true) === LOCAL_FILE_HEADER) {
    const flags = view.getUint16(offset + 6, true);
    const compressionMethod = view.getUint16(offset + 8, true);
    const size = view.getUint32(offset + 22, true);
    const filenameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const filenameStart = offset + 30;
    const dataStart = filenameStart + filenameLength + extraLength;
    const dataEnd = dataStart + size;

    expect(flags & 0x0800).toBe(0x0800);
    expect(compressionMethod).toBe(0);

    entries.push({
      path: decoder.decode(bytes.subarray(filenameStart, filenameStart + filenameLength)),
      bytes: bytes.slice(dataStart, dataEnd),
    });
    offset = dataEnd;
  }

  expect(view.getUint32(offset, true)).toBe(CENTRAL_DIRECTORY_HEADER);

  const endRecordOffset = bytes.length - 22;

  expect(view.getUint32(endRecordOffset, true)).toBe(END_OF_CENTRAL_DIRECTORY);
  expect(view.getUint16(endRecordOffset + 8, true)).toBe(entries.length);
  expect(view.getUint32(endRecordOffset + 12, true)).toBe(
    endRecordOffset - offset,
  );
  expect(view.getUint32(endRecordOffset + 16, true)).toBe(offset);

  return entries;
}

describe("createZipBlob", () => {
  it("stores the conversation and local image paths in a readable ZIP archive", async () => {
    const encoder = new TextEncoder();
    const markdown = encoder.encode(
      "![Image 1](images/image-001.png)",
    );
    const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const entries: ZipEntry[] = [
      { path: "conversation/", bytes: new Uint8Array() },
      { path: "conversation/chat.md", bytes: markdown },
      { path: "conversation/images/", bytes: new Uint8Array() },
      { path: "conversation/images/image-001.png", bytes: image },
    ];

    const archive = createZipBlob(entries);
    const decodedEntries = await readStoredEntries(archive);

    expect(archive.type).toBe("application/zip");
    expect(decodedEntries.map(({ path }) => path)).toEqual(
      entries.map(({ path }) => path),
    );
    expect(decodedEntries.map(({ bytes }) => [...bytes])).toEqual(
      entries.map(({ bytes }) => [...bytes]),
    );
  });

  it("rejects paths that escape the archive root", () => {
    expect(() =>
      createZipBlob([{ path: "../outside.md", bytes: new Uint8Array() }]),
    ).toThrow("invalid file path");
  });
});

/*
 * ---------------------------------------------------------
 * copyToArrayBuffer / decodeBase64 / encodeBlobBase64
 * ---------------------------------------------------------
 *
 * These three are the entire transport layer the download fix
 * (background.ts's DOWNLOAD_START handler, popup.ts's export
 * flow) relies on to move file bytes from the popup to the
 * background page as a plain string: popup.ts calls
 * encodeBlobBase64(blob) and background.ts reverses it with
 * decodeBase64() + copyToArrayBuffer() to rebuild the Blob. If
 * any of the three ever drops or mangles a byte - especially at
 * the 0x8000-byte chunk boundary encodeBlobBase64 uses to avoid
 * blowing the call stack on String.fromCharCode(...bigArray) -
 * every export silently corrupts, in both browsers, with no
 * error anywhere. None of this had direct test coverage before.
 */
describe("copyToArrayBuffer", () => {
  it("copies every byte, including zero", () => {
    const original = new Uint8Array([0, 1, 2, 255, 128, 0]);
    const copy = new Uint8Array(copyToArrayBuffer(original));

    expect([...copy]).toEqual([...original]);
  });

  it("returns a buffer independent of the source - mutating one does not affect the other", () => {
    const original = new Uint8Array([10, 20, 30]);
    const copy = new Uint8Array(copyToArrayBuffer(original));

    original[0] = 99;
    copy[1] = 99;

    expect(original[0]).toBe(99);
    expect(copy[0]).toBe(10);
    expect(original[1]).toBe(20);
  });

  it("handles an empty array", () => {
    expect(copyToArrayBuffer(new Uint8Array()).byteLength).toBe(0);
  });
});

describe("decodeBase64", () => {
  it("round-trips every byte value 0-255", () => {
    const bytes = new Uint8Array(256);

    for (let i = 0; i < 256; i++) {
      bytes[i] = i;
    }

    const encoded = btoa(String.fromCharCode(...bytes));

    expect([...decodeBase64(encoded)]).toEqual([...bytes]);
  });

  it("decodes an empty string to an empty array", () => {
    expect(decodeBase64("").byteLength).toBe(0);
  });
});

describe("encodeBlobBase64", () => {
  /*
   * The same shape of check background.ts's
   * isValidBinaryExportContent() runs before it will decode a
   * DOWNLOAD_START/GITHUB_SAVE_FILE payload: standard base64
   * alphabet, length a multiple of 4, no embedded whitespace or
   * newlines. A failure here means real exports would get
   * rejected as "Invalid download request." even though the
   * popup-side encoding "worked".
   */
  const STRICT_BASE64_PATTERN =
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

  it("round-trips a small blob exactly", async () => {
    const original = new TextEncoder().encode("hello AI Exporter");
    const blob = new Blob([original], { type: "text/plain" });

    const encoded = await encodeBlobBase64(blob);

    expect(encoded).toMatch(STRICT_BASE64_PATTERN);
    expect([...decodeBase64(encoded)]).toEqual([...original]);
  });

  it("round-trips an empty blob", async () => {
    const encoded = await encodeBlobBase64(new Blob([]));

    expect(encoded).toBe("");
    expect(decodeBase64(encoded).byteLength).toBe(0);
  });

  it("round-trips a blob exactly at the internal 0x8000-byte chunk boundary", async () => {
    const original = new Uint8Array(0x8000);

    for (let i = 0; i < original.length; i++) {
      original[i] = i % 256;
    }

    const encoded = await encodeBlobBase64(new Blob([original]));

    expect(encoded).toMatch(STRICT_BASE64_PATTERN);
    expect([...decodeBase64(encoded)]).toEqual([...original]);
  });

  it("round-trips a blob that straddles the chunk boundary by one byte on each side", async () => {
    for (const size of [0x8000 - 1, 0x8000 + 1]) {
      const original = new Uint8Array(size);

      for (let i = 0; i < size; i++) {
        original[i] = (i * 7) % 256;
      }

      const encoded = await encodeBlobBase64(new Blob([original]));

      expect([...decodeBase64(encoded)]).toEqual([...original]);
    }
  });

  it("round-trips a blob spanning multiple chunks, including every byte value", async () => {
    const size = 0x8000 * 3 + 123;
    const original = new Uint8Array(size);

    for (let i = 0; i < size; i++) {
      original[i] = i % 256;
    }

    const encoded = await encodeBlobBase64(new Blob([original]));

    expect(encoded).toMatch(STRICT_BASE64_PATTERN);

    const decoded = decodeBase64(encoded);
    expect(decoded.byteLength).toBe(size);
    expect([...decoded]).toEqual([...original]);
  });

  it("preserves bytes through encode -> decode -> copyToArrayBuffer, the exact path background.ts takes", async () => {
    const original = new Uint8Array([0, 10, 20, 255, 254, 1, 0, 128]);
    const blob = new Blob([original], { type: "application/pdf" });

    const encoded = await encodeBlobBase64(blob);
    const rebuilt = new Blob([copyToArrayBuffer(decodeBase64(encoded))], {
      type: blob.type,
    });

    expect(rebuilt.type).toBe("application/pdf");
    expect([...new Uint8Array(await rebuilt.arrayBuffer())]).toEqual([
      ...original,
    ]);
  });
});
