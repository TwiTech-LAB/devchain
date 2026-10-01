// Bump when parsing changes can move positional chunk IDs without a source revision.
export const TRANSCRIPT_PARSER_GENERATION = 1;

/**
 * The first field is an opaque numeric source revision compared by equality.
 * `decodeCursor().fileSize` retains its legacy name to preserve the wire/API shape.
 */
export function encodeCursor(
  sourceVersion: number,
  messageCount: number,
  chunkCount: number,
): string {
  return Buffer.from(
    `${sourceVersion}:${messageCount}:${chunkCount}:${TRANSCRIPT_PARSER_GENERATION}`,
  ).toString('base64url');
}

export function decodeCursor(
  cursor: string,
): { fileSize: number; messageCount: number; chunkCount: number; parserGeneration: number } | null {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString();
    const parts = decoded.split(':');
    if (parts.length !== 3 && parts.length !== 4) return null;
    // A legacy three-field cursor has no generation field and decodes as generation 0.
    const [, , , generation = '0'] = parts;
    if (!/^\d+$/.test(generation)) return null;
    const parserGeneration = Number(generation);
    if (!Number.isSafeInteger(parserGeneration)) return null;
    const fileSize = parseInt(parts[0], 10);
    const messageCount = parseInt(parts[1], 10);
    const chunkCount = parseInt(parts[2], 10);
    if (isNaN(fileSize) || isNaN(messageCount) || isNaN(chunkCount)) return null;
    if (fileSize < 0 || messageCount < 0 || chunkCount < 0) return null;
    return { fileSize, messageCount, chunkCount, parserGeneration };
  } catch {
    return null;
  }
}
