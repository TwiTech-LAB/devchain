/**
 * Estimate the retained byte size of a JavaScript value by walking its object graph.
 *
 * Shared-graph single-count rule: each object is counted exactly once, even if
 * referenced from multiple parents. Cycles are safe — visited objects return 0.
 *
 * Approximation: this measures a structural estimate of the retained heap
 * representation (property key bytes + primitive value sizes + per-object/array
 * overhead), NOT the serialized JSON wire size. It correlates with but is not
 * identical to `Buffer.byteLength(JSON.stringify(value), 'utf8')`. Key differences:
 * - Object/array overhead is included (hidden-class + property storage estimate)
 * - Dates are counted as their timestamp value, not their ISO string representation
 * - Functions and symbols are given fixed estimates
 * - JSON syntax characters ({, }, ", :, etc.) are not included
 *
 * A cache's pre-computed serialized byte length (e.g. the DTO cache's
 * `responseBytes`) is exact for its standalone wire-size view. Aggregate retained
 * accounting must still walk that cache's roots so shared descendants can be
 * counted once by identity.
 *
 * This function is safe to call on-demand (metrics endpoint / periodic log) but
 * must NOT be called on hot paths (per-frame, per-request). The object graph walk
 * is O(graph size). By default each call allocates its own WeakSet; callers taking
 * a multi-root snapshot can pass any identity set with `has`/`add` semantics to
 * count cross-root references once.
 */

const SIZE_NUMBER = 8;
const SIZE_BOOLEAN = 4;
const SIZE_DATE = 8;
const SIZE_OBJECT_OVERHEAD = 16;
const SIZE_ARRAY_OVERHEAD = 16;
const SIZE_MAP_OVERHEAD = 16;
const SIZE_SET_OVERHEAD = 16;
const SIZE_FUNCTION = 32;
const SIZE_SYMBOL = 8;
const SIZE_BIGINT = 8;

export interface ObjectIdentitySet {
  has(value: object): boolean;
  add(value: object): unknown;
}

export function estimateObjectBytes(
  value: unknown,
  seen: ObjectIdentitySet = new WeakSet<object>(),
): number {
  return estimateInternal(value, seen);
}

function estimateInternal(value: unknown, seen: ObjectIdentitySet): number {
  if (value === null || value === undefined) return 0;

  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8');
  if (typeof value === 'number') return SIZE_NUMBER;
  if (typeof value === 'boolean') return SIZE_BOOLEAN;
  if (typeof value === 'bigint') return SIZE_BIGINT;
  if (typeof value === 'function') return SIZE_FUNCTION;
  if (typeof value === 'symbol') return SIZE_SYMBOL;
  if (typeof value !== 'object') return 0;

  if (seen.has(value)) return 0;
  seen.add(value);

  if (value instanceof Date) return SIZE_DATE;
  if (Buffer.isBuffer(value)) return value.byteLength;
  if (value instanceof RegExp) {
    return Buffer.byteLength(value.source, 'utf8') + SIZE_OBJECT_OVERHEAD;
  }
  if (value instanceof Error) {
    return SIZE_OBJECT_OVERHEAD + Buffer.byteLength(value.message, 'utf8');
  }

  if (value instanceof Map) {
    let size = SIZE_MAP_OVERHEAD;
    for (const [k, v] of value) {
      size += estimateInternal(k, seen) + estimateInternal(v, seen);
    }
    return size;
  }

  if (value instanceof Set) {
    let size = SIZE_SET_OVERHEAD;
    for (const v of value) {
      size += estimateInternal(v, seen);
    }
    return size;
  }

  if (Array.isArray(value)) {
    let size = SIZE_ARRAY_OVERHEAD;
    for (const item of value) {
      size += estimateInternal(item, seen);
    }
    return size;
  }

  let size = SIZE_OBJECT_OVERHEAD;
  for (const key of Object.keys(value)) {
    size += Buffer.byteLength(key, 'utf8');
    size += estimateInternal((value as Record<string, unknown>)[key], seen);
  }
  return size;
}

export const BYTE_ACCOUNTING_CONSTANTS = {
  SIZE_NUMBER,
  SIZE_BOOLEAN,
  SIZE_DATE,
  SIZE_OBJECT_OVERHEAD,
  SIZE_ARRAY_OVERHEAD,
  SIZE_MAP_OVERHEAD,
  SIZE_SET_OVERHEAD,
  SIZE_FUNCTION,
  SIZE_SYMBOL,
  SIZE_BIGINT,
} as const;
