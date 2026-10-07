import { estimateObjectBytes, BYTE_ACCOUNTING_CONSTANTS as C } from './byte-accounting.helper';

describe('estimateObjectBytes', () => {
  describe('primitives', () => {
    it.each([
      { name: 'returns 0 for null', probes: [[null, 0]] as [unknown, number][] },
      { name: 'returns 0 for undefined', probes: [[undefined, 0]] as [unknown, number][] },
      {
        name: 'counts numbers as fixed size',
        probes: [
          [42, C.SIZE_NUMBER],
          [0, C.SIZE_NUMBER],
          [3.14159, C.SIZE_NUMBER],
        ] as [unknown, number][],
      },
      {
        name: 'counts booleans as fixed size',
        probes: [
          [true, C.SIZE_BOOLEAN],
          [false, C.SIZE_BOOLEAN],
        ] as [unknown, number][],
      },
      {
        name: 'counts bigint as fixed size',
        probes: [[123n, C.SIZE_BIGINT]] as [unknown, number][],
      },
    ])('$name', ({ probes }) => {
      for (const [value, expected] of probes) expect(estimateObjectBytes(value)).toBe(expected);
    });

    it('counts string bytes as UTF-8 length', () => {
      expect(estimateObjectBytes('hello')).toBe(5);
      expect(estimateObjectBytes('')).toBe(0);
      expect(estimateObjectBytes('héllo')).toBe(6);
      expect(estimateObjectBytes('日本語')).toBe(9);
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

    it.each([
      { name: 'Date', value: new Date('2026-07-12T00:00:00Z'), bytes: C.SIZE_DATE },
      { name: 'Buffer', value: Buffer.alloc(1024), bytes: 1024 },
      {
        name: 'RegExp',
        value: /shared\d+/,
        bytes: C.SIZE_OBJECT_OVERHEAD + Buffer.byteLength(/shared\d+/.source, 'utf8'),
      },
      {
        name: 'Error',
        value: new Error('shared failure'),
        bytes: C.SIZE_OBJECT_OVERHEAD + Buffer.byteLength('shared failure', 'utf8'),
      },
    ])('deduplicates repeated $name instances by identity', ({ value, bytes }) => {
      expect(estimateObjectBytes([value, value])).toBe(C.SIZE_ARRAY_OVERHEAD + bytes);
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

    it('does NOT count the same object twice across separate top-level calls', () => {
      const obj = { x: 1 };
      const size1 = estimateObjectBytes(obj);
      const size2 = estimateObjectBytes(obj);
      expect(size1).toBe(size2);
      expect(size1).toBe(C.SIZE_OBJECT_OVERHEAD + 1 + C.SIZE_NUMBER);
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
  });

  describe('determinism', () => {
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
