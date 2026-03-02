import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { readFileHead } from './file-search.util';

describe('readFileHead', () => {
  it('returns file content when file exists', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-head-'));
    const filePath = path.join(dir, 'exists.txt');

    try {
      await fs.writeFile(filePath, 'hello world', 'utf8');
      await expect(readFileHead(filePath)).resolves.toBe('hello world');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('reads only the requested number of bytes from the file head', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-head-'));
    const filePath = path.join(dir, 'sample.txt');

    try {
      await fs.writeFile(filePath, 'abcdefghij', 'utf8');
      await expect(readFileHead(filePath, 5)).resolves.toBe('abcde');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('returns empty string for an empty file', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-head-'));
    const filePath = path.join(dir, 'empty.txt');

    try {
      await fs.writeFile(filePath, '', 'utf8');
      await expect(readFileHead(filePath)).resolves.toBe('');
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

  it('respects custom maxBytes values larger than default', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-head-'));
    const filePath = path.join(dir, 'large-32kb.txt');

    try {
      const content = 'x'.repeat(40_000);
      await fs.writeFile(filePath, content, 'utf8');
      const head = await readFileHead(filePath, 32_768);
      expect(head).toHaveLength(32_768);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('returns a string for binary content without throwing', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-head-'));
    const filePath = path.join(dir, 'binary.bin');

    try {
      const buffer = Buffer.from([0, 255, 1, 254, 2, 253]);
      await fs.writeFile(filePath, buffer);
      const head = await readFileHead(filePath, 6);
      expect(typeof head).toBe('string');
      expect(head).not.toBeNull();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('returns null on file permission errors', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-head-'));
    const filePath = path.join(dir, 'private.txt');

    try {
      await fs.writeFile(filePath, 'secret', 'utf8');
      await fs.chmod(filePath, 0o000);
      await expect(readFileHead(filePath)).resolves.toBeNull();
    } finally {
      await fs.chmod(filePath, 0o644).catch(() => undefined);
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
