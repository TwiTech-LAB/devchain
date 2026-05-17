import { encodeCursor, decodeCursor } from './transcript-cursor';

describe('transcript-cursor', () => {
  describe('encodeCursor / decodeCursor roundtrip', () => {
    it('encodes and decodes a cursor correctly', () => {
      const cursor = encodeCursor(12345, 100, 10);
      const decoded = decodeCursor(cursor);
      expect(decoded).toEqual({ fileSize: 12345, messageCount: 100, chunkCount: 10 });
    });

    it('produces opaque base64url strings', () => {
      const cursor = encodeCursor(1000, 50, 5);
      expect(cursor).not.toContain(':');
      expect(typeof cursor).toBe('string');
      expect(cursor.length).toBeGreaterThan(0);
    });

    it('roundtrips zero values', () => {
      const cursor = encodeCursor(0, 0, 0);
      expect(decodeCursor(cursor)).toEqual({ fileSize: 0, messageCount: 0, chunkCount: 0 });
    });

    it('roundtrips large values', () => {
      const cursor = encodeCursor(999999999, 50000, 2500);
      expect(decodeCursor(cursor)).toEqual({
        fileSize: 999999999,
        messageCount: 50000,
        chunkCount: 2500,
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
