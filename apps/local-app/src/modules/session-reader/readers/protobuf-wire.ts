/**
 * Minimal protobuf wire-format decoder (no `.proto`, no dependency).
 *
 * Antigravity (`agy`) stores per-generation token usage as protobuf blobs in
 * `conversations/<convId>.db` (`gen_metadata.data`) with no schema on disk. We
 * only need to navigate a handful of varint fields inside a known submessage
 * path, so a tiny wire walker is sufficient (and avoids pulling in protobufjs).
 *
 * Wire types handled: 0 (varint), 1 (fixed64), 2 (length-delimited), 5
 * (fixed32). Group-start/end (3/4, deprecated) are treated as a decode error.
 *
 * @see https://protobuf.dev/programming-guides/encoding/
 */

/** A decoded field occurrence: a varint number, or a raw length-delimited slice. */
export interface WireField {
  wireType: number;
  /** Present for wire types 0/1/5 (numeric). */
  varint?: number;
  /** Present for wire type 2 (length-delimited: nested message, string, bytes). */
  bytes?: Uint8Array;
}

/** Map of field-number → occurrences (a field may repeat). */
export type WireMessage = Map<number, WireField[]>;

/** Thrown when the bytes are not valid protobuf wire format. */
export class ProtobufDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtobufDecodeError';
  }
}

/** Read a base-128 varint at `pos`. Returns the value and the next offset. */
function readVarint(buf: Uint8Array, pos: number): [number, number] {
  let result = 0;
  let shift = 0;
  let i = pos;
  // Token counts fit well within 2^53; accumulate in a JS number. Cap at 10
  // groups (70 bits) to refuse pathological input rather than loop forever.
  for (let group = 0; group < 10; group++) {
    if (i >= buf.length) throw new ProtobufDecodeError('truncated varint');
    const byte = buf[i++];
    result += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return [result, i];
    shift += 7;
  }
  throw new ProtobufDecodeError('varint too long');
}

/**
 * Decode a protobuf message into a field map. Throws {@link ProtobufDecodeError}
 * on malformed input (used as the fail-loud drift tripwire).
 */
export function decodeMessage(buf: Uint8Array): WireMessage {
  const out: WireMessage = new Map();
  let i = 0;
  while (i < buf.length) {
    const [key, afterKey] = readVarint(buf, i);
    i = afterKey;
    const field = Math.floor(key / 8);
    const wireType = key & 7;
    if (field === 0) throw new ProtobufDecodeError('field number 0');

    let entry: WireField;
    switch (wireType) {
      case 0: {
        const [value, next] = readVarint(buf, i);
        i = next;
        entry = { wireType, varint: value };
        break;
      }
      case 1: {
        if (i + 8 > buf.length) throw new ProtobufDecodeError('truncated fixed64');
        i += 8;
        entry = { wireType };
        break;
      }
      case 2: {
        const [len, afterLen] = readVarint(buf, i);
        i = afterLen;
        if (i + len > buf.length) throw new ProtobufDecodeError('truncated length-delimited');
        entry = { wireType, bytes: buf.subarray(i, i + len) };
        i += len;
        break;
      }
      case 5: {
        if (i + 4 > buf.length) throw new ProtobufDecodeError('truncated fixed32');
        i += 4;
        entry = { wireType };
        break;
      }
      default:
        throw new ProtobufDecodeError(`unsupported wire type ${wireType}`);
    }

    const bucket = out.get(field);
    if (bucket) bucket.push(entry);
    else out.set(field, [entry]);
  }
  return out;
}

/** First varint value for `field`, or `undefined` when absent/not a varint. */
export function getVarint(msg: WireMessage, field: number): number | undefined {
  const f = msg.get(field)?.[0];
  return f && f.varint !== undefined ? f.varint : undefined;
}

/** First nested message for `field` (decoded), or `undefined` when absent. */
export function getMessage(msg: WireMessage, field: number): WireMessage | undefined {
  const f = msg.get(field)?.[0];
  return f?.bytes ? decodeMessage(f.bytes) : undefined;
}

/** First length-delimited value decoded as a UTF-8 string, or `undefined`. */
export function getString(msg: WireMessage, field: number): string | undefined {
  const f = msg.get(field)?.[0];
  return f?.bytes ? Buffer.from(f.bytes).toString('utf8') : undefined;
}
