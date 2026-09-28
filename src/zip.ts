export interface ZipEntry {
  path: string;
  bytes: Uint8Array;
}

const CRC32_TABLE = new Uint32Array(256);

for (let index = 0; index < CRC32_TABLE.length; index++) {
  let value = index;

  for (let bit = 0; bit < 8; bit++) {
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }

  CRC32_TABLE[index] = value >>> 0;
}

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;

  for (const byte of bytes) {
    value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }

  return (value ^ 0xffffffff) >>> 0;
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

function getDosDateTime(date: Date): { time: number; day: number } {
  const year = Math.max(1980, date.getFullYear());
  const time =
    (date.getHours() << 11) |
    (date.getMinutes() << 5) |
    Math.floor(date.getSeconds() / 2);
  const day =
    ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();

  return { time, day };
}

export function createZipBlob(entries: ZipEntry[]): Blob {
  if (entries.length === 0 || entries.length > 0xffff) {
    throw new Error("The export archive has an invalid number of files.");
  }

  const encoder = new TextEncoder();
  const localParts: ArrayBuffer[] = [];
  const centralParts: ArrayBuffer[] = [];
  const { time, day } = getDosDateTime(new Date());
  let localOffset = 0;
  let centralSize = 0;

  for (const entry of entries) {
    if (
      entry.path.length === 0 ||
      entry.path.startsWith("/") ||
      entry.path.split("/").some((part) => part === "..")
    ) {
      throw new Error("The export archive contains an invalid file path.");
    }

    const filename = encoder.encode(entry.path);

    if (
      filename.byteLength > 0xffff ||
      entry.bytes.byteLength > 0xffffffff ||
      localOffset > 0xffffffff
    ) {
      throw new Error("The export archive exceeds the ZIP format limits.");
    }

    const checksum = crc32(entry.bytes);
    const isDirectory = entry.path.endsWith("/");
    const localHeader = new Uint8Array(30 + filename.byteLength);
    const localView = new DataView(localHeader.buffer);

    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, time, true);
    localView.setUint16(12, day, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, entry.bytes.byteLength, true);
    localView.setUint32(22, entry.bytes.byteLength, true);
    localView.setUint16(26, filename.byteLength, true);
    localView.setUint16(28, 0, true);
    localHeader.set(filename, 30);

    localParts.push(copyToArrayBuffer(localHeader));

    if (entry.bytes.byteLength > 0) {
      localParts.push(copyToArrayBuffer(entry.bytes));
    }

    const centralHeader = new Uint8Array(46 + filename.byteLength);
    const centralView = new DataView(centralHeader.buffer);

    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, time, true);
    centralView.setUint16(14, day, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, entry.bytes.byteLength, true);
    centralView.setUint32(24, entry.bytes.byteLength, true);
    centralView.setUint16(28, filename.byteLength, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, isDirectory ? 0x10 : 0, true);
    centralView.setUint32(42, localOffset, true);
    centralHeader.set(filename, 46);

    centralParts.push(copyToArrayBuffer(centralHeader));
    localOffset += 30 + filename.byteLength + entry.bytes.byteLength;
    centralSize += centralHeader.byteLength;
  }

  if (localOffset > 0xffffffff || centralSize > 0xffffffff) {
    throw new Error("The export archive exceeds the ZIP format limits.");
  }

  const endRecord = new Uint8Array(22);
  const endView = new DataView(endRecord.buffer);

  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, localOffset, true);
  endView.setUint16(20, 0, true);

  return new Blob(
    [...localParts, ...centralParts, copyToArrayBuffer(endRecord)],
    { type: "application/zip" },
  );
}

export function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

export async function encodeBlobBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const chunkSize = 0x8000;
  let binary = "";

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)),
    );
  }

  return btoa(binary);
}
