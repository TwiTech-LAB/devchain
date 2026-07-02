import {
  decodeMessage,
  getVarint,
  getMessage,
  getString,
  ProtobufDecodeError,
} from './protobuf-wire';

// Minimal protobuf wire encoder (test-only) mirroring the decoder under test.
function varint(n: number): Buffer {
  const bytes: number[] = [];
  let v = n;
  while (v > 0x7f) {
    bytes.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  bytes.push(v);
  return Buffer.from(bytes);
}
function tag(field: number, wireType: number): Buffer {
  return varint(field * 8 + wireType);
}
function vField(field: number, n: number): Buffer {
  return Buffer.concat([tag(field, 0), varint(n)]);
}
function lenField(field: number, buf: Buffer): Buffer {
  return Buffer.concat([tag(field, 2), varint(buf.length), buf]);
}
function strField(field: number, s: string): Buffer {
  return lenField(field, Buffer.from(s, 'utf8'));
}

describe('protobuf-wire decodeMessage', () => {
  it('decodes varint fields', () => {
    const msg = decodeMessage(Buffer.concat([vField(2, 17275), vField(3, 205)]));
    expect(getVarint(msg, 2)).toBe(17275);
    expect(getVarint(msg, 3)).toBe(205);
    expect(getVarint(msg, 9)).toBeUndefined();
  });

  it('decodes large varints (multi-byte) accurately', () => {
    const msg = decodeMessage(vField(2, 148509));
    expect(getVarint(msg, 2)).toBe(148509);
  });

  it('decodes nested messages and strings', () => {
    const usage = Buffer.concat([vField(2, 100), vField(3, 50)]);
    const wrapper = Buffer.concat([lenField(4, usage), strField(19, 'gemini-3-flash-a')]);
    const top = decodeMessage(lenField(1, wrapper));

    const w = getMessage(top, 1)!;
    expect(getString(w, 19)).toBe('gemini-3-flash-a');
    const u = getMessage(w, 4)!;
    expect(getVarint(u, 2)).toBe(100);
    expect(getVarint(u, 3)).toBe(50);
  });

  it('returns undefined for absent nested message / string', () => {
    const msg = decodeMessage(vField(1, 5));
    expect(getMessage(msg, 4)).toBeUndefined();
    expect(getString(msg, 19)).toBeUndefined();
  });

  it('throws ProtobufDecodeError on a truncated varint', () => {
    expect(() => decodeMessage(Buffer.from([0x80]))).toThrow(ProtobufDecodeError);
  });

  it('throws ProtobufDecodeError on a truncated length-delimited field', () => {
    // tag for field 1 wt2, length 10, but no payload
    expect(() => decodeMessage(Buffer.concat([tag(1, 2), varint(10)]))).toThrow(
      ProtobufDecodeError,
    );
  });

  it('throws ProtobufDecodeError on field number 0', () => {
    expect(() => decodeMessage(Buffer.from([0x00, 0x01]))).toThrow(ProtobufDecodeError);
  });
});
