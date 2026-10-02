import { appendFile, mkdtemp, open, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkAppendProof,
  FILE_ANCHOR_BYTES,
  hashFileAnchors,
  type FileContentAnchors,
} from './bounded-anchor-proof';

// Pass-through, so one test can land an append between opening the file and hashing it.
jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual('node:fs/promises');
  return { ...actual, open: jest.fn(actual.open) };
});
const mockOpen = open as jest.MockedFunction<typeof open>;

// Real temp files: the proof's contract is about filesystem identity, size and bytes, which a
// mocked fs would assume away.
describe('checkAppendProof', () => {
  let directory: string;
  let filePath: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'devchain-append-proof-'));
    filePath = join(directory, 'session.jsonl');
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  /** Identity and anchors over the whole current file, as a parse would mint them. */
  async function mint(): Promise<{
    fileIdentity: string;
    offset: number;
    anchors: FileContentAnchors;
  }> {
    const current = await stat(filePath);
    const fileIdentity = `${current.dev}:${current.ino}`;
    const anchors = await hashFileAnchors(
      filePath,
      { size: current.size, mtimeMs: current.mtime.getTime(), fileIdentity },
      current.size,
    );
    return { fileIdentity, offset: current.size, anchors };
  }

  async function check(proof: Awaited<ReturnType<typeof mint>>) {
    return checkAppendProof(filePath, proof.fileIdentity, proof.offset, proof.anchors);
  }

  // Longer than both anchor windows, so an edit between them is the accepted blind spot.
  const prefix = 'x'.repeat(FILE_ANCHOR_BYTES * 3) + '\n';

  it('proves an unchanged file and an appended file', async () => {
    await writeFile(filePath, prefix);
    const proof = await mint();

    await expect(check(proof)).resolves.toBe('appended');
    await appendFile(filePath, '{"more":true}\n');
    await expect(check(proof)).resolves.toBe('appended');
  });

  it('proves while an append lands during the proof', async () => {
    await writeFile(filePath, prefix);
    const proof = await mint();
    const realOpen: typeof open = jest.requireActual('node:fs/promises').open;
    mockOpen.mockClear();
    mockOpen.mockImplementationOnce(async (...args) => {
      const handle = await realOpen(...args);
      await appendFile(filePath, '{"during":"proof"}\n');
      return handle;
    });

    await expect(check(proof)).resolves.toBe('appended');
    expect(mockOpen).toHaveBeenCalledTimes(1);
    expect((await stat(filePath)).size).toBeGreaterThan(proof.offset);
  });

  it('reports a replacement, a missing file, a truncation and a rewrite', async () => {
    await writeFile(filePath, prefix);
    const proof = await mint();

    await writeFile(filePath, prefix.slice(0, 10));
    await expect(check(proof)).resolves.toBe('truncated');

    await writeFile(filePath, 'y' + prefix.slice(1) + 'appended\n');
    await expect(check(proof)).resolves.toBe('rewritten');

    const replacement = join(directory, 'replacement.jsonl');
    await writeFile(replacement, prefix);
    await rename(replacement, filePath);
    await expect(check(proof)).resolves.toBe('replaced');

    await rm(filePath);
    await expect(check(proof)).resolves.toBe('replaced');
  });

  it('detects a rewrite inside the tail window that keeps the length', async () => {
    await writeFile(filePath, prefix);
    const proof = await mint();

    await writeFile(filePath, prefix.slice(0, -2) + 'y\n' + 'appended\n');
    await expect(check(proof)).resolves.toBe('rewritten');
  });
});
