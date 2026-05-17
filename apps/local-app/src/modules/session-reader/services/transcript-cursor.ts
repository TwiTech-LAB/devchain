export function encodeCursor(fileSize: number, messageCount: number, chunkCount: number): string {
  return Buffer.from(`${fileSize}:${messageCount}:${chunkCount}`).toString('base64url');
}

export function decodeCursor(
  cursor: string,
): { fileSize: number; messageCount: number; chunkCount: number } | null {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString();
    const parts = decoded.split(':');
    if (parts.length !== 3) return null;
    const fileSize = parseInt(parts[0], 10);
    const messageCount = parseInt(parts[1], 10);
    const chunkCount = parseInt(parts[2], 10);
    if (isNaN(fileSize) || isNaN(messageCount) || isNaN(chunkCount)) return null;
    if (fileSize < 0 || messageCount < 0 || chunkCount < 0) return null;
    return { fileSize, messageCount, chunkCount };
  } catch {
    return null;
  }
}
