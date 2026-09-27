import { describe, expect, it } from "vitest";
import { createZipBlob, type ZipEntry } from "../src/zip";

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
