/**
 * Host-side AUTH response for cryptX ledger firmware v5 (SipHash-2-4).
 * Pepper bytes MUST match firmware/ledger/ledger.ino (loadPepperK0 / loadPepperK1).
 * Auth key is derived from chip signature + EEPROM salt + device ID — read from
 * the META:SIG=...;SALT=... line emitted on boot (or via the META command).
 */

const MASK64 = (1n << 64n) - 1n;

function u64ToLe(x: bigint): Uint8Array {
  const out = new Uint8Array(8);
  let v = x & MASK64;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function u8To64Le(p: Uint8Array, off: number): bigint {
  let v = 0n;
  for (let i = 0; i < 8; i++) v |= BigInt(p[off + i]!) << (8n * BigInt(i));
  return v & MASK64;
}

function rotl(x: bigint, b: number): bigint {
  return ((x << BigInt(b)) | (x >> BigInt(64 - b))) & MASK64;
}

function sipRound(
  v0: bigint,
  v1: bigint,
  v2: bigint,
  v3: bigint,
): [bigint, bigint, bigint, bigint] {
  let a = v0,
    b = v1,
    c = v2,
    d = v3;
  a = (a + b) & MASK64;
  b = rotl(b, 13);
  b ^= a;
  a = rotl(a, 32);
  c = (c + d) & MASK64;
  d = rotl(d, 16);
  d ^= c;
  a = (a + d) & MASK64;
  d = rotl(d, 21);
  d ^= a;
  c = (c + b) & MASK64;
  b = rotl(b, 17);
  b ^= c;
  c = rotl(c, 32);
  return [a, b, c, d];
}

/** SipHash-2-4, 64-bit tag (test: zero key, empty msg → 1e924b9d737700d7). */
export function siphash24(key16: Uint8Array, msg: Uint8Array): bigint {
  const k0 = u8To64Le(key16, 0);
  const k1 = u8To64Le(key16, 8);
  let v0 = k0 ^ 0x736f6d6570736575n;
  let v1 = k1 ^ 0x646f72616e646f6dn;
  let v2 = k0 ^ 0x6c7967656e657261n;
  let v3 = k1 ^ 0x7465646279746573n;
  let off = 0;
  const len = msg.length;
  const left = len & 7;
  const end = len - left;
  while (off < end) {
    const m = u8To64Le(msg, off);
    v3 ^= m;
    for (let i = 0; i < 2; i++) [v0, v1, v2, v3] = sipRound(v0, v1, v2, v3);
    v0 ^= m;
    off += 8;
  }
  let b = (BigInt(len) << 56n) & MASK64;
  for (let i = 0; i < left; i++) b |= BigInt(msg[off + i]!) << (8n * BigInt(i));
  v3 ^= b;
  for (let i = 0; i < 2; i++) [v0, v1, v2, v3] = sipRound(v0, v1, v2, v3);
  v0 ^= b;
  v2 ^= 0xffn;
  for (let i = 0; i < 4; i++) [v0, v1, v2, v3] = sipRound(v0, v1, v2, v3);
  return (v0 ^ v1 ^ v2 ^ v3) & MASK64;
}

/** Must match ledger.ino loadPepperK0 */
export function loadPepperK0(): Uint8Array {
  const k = new Uint8Array(16);
  const s = [0x4b, 0x72, 0x79, 0x70, 0x74, 0x58, 0x21, 0x01];
  for (let i = 0; i < 16; i++) {
    k[i] = (s[i % 8]! ^ (i * 17 + 3)) & 0xff;
  }
  return k;
}

/** Must match ledger.ino loadPepperK1 */
export function loadPepperK1(): Uint8Array {
  const k = new Uint8Array(16);
  const s = [0x58, 0x21, 0x4b, 0x01, 0x72, 0x79, 0x70, 0x74];
  for (let i = 0; i < 16; i++) {
    k[i] = (s[i % 8]! ^ (i * 31 + 5)) & 0xff;
  }
  return k;
}

function buildAuthMaterial(
  sig3: [number, number, number],
  salt8: Uint8Array,
  deviceId: string,
): Uint8Array {
  const buf = new Uint8Array(16);
  buf[0] = sig3[0] & 0xff;
  buf[1] = sig3[1] & 0xff;
  buf[2] = sig3[2] & 0xff;
  buf.set(salt8.subarray(0, 8), 3);
  buf[11] = deviceId.charCodeAt(0) & 0xff;
  buf[12] = 0x63;
  buf[13] = 0x72;
  buf[14] = 0x79;
  buf[15] = 0x70;
  return buf;
}

export function deriveAuthKey(
  sig3: [number, number, number],
  salt8: Uint8Array,
  deviceId: string,
): Uint8Array {
  const mat = buildAuthMaterial(sig3, salt8, deviceId);
  const pk0 = loadPepperK0();
  const pk1 = loadPepperK1();
  const ha = siphash24(pk0, mat);
  const hb = siphash24(pk1, mat);
  const out = new Uint8Array(16);
  out.set(u64ToLe(ha), 0);
  out.set(u64ToLe(hb), 8);
  return out;
}

/** 8-byte nonce from NONCE: line (16 hex chars, no prefix). */
export function parseNonceHex16(hex: string): Uint8Array {
  const h = hex.trim();
  if (h.length !== 16) throw new Error("nonce must be 16 hex chars");
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** 16 uppercase hex chars matching firmware AUTH expectation. */
export function computeAuthHex(
  sig3: [number, number, number],
  salt8: Uint8Array,
  deviceId: string,
  nonce8: Uint8Array,
): string {
  const authKey = deriveAuthKey(sig3, salt8, deviceId);
  const tag = siphash24(authKey, nonce8);
  const bytes = u64ToLe(tag);
  let s = "";
  for (let i = 0; i < 8; i++) {
    s += bytes[i]!.toString(16).toUpperCase().padStart(2, "0");
  }
  return s;
}
