import {base64ToBytes, base64ToHex, base64ToUtf8, bytesToBase64, bytesToHex, utf8ToBase64} from '../src/util/bytes';

// Jest runs under Node, where Buffer exists; the RN tsconfig has no node types.
declare const Buffer: {
  from(data: Uint8Array | number[] | string, enc?: string): {toString(enc: string): string};
};

test('base64 round trip', () => {
  const cases = [new Uint8Array([]), new Uint8Array([0]), new Uint8Array([1, 2]), new Uint8Array([255, 0, 127, 64, 3])];
  for (const bytes of cases) {
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  }
});

test('matches node Buffer base64', () => {
  for (const len of [1, 2, 3, 31, 32, 33, 100]) {
    const bytes = Uint8Array.from({length: len}, (_, i) => (i * 37 + 11) % 256);
    expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
    expect(base64ToBytes(Buffer.from(bytes).toString('base64'))).toEqual(bytes);
  }
});

test('hex conversion', () => {
  expect(bytesToHex(new Uint8Array([0, 15, 255]))).toBe('0x000fff');
  expect(base64ToHex(Buffer.from([0xab, 0xcd]).toString('base64'))).toBe('0xabcd');
});

test('utf8 round trip', () => {
  for (const s of ['', 'hello', '{"a":1,"b":"héllo"}', 'emoji \u{1F600} end']) {
    expect(base64ToUtf8(utf8ToBase64(s))).toBe(s);
    expect(utf8ToBase64(s)).toBe(Buffer.from(s, 'utf8').toString('base64'));
  }
});
