import * as fs from 'node:fs/promises';

const SCAN_CHUNK_BYTES = 64 * 1024;

/**
 * Empty line source for a bounded read whose window holds no complete line. Lets the
 * parser keep its single `for await (const line of ...)` loop instead of branching, while
 * still consuming zero lines and leaving `bytesRead` at the window start.
 */
export async function* noLines(): AsyncGenerator<string> {}

/**
 * Exclusive end of the last newline-terminated line within `[start, endExclusive)`:
 * one byte past the final `\n`, or `start` when the range contains none.
 *
 * A bounded incremental read streams `[start, result)` so the parser sees only complete
 * lines. An unterminated final line — one still being written, or cut off by
 * `endExclusive` when the file grew past the proven snapshot — is held back, and the
 * caller advances the offset only to `result` (the line's true start) so the next pass
 * reads the completed line exactly once. `start` must be a line boundary.
 */
export async function lastCompleteLineEnd(
  filePath: string,
  start: number,
  endExclusive: number,
): Promise<number> {
  if (endExclusive <= start) return start;
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(Math.min(SCAN_CHUNK_BYTES, endExclusive - start));
    let pos = endExclusive;
    while (pos > start) {
      const length = Math.min(buffer.byteLength, pos - start);
      const readStart = pos - length;
      const { bytesRead } = await handle.read(buffer, 0, length, readStart);
      if (bytesRead <= 0) break;
      for (let i = bytesRead - 1; i >= 0; i -= 1) {
        if (buffer[i] === 0x0a) return readStart + i + 1;
      }
      pos = readStart;
    }
    return start;
  } finally {
    await handle.close();
  }
}
