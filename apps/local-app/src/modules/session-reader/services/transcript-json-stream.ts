import { Readable } from 'node:stream';
import { cooperativeBudget } from './cooperative-work';

const STRING_SLICE = 16 * 1024;
const OUTPUT_SLICE = 64 * 1024;

// Transcript DTOs contain JSON data and Dates, with no replacers or custom serializers.
function* jsonTokens(value: unknown, ancestors = new Set<object>()): Generator<string> {
  if (value instanceof Date) value = value.toJSON();
  if (typeof value === 'string') {
    yield '"';
    for (let start = 0; start < value.length; ) {
      let end = Math.min(start + STRING_SLICE, value.length);
      // Keep a surrogate pair together: JSON.stringify escapes a lone surrogate.
      const last = value.charCodeAt(end - 1);
      if (end < value.length && last >= 0xd800 && last <= 0xdbff) end--;
      yield JSON.stringify(value.slice(start, end)).slice(1, -1);
      start = end;
    }
    yield '"';
    return;
  }
  if (value === null || typeof value !== 'object') {
    yield JSON.stringify(value) ?? 'null';
    return;
  }
  if (ancestors.has(value)) throw new TypeError('Converting circular structure to JSON');
  ancestors.add(value);
  try {
    const array = Array.isArray(value);
    yield array ? '[' : '{';
    let first = true;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (!first) yield ',';
        first = false;
        yield* jsonTokens(item, ancestors);
      }
    } else {
      for (const key of Object.keys(value)) {
        const item = (value as Record<string, unknown>)[key];
        if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue;
        if (!first) yield ',';
        first = false;
        yield JSON.stringify(key);
        yield ':';
        yield* jsonTokens(item, ancestors);
      }
    }
    yield array ? ']' : '}';
  } finally {
    ancestors.delete(value);
  }
}

/** Encode without a whole-response stringify or buffer; Readable supplies backpressure. */
export function transcriptJsonStream(value: unknown): Readable {
  async function* encode() {
    const checkpoint = cooperativeBudget();
    let buffer = '';
    for (const token of jsonTokens(value)) {
      buffer += token;
      if (buffer.length >= OUTPUT_SLICE) {
        yield Buffer.from(buffer);
        buffer = '';
      }
      const pause = checkpoint();
      if (pause) await pause;
    }
    if (buffer) yield Buffer.from(buffer);
  }
  return Readable.from(encode(), { objectMode: false, highWaterMark: OUTPUT_SLICE });
}
