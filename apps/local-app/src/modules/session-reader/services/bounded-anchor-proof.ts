/**
 * Bounded head/tail append proof for a file-backed source, shared by the parsed cache
 * ({@link SessionCacheService}) and the watcher's metrics-only lane
 * ({@link TranscriptWatcherService}). Both prove that the cached/lane prefix `[0, offset)` is
 * still the exact bytes they parsed before extending it — at a cost that depends on the anchor
 * size, not the file size.
 *
 * Accepted limit (user-approved): a same-length in-place overwrite strictly BETWEEN the head
 * and tail windows, combined with growth, is not detected until the next full parse. Any edit
 * that changes the length shifts the tail window and is detected.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';

const FILE_HASH_CHUNK_BYTES = 64 * 1024;
/** Size of each bounded append-proof window (head and tail). */
export const FILE_ANCHOR_BYTES = 64 * 1024;

/** SHA-256 of the first and last {@link FILE_ANCHOR_BYTES} of the accepted prefix `[0, offset)`. */
export interface FileContentAnchors {
  headDigest: string;
  tailDigest: string;
}

/** The file-identity/size/mtime snapshot an anchor proof is asserted against. */
export interface FileFreshnessSnapshot {
  size: number;
  mtimeMs: number;
  fileIdentity?: string;
}

export function anchorsEqual(
  a: FileContentAnchors | undefined,
  b: FileContentAnchors | undefined,
): boolean {
  return (
    a !== undefined &&
    b !== undefined &&
    a.headDigest === b.headDigest &&
    a.tailDigest === b.tailDigest
  );
}

/**
 * Bounded head/tail SHA-256 anchors over the `[0, offset)` prefix of a file. The head is the
 * first {@link FILE_ANCHOR_BYTES}; the tail is the last {@link FILE_ANCHOR_BYTES} ending at
 * `offset` (each window shrinks to the available bytes for a short prefix). Cost is O(anchor),
 * independent of file size. Throws when the bounds are invalid or the snapshot drifted.
 *
 * `allowGrowth` picks the stability assertion: `false` (pre-parse / full-parse store) requires
 * the file to still match `expected` exactly, so a file that changes during the work yields no
 * anchors; `true` (post-parse) accepts the same inode grown to a size no smaller than the
 * snapshot, so an append landing mid-parse does not fail the proof.
 */
export async function hashFileAnchors(
  filePath: string,
  expected: FileFreshnessSnapshot,
  offset: number,
  allowGrowth = false,
): Promise<FileContentAnchors> {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > expected.size ||
    expected.fileIdentity === undefined
  ) {
    throw new Error('Invalid file anchor bounds');
  }

  const handle = await fs.open(filePath, 'r');
  const assertStableSnapshot = async (): Promise<void> => {
    const current = await handle.stat();
    const currentIdentity = `${current.dev}:${current.ino}`;
    if (currentIdentity !== expected.fileIdentity) {
      throw new Error('File identity changed while computing anchor proof');
    }
    if (allowGrowth) {
      if (current.size < expected.size) {
        throw new Error('File shrank while computing anchor proof');
      }
    } else if (current.size !== expected.size || current.mtime.getTime() !== expected.mtimeMs) {
      throw new Error('File changed while computing anchor proof');
    }
  };

  try {
    await assertStableSnapshot();
    const headLength = Math.min(FILE_ANCHOR_BYTES, offset);
    const tailStart = Math.max(0, offset - FILE_ANCHOR_BYTES);
    const headDigest = await hashRange(handle, 0, headLength);
    const tailDigest = await hashRange(handle, tailStart, offset - tailStart);
    await assertStableSnapshot();
    return { headDigest, tailDigest };
  } finally {
    await handle.close();
  }
}

/** SHA-256 of `length` bytes read from `start`; the empty range hashes to a constant. */
async function hashRange(handle: fs.FileHandle, start: number, length: number): Promise<string> {
  const hash = createHash('sha256');
  if (length <= 0) return hash.digest('hex');

  const buffer = Buffer.allocUnsafe(Math.min(FILE_HASH_CHUNK_BYTES, length));
  const end = start + length;
  let position = start;
  while (position < end) {
    const requested = Math.min(buffer.byteLength, end - position);
    const { bytesRead } = await handle.read(buffer, 0, requested, position);
    if (bytesRead === 0) {
      throw new Error('File ended while computing anchor proof');
    }
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest('hex');
}
