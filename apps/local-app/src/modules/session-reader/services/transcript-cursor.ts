import type { FileContentAnchors } from './bounded-anchor-proof';

// Bump when parsing changes can move positional chunk IDs without a source revision,
// or when the cursor layout changes: a cursor from another generation fails closed.
export const TRANSCRIPT_PARSER_GENERATION = 2;

/**
 * Append proof for a file-backed cursor: the bytes `[0, offset)` of the file `fileIdentity`
 * that produced the cursor's counts, pinned by bounded head/tail anchors. A tail proves the
 * source only grew since then by hashing the current file again at `offset`.
 */
export interface TranscriptCursorProof {
  /** `dev:ino` of the parsed file. */
  fileIdentity: string;
  /** Last complete line end of the parsed snapshot. */
  offset: number;
  anchors: FileContentAnchors;
}

export interface DecodedTranscriptCursor {
  /** Opaque numeric source revision; the legacy name preserves the wire/API shape. */
  fileSize: number;
  messageCount: number;
  chunkCount: number;
  parserGeneration: number;
  /** Absent for DB sources and for a file parse that could not mint a proof. */
  proof?: TranscriptCursorProof;
}

const UNSIGNED_INTEGER = /^\d+$/;
const HEX_SHA256 = /^[0-9a-f]{64}$/;
const BASE64URL_SHA256 = /^[A-Za-z0-9_-]{43}$/;

/**
 * The first field is an opaque numeric source revision compared by equality. A proof whose
 * fields cannot be encoded losslessly is dropped, so the cursor fails closed on the next tail.
 */
export function encodeCursor(
  sourceVersion: number,
  messageCount: number,
  chunkCount: number,
  proof: TranscriptCursorProof | undefined,
): string {
  const fields = [sourceVersion, messageCount, chunkCount, TRANSCRIPT_PARSER_GENERATION].map(
    String,
  );
  const proofFields = proof ? encodeProof(proof) : undefined;
  if (proofFields) fields.push(...proofFields);
  return Buffer.from(fields.join(':')).toString('base64url');
}

/** The cursor of a parse: its source revision and proof, at the parsed message and chunk counts. */
export function encodeParseCursor(
  parse: { sourceVersion: number; cursorProof?: TranscriptCursorProof },
  messageCount: number,
  chunkCount: number,
): string {
  return encodeCursor(parse.sourceVersion, messageCount, chunkCount, parse.cursorProof);
}

export function decodeCursor(cursor: string): DecodedTranscriptCursor | null {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString();
    const parts = decoded.split(':');
    // 3: legacy (generation 0); 4: no proof; 9: with proof.
    if (parts.length !== 3 && parts.length !== 4 && parts.length !== 9) return null;
    // A legacy three-field cursor has no generation field and decodes as generation 0.
    const [, , , generation = '0'] = parts;
    if (!UNSIGNED_INTEGER.test(generation)) return null;
    const parserGeneration = Number(generation);
    if (!Number.isSafeInteger(parserGeneration)) return null;
    const fileSize = parseInt(parts[0], 10);
    const messageCount = parseInt(parts[1], 10);
    const chunkCount = parseInt(parts[2], 10);
    if (isNaN(fileSize) || isNaN(messageCount) || isNaN(chunkCount)) return null;
    if (fileSize < 0 || messageCount < 0 || chunkCount < 0) return null;
    const result: DecodedTranscriptCursor = {
      fileSize,
      messageCount,
      chunkCount,
      parserGeneration,
    };
    if (parts.length === 9) {
      const proof = decodeProof(parts.slice(4));
      if (!proof) return null;
      result.proof = proof;
    }
    return result;
  } catch {
    return null;
  }
}

function encodeProof(proof: TranscriptCursorProof): string[] | undefined {
  const identity = proof.fileIdentity.split(':');
  if (
    identity.length !== 2 ||
    !identity.every((part) => UNSIGNED_INTEGER.test(part)) ||
    !Number.isSafeInteger(proof.offset) ||
    proof.offset < 0 ||
    !HEX_SHA256.test(proof.anchors.headDigest) ||
    !HEX_SHA256.test(proof.anchors.tailDigest)
  ) {
    return undefined;
  }
  return [
    identity[0],
    identity[1],
    String(proof.offset),
    Buffer.from(proof.anchors.headDigest, 'hex').toString('base64url'),
    Buffer.from(proof.anchors.tailDigest, 'hex').toString('base64url'),
  ];
}

function decodeProof(fields: string[]): TranscriptCursorProof | undefined {
  const [dev, ino, offsetField, head, tail] = fields;
  if (![dev, ino, offsetField].every((field) => UNSIGNED_INTEGER.test(field))) return undefined;
  if (!BASE64URL_SHA256.test(head) || !BASE64URL_SHA256.test(tail)) return undefined;
  const offset = Number(offsetField);
  if (!Number.isSafeInteger(offset)) return undefined;
  return {
    fileIdentity: `${dev}:${ino}`,
    offset,
    anchors: {
      headDigest: Buffer.from(head, 'base64url').toString('hex'),
      tailDigest: Buffer.from(tail, 'base64url').toString('hex'),
    },
  };
}
