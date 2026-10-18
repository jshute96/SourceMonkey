// A minimal zip reader for tests of the backup export
// (src/extension/zip-writer.ts): reads the central directory, then each
// entry's data, and checks its CRC. Independent of the writer, so a
// test reading back what it wrote checks the format, not the code
// against itself.

import zlib from 'node:zlib';

// Every entry: { path, data (Buffer), method, flags, crc }.
export function readZip(bytes) {
  const buf = Buffer.from(bytes);
  let end = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('No end-of-central-directory record');
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error(`Bad central header at ${at}`);
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const crc = buf.readUInt32LE(at + 16);
    const compSize = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const localAt = buf.readUInt32LE(at + 42);
    const path = buf.subarray(at + 46, at + 46 + nameLen).toString('utf8');
    at += 46 + nameLen + extraLen + commentLen;

    if (buf.readUInt32LE(localAt) !== 0x04034b50) throw new Error(`Bad local header for ${path}`);
    const localName = buf.readUInt16LE(localAt + 26);
    const localExtra = buf.readUInt16LE(localAt + 28);
    const start = localAt + 30 + localName + localExtra;
    const raw = buf.subarray(start, start + compSize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : method === 0 ? Buffer.from(raw) : null;
    if (!data) throw new Error(`Unsupported method ${method} for ${path}`);
    if (data.length !== size) throw new Error(`Size mismatch for ${path}`);
    if (zlib.crc32(data) !== crc) throw new Error(`CRC mismatch for ${path}`);
    entries.push({ path, data, method, flags, crc });
  }
  return entries;
}
