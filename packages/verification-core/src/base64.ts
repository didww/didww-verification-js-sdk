// Hand-rolled rather than `Buffer` (absent off Node), `btoa` (throws above U+00FF, so a non-ASCII
// secret would encode on one runtime and fail on another) or `TextEncoder` (present in the DOM lib,
// but not something this package's correctness should rest on across older Hermes builds).

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const REPLACEMENT = 0xfffd;

function utf8Bytes(value: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i += 1) {
    let point = value.charCodeAt(i);
    if (point >= 0xd800 && point <= 0xdbff) {
      const low = value.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        point = 0x10000 + ((point - 0xd800) << 10) + (low - 0xdc00);
        i += 1;
      } else {
        point = REPLACEMENT;
      }
    } else if (point >= 0xdc00 && point <= 0xdfff) {
      point = REPLACEMENT;
    }

    if (point < 0x80) {
      bytes.push(point);
    } else if (point < 0x800) {
      bytes.push(0xc0 | (point >> 6), 0x80 | (point & 0x3f));
    } else if (point < 0x10000) {
      bytes.push(0xe0 | (point >> 12), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f));
    } else {
      bytes.push(
        0xf0 | (point >> 18),
        0x80 | ((point >> 12) & 0x3f),
        0x80 | ((point >> 6) & 0x3f),
        0x80 | (point & 0x3f),
      );
    }
  }
  return bytes;
}

/** Standard, padded base64 over the UTF-8 bytes of `value`. */
export function base64Encode(value: string): string {
  const bytes = utf8Bytes(value);
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const remaining = bytes.length - i;
    // The tail's missing bytes are the zeroes the padded encoding calls for.
    const triple = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += ALPHABET.charAt((triple >> 18) & 0x3f);
    out += ALPHABET.charAt((triple >> 12) & 0x3f);
    out += remaining > 1 ? ALPHABET.charAt((triple >> 6) & 0x3f) : '=';
    out += remaining > 2 ? ALPHABET.charAt(triple & 0x3f) : '=';
  }
  return out;
}
