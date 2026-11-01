/**
 * Minimal streaming ZIP reader (stored + deflate, ZIP64 aware). The national GTFS archive is
 * large and stop_times.txt is millions of rows, so entries are streamed, never loaded whole.
 */
import { createInflateRaw } from "node:zlib";
import { Readable } from "node:stream";

export interface ZipEntry {
  name: string;
  method: number; // 0 stored, 8 deflate
  compressedSize: number;
  localHeaderOffset: number;
}

async function readBytes(path: string, start: number, end: number): Promise<DataView> {
  const buf = await Bun.file(path).slice(start, end).arrayBuffer();
  return new DataView(buf);
}

export async function listZip(path: string): Promise<ZipEntry[]> {
  const size = Bun.file(path).size;
  const tailLen = Math.min(size, 65_557 + 20);
  const tail = await readBytes(path, size - tailLen, size);
  // End of central directory record
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip file");
  let cdSize = tail.getUint32(eocd + 12, true);
  let cdOffset = tail.getUint32(eocd + 16, true);
  let count = tail.getUint16(eocd + 10, true);
  // ZIP64 locator sits 20 bytes before the EOCD
  if (cdOffset === 0xffffffff || count === 0xffff) {
    const loc = eocd - 20;
    if (loc >= 0 && tail.getUint32(loc, true) === 0x07064b50) {
      const z64Off = Number(tail.getBigUint64(loc + 8, true));
      const z = await readBytes(path, z64Off, z64Off + 56);
      count = Number(z.getBigUint64(32, true));
      cdSize = Number(z.getBigUint64(40, true));
      cdOffset = Number(z.getBigUint64(48, true));
    }
  }
  const cd = await readBytes(path, cdOffset, cdOffset + cdSize);
  const entries: ZipEntry[] = [];
  let p = 0;
  const dec = new TextDecoder();
  for (let n = 0; n < count && p < cd.byteLength; n++) {
    if (cd.getUint32(p, true) !== 0x02014b50) break;
    const method = cd.getUint16(p + 10, true);
    let compressedSize = cd.getUint32(p + 20, true);
    let uncompressed = cd.getUint32(p + 24, true);
    const nameLen = cd.getUint16(p + 28, true);
    const extraLen = cd.getUint16(p + 30, true);
    const commentLen = cd.getUint16(p + 32, true);
    let localHeaderOffset = cd.getUint32(p + 42, true);
    const name = dec.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen));
    // ZIP64 extra field
    let e = p + 46 + nameLen;
    const eEnd = e + extraLen;
    while (e + 4 <= eEnd) {
      const id = cd.getUint16(e, true);
      const len = cd.getUint16(e + 2, true);
      if (id === 0x0001) {
        let q = e + 4;
        if (uncompressed === 0xffffffff) { uncompressed = Number(cd.getBigUint64(q, true)); q += 8; }
        if (compressedSize === 0xffffffff) { compressedSize = Number(cd.getBigUint64(q, true)); q += 8; }
        if (localHeaderOffset === 0xffffffff) { localHeaderOffset = Number(cd.getBigUint64(q, true)); }
      }
      e += 4 + len;
    }
    entries.push({ name, method, compressedSize, localHeaderOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Stream an entry's text line by line. */
export async function* zipLines(path: string, entry: ZipEntry): AsyncGenerator<string> {
  const lh = await readBytes(path, entry.localHeaderOffset, entry.localHeaderOffset + 30);
  const dataStart = entry.localHeaderOffset + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
  const raw = Readable.fromWeb(Bun.file(path).slice(dataStart, dataStart + entry.compressedSize).stream() as any);
  const stream = entry.method === 8 ? raw.pipe(createInflateRaw()) : raw;
  const dec = new TextDecoder("utf-8");
  let rest = "";
  for await (const chunk of stream) {
    rest += dec.decode(chunk as Uint8Array, { stream: true });
    let i: number;
    while ((i = rest.indexOf("\n")) >= 0) {
      yield rest.slice(0, i).replace(/\r$/, "");
      rest = rest.slice(i + 1);
    }
  }
  rest += dec.decode();
  if (rest) yield rest.replace(/\r$/, "");
}
