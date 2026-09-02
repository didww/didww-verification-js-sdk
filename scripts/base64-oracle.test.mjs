// Cross-checks the hand-rolled encoder against Node's `Buffer`, an answer produced independently of
// the one being tested.
//
// This lives at the repository root rather than beside the encoder because reading Node's answer
// needs Node, and `packages/verification-core` deliberately compiles with `types: []` so that no
// Node global can reach a package that also runs on Hermes.

import { describe, expect, it } from 'vitest';

import { base64Encode } from '../packages/verification-core/src/base64.ts';

const NAMED_VECTORS = [
  '',
  'f',
  'fo',
  'foo',
  'foob',
  'fooba',
  'foobar',
  'é',
  '€',
  '😀',
  'abcé€😀',
  'key:secret',
  'ak_live_9f3c:s3cr3t-pässwörd/+=',
  'ÿï¾',
];

// Mulberry32: a fixed seed makes any failure reproducible, which `Math.random` would not.
function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RANGES = [
  // ASCII printable, including the `:` that separates a credential pair.
  [0x20, 0x7e],
  // Latin-1 supplement — two UTF-8 bytes, and the range `btoa` would accept but mis-encode.
  [0xa0, 0xff],
  // The rest of the two-byte span, up to its boundary with three.
  [0x0100, 0x07ff],
  // The whole three-byte BMP span below the surrogates, so no width boundary goes unsampled.
  [0x0800, 0xd7ff],
  // CJK — three bytes.
  [0x4e00, 0x4fff],
  // Emoji — four bytes, reached through a surrogate pair.
  [0x1f300, 0x1f64f],
];

// The exact code points on either side of every UTF-8 width change, which a random draw can miss.
const BOUNDARY_POINTS = [
  0x0000, 0x0001, 0x007f, 0x0080, 0x0081, 0x07fe, 0x07ff, 0x0800, 0x0801, 0xd7ff, 0xe000, 0xfffd,
  0xfffe, 0xffff, 0x10000, 0x10001, 0x10ffff,
];

function generateCorpus(count, seed) {
  const random = seededRandom(seed);
  const pick = (min, max) => min + Math.floor(random() * (max - min + 1));
  const corpus = [];
  for (let i = 0; i < count; i += 1) {
    // Every fourth string draws from all ranges at once; the rest stay inside one.
    const mixed = i % 4 === 0;
    const range = RANGES[i % RANGES.length];
    const length = pick(0, 40);
    let value = '';
    for (let j = 0; j < length; j += 1) {
      const [min, max] = mixed ? RANGES[pick(0, RANGES.length - 1)] : range;
      value += String.fromCodePoint(pick(min, max));
    }
    corpus.push(value);
  }
  return corpus;
}

const CORPUS = [...NAMED_VECTORS, ...generateCorpus(400, 0xdec0de)];

describe('base64Encode against Buffer', () => {
  it('agrees on a corpus spanning ASCII, Latin-1, CJK, emoji and mixed ranges', () => {
    expect(CORPUS.length).toBe(414);
    const disagreements = CORPUS.filter(
      (value) => base64Encode(value) !== Buffer.from(value, 'utf8').toString('base64'),
    );
    expect(disagreements).toEqual([]);
  });

  it('agrees on every length from 0 to 200 of a mixed-width string', () => {
    const unit = 'aé€😀';
    for (let length = 0; length <= 200; length += 1) {
      const value = unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
      expect(base64Encode(value)).toBe(Buffer.from(value, 'utf8').toString('base64'));
    }
  });

  it('agrees on both sides of every UTF-8 width boundary', () => {
    for (const point of BOUNDARY_POINTS) {
      const value = String.fromCodePoint(point);
      expect(base64Encode(value)).toBe(Buffer.from(value, 'utf8').toString('base64'));
      const padded = `a${value}b`;
      expect(base64Encode(padded)).toBe(Buffer.from(padded, 'utf8').toString('base64'));
    }
  });

  it('agrees on lone surrogates, which both map to U+FFFD', () => {
    for (const value of ['\ud83d', '\ude00', 'a\ud83db', '\ude00\ud83d', '\ud83d😀']) {
      expect(base64Encode(value)).toBe(Buffer.from(value, 'utf8').toString('base64'));
    }
  });
});
