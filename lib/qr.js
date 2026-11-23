// Dependency-free QR code encoder (ISO/IEC 18004): byte mode, error correction level M,
// versions 1-10 (up to 213 bytes, plenty for a URL). Also renders the code as a 1-bit PNG.
// The structure follows the well-known Project Nayuki reference design (MIT).

// ECC level M: [total codewords, EC codewords per block, [[blocks, data codewords per block], ...]]
const VERSIONS = {
  1: [26, 10, [[1, 16]]],
  2: [44, 16, [[1, 28]]],
  3: [70, 26, [[1, 44]]],
  4: [100, 18, [[2, 32]]],
  5: [134, 24, [[2, 43]]],
  6: [172, 16, [[4, 27]]],
  7: [196, 18, [[4, 31]]],
  8: [242, 22, [[2, 38], [2, 39]]],
  9: [292, 22, [[3, 36], [2, 37]]],
  10: [346, 26, [[4, 43], [1, 44]]],
};
const ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };
const FORMAT_BITS_M = 0; // ECC level M

// ---------- Reed-Solomon over GF(256), polynomial 0x11D ----------
function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}
function rsDivisor(degree) {
  const r = new Array(degree).fill(0);
  r[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      r[j] = gfMul(r[j], root);
      if (j + 1 < degree) r[j] ^= r[j + 1];
    }
    root = gfMul(root, 2);
  }
  return r;
}
function rsRemainder(data, divisor) {
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    divisor.forEach((coef, i) => { result[i] ^= gfMul(coef, factor); });
  }
  return result;
}

// ---------- data codewords ----------
function encodeData(bytes, version) {
  const [, , groups] = VERSIONS[version];
  const dataCap = groups.reduce((n, [b, d]) => n + b * d, 0);
  const bits = [];
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  push(0b0100, 4);
  push(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  const capBits = dataCap * 8;
  push(0, Math.min(4, capBits - bits.length));
  while (bits.length % 8) bits.push(0);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0xec; out.length < dataCap; pad ^= 0xec ^ 0x11) out.push(pad);
  return out;
}

function addEccAndInterleave(data, version) {
  const [, ecLen, groups] = VERSIONS[version];
  const divisor = rsDivisor(ecLen);
  const blocks = [];
  let k = 0;
  for (const [count, len] of groups) {
    for (let i = 0; i < count; i++) {
      const d = data.slice(k, k + len);
      k += len;
      blocks.push({ d, e: rsRemainder(d, divisor) });
    }
  }
  const out = [];
  const maxD = Math.max(...blocks.map((b) => b.d.length));
  for (let i = 0; i < maxD; i++) for (const b of blocks) if (i < b.d.length) out.push(b.d[i]);
  for (let i = 0; i < ecLen; i++) for (const b of blocks) out.push(b.e[i]);
  return out;
}

// ---------- matrix ----------
function buildMatrix(version, codewords, mask) {
  const size = version * 4 + 17;
  const m = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => { m[y][x] = dark; fn[y][x] = true; };

  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      set(x, y, d !== 2 && d !== 4);
    }
  }
  const al = ALIGN[version];
  for (let i = 0; i < al.length; i++) for (let j = 0; j < al.length; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      set(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
  drawFormat(set, size, mask); // reserves the format areas (redrawn after masking)
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3), b = Math.floor(i / 3);
      set(a, b, dark);
      set(b, a, dark);
    }
  }

  // Data, in the zigzag order, skipping function modules.
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!fn[y][x] && i < codewords.length * 8) {
          m[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
          i++;
        }
      }
    }
  }

  // Mask
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (fn[y][x]) continue;
    let inv;
    switch (mask) {
      case 0: inv = (x + y) % 2 === 0; break;
      case 1: inv = y % 2 === 0; break;
      case 2: inv = x % 3 === 0; break;
      case 3: inv = (x + y) % 3 === 0; break;
      case 4: inv = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
      case 5: inv = ((x * y) % 2) + ((x * y) % 3) === 0; break;
      case 6: inv = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
      default: inv = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    }
    if (inv) m[y][x] = !m[y][x];
  }
  drawFormat(set, size, mask);
  return m;
}

function drawFormat(set, size, mask) {
  const data = (FORMAT_BITS_M << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const bit = (i) => ((bits >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) set(8, i, bit(i));
  set(8, 7, bit(6));
  set(8, 8, bit(7));
  set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
  set(8, size - 8, true); // dark module
}

function penalty(m) {
  const size = m.length;
  let p = 0;
  // N1: runs of 5+ same-colored modules in rows and columns
  for (let pass = 0; pass < 2; pass++) {
    for (let a = 0; a < size; a++) {
      let run = 1;
      for (let b = 1; b < size; b++) {
        const cur = pass ? m[b][a] : m[a][b];
        const prev = pass ? m[b - 1][a] : m[a][b - 1];
        if (cur === prev) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else run = 1;
      }
    }
  }
  // N2: 2x2 blocks
  for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
    const c = m[y][x];
    if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) p += 3;
  }
  // N3: finder-like patterns 1011101 with 4 light modules on one side
  const pat = [true, false, true, true, true, false, true];
  const matchAt = (get, i) => pat.every((v, k) => get(i + k) === v);
  const light = (get, from, to) => { for (let k = from; k < to; k++) if (k >= 0 && k < size && get(k)) return false; return true; };
  for (let a = 0; a < size; a++) {
    for (const get of [(k) => m[a][k], (k) => m[k][a]]) {
      for (let i = 0; i + 7 <= size; i++) {
        if (matchAt(get, i) && (light(get, i - 4, i) || light(get, i + 7, i + 11))) p += 40;
      }
    }
  }
  // N4: dark/light balance
  let dark = 0;
  for (const row of m) for (const c of row) if (c) dark++;
  p += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
  return p;
}

// Returns a square boolean matrix (true = dark), without the quiet zone.
export function qrMatrix(text) {
  const bytes = new TextEncoder().encode(text);
  let version = 0;
  for (let v = 1; v <= 10; v++) {
    const cap = VERSIONS[v][2].reduce((n, [b, d]) => n + b * d, 0);
    const need = Math.ceil((4 + (v < 10 ? 8 : 16) + bytes.length * 8) / 8);
    if (need <= cap) { version = v; break; }
  }
  if (!version) throw new Error('That text is too long for a QR code here (max about 210 characters).');
  const codewords = addEccAndInterleave(encodeData(bytes, version), version);
  let best = null, bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const m = buildMatrix(version, codewords, mask);
    const s = penalty(m);
    if (s < bestScore) { best = m; bestScore = s; }
  }
  return best;
}

// ---------- PNG (1-bit grayscale, stored deflate) ----------
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function u32(n) { return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]; }
function chunk(type, data) {
  const td = [...new TextEncoder().encode(type), ...data];
  return [...u32(data.length), ...td, ...u32(crc32(td))];
}
function zlibStored(raw) {
  const out = [0x78, 0x01];
  for (let i = 0; i < raw.length || i === 0; i += 65535) {
    const block = raw.subarray(i, i + 65535);
    const last = i + 65535 >= raw.length ? 1 : 0;
    out.push(last, block.length & 255, block.length >>> 8, ~block.length & 255, (~block.length >>> 8) & 255, ...block);
  }
  let a = 1, b = 0;
  for (const x of raw) { a = (a + x) % 65521; b = (b + a) % 65521; }
  out.push(...u32(((b << 16) | a) >>> 0));
  return out;
}

// PNG bytes for a QR code: `scale` pixels per module, 4-module quiet zone.
export function qrPng(text, scale = 10) {
  const m = qrMatrix(text);
  const border = 4;
  const px = (m.length + border * 2) * scale;
  const rowBytes = Math.ceil(px / 8);
  const raw = new Uint8Array((rowBytes + 1) * px);
  for (let y = 0; y < px; y++) {
    const my = Math.floor(y / scale) - border;
    raw[y * (rowBytes + 1)] = 0; // filter: none
    for (let x = 0; x < px; x++) {
      const mx = Math.floor(x / scale) - border;
      const dark = my >= 0 && mx >= 0 && my < m.length && mx < m.length && m[my][mx];
      if (!dark) raw[y * (rowBytes + 1) + 1 + (x >> 3)] |= 0x80 >>> (x & 7); // 1 = white
    }
  }
  const ihdr = [...u32(px), ...u32(px), 1, 0, 0, 0, 0]; // 1-bit grayscale
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk('IHDR', ihdr),
    ...chunk('IDAT', zlibStored(raw)),
    ...chunk('IEND', []),
  ]);
}
