/**
 * Minimal byte/hex/base64 helpers. Hermes provides neither Buffer nor
 * atob/btoa reliably, so these are pure JS.
 */

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[=\s]+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n =
      (b64Val(clean, i) << 18) |
      (b64Val(clean, i + 1) << 12) |
      (b64Val(clean, i + 2) << 6) |
      b64Val(clean, i + 3);
    out[o++] = (n >> 16) & 0xff;
    if (o < out.length) {
      out[o++] = (n >> 8) & 0xff;
    }
    if (o < out.length) {
      out[o++] = n & 0xff;
    }
  }
  return out;
}

function b64Val(s: string, i: number): number {
  if (i >= s.length) {
    return 0;
  }
  const v = B64_ALPHABET.indexOf(s[i]);
  if (v < 0) {
    throw new Error(`invalid base64 char at ${i}`);
  }
  return v;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const n = (b0 << 16) | (b1 << 8) | b2;
    out += B64_ALPHABET[(n >> 18) & 63];
    out += B64_ALPHABET[(n >> 12) & 63];
    out += i + 1 < bytes.length ? B64_ALPHABET[(n >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? B64_ALPHABET[n & 63] : '=';
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = '0x';
  for (const b of bytes) {
    s += b.toString(16).padStart(2, '0');
  }
  return s;
}

export function base64ToHex(b64: string): string {
  return bytesToHex(base64ToBytes(b64));
}

export function utf8ToBase64(s: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.codePointAt(i)!;
    if (c > 0xffff) {
      i++;
    }
    if (c < 0x80) {
      bytes.push(c);
    } else if (c < 0x800) {
      bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    } else if (c < 0x10000) {
      bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    } else {
      bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
  }
  return bytesToBase64(new Uint8Array(bytes));
}

export function base64ToUtf8(b64: string): string {
  const bytes = base64ToBytes(b64);
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    let cp: number;
    if (b < 0x80) {
      cp = b;
      i += 1;
    } else if (b < 0xe0) {
      cp = ((b & 0x1f) << 6) | (bytes[i + 1] & 63);
      i += 2;
    } else if (b < 0xf0) {
      cp = ((b & 0x0f) << 12) | ((bytes[i + 1] & 63) << 6) | (bytes[i + 2] & 63);
      i += 3;
    } else {
      cp = ((b & 0x07) << 18) | ((bytes[i + 1] & 63) << 12) | ((bytes[i + 2] & 63) << 6) | (bytes[i + 3] & 63);
      i += 4;
    }
    out += String.fromCodePoint(cp);
  }
  return out;
}
