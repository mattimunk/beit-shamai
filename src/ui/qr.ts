/**
 * Minimal QR code generator (ISO/IEC 18004): byte mode, error correction level M,
 * versions 1–10 (up to 213 bytes – plenty for a link). Returns the module matrix;
 * `qrSvg` draws it with a quiet zone.
 */

// [total codewords, error-correction blocks, EC codewords per block] for level M.
const M_TABLE: [number, number, number][] = [
  [0, 0, 0], [26, 1, 10], [44, 1, 16], [70, 1, 26], [100, 2, 18], [134, 2, 24],
  [172, 4, 16], [196, 4, 18], [242, 4, 22], [292, 5, 22], [346, 5, 26],
];
const ALIGN: number[][] = [[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree: number): number[] {
  const r = new Array(degree).fill(0);
  r[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < r.length; j++) {
      r[j] = gfMul(r[j], root);
      if (j + 1 < r.length) r[j] ^= r[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return r;
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const r = new Array(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ r.shift()!;
    r.push(0);
    divisor.forEach((c, i) => { r[i] ^= gfMul(c, factor); });
  }
  return r;
}

export function qrMatrix(text: string): boolean[][] {
  const bytes = Array.from(new TextEncoder().encode(text));
  let ver = 1;
  for (; ver <= 10; ver++) {
    const [total, blocks, ecc] = M_TABLE[ver]!;
    const capacityBits = (total - blocks * ecc) * 8;
    if (4 + (ver < 10 ? 8 : 16) + bytes.length * 8 <= capacityBits) break;
  }
  if (ver > 10) throw new Error("text too long for a QR code");
  const [total, numBlocks, eccLen] = M_TABLE[ver]!;
  const dataCap = total - numBlocks * eccLen;

  // Bit stream: mode 0100, length, bytes, terminator, padding.
  const bits: number[] = [];
  const put = (v: number, n: number) => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
  put(4, 4);
  put(bytes.length, ver < 10 ? 8 : 16);
  bytes.forEach((b) => put(b, 8));
  put(0, Math.min(4, dataCap * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(""), 2));
  for (let pad = 0xec; data.length < dataCap; pad ^= 0xec ^ 0x11) data.push(pad);

  // Split into blocks, add error correction, interleave.
  const numShort = numBlocks - (total % numBlocks);
  const shortLen = Math.floor(total / numBlocks);
  const div = rsDivisor(eccLen);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, div);
    if (i < numShort) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const codewords: number[] = [];
  for (let i = 0; i < blocks[0]!.length; i++)
    for (let j = 0; j < blocks.length; j++)
      if (i !== shortLen - eccLen || j >= numShort) codewords.push(blocks[j]![i]!);

  // Function patterns.
  const size = ver * 4 + 17;
  const mod: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x: number, y: number, dark: boolean) => { mod[y]![x] = dark; fn[y]![x] = true; };
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  const finder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy, d = Math.max(Math.abs(dx), Math.abs(dy));
      if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
    }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  const al = ALIGN[ver]!;
  for (let i = 0; i < al.length; i++) for (let j = 0; j < al.length; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(al[i]! + dx, al[j]! + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  const drawFormat = (mask: number) => {
    const d = (0 << 3) | mask; // level M = 00
    let rem = d;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const b = ((d << 10) | rem) ^ 0x5412;
    const bit = (i: number) => ((b >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  drawFormat(0);
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const b = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((b >>> i) & 1) !== 0, a = size - 11 + (i % 3), c = Math.floor(i / 3);
      set(a, c, dark); set(c, a, dark);
    }
  }

  // Data, in the zigzag order.
  let k = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let v = 0; v < size; v++) for (let j = 0; j < 2; j++) {
      const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - v : v;
      if (!fn[y]![x] && k < codewords.length * 8) { mod[y]![x] = ((codewords[k >>> 3]! >>> (7 - (k & 7))) & 1) !== 0; k++; }
    }
  }

  // Pick the mask with the lowest penalty.
  const maskFn = [
    (x: number, y: number) => (x + y) % 2 === 0, (_x: number, y: number) => y % 2 === 0, (x: number) => x % 3 === 0,
    (x: number, y: number) => (x + y) % 3 === 0, (x: number, y: number) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x: number, y: number) => ((x * y) % 2) + ((x * y) % 3) === 0, (x: number, y: number) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x: number, y: number) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];
  const applyMask = (m: number) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y]![x] && maskFn[m]!(x, y)) mod[y]![x] = !mod[y]![x];
  };
  const penalty = () => {
    let p = 0, dark = 0;
    const line = (get: (i: number) => boolean) => {
      let run = 1;
      for (let i = 1; i <= size; i++) {
        if (i < size && get(i) === get(i - 1)) run++;
        else { if (run >= 5) p += run - 2; run = 1; }
      }
      const pat = [true, false, true, true, true, false, true];
      for (let i = 0; i + 7 <= size; i++) {
        if (!pat.every((v, k2) => get(i + k2) === v)) continue;
        const before = i >= 4 && [1, 2, 3, 4].every((d) => !get(i - d));
        const after = i + 11 <= size && [7, 8, 9, 10].every((d) => !get(i + d));
        if (before || after) p += 40;
      }
    };
    for (let y = 0; y < size; y++) line((i) => mod[y]![i]!);
    for (let x = 0; x < size; x++) line((i) => mod[i]![x]!);
    for (let y = 0; y + 1 < size; y++) for (let x = 0; x + 1 < size; x++) {
      const c = mod[y]![x];
      if (c === mod[y]![x + 1] && c === mod[y + 1]![x] && c === mod[y + 1]![x + 1]) p += 3;
    }
    for (const row of mod) for (const c of row) if (c) dark++;
    p += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
    return p;
  };
  let best = 0, bestP = Infinity;
  for (let m = 0; m < 8; m++) {
    applyMask(m); drawFormat(m);
    const p = penalty();
    if (p < bestP) { bestP = p; best = m; }
    applyMask(m); // undo (XOR)
  }
  applyMask(best); drawFormat(best);
  return mod;
}

/** The QR code as an SVG string (dark modules as one path, 4-module quiet zone). */
export function qrSvg(text: string, px = 220): string {
  const m = qrMatrix(text);
  const n = m.length + 8;
  let d = "";
  m.forEach((row, y) => row.forEach((c, x) => { if (c) d += `M${x + 4} ${y + 4}h1v1h-1z`; }));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${px}" height="${px}" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="#fff"/><path d="${d}" fill="#111"/></svg>`;
}
