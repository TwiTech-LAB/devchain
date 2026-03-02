import { open } from 'node:fs/promises';

const DEFAULT_READ_BYTES = 16_384;

/**
 * Read the first N bytes from a file without loading the entire file in memory.
 *
 * Returns:
 * - string (including empty string for empty files) on success
 * - null on I/O error
 */
export async function readFileHead(
  filePath: string,
  maxBytes = DEFAULT_READ_BYTES,
): Promise<string | null> {
  const bytesToRead = Math.max(0, Math.floor(maxBytes));
  let fileHandle: Awaited<ReturnType<typeof open>> | null = null;

  try {
    fileHandle = await open(filePath, 'r');
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await fileHandle.read(buffer, 0, bytesToRead, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    return null;
  } finally {
    await fileHandle?.close();
  }
}
