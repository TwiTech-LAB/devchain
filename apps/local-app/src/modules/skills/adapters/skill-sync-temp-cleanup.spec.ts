import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cleanupStaleSkillSyncDirectories,
  STALE_SKILL_SYNC_DIR_MAX_AGE_MS as maxAgeMs,
} from './skill-sync-temp-cleanup';

jest.mock('node:fs/promises', () => ({
  ...jest.requireActual('node:fs/promises'),
  rm: jest.fn(jest.requireActual('node:fs/promises').rm),
}));

jest.mock('../../../common/logging/logger', () => ({
  __mockLogger: { warn: jest.fn() },
  createLogger: jest.fn(() => jest.requireMock('../../../common/logging/logger').__mockLogger),
}));

describe('cleanupStaleSkillSyncDirectories', () => {
  const warn = jest.requireMock('../../../common/logging/logger').__mockLogger.warn;
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'skill-cleanup-test-'));
    warn.mockClear();
    jest.mocked(fs.rm).mockReset().mockImplementation(jest.requireActual('node:fs/promises').rm);
  });

  afterEach(async () => {
    jest.mocked(fs.rm).mockImplementation(jest.requireActual('node:fs/promises').rm);
    await fs.rm(root, { recursive: true, force: true });
  });

  async function directory(name: string, contents: string[], old = true): Promise<string> {
    const path = join(root, name);
    await fs.mkdir(path);
    for (const content of contents) {
      if (content === 'repo') await fs.mkdir(join(path, content));
      else await fs.writeFile(join(path, content), 'test');
    }
    if (old) {
      const timestamp = new Date(Date.now() - 2 * maxAgeMs);
      await fs.utimes(path, timestamp, timestamp);
    }
    return path;
  }

  it('removes only old matching directories holding repository artifacts', async () => {
    await directory('skills-openai-Ab12Cd', ['repo', 'repo.tar.gz']);
    await directory('skills-other-AB1234', ['repo']);
    await directory('skills-empty-abc123', []);
    await directory('skills-young-abc123', ['repo'], false);
    await directory('skills-extra-abc123', ['repo', 'keep.txt']);
    await directory('unrelated-abc123', ['repo']);
    await directory('skills-short-abc12', ['repo']);
    await directory('skills-long-abc1234', ['repo']);
    await fs.writeFile(join(root, 'skills-file-abc123'), 'keep');
    const target = await directory('outside', ['repo']);
    await fs.symlink(target, join(root, 'skills-link-abc123'));

    await cleanupStaleSkillSyncDirectories(root, maxAgeMs);

    expect((await fs.readdir(root)).sort()).toEqual(
      [
        'outside',
        'skills-extra-abc123',
        'skills-file-abc123',
        'skills-link-abc123',
        'skills-long-abc1234',
        'skills-short-abc12',
        'skills-young-abc123',
        'unrelated-abc123',
      ].sort(),
    );
  });

  it('logs a failed delete and continues cleaning other entries', async () => {
    const failingPath = await directory('skills-a-abc123', ['repo']);
    await directory('skills-b-abc123', ['repo.tar.gz']);
    const realRm = jest.requireActual<typeof fs>('node:fs/promises').rm;
    jest.mocked(fs.rm).mockImplementation(async (path, options) => {
      if (path === failingPath) throw new Error('permission denied');
      await realRm(path, options);
    });

    await expect(cleanupStaleSkillSyncDirectories(root, maxAgeMs)).resolves.toBeUndefined();

    expect(await fs.readdir(root)).toEqual(['skills-a-abc123']);
    expect(warn).toHaveBeenCalledWith(
      { path: failingPath, error: expect.any(Error) },
      'Failed to clean stale skill sync directory',
    );
  });

  it('logs a root scan failure without throwing', async () => {
    await expect(
      cleanupStaleSkillSyncDirectories(join(root, 'missing'), maxAgeMs),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      { rootDir: join(root, 'missing'), error: expect.objectContaining({ code: 'ENOENT' }) },
      'Failed to scan skill sync temp directories',
    );
  });
});
