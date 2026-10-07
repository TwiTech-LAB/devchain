import { chmod, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { captureFileSyncConflictBaseline, scanFileSyncConflicts } from './file-sync-conflicts';

// Filesystem unit coverage owns baseline exclusion, ignore semantics and full count.
describe('scanFileSyncConflicts', () => {
  let root: string;
  const startedAt = '2020-01-01T00:00:00.000Z';
  const since = Date.parse(startedAt) / 1000;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'devchain-conflicts-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  async function file(name: string, modified = since + 10) {
    const path = join(root, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'conflict');
    await utimes(path, modified, modified);
  }

  it('counts new copies with old mtimes beyond the sample and excludes baseline copies and symlinks', async () => {
    await file('old.sync-conflict-date.txt', since - 1);
    const baseline = await captureFileSyncConflictBaseline(root, []);
    await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        file(`src/file-${index}.sync-conflict-date.txt`, since - 100),
      ),
    );
    await file('boundary.sync-conflict-date.txt', since);
    await file('old.sync-conflict-date.txt', since - 1);
    await file('ordinary.txt');
    await symlink(join(root, 'src'), join(root, 'linked'));
    await symlink(
      join(root, 'boundary.sync-conflict-date.txt'),
      join(root, 'link.sync-conflict-date.txt'),
    );
    const report = await scanFileSyncConflicts(root, baseline, []);
    expect(report.total).toBe(26);
    expect(report.sample).toHaveLength(20);
    expect(
      report.sample.some(
        (name) => name.startsWith('linked/') || name.startsWith('old') || name.startsWith('link.'),
      ),
    ).toBe(false);
  });

  it('honors ordered system/managed/user ignores, globs, negations, flags and included patterns', async () => {
    const ignored = [
      '.git/hook.sync-conflict-date',
      'data/value.sync-conflict-date',
      'nested/drop.sync-conflict-date.txt',
      'CACHE/value.sync-conflict-date',
      'logs/deep/value.sync-conflict-date.txt',
      'dist/value.sync-conflict-date',
      'build/value.sync-conflict-date',
      'range5/value.sync-conflict-date',
      '[literal]/value.sync-conflict-date',
      'slash/value.sync-conflict-date',
    ];
    const kept = [
      'nested/keep.sync-conflict-date.txt',
      'sub/data/value.sync-conflict-date',
      'src/value.sync-conflict-date.ts',
    ];
    await Promise.all([...ignored, ...kept].map((name) => file(name)));
    await writeFile(
      join(root, 'patterns'),
      '(?d)(?i)cache\n/{dist,build}\nrange[0-9]\n/\\[literal\\]\n',
    );
    const report = await scanFileSyncConflicts(root, { baselineOverCap: false, paths: [] }, [
      '/.git',
      '/data',
      '!nested/keep*',
      'nested/**',
      'logs/**/*.sync-conflict-*',
      '#include patterns',
      '/slash/',
    ]);
    expect(report).toEqual({ total: 3, sample: kept.sort() });
  });

  it('prunes an unreadable ignored folder that no earlier negation can reach, and still enters reachable ones', async () => {
    await file('cache/.gitignore.sync-conflict-date');
    await file('cache/locked/output');
    await file('keep/inner/copy.sync-conflict-date.txt');
    await file('keep/other/drop.sync-conflict-date.txt');
    await file('src/value.sync-conflict-date.ts');
    const locked = join(root, 'cache/locked');
    await chmod(locked, 0o000);
    try {
      // The Fix file sync patterns: a tracked-file negation before its folder exclusion.
      const patterns = [
        '!/cache/.gitignore',
        '!/cache/control\\[1\\].txt',
        '(?d)/cache',
        '!/keep/inner/*',
        '/keep',
      ];
      const baseline = await captureFileSyncConflictBaseline(root, patterns);
      expect(baseline).toEqual({
        baselineOverCap: false,
        paths: expect.arrayContaining([
          'keep/inner/copy.sync-conflict-date.txt',
          'src/value.sync-conflict-date.ts',
        ]),
      });
      expect(baseline.baselineOverCap === false && baseline.paths).toHaveLength(2);
    } finally {
      await chmod(locked, 0o755);
    }
  });

  it('ends an interrupted walk with the cancellation reason', async () => {
    const controller = new AbortController();
    controller.abort(new Error('Connect cancelled'));
    await expect(
      scanFileSyncConflicts(root, { baselineOverCap: false, paths: [] }, [], controller.signal),
    ).rejects.toThrow('Connect cancelled');
  });

  it('marks an over-cap baseline without retaining a partial list, then counts all copies', async () => {
    await Promise.all(
      Array.from({ length: 1001 }, (_, index) => file(`${index}.sync-conflict-date.txt`)),
    );
    const baseline = await captureFileSyncConflictBaseline(root, []);
    expect(baseline).toEqual({ baselineOverCap: true });
    const report = await scanFileSyncConflicts(root, baseline, []);
    expect(report).toMatchObject({ total: 1001, baselineOverCap: true });
    expect(report.sample).toHaveLength(20);
  });
});
