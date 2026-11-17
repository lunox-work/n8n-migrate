// Synchronous hashes, HMAC and base64 for expressions and the Crypto node.
// Expressions are synchronous in n8n (`"x".hash("sha256")`), so WebCrypto (async) cannot
// serve them; these are small textbook implementations (RFC 1321, FIPS 180-4, FIPS 202).

export function utf8Bytes(s) {
  return new TextEncoder().encode(String(s));
}
export function utf8Decode(bytes) {
  return new TextDecoder().decode(bytes);
}
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

// ---------- base64 (js-base64 semantics: UTF-8 text) ----------
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
export function bytesToBase64(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : "=") + (i + 2 < bytes.length ? B64[n & 63] : "=");
  }
  return out;
}
export function base64ToBytes(s) {
  const clean = String(s).replace(/[-_]/g, (c) => (c === "-" ? "+" : "/")).replace(/[^A-Za-z0-9+/]/g, "");
  const out = [];
  let buf = 0;
  let bits = 0;
  for (const c of clean) {
    buf = (buf << 6) | B64.indexOf(c);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 255);
    }
  }
  return new Uint8Array(out);
}
export const toBase64 = (s) => bytesToBase64(utf8Bytes(s));
export const fromBase64 = (s) => utf8Decode(base64ToBytes(s));

// ---------- MD5 ----------
const MD5_S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
const MD5_K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);
function md5Bytes(msg) {
  const len = msg.length;
  const total = (((len + 8) >> 6) + 1) * 64;
  const m = new Uint8Array(total);
  m.set(msg);
  m[len] = 0x80;
  const bitLen = len * 8;
  for (let i = 0; i < 8; i++) m[total - 8 + i] = Math.floor(bitLen / 2 ** (8 * i)) & 255;
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const w = new Uint32Array(16);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = m[off + i * 4] | (m[off + i * 4 + 1] << 8) | (m[off + i * 4 + 2] << 16) | (m[off + i * 4 + 3] << 24);
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f, g;
      if (i < 16) [f, g] = [(b & c) | (~b & d), i];
      else if (i < 32) [f, g] = [(d & b) | (~d & c), (5 * i + 1) % 16];
      else if (i < 48) [f, g] = [b ^ c ^ d, (3 * i + 5) % 16];
      else [f, g] = [c ^ (b | ~d), (7 * i) % 16];
      const tmp = d;
      d = c;
      c = b;
      const x = (a + f + MD5_K[i] + w[g]) >>> 0;
      b = (b + ((x << MD5_S[i]) | (x >>> (32 - MD5_S[i])))) >>> 0;
      a = tmp;
    }
    a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0;
  }
  const out = new Uint8Array(16);
  [a0, b0, c0, d0].forEach((v, i) => { for (let j = 0; j < 4; j++) out[i * 4 + j] = (v >>> (8 * j)) & 255; });
  return out;
}

// ---------- SHA-1 / SHA-2 (32-bit) ----------
function pad64(msg) {
  const len = msg.length;
  const total = (((len + 8) >> 6) + 1) * 64;
  const m = new Uint8Array(total);
  m.set(msg);
  m[len] = 0x80;
  const bitLen = len * 8;
  for (let i = 0; i < 8; i++) m[total - 1 - i] = Math.floor(bitLen / 2 ** (8 * i)) & 255;
  return m;
}
const rotr = (x, n) => (x >>> n) | (x << (32 - n));
function sha1Bytes(msg) {
  const m = pad64(msg);
  let h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const w = new Uint32Array(80);
  for (let off = 0; off < m.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = (m[off + 4 * i] << 24) | (m[off + 4 * i + 1] << 16) | (m[off + 4 * i + 2] << 8) | m[off + 4 * i + 3];
    for (let i = 16; i < 80; i++) { const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]; w[i] = (x << 1) | (x >>> 31); }
    let [a, b, c, d, e] = h;
    for (let i = 0; i < 80; i++) {
      const [f, k] = i < 20 ? [(b & c) | (~b & d), 0x5a827999] : i < 40 ? [b ^ c ^ d, 0x6ed9eba1] : i < 60 ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc] : [b ^ c ^ d, 0xca62c1d6];
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) >>> 0;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t;
    }
    h = h.map((v, i) => (v + [a, b, c, d, e][i]) >>> 0);
  }
  return words32ToBytes(h);
}
function words32ToBytes(ws) {
  const out = new Uint8Array(ws.length * 4);
  ws.forEach((v, i) => { out[4 * i] = v >>> 24; out[4 * i + 1] = (v >>> 16) & 255; out[4 * i + 2] = (v >>> 8) & 255; out[4 * i + 3] = v & 255; });
  return out;
}
const K256 = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
function sha256Bytes(msg, is224 = false) {
  const m = pad64(msg);
  let h = is224
    ? [0xc1059ed8, 0x367cd507, 0x3070dd17, 0xf70e5939, 0xffc00b31, 0x68581511, 0x64f98fa7, 0xbefa4fa4]
    : [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Uint32Array(64);
  for (let off = 0; off < m.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = (m[off + 4 * i] << 24) | (m[off + 4 * i + 1] << 16) | (m[off + 4 * i + 2] << 8) | m[off + 4 * i + 3];
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const t1 = (hh + S1 + ((e & f) ^ (~e & g)) + K256[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h = h.map((v, i) => (v + [a, b, c, d, e, f, g, hh][i]) >>> 0);
  }
  return words32ToBytes(is224 ? h.slice(0, 7) : h);
}

// ---------- SHA-512 / SHA-384 (BigInt) ----------
const K512 = [
  "428a2f98d728ae22", "7137449123ef65cd", "b5c0fbcfec4d3b2f", "e9b5dba58189dbbc", "3956c25bf348b538", "59f111f1b605d019", "923f82a4af194f9b", "ab1c5ed5da6d8118", "d807aa98a3030242", "12835b0145706fbe",
  "243185be4ee4b28c", "550c7dc3d5ffb4e2", "72be5d74f27b896f", "80deb1fe3b1696b1", "9bdc06a725c71235", "c19bf174cf692694", "e49b69c19ef14ad2", "efbe4786384f25e3", "0fc19dc68b8cd5b5", "240ca1cc77ac9c65",
  "2de92c6f592b0275", "4a7484aa6ea6e483", "5cb0a9dcbd41fbd4", "76f988da831153b5", "983e5152ee66dfab", "a831c66d2db43210", "b00327c898fb213f", "bf597fc7beef0ee4", "c6e00bf33da88fc2", "d5a79147930aa725",
  "06ca6351e003826f", "142929670a0e6e70", "27b70a8546d22ffc", "2e1b21385c26c926", "4d2c6dfc5ac42aed", "53380d139d95b3df", "650a73548baf63de", "766a0abb3c77b2a8", "81c2c92e47edaee6", "92722c851482353b",
  "a2bfe8a14cf10364", "a81a664bbc423001", "c24b8b70d0f89791", "c76c51a30654be30", "d192e819d6ef5218", "d69906245565a910", "f40e35855771202a", "106aa07032bbd1b8", "19a4c116b8d2d0c8", "1e376c085141ab53",
  "2748774cdf8eeb99", "34b0bcb5e19b48a8", "391c0cb3c5c95a63", "4ed8aa4ae3418acb", "5b9cca4f7763e373", "682e6ff3d6b2b8a3", "748f82ee5defb2fc", "78a5636f43172f60", "84c87814a1f0ab72", "8cc702081a6439ec",
  "90befffa23631e28", "a4506cebde82bde9", "bef9a3f7b2c67915", "c67178f2e372532b", "ca273eceea26619c", "d186b8c721c0c207", "eada7dd6cde0eb1e", "f57d4f7fee6ed178", "06f067aa72176fba", "0a637dc5a2c898a6",
  "113f9804bef90dae", "1b710b35131c471b", "28db77f523047d84", "32caab7b40c72493", "3c9ebe0a15c9bebc", "431d67c49c100d4c", "4cc5d4becb3e42b6", "597f299cfc657e2a", "5fcb6fab3ad6faec", "6c44198c4a475817",
].map((x) => BigInt("0x" + x));
const M64 = (1n << 64n) - 1n;
const rotr64 = (x, n) => ((x >> n) | (x << (64n - n))) & M64;
function sha512Bytes(msg, is384 = false) {
  const len = msg.length;
  const total = (((len + 16) >> 7) + 1) * 128;
  const m = new Uint8Array(total);
  m.set(msg);
  m[len] = 0x80;
  const bitLen = len * 8;
  for (let i = 0; i < 8; i++) m[total - 1 - i] = Math.floor(bitLen / 2 ** (8 * i)) & 255;
  let h = (is384
    ? ["cbbb9d5dc1059ed8", "629a292a367cd507", "9159015a3070dd17", "152fecd8f70e5939", "67332667ffc00b31", "8eb44a8768581511", "db0c2e0d64f98fa7", "47b5481dbefa4fa4"]
    : ["6a09e667f3bcc908", "bb67ae8584caa73b", "3c6ef372fe94f82b", "a54ff53a5f1d36f1", "510e527fade682d1", "9b05688c2b3e6c1f", "1f83d9abfb41bd6b", "5be0cd19137e2179"]
  ).map((x) => BigInt("0x" + x));
  const w = new Array(80);
  for (let off = 0; off < total; off += 128) {
    for (let i = 0; i < 16; i++) {
      let v = 0n;
      for (let j = 0; j < 8; j++) v = (v << 8n) | BigInt(m[off + 8 * i + j]);
      w[i] = v;
    }
    for (let i = 16; i < 80; i++) {
      const s0 = rotr64(w[i - 15], 1n) ^ rotr64(w[i - 15], 8n) ^ (w[i - 15] >> 7n);
      const s1 = rotr64(w[i - 2], 19n) ^ rotr64(w[i - 2], 61n) ^ (w[i - 2] >> 6n);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) & M64;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 80; i++) {
      const S1 = rotr64(e, 14n) ^ rotr64(e, 18n) ^ rotr64(e, 41n);
      const t1 = (hh + S1 + ((e & f) ^ (~e & M64 & g)) + K512[i] + w[i]) & M64;
      const S0 = rotr64(a, 28n) ^ rotr64(a, 34n) ^ rotr64(a, 39n);
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) & M64;
      hh = g; g = f; f = e; e = (d + t1) & M64; d = c; c = b; b = a; a = (t1 + t2) & M64;
    }
    h = h.map((v, i) => (v + [a, b, c, d, e, f, g, hh][i]) & M64);
  }
  const words = is384 ? h.slice(0, 6) : h;
  const out = new Uint8Array(words.length * 8);
  words.forEach((v, i) => { for (let j = 0; j < 8; j++) out[8 * i + j] = Number((v >> BigInt(56 - 8 * j)) & 255n); });
  return out;
}

// ---------- SHA3-512 (Keccak-f[1600]) ----------
const RC = [
  "0000000000000001", "0000000000008082", "800000000000808a", "8000000080008000", "000000000000808b", "0000000080000001", "8000000080008081", "8000000000008009", "000000000000008a", "0000000000000088",
  "0000000080008009", "000000008000000a", "000000008000808b", "800000000000008b", "8000000000008089", "8000000000008003", "8000000000008002", "8000000000000080", "000000000000800a", "800000008000000a",
  "8000000080008081", "8000000000008080", "0000000080000001", "8000000080008008",
].map((x) => BigInt("0x" + x));
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14].map(BigInt);
const rotl64 = (x, n) => (n === 0n ? x : ((x << n) | (x >> (64n - n))) & M64);
function keccakF(s) {
  for (let round = 0; round < 24; round++) {
    const c = [0, 1, 2, 3, 4].map((x) => s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20]);
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl64(c[(x + 1) % 5], 1n);
      for (let y = 0; y < 25; y += 5) s[x + y] ^= d;
    }
    const b = new Array(25);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl64(s[x + 5 * y], ROT[x + 5 * y]);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) s[x + 5 * y] = b[x + 5 * y] ^ (~b[((x + 1) % 5) + 5 * y] & M64 & b[((x + 2) % 5) + 5 * y]);
    s[0] ^= RC[round];
  }
}
function sha3_512Bytes(msg) {
  const rate = 72;
  const padded = new Uint8Array(Math.ceil((msg.length + 1) / rate) * rate);
  padded.set(msg);
  padded[msg.length] ^= 0x06;
  padded[padded.length - 1] ^= 0x80;
  const s = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let v = 0n;
      for (let j = 7; j >= 0; j--) v = (v << 8n) | BigInt(padded[off + 8 * i + j]);
      s[i] ^= v;
    }
    keccakF(s);
  }
  const out = new Uint8Array(64);
  for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) out[8 * i + j] = Number((s[i] >> BigInt(8 * j)) & 255n);
  return out;
}

const ALGOS = {
  md5: [md5Bytes, 64],
  sha1: [sha1Bytes, 64],
  sha224: [(m) => sha256Bytes(m, true), 64],
  sha256: [(m) => sha256Bytes(m), 64],
  sha384: [(m) => sha512Bytes(m, true), 128],
  sha512: [(m) => sha512Bytes(m), 128],
  "sha3-512": [sha3_512Bytes, 72],
};
export const HASH_ALGORITHMS = Object.keys(ALGOS);

export function digestBytes(algorithm, data) {
  const a = ALGOS[String(algorithm).toLowerCase()];
  if (!a) throw new Error(`Unknown hash algorithm ${algorithm}`);
  return a[0](typeof data === "string" ? utf8Bytes(data) : data);
}

export function hashHex(algorithm, data) {
  return hex(digestBytes(algorithm, data));
}

export function hmacBytes(algorithm, key, data) {
  const a = ALGOS[String(algorithm).toLowerCase()];
  if (!a) throw new Error(`Unknown hash algorithm ${algorithm}`);
  const [fn, block] = a;
  let k = typeof key === "string" ? utf8Bytes(key) : key;
  if (k.length > block) k = fn(k);
  const kp = new Uint8Array(block);
  kp.set(k);
  const msg = typeof data === "string" ? utf8Bytes(data) : data;
  const inner = new Uint8Array(block + msg.length);
  const outer = new Uint8Array(block + (fn === md5Bytes ? 16 : fn(new Uint8Array(0)).length));
  for (let i = 0; i < block; i++) {
    inner[i] = kp[i] ^ 0x36;
    outer[i] = kp[i] ^ 0x5c;
  }
  inner.set(msg, block);
  outer.set(fn(inner), block);
  return fn(outer);
}

export const toHex = hex;
