/** Filesystem integration is the cheapest layer that verifies tar traversal rejection and rename rollback against real directories. */
import * as fs from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import * as tar from 'tar';
import {
  HOME_SKILL_CONTENT_LIMIT,
  swapHomeSkillContent,
  unpackHomeSkillContent,
} from './host-skill-content';

function archive(
  path: string,
  type: 'File' | 'Directory' | 'SymbolicLink' | 'Link' = 'File',
  content = Buffer.from('data'),
): Buffer {
  const header = new tar.Header({
    path,
    type,
    size: type === 'File' ? content.length : 0,
    mode: 0o644,
    linkpath: type === 'Link' || type === 'SymbolicLink' ? 'outside' : '',
  });
  header.encode();
  return Buffer.concat([
    header.block!,
    type === 'File' ? content : Buffer.alloc(0),
    Buffer.alloc(((512 - (content.length % 512)) % 512) + 1024),
  ]);
}

describe('Home local content', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'home-content-'));
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });
  it.each(['/absolute', 'skills/../escape', '../escape', 'outside/file', 'skills\\escape'])(
    'refuses unsafe entry %s',
    async (path) => {
      await expect(
        unpackHomeSkillContent(Readable.from([archive(path)]), root),
      ).rejects.toMatchObject({ status: 400 });
      expect(await fs.readdir(root)).toEqual([]);
    },
  );
  it.each(['Link', 'SymbolicLink'] as const)('refuses %s entries', async (type) => {
    await expect(
      unpackHomeSkillContent(Readable.from([archive('skills/link', type)]), root),
    ).rejects.toMatchObject({ status: 400 });
  });
  it('refuses more than 20 MB received', async () => {
    await expect(
      unpackHomeSkillContent(Readable.from([Buffer.alloc(HOME_SKILL_CONTENT_LIMIT + 1)]), root),
    ).rejects.toMatchObject({ status: 413 });
  });
  it('refuses a compressed archive whose unpacked entries exceed 20 MB', async () => {
    const compressed = gzipSync(
      archive('skills/large', 'File', Buffer.alloc(HOME_SKILL_CONTENT_LIMIT + 1)),
    );
    expect(compressed.length).toBeLessThan(HOME_SKILL_CONTENT_LIMIT);
    await expect(unpackHomeSkillContent(Readable.from([compressed]), root)).rejects.toMatchObject({
      status: 413,
    });
  });
  it('accepts gzip and rolls back a failed second rename without losing the previous copy', async () => {
    const destination = join(root, 'source');
    await fs.mkdir(destination);
    await fs.writeFile(join(destination, 'old'), 'old');
    const temporary = await unpackHomeSkillContent(
      Readable.from([gzipSync(archive('skills/example/SKILL.md'))]),
      root,
    );
    let calls = 0;
    await expect(
      swapHomeSkillContent(temporary, destination, () => {
        if (++calls === 2) rmSync(temporary, { recursive: true });
      }),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(join(destination, 'old'), 'utf8')).toBe('old');
  });
  it('rolls back when a newer hash arrives during the swap', async () => {
    const destination = join(root, 'source');
    await fs.mkdir(destination);
    await fs.writeFile(join(destination, 'old'), 'old');
    const temporary = await unpackHomeSkillContent(
      Readable.from([archive('skills/example/SKILL.md')]),
      root,
    );
    let calls = 0;
    await expect(
      swapHomeSkillContent(temporary, destination, () => {
        if (++calls === 3) throw new Error('stale upload');
      }),
    ).rejects.toThrow('stale upload');
    expect(await fs.readFile(join(destination, 'old'), 'utf8')).toBe('old');
  });
});
