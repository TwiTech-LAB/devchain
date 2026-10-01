import {
  Dirent,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { opendir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isSyncthingTemp } from '../../../common/constants/syncthing-markers';

const mockLogger = { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() };

jest.mock('../../../common/logging/logger', () => ({
  createLogger: () => mockLogger,
}));

jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, opendir: jest.fn(actual.opendir) };
});

import {
  SYNCTHING_TEMP_CLEANUP_TIMEOUT_MS,
  deleteSyncthingTempFiles,
} from './syncthing-temp-cleanup';

// Unit over a real directory: the walk's rules are filesystem decisions, and a
// temp dir is cheaper than any Syncthing-dependent layer.
describe('deleteSyncthingTempFiles', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'devchain-temp-cleanup-'));
    mockLogger.warn.mockClear();
    jest
      .mocked(opendir)
      .mockImplementation(
        jest.requireActual<typeof import('node:fs/promises')>('node:fs/promises').opendir,
      );
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('deletes temp files in the root, in sub-folders and in .git, and keeps every other file', async () => {
    writeFileSync(join(root, '.syncthing.app.ts.tmp'), 'partial');
    writeFileSync(join(root, '~syncthing~app.ts.tmp'), 'partial');
    writeFileSync(join(root, 'app.ts'), 'kept');
    writeFileSync(join(root, 'syncthing-notes.md'), 'kept');
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', '.syncthing.lib.ts.tmp'), 'partial');
    writeFileSync(join(root, 'src', 'lib.ts'), 'kept');
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, '.git', '.syncthing.index.tmp'), 'partial');
    writeFileSync(join(root, '.git', 'HEAD'), 'kept');

    await expect(deleteSyncthingTempFiles(root, [])).resolves.toBe(4);

    for (const kept of ['app.ts', 'syncthing-notes.md', 'src/lib.ts', '.git/HEAD']) {
      expect(existsSync(join(root, kept))).toBe(true);
    }
    for (const removed of [
      '.syncthing.app.ts.tmp',
      '~syncthing~app.ts.tmp',
      'src/.syncthing.lib.ts.tmp',
      '.git/.syncthing.index.tmp',
    ]) {
      expect(existsSync(join(root, removed))).toBe(false);
    }
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it('does not enter a directory the code folder ignores by plain name, but enters rooted and glob-ignored paths', async () => {
    const ignores = ['(?d)node_modules', '(?i)cache', '/rooted/path', '*.log'];
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'node_modules', '.syncthing.x.tmp'), 'partial');
    mkdirSync(join(root, 'CACHE'));
    writeFileSync(join(root, 'CACHE', '.syncthing.x.tmp'), 'partial');
    mkdirSync(join(root, 'rooted', 'path'), { recursive: true });
    writeFileSync(join(root, 'rooted', 'path', '.syncthing.x.tmp'), 'partial');

    await expect(deleteSyncthingTempFiles(root, ignores)).resolves.toBe(1);

    expect(existsSync(join(root, 'node_modules', '.syncthing.x.tmp'))).toBe(true);
    expect(existsSync(join(root, 'CACHE', '.syncthing.x.tmp'))).toBe(true);
    expect(existsSync(join(root, 'rooted', 'path', '.syncthing.x.tmp'))).toBe(false);
  });

  it('does not follow symlinks and keeps a symlink whose own name looks like a temp file', async () => {
    const outside = join(root, '..', `devchain-temp-cleanup-outside-${Date.now()}`);
    mkdirSync(outside);
    try {
      writeFileSync(join(outside, '.syncthing.outside.tmp'), 'partial');
      writeFileSync(join(root, 'app.ts'), 'kept');
      symlinkSync(outside, join(root, 'linked-dir'));
      symlinkSync(join(root, 'app.ts'), join(root, '.syncthing.link.tmp'));

      await expect(deleteSyncthingTempFiles(root, [])).resolves.toBe(0);

      expect(existsSync(join(outside, '.syncthing.outside.tmp'))).toBe(true);
      expect(existsSync(join(root, '.syncthing.link.tmp'))).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('deletes only regular files: a directory named like a temp file is entered, not removed', async () => {
    mkdirSync(join(root, '.syncthing.dir.tmp'));
    writeFileSync(join(root, '.syncthing.dir.tmp', '.syncthing.inner.tmp'), 'partial');

    await deleteSyncthingTempFiles(root, []);

    expect(existsSync(join(root, '.syncthing.dir.tmp'))).toBe(true);
    expect(existsSync(join(root, '.syncthing.dir.tmp', '.syncthing.inner.tmp'))).toBe(false);
  });

  it('stops at its time limit, warns with the number already deleted, and does not throw', async () => {
    writeFileSync(join(root, '.syncthing.first.tmp'), 'partial');
    const slowDirectory = {
      [Symbol.asyncIterator]: async function* (): AsyncGenerator<Dirent> {
        yield new Dirent('.syncthing.first.tmp', 1);
        yield new Dirent('slow', 2);
      },
      close: async () => undefined,
    };
    // The root answers with a fixed entry order; the sub-directory's opendir
    // never settles, so only the time limit can end the walk.
    jest
      .mocked(opendir)
      .mockImplementation(async (path: string) =>
        path === root ? (slowDirectory as never) : (new Promise<never>(() => undefined) as never),
      );

    await expect(deleteSyncthingTempFiles(root, [], 20)).resolves.toBe(1);

    expect(existsSync(join(root, '.syncthing.first.tmp'))).toBe(false);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ rootPath: root, deleted: 1 }),
      'Syncthing temp-file cleanup stopped at its time limit',
    );
    expect(SYNCTHING_TEMP_CLEANUP_TIMEOUT_MS).toBe(30_000);
  });

  it('warns and returns the count when the walk hits an error', async () => {
    const missing = join(root, 'missing');

    await expect(deleteSyncthingTempFiles(missing, [])).resolves.toBe(0);

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ rootPath: missing, deleted: 0, error: expect.any(String) }),
      'Syncthing temp-file cleanup failed',
    );
  });
});

describe('isSyncthingTemp', () => {
  it.each<[string, boolean]>([
    ['.syncthing.app.ts.tmp', true],
    ['~syncthing~app.ts.tmp', true],
    ['.syncthing..weird.tmp', true],
    ['app.ts', false],
    ['syncthing-notes.md', false],
    ['pre.syncthing.app.ts.tmp', false],
    ['.syncthing.app.ts.tmp2', false],
    ['.syncthing.tmp', false],
    ['~syncthing~.tmp', false],
  ])('names %s as a temp file: %s', (name, expected) => {
    expect(isSyncthingTemp(name)).toBe(expected);
  });
});
