import { encodeCursor, decodeCursor, TRANSCRIPT_PARSER_GENERATION } from './transcript-cursor';

describe('transcript-cursor', () => {
  describe('encodeCursor / decodeCursor roundtrip', () => {
    it('encodes and decodes a cursor correctly', () => {
      const cursor = encodeCursor(12345, 100, 10);
      const decoded = decodeCursor(cursor);
      expect(decoded).toEqual({
        fileSize: 12345,
        messageCount: 100,
        chunkCount: 10,
        parserGeneration: TRANSCRIPT_PARSER_GENERATION,
      });
    });

    it('produces opaque base64url strings', () => {
      const cursor = encodeCursor(1000, 50, 5);
      expect(cursor).not.toContain(':');
      expect(typeof cursor).toBe('string');
      expect(cursor.length).toBeGreaterThan(0);
    });

    it('roundtrips zero values', () => {
      const cursor = encodeCursor(0, 0, 0);
      expect(decodeCursor(cursor)).toEqual({
        fileSize: 0,
        messageCount: 0,
        chunkCount: 0,
        parserGeneration: TRANSCRIPT_PARSER_GENERATION,
      });
    });

    it('roundtrips large values', () => {
      const cursor = encodeCursor(999999999, 50000, 2500);
      expect(decodeCursor(cursor)).toEqual({
        fileSize: 999999999,
        messageCount: 50000,
        chunkCount: 2500,
        parserGeneration: TRANSCRIPT_PARSER_GENERATION,
      });
    });

    it('roundtrips a safe-integer source revision with the parser generation', () => {
      const cursor = encodeCursor(Number.MAX_SAFE_INTEGER, 2, 2);
      expect(decodeCursor(cursor)).toEqual({
        fileSize: Number.MAX_SAFE_INTEGER,
        messageCount: 2,
        chunkCount: 2,
        parserGeneration: TRANSCRIPT_PARSER_GENERATION,
      });
    });
  });

  describe('decodeCursor error cases', () => {
    it('returns null for empty string', () => {
      expect(decodeCursor('')).toBeNull();
    });

    it('returns null for invalid base64', () => {
      expect(decodeCursor('not-valid-cursor!')).toBeNull();
    });

    it('returns null for missing fields (only 2 parts)', () => {
      const badCursor = Buffer.from('100:50').toString('base64url');
      expect(decodeCursor(badCursor)).toBeNull();
    });

    it('returns null for non-numeric values', () => {
      const badCursor = Buffer.from('abc:def:ghi').toString('base64url');
      expect(decodeCursor(badCursor)).toBeNull();
    });

    it('returns null for negative values', () => {
      const badCursor = Buffer.from('-1:50:10').toString('base64url');
      expect(decodeCursor(badCursor)).toBeNull();
    });
  });
});

// Pure decoding tests are sufficient for legacy cursor compatibility and field validation.
it('decodes a legacy three-field cursor as parser generation zero', () => {
  expect(decodeCursor(Buffer.from('123:4:3').toString('base64url'))).toEqual({
    fileSize: 123,
    messageCount: 4,
    chunkCount: 3,
    parserGeneration: 0,
  });
});

it.each(['', '-1', 'NaN', '1x', '0.5', '9007199254740992'])(
  'rejects invalid parser generation %s',
  (generation) => {
    expect(decodeCursor(Buffer.from(`123:4:3:${generation}`).toString('base64url'))).toBeNull();
  },
);
