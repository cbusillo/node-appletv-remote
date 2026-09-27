import { describe, expect, it } from 'vitest';
import { opackDecode, opackEncode, OpackFloat } from '../opack.js';

// Independent wire fixtures: pyatv 0.18.0 and its published OPACK examples.
// These test protocol compatibility, rather than just this codec's round trips.
describe('Companion OPACK compatibility', () => {
  it('preserves a backward seek instead of decoding it as a huge positive integer', () => {
    expect(opackEncode(-10).toString('hex')).toBe('3600000000000024c0');
    expect(opackDecode(opackEncode(-10))).toBe(-10);
  });

  it('supports a combined session identifier with its top bit set', () => {
    const sessionId = 0x8000000000000001n;
    expect(opackEncode(sessionId).toString('hex')).toBe('330100000000000080');
    expect(opackDecode(opackEncode(sessionId))).toBe(sessionId);
  });

  it('decodes an app-list reply containing a repeated app-name reference', () => {
    const packet = Buffer.from(
      'e2425f740b425f63e24f636f6d2e6578616d706c652e6f6e654b4578616d706c65204170704f636f6d2e6578616d706c652e74776fa3',
      'hex',
    );
    expect(opackDecode(packet)).toEqual(new Map<string, unknown>([
      ['_t', 3],
      ['_c', new Map([
        ['com.example.one', 'Example App'],
        ['com.example.two', 'Example App'],
      ])],
    ]));
  });

  it('decodes the documented pointer example without indexing the boolean', () =>
    expect(opackDecode(Buffer.from('e3416102416244746573744163a2', 'hex')))
      .toEqual(new Map<string, unknown>([['a', false], ['b', 'test'], ['c', 'test']])));

  it.each([
    [30, '360000000000003e40'],
    [0, '360000000000000000'],
    [1, '36000000000000f03f'],
    [-10, '3600000000000024c0'],
  ])('preserves an explicit float wire type for %s', (value, hex) => {
    const encoded = opackEncode(new OpackFloat(value));
    expect(encoded.toString('hex')).toBe(hex);
    expect(opackDecode(encoded)).toBe(value);
  });

  it('keeps ordinary positive integers and negative zero distinct', () => {
    expect(opackEncode(30)).toEqual(Buffer.from([0x26]));
    expect(Object.is(opackDecode(opackEncode(-0)), -0)).toBe(true);
  });

  it('rejects unsigned overflow, negative bigint and imprecise integer input', () => {
    expect(() => opackEncode(1n << 64n)).toThrow(RangeError);
    expect(() => opackEncode(-1n)).toThrow(RangeError);
    expect(() => opackEncode(Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
    expect(opackDecode(opackEncode((1n << 64n) - 1n))).toBe((1n << 64n) - 1n);
  });

  it('shares the object table across nested containers without indexing containers', () =>
    expect(opackDecode(Buffer.from('d343666f6fd1426261a1', 'hex')))
      .toEqual(['foo', ['ba'], 'ba']));

  it('does not add duplicate literals or references to the object table', () =>
    expect(opackDecode(Buffer.from('d543666f6f43666f6fa043626172a1', 'hex')))
      .toEqual(['foo', 'foo', 'foo', 'bar', 'bar']));

  it.each([1, 2, 3, 4])('decodes an extended reference with %s index bytes', width => {
    const pointer = Buffer.alloc(1 + width);
    pointer[0] = 0xc0 + width;
    pointer.writeUIntLE(1, 1, width);
    expect(opackDecode(Buffer.concat([Buffer.from('d343666f6f43626172', 'hex'), pointer])))
      .toEqual(['foo', 'bar', 'bar']);
  });

  it('resets references between messages and rejects missing or truncated references', () => {
    expect(opackDecode(Buffer.from('d243666f6fa0', 'hex'))).toEqual(['foo', 'foo']);
    expect(() => opackDecode(Buffer.from('a0', 'hex'))).toThrow(/reference/);
    expect(() => opackDecode(Buffer.from('d243666f6fa1', 'hex'))).toThrow(/reference/);
    expect(() => opackDecode(Buffer.from('d243666f6fc2', 'hex'))).toThrow();
  });
});
