// Platform-agnostic standard base64 (RFC 4648, with padding) over Uint8Array.
//
// Deliberately NOT using `Buffer` (absent in Hermes/RN) or `atob`/`btoa` (not
// guaranteed in Node without globals, and lossy for binary). One implementation
// must run byte-identically on Node (PC) and Hermes (mobile) so a value sealed on
// one side decodes on the other. Operates only on the envelope's nonce/ciphertext
// — never on key material or plaintext — so its timing carries no secret.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// Reverse lookup table: char code -> 6-bit value, or -1 for non-alphabet bytes.
const LOOKUP: Int8Array = (() => {
  const table = new Int8Array(256).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) table[ALPHABET.charCodeAt(i)] = i;
  return table;
})();

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out +=
      ALPHABET[(n >> 18) & 63] +
      ALPHABET[(n >> 12) & 63] +
      ALPHABET[(n >> 6) & 63] +
      ALPHABET[n & 63];
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i] << 16;
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63] + '==';
  } else if (rem === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63] + '=';
  }
  return out;
}

/**
 * Decode a standard base64 string. Throws {@link InvalidBase64Error} on any
 * malformed input (bad length, illegal char, misplaced padding) so callers can
 * map it to a typed envelope error instead of producing silently-wrong bytes.
 */
export function base64ToBytes(b64: string): Uint8Array {
  const len = b64.length;
  if (len % 4 !== 0) throw new InvalidBase64Error('length is not a multiple of 4');
  let pad = 0;
  if (len > 0 && b64.charCodeAt(len - 1) === 61 /* = */) {
    pad++;
    if (b64.charCodeAt(len - 2) === 61) pad++;
  }
  const outLen = (len / 4) * 3 - pad;
  const out = new Uint8Array(outLen);
  let o = 0;
  for (let i = 0; i < len; i += 4) {
    const c0 = LOOKUP[b64.charCodeAt(i)];
    const c1 = LOOKUP[b64.charCodeAt(i + 1)];
    const isLast = i + 4 >= len;
    const ch2 = b64.charCodeAt(i + 2);
    const ch3 = b64.charCodeAt(i + 3);
    const c2 = ch2 === 61 && isLast ? 0 : LOOKUP[ch2];
    const c3 = ch3 === 61 && isLast ? 0 : LOOKUP[ch3];
    if (c0 < 0 || c1 < 0 || c2 < 0 || c3 < 0) throw new InvalidBase64Error('illegal character');
    const n = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
    if (o < outLen) out[o++] = (n >> 16) & 0xff;
    if (o < outLen) out[o++] = (n >> 8) & 0xff;
    if (o < outLen) out[o++] = n & 0xff;
  }
  return out;
}

export class InvalidBase64Error extends Error {
  constructor(reason: string) {
    super(`invalid base64: ${reason}`);
    this.name = 'InvalidBase64Error';
  }
}
