import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { readFileHead } from './file-search.util';

describe('readFileHead', () => {
  it.each([
    ['whole file', 'hello world', undefined, 'hello world'],
    ['bounded head', 'abcdefghij', 5, 'abcde'],
    ['empty file', '', undefined, ''],
  ] as const)('reads %s', async (_name, content, maxBytes, expected) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-head-'));
    const filePath = path.join(dir, 'sample.txt');
    try {
      await fs.writeFile(filePath, content, 'utf8');
      await expect(readFileHead(filePath, maxBytes)).resolves.toBe(expected);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('returns null when file cannot be read', async () => {
    await expect(readFileHead('/does/not/exist/session.jsonl')).resolves.toBeNull();
  });

  it('uses the 16KB default when maxBytes is omitted', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-head-'));
    const filePath = path.join(dir, 'large.txt');

    try {
      const content = 'x'.repeat(20_000);
      await fs.writeFile(filePath, content, 'utf8');
      const head = await readFileHead(filePath);
      expect(head).toHaveLength(16_384);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
