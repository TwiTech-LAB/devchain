import {
  encodeCursor,
  decodeCursor,
  TRANSCRIPT_PARSER_GENERATION,
  type TranscriptCursorProof,
} from './transcript-cursor';

// Pure codec tests: encoding, legacy compatibility and field validation need no I/O.

const PROOF: TranscriptCursorProof = {
  fileIdentity: '66306:123456789',
  offset: 1_048_576,
  anchors: {
    headDigest: 'a'.repeat(64),
    tailDigest: '0123456789abcdef'.repeat(4),
  },
};

function rawCursor(fields: Array<string | number>): string {
  return Buffer.from(fields.join(':')).toString('base64url');
}

describe('transcript-cursor', () => {
  describe('encodeCursor / decodeCursor roundtrip', () => {
    it('encodes and decodes a cursor correctly', () => {
      const cursor = encodeCursor(12345, 100, 10, undefined);
      const decoded = decodeCursor(cursor);
      expect(decoded).toEqual({
        fileSize: 12345,
        messageCount: 100,
        chunkCount: 10,
        parserGeneration: TRANSCRIPT_PARSER_GENERATION,
      });
    });

    it('produces opaque base64url strings', () => {
      const cursor = encodeCursor(1000, 50, 5, PROOF);
      expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('roundtrips zero values', () => {
      const cursor = encodeCursor(0, 0, 0, undefined);
      expect(decodeCursor(cursor)).toEqual({
        fileSize: 0,
        messageCount: 0,
        chunkCount: 0,
        parserGeneration: TRANSCRIPT_PARSER_GENERATION,
      });
    });

    it('roundtrips a safe-integer source revision with the parser generation', () => {
      const cursor = encodeCursor(Number.MAX_SAFE_INTEGER, 2, 2, undefined);
      expect(decodeCursor(cursor)).toEqual({
        fileSize: Number.MAX_SAFE_INTEGER,
        messageCount: 2,
        chunkCount: 2,
        parserGeneration: TRANSCRIPT_PARSER_GENERATION,
      });
    });

    it('roundtrips the file identity, parsed offset and both anchors', () => {
      const cursor = encodeCursor(Number.MAX_SAFE_INTEGER, 50000, 2500, PROOF);
      expect(decodeCursor(cursor)).toEqual({
        fileSize: Number.MAX_SAFE_INTEGER,
        messageCount: 50000,
        chunkCount: 2500,
        parserGeneration: TRANSCRIPT_PARSER_GENERATION,
        proof: PROOF,
      });
      // Opaque `since` parameter budget for REST and the mobile RPC.
      expect(cursor.length).toBeLessThanOrEqual(200);
    });

    it('roundtrips a proof over the empty prefix', () => {
      const proof = { ...PROOF, offset: 0 };
      expect(decodeCursor(encodeCursor(1, 0, 0, proof))?.proof).toEqual(proof);
    });

    it.each([
      ['a non-numeric identity', { ...PROOF, fileIdentity: 'dev:ino' }],
      ['an identity without an inode', { ...PROOF, fileIdentity: '66306' }],
      ['a negative offset', { ...PROOF, offset: -1 }],
      ['a fractional offset', { ...PROOF, offset: 1.5 }],
      ['a short digest', { ...PROOF, anchors: { ...PROOF.anchors, headDigest: 'abc' } }],
    ])('drops a proof with %s so the cursor fails closed', (_label, proof) => {
      const decoded = decodeCursor(encodeCursor(7, 1, 1, proof));
      expect(decoded).not.toBeNull();
      expect(decoded).not.toHaveProperty('proof');
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
      expect(decodeCursor(rawCursor([100, 50]))).toBeNull();
    });

    it('returns null for non-numeric values', () => {
      expect(decodeCursor(rawCursor(['abc', 'def', 'ghi']))).toBeNull();
    });

    it('returns null for negative values', () => {
      expect(decodeCursor(rawCursor([-1, 50, 10]))).toBeNull();
    });

    it.each([5, 8, 10])('returns null for %i fields', (count) => {
      expect(decodeCursor(rawCursor(Array.from({ length: count }, () => 1)))).toBeNull();
    });

    it.each([
      ['identity', ['x', 2, 3]],
      ['offset', [1, 2, '-3']],
    ])('returns null for a malformed proof %s', (_label, [dev, ino, offset]) => {
      const head = Buffer.alloc(32, 1).toString('base64url');
      expect(
        decodeCursor(
          rawCursor([1, 1, 1, TRANSCRIPT_PARSER_GENERATION, dev, ino, offset, head, head]),
        ),
      ).toBeNull();
    });

    it('returns null for a malformed anchor', () => {
      const head = Buffer.alloc(32, 1).toString('base64url');
      expect(
        decodeCursor(rawCursor([1, 1, 1, TRANSCRIPT_PARSER_GENERATION, 1, 2, 3, head, 'short'])),
      ).toBeNull();
    });
  });

  describe('older cursor formats', () => {
    it('decodes a legacy three-field cursor as parser generation zero', () => {
      expect(decodeCursor(rawCursor([123, 4, 3]))).toEqual({
        fileSize: 123,
        messageCount: 4,
        chunkCount: 3,
        parserGeneration: 0,
      });
    });

    it('decodes a proof-less generation-1 cursor as an older generation', () => {
      const decoded = decodeCursor(rawCursor([123, 4, 3, 1]));
      expect(decoded).toEqual({
        fileSize: 123,
        messageCount: 4,
        chunkCount: 3,
        parserGeneration: 1,
      });
      expect(decoded?.parserGeneration).not.toBe(TRANSCRIPT_PARSER_GENERATION);
    });

    it.each(['', '-1', 'NaN', '1x', '0.5', '9007199254740992'])(
      'rejects invalid parser generation %s',
      (generation) => {
        expect(decodeCursor(rawCursor([123, 4, 3, generation]))).toBeNull();
      },
    );
  });
});
