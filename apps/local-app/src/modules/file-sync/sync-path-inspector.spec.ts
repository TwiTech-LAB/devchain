// Service unit tests use real Git/files to catch ignore/index semantics; only numeric ownership is substituted.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ChildProcessExecutor } from '../terminal/services/process-executor/child-process-executor';
import { SyncPathInspector } from './sync-path-inspector';
import {
  buildExclusionSuggestions,
  proposeExclusionPatterns,
  type BuildExclusionSuggestionsInput,
} from './build-exclusion-suggestions';
import { SyncPathInspectionSchema } from './sync-path-inspection.dto';
import { firstMatch } from './ignore-pattern-matcher';

describe('SyncPathInspector', () => {
  let root: string;
  let inspector: SyncPathInspector;
  let executor: ChildProcessExecutor;
  let uids: Map<string, number>;
  let files: typeof fs;
  const write = (path: string, contents = 'runtime') => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  };
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  const buildChecked = async (input: BuildExclusionSuggestionsInput) => {
    const patterns = proposeExclusionPatterns(input);
    const home = await inspector.inspect(input.home.rootPath, false, [], patterns);
    const vm =
      input.vm === 'unavailable'
        ? null
        : await inspector.inspect(input.vm.rootPath, false, [], patterns);
    return buildExclusionSuggestions({
      ...input,
      patternChecks: {
        home: home.patternChecks!,
        vm: vm ? vm.patternChecks! : 'unavailable',
      },
    });
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'devchain-sync-inspection-'));
    git('init', '-q');
    uids = new Map();
    executor = new ChildProcessExecutor();
    files = {
      ...fs,
      lstat: async (path: string) =>
        Object.assign(await fs.lstat(path), { uid: uids.get(path) ?? 1000 }),
      readFile: async (path: string, encoding: BufferEncoding) =>
        path === '/etc/passwd'
          ? 'alice:x:1000:1000::/home/alice:/bin/bash\napache:x:48:48::/:/bin/false\n'
          : fs.readFile(path, encoding),
    } as typeof fs;
    inspector = new SyncPathInspector(executor, files);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it('excludes only foreign-owned output in a netbox-shaped Git repository', async () => {
    write('.gitignore', '*__pycache__/\n*.egg-info/\ntmp/\n');
    write('device-type-importer/.gitignore', '.env*\n__pycache__/\nrepo\n');
    write('device-type-importer/settings.py', 'tracked source');
    write('device-type-importer/.env', 'NETBOX_URL=local');
    write('device-type-importer/.env.stage', 'NETBOX_URL=stage');
    write('tmp/backup.bak', 'healthy backup');
    for (const plugin of ['a', 'b']) {
      write(`plugins/${plugin}/.gitignore`, '__pycache__/\n*.egg-info/\n');
      write(`plugins/${plugin}/pkg/source.py`, 'tracked source');
    }
    git(
      'add',
      '.gitignore',
      'device-type-importer/.gitignore',
      'device-type-importer/settings.py',
      'plugins',
    );
    const foreignPaths = [
      'device-type-importer/repo',
      'device-type-importer/__pycache__',
      ...['a', 'b'].flatMap((plugin) => [
        `plugins/${plugin}/x.egg-info`,
        `plugins/${plugin}/pkg/__pycache__`,
      ]),
    ];
    for (const path of foreignPaths) {
      write(`${path}/generated`, 'foreign output');
      uids.set(join(root, path), 0);
      uids.set(join(root, path, 'generated'), 0);
    }
    const inspection = await inspector.inspect(root, true);
    expect(inspection.candidates).toEqual([...foreignPaths].sort());
    const result = await buildChecked({
      ownerSide: 'home',
      home: inspection,
      vm: inspection,
      userIgnores: [],
      managedExclusions: [],
    });
    const patterns = result.groups.flatMap((group) => group.patterns);
    expect(patterns).toEqual([
      '(?d)*__pycache__',
      '(?d)*.egg-info',
      '(?d)/device-type-importer/repo',
      '(?d)/device-type-importer/**/repo',
    ]);
    expect(result.overLimit).toBe(false);
    expect(
      result.groups.map((group) => ({
        selected: group.selected,
        checked: group.patternChecksPassed,
      })),
    ).toEqual([
      { selected: true, checked: true },
      { selected: true, checked: true },
      { selected: true, checked: true },
    ]);
    for (const path of [
      'device-type-importer/.env',
      'device-type-importer/.env.stage',
      'tmp',
      'tmp/backup.bak',
      'device-type-importer/settings.py',
      'device-type-importer/new.py',
    ]) {
      expect(firstMatch(patterns, path)).toEqual({ kind: 'none' });
    }
    for (const path of foreignPaths) {
      expect(firstMatch(patterns, `${path}/generated`)).toMatchObject({
        kind: 'matched',
        ignored: true,
      });
    }
  });

  it.each([1, 50, 51])(
    'reports all %i tracked matches only within the complete-list limit',
    async (count) => {
      const files = Array.from(
        { length: count },
        (_, index) => `cache/file-${String(index).padStart(2, '0')}`,
      );
      for (const file of files) write(file);
      git('add', 'cache');
      const run = jest.spyOn(executor, 'run');
      const result = await inspector.inspect(root, false, [], ['(?d)/cache']);
      expect(result.patternChecks).toEqual({
        state: 'checked',
        results: [
          {
            pattern: '(?d)/cache',
            tracked: { count, files: count <= 50 ? files : [], complete: count <= 50 },
            kept: { count: 0, sample: [] },
          },
        ],
      });
      expect(run.mock.calls.map(([request]) => request.argv)).toEqual([
        ['git', 'ls-files', '-z'],
        ['git', 'ls-files', '-z', '--others', '--exclude-standard'],
      ]);
      expect(result).toMatchObject({ candidates: [], entries: [] });
    },
  );

  it('counts Git-kept matches from a later keep rule and bounds the sample', async () => {
    write('.gitignore', '*.egg-info/\n!/scratch.egg-info/\n');
    write('output.egg-info/ignored');
    const files = Array.from({ length: 6 }, (_, index) => `scratch.egg-info/keep-${index}`);
    for (const file of files) write(file);
    const result = await inspector.inspect(root, false, [], ['(?d)*.egg-info']);
    expect(result.patternChecks).toEqual({
      state: 'checked',
      results: [
        {
          pattern: '(?d)*.egg-info',
          tracked: { count: 0, files: [], complete: true },
          kept: { count: 6, sample: files.slice(0, 5) },
        },
      ],
    });
  });

  it('detects a plain file excluded by a translated directory-only Git rule', async () => {
    write('.gitignore', '*.egg-info/\n');
    write('README.egg-info');
    write('output.egg-info/ignored');
    const result = await inspector.inspect(root, false, [], ['(?d)*.egg-info']);
    expect(result.patternChecks?.results[0].kept).toEqual({
      count: 1,
      sample: ['README.egg-info'],
    });
  });

  it.each(['no-root', 'no-repo'] as const)('reports %s without running Git', async (state) => {
    rmSync(join(root, '.git'), { recursive: true });
    const run = jest.spyOn(executor, 'run');
    const result = await inspector.inspect(
      state === 'no-root' ? join(root, 'missing') : root,
      false,
      [],
      ['cache'],
    );
    expect(result.patternChecks).toEqual({ state, results: [] });
    expect(result.exists).toBe(state !== 'no-root');
    expect(run).not.toHaveBeenCalled();
  });

  it.each(['tracked', 'kept'] as const)(
    'reports a failed %s listing without zero counts',
    async (listing) => {
      write('tracked.txt');
      git('add', 'tracked.txt');
      const run = jest.spyOn(executor, 'run');
      if (listing === 'kept')
        run.mockResolvedValueOnce({
          success: true,
          exitCode: 0,
          stdout: 'tracked.txt\0',
          stderr: '',
          timedOut: false,
          truncated: false,
        });
      run.mockResolvedValue({
        success: false,
        exitCode: 128,
        stdout: '',
        stderr: 'git failed',
        timedOut: false,
        truncated: false,
      });
      const result = await inspector.inspect(root, false, [], ['*.txt']);
      expect(result.patternChecks).toEqual({ state: 'error', error: 'git failed', results: [] });
      expect(result.gitState).toBe('error');
    },
  );

  it.each(['truncated', 'timedOut'] as const)(
    'reports an incomplete Git-kept listing (%s) as an error',
    async (failure) => {
      const run = jest.spyOn(executor, 'run');
      run.mockResolvedValueOnce({
        success: true,
        exitCode: 0,
        stdout: '',
        stderr: '',
        timedOut: false,
        truncated: false,
      });
      run.mockResolvedValue({
        success: true,
        exitCode: 0,
        stdout: 'keep.txt\0',
        stderr: '',
        timedOut: failure === 'timedOut',
        truncated: failure === 'truncated',
      });
      const result = await inspector.inspect(root, false, [], ['*.txt']);
      expect(result.patternChecks).toMatchObject({ state: 'error', results: [] });
    },
  );

  it.each(['[', '#include other.ignore'])(
    'leaves uncheckable pattern %s unknown',
    async (pattern) => {
      write('keep.txt');
      const result = await inspector.inspect(root, false, [], [pattern]);
      expect(result.patternChecks).toMatchObject({ state: 'error', results: [] });
    },
  );

  it.each(['!*.txt', '// comment'])('does not report exclusions for %s', async (pattern) => {
    write('keep.txt');
    const result = await inspector.inspect(root, false, [], [pattern]);
    expect(result.patternChecks).toEqual({
      state: 'checked',
      results: [
        {
          pattern,
          tracked: { count: 0, files: [], complete: true },
          kept: { count: 0, sample: [] },
        },
      ],
    });
  });

  it.each(['valid', 'empty', 'partial', 'missing', 'worktree'] as const)(
    'reports repository separately from gitState for %s .git',
    async (kind) => {
      if (kind !== 'valid') rmSync(join(root, '.git'), { recursive: true, force: true });
      if (kind === 'empty' || kind === 'partial') mkdirSync(join(root, '.git'));
      if (kind === 'partial') write('.git/HEAD', 'ref: refs/heads/main\n');
      if (kind === 'worktree') write('.git', 'gitdir: /somewhere');
      const result = await inspector.inspect(root, false);
      expect(result.repository).toBe(kind === 'valid');
      if (kind === 'empty' || kind === 'partial') expect(result.gitState).toBe('error');
    },
  );

  it('finds only foreign-owned ignored output and leaves healthy runtime names and env files out', async () => {
    write('.gitignore', '*.egg-info/\nlogs/\n.env\nenv/\nservice-output/\ntmp/\n');
    write('plugins/a/a.egg-info/PKG-INFO');
    write('plugins/b/b.egg-info/PKG-INFO');
    write('logs/log.txt');
    write('.env', 'needed config');
    write('env/netbox.env', 'needed config');
    write('tmp/backup.bak');
    write('service-output/state');
    write('templates_c/.gitignore', '*\n!.gitignore\n');
    write('templates_c/output');
    for (const path of [
      'plugins/a/a.egg-info/PKG-INFO',
      'plugins/b/b.egg-info/PKG-INFO',
      'logs/log.txt',
      'service-output/state',
      'templates_c/output',
    ])
      uids.set(join(root, path), 48);
    git('add', 'templates_c/.gitignore');
    const run = jest.spyOn(executor, 'run');
    const result = await inspector.inspect(root, true);
    expect(result.gitState).toBe('repo');
    expect(result.candidates).toEqual([
      'logs',
      'plugins/a/a.egg-info',
      'plugins/b/b.egg-info',
      'service-output',
      'templates_c/output',
    ]);
    expect(result.entries.find((entry) => entry.path === 'service-output')).toMatchObject({
      owner: { uid: 1000, name: 'alice' },
      foreignOwner: false,
      foreignOwners: [{ uid: 48, name: 'apache' }],
      fileCount: 1,
    });
    expect(result.entries.find((entry) => entry.path === 'templates_c/output')).toMatchObject({
      ignored: true,
      trackedDescendants: [],
    });
    expect(
      run.mock.calls.filter(([request]) => request.argv.join(' ') === 'git ls-files -z'),
    ).toHaveLength(1);
    const built = await buildChecked({
      ownerSide: 'home',
      home: result,
      vm: 'unavailable',
      userIgnores: [],
      managedExclusions: [],
    });
    expect(built.groups.find((group) => group.path === 'templates_c/output')).toMatchObject({
      selected: true,
      reason: 'Written by another user (apache)',
      patterns: ['!/templates_c/.gitignore', '(?d)/templates_c/*', '(?d)/templates_c/**/*'],
    });
    expect(built.groups.find((group) => group.path === 'logs')).toMatchObject({
      selected: true,
      pattern: '(?d)logs',
    });
    expect(built.groups.some((group) => group.path.includes('env'))).toBe(false);
  });

  it.each([false, true])(
    'keeps foreign-owned output separate from its Git-kept parent and sibling when unignored=%s',
    async (unignored) => {
      const folder = 'data[one]/templates_c';
      write(`${folder}/.gitignore`, '*\n!.gitignore\n!keep.txt\n');
      write(`${folder}/output`);
      uids.set(join(root, `${folder}/output`), 48);
      git('add', `${folder}/.gitignore`);
      if (unignored) write(`${folder}/keep.txt`);
      const result = await inspector.inspect(root, true);
      expect(result.entries).toEqual([
        expect.objectContaining({ path: `${folder}/output`, ignored: true }),
      ]);
      const built = await buildChecked({
        ownerSide: 'home',
        home: result,
        vm: 'unavailable',
        userIgnores: [],
        managedExclusions: [],
      });
      expect(built.groups[0]).toMatchObject({
        selected: true,
        patterns: unignored
          ? ['(?d)/data\\[one\\]/templates_c/output']
          : [
              '!/data\\[one\\]/templates_c/.gitignore',
              '(?d)/data\\[one\\]/templates_c/*',
              '(?d)/data\\[one\\]/templates_c/**/*',
            ],
      });
    },
  );

  it('keeps foreign-owned ignored output below a tracked folder and leaves sibling env files synced', async () => {
    write('.gitignore', '/data/\n');
    write('data/keep.txt', 'tracked source');
    write('data/.env', 'needed config');
    write('data/cache/runtime');
    uids.set(join(root, 'data/cache/runtime'), 48);
    git('add', '-f', 'data/keep.txt');
    const result = await inspector.inspect(root, true);
    expect(result.candidates).toEqual(['data/cache']);
    expect(result.entries[0]).toMatchObject({ path: 'data/cache', ignored: true });
    const built = await buildChecked({
      ownerSide: 'home',
      home: result,
      vm: 'unavailable',
      userIgnores: [],
      managedExclusions: [],
    });
    expect(built.groups).toEqual([
      expect.objectContaining({
        path: 'data/cache',
        selected: true,
        patterns: ['(?d)/data/cache'],
      }),
    ]);
  });

  it('keeps an explicitly requested tracked file separate from its ignored ancestor for the ownership fix', async () => {
    write('.gitignore', 'logs/\n');
    write('logs/staged.txt', 'tracked source');
    git('add', '-f', 'logs/staged.txt');
    const result = await inspector.inspect(root, false, ['logs/staged.txt']);
    expect(result).toMatchObject({ candidates: [], requestedPaths: ['logs/staged.txt'] });
    const built = await buildChecked({
      ownerSide: 'home',
      home: result,
      vm: 'unavailable',
      userIgnores: [],
      managedExclusions: [],
    });
    expect(built.groups).toEqual([
      expect.objectContaining({
        path: 'logs/staged.txt',
        patterns: [],
        chown: { home: `sudo chown -R alice '${root}/logs/staged.txt'` },
      }),
    ]);
  });

  it('protects peer-only tracked siblings when only the owner side ignores the explicit path ancestor', async () => {
    write('.gitignore', 'logs/deep/\n');
    write('logs/home.txt', 'home tracked source');
    write('logs/deep/runtime');
    git('add', 'logs/home.txt');
    const home = await inspector.inspect(root, false, ['logs/deep/runtime']);
    const homeCheck = await inspector.inspect(root, false, [], ['(?d)logs', '(?d)/logs']);
    write('.gitignore', 'logs/\n');
    git('rm', '--cached', 'logs/home.txt');
    const vm = await inspector.inspect(root, false, ['logs/deep/runtime']);
    expect(home.entries.find((entry) => entry.path === 'logs')).toMatchObject({
      ignored: false,
      trackedDescendants: ['logs/home.txt'],
    });
    expect(vm.entries.find((entry) => entry.path === 'logs')).toMatchObject({
      ignored: true,
      trackedDescendants: [],
    });
    const vmCheck = await inspector.inspect(root, false, [], ['(?d)logs', '(?d)/logs']);
    const built = buildExclusionSuggestions({
      ownerSide: 'vm',
      home,
      vm,
      userIgnores: [],
      managedExclusions: [],
      patternChecks: { home: homeCheck.patternChecks!, vm: vmCheck.patternChecks! },
    });
    expect(built.groups).toEqual([
      expect.objectContaining({
        path: 'logs',
        selected: true,
        patterns: ['!/logs/home.txt', '(?d)logs'],
      }),
    ]);
  });

  it('keeps foreign-owned ignored files separate from the folder that also holds tracked files', async () => {
    write('output/.gitignore', '*\n!.gitignore\n');
    write('output/runtime');
    uids.set(join(root, 'output/runtime'), 48);
    git('add', 'output/.gitignore');
    const result = await inspector.inspect(root, true);
    expect(result.candidates).toEqual(['output/runtime']);
    expect(result.entries[0]).toMatchObject({
      path: 'output/runtime',
      ignored: true,
      trackedDescendants: [],
      foreignOwners: [{ uid: 48, name: 'apache' }],
    });
  });

  it.each(['', '!logs/\n'])(
    'checks listed folders before deduplication and keeps their ignored foreign-owned files with keep rule %j',
    async (keep) => {
      write('.gitignore', `*.log\n${keep}`);
      write('logs/a.log');
      uids.set(join(root, 'logs/a.log'), 48);
      const result = await inspector.inspect(root, true);
      expect(result.candidates).toEqual(['logs/a.log']);
      expect(result.entries).toEqual([
        expect.objectContaining({
          path: 'logs/a.log',
          kind: 'file',
          ignored: true,
          ignoredAncestor: null,
          ignoreRule: { source: '.gitignore', line: 1, pattern: '*.log' },
        }),
      ]);
    },
  );

  it.each(['', '!data/keep.txt\n'])(
    'never widens to an existing folder that `data/*` only empties, with keep rule %j',
    async (keep) => {
      write('.gitignore', `data/*\n${keep}`);
      write('data/keep.txt');
      write('data/x');
      uids.set(join(root, 'data/x'), 48);
      const result = await inspector.inspect(root, true);
      expect(result.candidates).toEqual(['data/x']);
      expect(result.entries).toEqual([
        expect.objectContaining({ path: 'data/x', ignored: true, ignoredAncestor: null }),
      ]);
    },
  );

  it('keeps an ignored foreign-owned repo inside a tracked folder without excluding its healthy config', async () => {
    write('device-type-importer/.gitignore', '.env*\nrepo\n');
    write('device-type-importer/settings.py', 'tracked source');
    write('device-type-importer/.env', 'needed config');
    write('device-type-importer/repo/library.yaml');
    uids.set(join(root, 'device-type-importer/repo'), 48);
    git('add', 'device-type-importer/.gitignore', 'device-type-importer/settings.py');
    const result = await inspector.inspect(root, true);
    expect(result.candidates).toEqual(['device-type-importer/repo']);
    expect(result.entries).toEqual([
      expect.objectContaining({
        path: 'device-type-importer/repo',
        ignored: true,
        ignoredAncestor: null,
        ignoreRule: { source: 'device-type-importer/.gitignore', line: 2, pattern: 'repo' },
      }),
    ]);
  });

  it('catalogues every matching local rule once per source and preserves the rules through DTO parsing', async () => {
    write('.gitignore', '# root\n\n*.egg-info/\n!keep.egg-info/\n*.sync-conflict-*\n');
    write('plugins/.gitignore', '# shared\n*.egg-info/\n');
    write('plugins/a/.gitignore', '# nested\n*.egg-info/\n!kept.egg-info/\n*.txt\n');
    write('.git/info/exclude', '# local\n*.egg-info/\n/.stfolder\n/.stignore\n*.sync-conflict-*\n');
    for (const path of [
      'plugins/a/a.egg-info/PKG-INFO',
      'plugins/a/b.egg-info/PKG-INFO',
      'copy.sync-conflict-test',
    ]) {
      write(path);
      uids.set(join(root, path), 48);
    }
    const read = jest.spyOn(files, 'readFile');
    const result = SyncPathInspectionSchema.parse(await inspector.inspect(root, true));
    expect(result.candidates).toEqual([
      'copy.sync-conflict-test',
      'plugins/a/a.egg-info',
      'plugins/a/b.egg-info',
    ]);
    for (const path of ['plugins/a/a.egg-info', 'plugins/a/b.egg-info']) {
      expect(result.entries.find((entry) => entry.path === path)).toMatchObject({
        ignoreRule: { source: 'plugins/a/.gitignore', line: 2, pattern: '*.egg-info/' },
        ignoreRules: [
          { source: '.gitignore', line: 3, pattern: '*.egg-info/' },
          { source: 'plugins/.gitignore', line: 2, pattern: '*.egg-info/' },
          { source: 'plugins/a/.gitignore', line: 2, pattern: '*.egg-info/' },
          { source: '.git/info/exclude', line: 2, pattern: '*.egg-info/' },
        ],
      });
    }
    expect(result.entries.find((entry) => entry.path === 'copy.sync-conflict-test')).toMatchObject({
      ignoreRules: [{ source: '.gitignore', line: 5, pattern: '*.sync-conflict-*' }],
    });
    for (const source of [
      '.gitignore',
      'plugins/.gitignore',
      'plugins/a/.gitignore',
      '.git/info/exclude',
    ])
      expect(read.mock.calls.filter(([path]) => path === join(root, source))).toHaveLength(1);
  });

  it.each(['global', 'untranslatable'] as const)(
    'keeps Git as the ignore authority when the deciding rule is %s and has no catalogue match',
    async (kind) => {
      const source = kind === 'global' ? join(root, '.git/global-ignore') : '.gitignore';
      const pattern = kind === 'global' ? 'cache/' : 'output/**/cache/';
      if (kind === 'global') git('config', 'core.excludesFile', source);
      write(kind === 'global' ? '.git/global-ignore' : source, `${pattern}\n`);
      write('output/a/cache/runtime');
      uids.set(join(root, 'output/a/cache'), 48);
      const read = jest.spyOn(files, 'readFile');
      const result = await inspector.inspect(root, true);
      expect(result.candidates).toEqual(['output/a/cache']);
      expect(result.entries).toEqual([
        expect.objectContaining({
          path: 'output/a/cache',
          ignored: true,
          ignoreRule: { source, line: 1, pattern },
          ignoreRules: [],
        }),
      ]);
      if (kind === 'global') expect(read).not.toHaveBeenCalledWith(source, 'utf8');
    },
  );

  it('checks missing folders with a trailing slash and returns the topmost ignored ancestor and parent owner', async () => {
    write('.gitignore', 'logs/\n');
    mkdirSync(join(root, 'foreign'));
    uids.set(join(root, 'foreign'), 123456);
    const result = await inspector.inspect(root, false, ['logs/deep/file.txt', 'foreign/missing']);
    expect(result.entries.find((entry) => entry.path === 'logs')).toMatchObject({
      kind: 'missing',
      ignored: true,
      ignoreRule: { source: '.gitignore', line: 1, pattern: 'logs/' },
    });
    expect(result.entries.find((entry) => entry.path === 'logs/deep/file.txt')).toMatchObject({
      ignoredAncestor: 'logs',
      owner: { uid: 1000, name: 'alice' },
    });
    expect(result.entries.find((entry) => entry.path === 'foreign/missing')).toMatchObject({
      kind: 'missing',
      foreignOwner: true,
      owner: { uid: 123456, name: 'uid 123456' },
    });
  });

  it('offers no exclusion over a path that home cannot reach and keeps unrelated suggestions', async () => {
    // Home tracks cache/locked/output, but cannot search cache/locked; the VM sees it untracked.
    write('.gitignore', 'cache/\nlogs/\n');
    write('cache/locked/output');
    write('logs/x.log');
    git('add', '.gitignore');
    git('add', '-f', 'cache/locked/output');
    const vmRoot = mkdtempSync(join(tmpdir(), 'devchain-sync-inspection-vm-'));
    try {
      execFileSync('git', ['-C', vmRoot, 'init', '-q']);
      for (const [path, contents] of [
        ['.gitignore', 'cache/\nlogs/\n'],
        ['cache/locked/output', 'runtime'],
        ['logs/x.log', 'runtime'],
      ]) {
        mkdirSync(dirname(join(vmRoot, path)), { recursive: true });
        writeFileSync(join(vmRoot, path), contents);
      }
      const hidden = join(root, 'cache/locked/output');
      const files = {
        ...fs,
        lstat: async (path: string) => {
          if (path === hidden)
            throw Object.assign(new Error(`EACCES: permission denied, lstat '${path}'`), {
              code: 'EACCES',
            });
          return fs.lstat(path);
        },
      } as typeof fs;
      const paths = ['cache/locked/output', 'logs/x.log'];
      const home = await new SyncPathInspector(executor, files).inspect(root, false, paths);
      const vm = await new SyncPathInspector(executor).inspect(vmRoot, false, paths);
      expect(home.hiddenPaths).toEqual(['cache/locked/output']);
      expect(home.entries.find((entry) => entry.path === 'logs/x.log')).toMatchObject({
        ignored: true,
        ignoredAncestor: 'logs',
      });
      const { groups } = await buildChecked({
        ownerSide: 'vm',
        home,
        vm,
        userIgnores: [],
        managedExclusions: [],
      });
      expect(groups.find((group) => group.path === 'cache')).toMatchObject({
        gitUnchecked: true,
        selected: false,
        patterns: [],
      });
      expect(groups.find((group) => group.path === 'logs')).toMatchObject({
        selected: true,
        patterns: ['(?d)logs'],
      });
    } finally {
      rmSync(vmRoot, { recursive: true, force: true });
    }
  });

  it('without a repo finds only topmost foreign-owned paths and skips sync metadata and links', async () => {
    rmSync(join(root, '.git'), { recursive: true });
    write('logs/owned');
    write('foreign/nested/file');
    uids.set(join(root, 'foreign'), 48);
    uids.set(join(root, 'foreign/nested/file'), 48);
    for (const path of [
      '.stfolder',
      '.stignore',
      '.stversions/data',
      '.syncthing.secret.tmp',
      '~syncthing~secret.tmp',
    ]) {
      write(path);
      uids.set(join(root, path), 48);
    }
    symlinkSync(tmpdir(), join(root, 'link'));
    const result = await inspector.inspect(root, true);
    expect(result).toMatchObject({
      gitState: 'no-repo',
      candidates: ['foreign'],
      entries: [expect.objectContaining({ path: 'foreign', foreignOwner: true })],
    });
    expect(
      buildExclusionSuggestions({
        ownerSide: 'home',
        home: result,
        vm: 'unavailable',
        userIgnores: [],
        managedExclusions: [],
      }).groups[0],
    ).toMatchObject({ selected: false, patterns: [], gitUnchecked: true });
    await expect(inspector.inspect(root, false, ['link/file'])).rejects.toThrow(
      'must not contain links',
    );
  });

  it.each(['failure', 'truncated'] as const)(
    'keeps %s Git results unknown instead of untracked',
    async (failure) => {
      write('logs/file');
      uids.set(join(root, 'logs'), 48);
      jest.spyOn(executor, 'run').mockResolvedValue({
        success: failure === 'truncated',
        exitCode: failure === 'truncated' ? 0 : 128,
        stdout: '',
        stderr: 'git failed',
        timedOut: false,
        truncated: failure === 'truncated',
      });
      const result = await inspector.inspect(root, true);
      expect(result).toMatchObject({
        gitState: 'error',
        candidates: ['logs'],
        entries: [
          expect.objectContaining({ ignored: null, tracked: null, trackedDescendants: null }),
        ],
      });
      const built = await buildChecked({
        ownerSide: 'home',
        home: result,
        vm: 'unavailable',
        userIgnores: [],
        managedExclusions: [],
      });
      expect(built.groups[0]).toMatchObject({ gitUnchecked: true, patterns: [] });
    },
  );
});
