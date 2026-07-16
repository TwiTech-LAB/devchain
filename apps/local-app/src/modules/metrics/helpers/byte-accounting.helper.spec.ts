import { estimateObjectBytes, BYTE_ACCOUNTING_CONSTANTS as C } from './byte-accounting.helper';

describe('estimateObjectBytes', () => {
  describe('primitives', () => {
    it('returns 0 for null', () => {
      expect(estimateObjectBytes(null)).toBe(0);
    });

    it('returns 0 for undefined', () => {
      expect(estimateObjectBytes(undefined)).toBe(0);
    });

    it('counts string bytes as UTF-8 length', () => {
      expect(estimateObjectBytes('hello')).toBe(5);
      expect(estimateObjectBytes('')).toBe(0);
      expect(estimateObjectBytes('héllo')).toBe(6);
      expect(estimateObjectBytes('日本語')).toBe(9);
    });

    it('counts numbers as fixed size', () => {
      expect(estimateObjectBytes(42)).toBe(C.SIZE_NUMBER);
      expect(estimateObjectBytes(0)).toBe(C.SIZE_NUMBER);
      expect(estimateObjectBytes(3.14159)).toBe(C.SIZE_NUMBER);
    });

    it('counts booleans as fixed size', () => {
      expect(estimateObjectBytes(true)).toBe(C.SIZE_BOOLEAN);
      expect(estimateObjectBytes(false)).toBe(C.SIZE_BOOLEAN);
    });

    it('counts bigint as fixed size', () => {
      expect(estimateObjectBytes(123n)).toBe(C.SIZE_BIGINT);
    });
  });

  describe('objects', () => {
    it('counts object overhead + property keys + values', () => {
      const obj = { a: 1, b: 'hi' };
      const expected = C.SIZE_OBJECT_OVERHEAD + 1 + C.SIZE_NUMBER + 1 + 2;
      expect(estimateObjectBytes(obj)).toBe(expected);
    });

    it('counts empty object as just overhead', () => {
      expect(estimateObjectBytes({})).toBe(C.SIZE_OBJECT_OVERHEAD);
    });

    it('counts nested objects', () => {
      const obj = { inner: { x: 1 } };
      const expected =
        C.SIZE_OBJECT_OVERHEAD + // outer
        5 + // key 'inner'
        C.SIZE_OBJECT_OVERHEAD + // inner
        1 + // key 'x'
        C.SIZE_NUMBER; // value 1
      expect(estimateObjectBytes(obj)).toBe(expected);
    });

    it('counts property key bytes as UTF-8', () => {
      const obj = { héllo: 1 };
      const expected = C.SIZE_OBJECT_OVERHEAD + 6 + C.SIZE_NUMBER;
      expect(estimateObjectBytes(obj)).toBe(expected);
    });
  });

  describe('arrays', () => {
    it('counts array overhead + elements', () => {
      const arr = [1, 2, 3];
      const expected = C.SIZE_ARRAY_OVERHEAD + 3 * C.SIZE_NUMBER;
      expect(estimateObjectBytes(arr)).toBe(expected);
    });

    it('counts empty array as just overhead', () => {
      expect(estimateObjectBytes([])).toBe(C.SIZE_ARRAY_OVERHEAD);
    });

    it('counts mixed-type arrays', () => {
      const arr = ['hi', 42, true];
      const expected = C.SIZE_ARRAY_OVERHEAD + 2 + C.SIZE_NUMBER + C.SIZE_BOOLEAN;
      expect(estimateObjectBytes(arr)).toBe(expected);
    });
  });

  describe('special types', () => {
    it('counts Date as fixed size', () => {
      expect(estimateObjectBytes(new Date())).toBe(C.SIZE_DATE);
    });

    it('counts Buffer as its byte length', () => {
      const buf = Buffer.alloc(128);
      expect(estimateObjectBytes(buf)).toBe(128);
    });

    it('counts RegExp as source length + overhead', () => {
      const re = /abc\d+/;
      const expected = Buffer.byteLength(re.source, 'utf8') + C.SIZE_OBJECT_OVERHEAD;
      expect(estimateObjectBytes(re)).toBe(expected);
    });

    it('counts Error as overhead + message length', () => {
      const err = new Error('something broke');
      const expected = C.SIZE_OBJECT_OVERHEAD + Buffer.byteLength('something broke', 'utf8');
      expect(estimateObjectBytes(err)).toBe(expected);
    });

    it('deduplicates repeated Date instances by identity', () => {
      const date = new Date('2026-07-12T00:00:00Z');

      expect(estimateObjectBytes([date, date])).toBe(C.SIZE_ARRAY_OVERHEAD + C.SIZE_DATE);
    });

    it('deduplicates repeated Buffer instances by identity', () => {
      const buffer = Buffer.alloc(1024);

      expect(estimateObjectBytes([buffer, buffer])).toBe(1040);
    });

    it('deduplicates repeated RegExp instances by identity', () => {
      const regexp = /shared\d+/;
      const regexpBytes = C.SIZE_OBJECT_OVERHEAD + Buffer.byteLength(regexp.source, 'utf8');

      expect(estimateObjectBytes([regexp, regexp])).toBe(C.SIZE_ARRAY_OVERHEAD + regexpBytes);
    });

    it('deduplicates repeated Error instances by identity', () => {
      const error = new Error('shared failure');
      const errorBytes = C.SIZE_OBJECT_OVERHEAD + Buffer.byteLength(error.message, 'utf8');

      expect(estimateObjectBytes([error, error])).toBe(C.SIZE_ARRAY_OVERHEAD + errorBytes);
    });

    it('counts functions as fixed size', () => {
      expect(estimateObjectBytes(() => {})).toBe(C.SIZE_FUNCTION);
      expect(estimateObjectBytes(function named() {})).toBe(C.SIZE_FUNCTION);
    });
  });

  describe('Map and Set', () => {
    it('counts Map as overhead + keys + values', () => {
      const map = new Map<string, unknown>([
        ['a', 1],
        ['b', 'hi'],
      ]);
      const expected =
        C.SIZE_MAP_OVERHEAD +
        (1 + C.SIZE_NUMBER) + // 'a' -> 1
        (1 + 2); // 'b' -> 'hi'
      expect(estimateObjectBytes(map)).toBe(expected);
    });

    it('counts Set as overhead + elements', () => {
      const set = new Set([1, 'hi', true]);
      const expected = C.SIZE_SET_OVERHEAD + C.SIZE_NUMBER + 2 + C.SIZE_BOOLEAN;
      expect(estimateObjectBytes(set)).toBe(expected);
    });

    it('counts empty Map as just overhead', () => {
      expect(estimateObjectBytes(new Map())).toBe(C.SIZE_MAP_OVERHEAD);
    });
  });

  describe('shared-graph single-count rule', () => {
    it('counts shared object only once when referenced from multiple parents', () => {
      const shared = { data: 'hello' };
      const sharedBytes = C.SIZE_OBJECT_OVERHEAD + 4 + 5;
      const parent = { a: shared, b: shared };
      const expected =
        C.SIZE_OBJECT_OVERHEAD + // parent
        (1 + sharedBytes) + // key 'a' -> shared (counted)
        (1 + 0); // key 'b' -> shared (already seen, 0)
      expect(estimateObjectBytes(parent)).toBe(expected);
    });

    it('counts shared array only once', () => {
      const shared = [1, 2];
      const sharedBytes = C.SIZE_ARRAY_OVERHEAD + 2 * C.SIZE_NUMBER;
      const parent = { a: shared, b: shared };
      const expected = C.SIZE_OBJECT_OVERHEAD + 1 + sharedBytes + 1 + 0;
      expect(estimateObjectBytes(parent)).toBe(expected);
    });

    it('does NOT count the same object twice across separate top-level calls', () => {
      const obj = { x: 1 };
      const size1 = estimateObjectBytes(obj);
      const size2 = estimateObjectBytes(obj);
      expect(size1).toBe(size2);
      expect(size1).toBe(C.SIZE_OBJECT_OVERHEAD + 1 + C.SIZE_NUMBER);
    });

    it('counts shared object in array only once across array entries', () => {
      const shared = { v: 42 };
      const sharedBytes = C.SIZE_OBJECT_OVERHEAD + 1 + C.SIZE_NUMBER;
      const arr = [shared, shared, shared];
      const expected = C.SIZE_ARRAY_OVERHEAD + sharedBytes + 0 + 0;
      expect(estimateObjectBytes(arr)).toBe(expected);
    });

    it('counts a shared graph once across snapshot roots when given one visit set', () => {
      const chunks = [{ text: 'shared' }];
      const session = { chunks };
      const seen = new WeakSet<object>();

      const parsedBytes = estimateObjectBytes(session, seen);
      const chunksBytes = estimateObjectBytes(chunks, seen);

      expect(parsedBytes).toBe(estimateObjectBytes(session));
      expect(chunksBytes).toBe(0);
    });
  });

  describe('circular references', () => {
    it('handles circular object references without infinite loop', () => {
      const obj: Record<string, unknown> = { x: 1 };
      obj.self = obj;
      const result = estimateObjectBytes(obj);
      expect(result).toBeGreaterThan(0);
      const expected = C.SIZE_OBJECT_OVERHEAD + 1 + C.SIZE_NUMBER + 4 + 0;
      expect(result).toBe(expected);
    });

    it('handles circular array references', () => {
      const arr: unknown[] = [1];
      (arr as unknown as Record<string, unknown>).push(arr);
      const result = estimateObjectBytes(arr);
      expect(result).toBeGreaterThan(0);
    });

    it('handles mutual circular references between objects', () => {
      const a: Record<string, unknown> = { x: 1 };
      const b: Record<string, unknown> = { y: 2 };
      a.b = b;
      b.a = a;
      const result = estimateObjectBytes(a);
      expect(result).toBeGreaterThan(0);
    });
  });

  describe('determinism', () => {
    it('returns the same value for the same input on repeated calls', () => {
      const obj = {
        messages: [
          { role: 'user', content: 'hello world', timestamp: new Date() },
          { role: 'assistant', content: 'hi there', timestamp: new Date() },
        ],
        count: 2,
      };
      const result1 = estimateObjectBytes(obj);
      const result2 = estimateObjectBytes(obj);
      expect(result1).toBe(result2);
    });

    it('produces a positive value for realistic session-like objects', () => {
      const session = {
        id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        providerName: 'claude',
        filePath: '/home/user/.claude/sessions/test.jsonl',
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'Can you help me with a coding task?' }],
            timestamp: new Date('2026-07-11T10:00:00Z'),
            toolCalls: [],
            toolResults: [],
          },
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'Sure! What do you need help with?' }],
            timestamp: new Date('2026-07-11T10:00:05Z'),
            toolCalls: [],
            toolResults: [],
          },
        ],
        metrics: {
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          messageCount: 2,
        },
        isOngoing: false,
      };
      const result = estimateObjectBytes(session);
      expect(result).toBeGreaterThan(500);
      expect(result).toBeLessThan(10000);
    });
  });
});
