// Pure builder tests are the cheapest layer for cross-side authority and ordered-pattern decisions.
import {
  buildExclusionSuggestions,
  proposeExclusionPatterns,
  type BuildExclusionSuggestionsInput,
} from './build-exclusion-suggestions';
import { compileIgnorePattern } from './ignore-pattern-matcher';
import type {
  SyncPathFacts,
  SyncPathInspection,
  SyncPatternChecks,
} from './sync-path-inspection.dto';

const alice = { uid: 1000, name: 'alice' };
function fact(path = 'logs', extra: Partial<SyncPathFacts> = {}): SyncPathFacts {
  return {
    path,
    kind: 'folder',
    owner: alice,
    foreignOwner: false,
    foreignOwners: [{ uid: 48, name: 'apache' }],
    fileCount: 3,
    ignored: true,
    ignoreRule: { source: '.gitignore', line: 1, pattern: 'logs/' },
    ignoredAncestor: null,
    ignoreRules: [],
    tracked: false,
    trackedDescendants: [],
    ...extra,
  };
}
function inspection(
  entries: SyncPathFacts[],
  gitState: SyncPathInspection['gitState'] = 'repo',
): SyncPathInspection {
  return {
    rootPath: '/home/alice/project',
    exists: true,
    repository: true,
    projectOwner: alice,
    gitState,
    candidates: entries.map((entry) => entry.path),
    requestedPaths: [],
    entries,
  };
}
function input(
  home = inspection([fact()]),
  vm: SyncPathInspection | 'unavailable' = 'unavailable',
  ownerSide: 'home' | 'vm' = 'home',
): BuildExclusionSuggestionsInput {
  const initial: BuildExclusionSuggestionsInput = {
    ownerSide,
    home,
    vm,
    userIgnores: [],
    managedExclusions: [],
  };
  const patterns = proposeExclusionPatterns(initial);
  return {
    ...initial,
    patternChecks: {
      home: checked(
        patterns,
        home.entries.flatMap((entry) => entry.trackedDescendants ?? []),
      ),
      vm:
        vm === 'unavailable'
          ? 'unavailable'
          : checked(
              patterns,
              vm.entries.flatMap((entry) => entry.trackedDescendants ?? []),
            ),
    },
  };
}

function checked(patterns: string[], files: string[] = []): SyncPatternChecks {
  return {
    state: 'checked',
    results: patterns.map((pattern) => {
      const compiled = compileIgnorePattern(pattern);
      const matches = files.filter((file) => compiled.kind === 'pattern' && compiled.matches(file));
      return {
        pattern,
        tracked: { count: matches.length, files: matches, complete: true },
        kept: { count: 0, sample: [] },
      };
    }),
  };
}

function netbox(): SyncPathInspection {
  return inspection(
    Array.from({ length: 23 }, (_, i) =>
      fact(`plugins/plugin-${i}/plugin_${i}.egg-info`, {
        owner: { uid: 0, name: 'root' },
        foreignOwner: true,
        foreignOwners: [{ uid: 0, name: 'root' }],
        ignoreRule: { source: '.gitignore', line: 17, pattern: '*.egg-info/' },
      }),
    ),
  );
}

function finalInput(
  home = netbox(),
  vm: SyncPathInspection | 'unavailable' = netbox(),
): BuildExclusionSuggestionsInput {
  const initial = input(home, vm);
  const patterns = proposeExclusionPatterns(initial);
  return { ...initial, patternChecks: { home: checked(patterns), vm: checked(patterns) } };
}

describe('buildExclusionSuggestions', () => {
  it.each([
    ['.git/info/exclude', '(?d)/copy.sync-conflict-test'],
    ['.gitignore', '(?d)*.sync-conflict-*'],
    ['/global-ignore', '(?d)/copy.sync-conflict-test'],
  ])('gates managed and global deciding rules by source %s', (source, pattern) => {
    const rule = { source, line: 1, pattern: '*.sync-conflict-*' };
    const owner = inspection([
      fact('copy.sync-conflict-test', {
        ignoreRule: rule,
        ignoreRules: source === '/global-ignore' ? [] : [rule],
      }),
    ]);
    const result = buildExclusionSuggestions(input(owner));
    expect(result.groups).toEqual([
      expect.objectContaining({ patterns: [pattern], patternChecksPassed: true }),
    ]);
  });
  it('breaks equal coverage ties by shallower source and then earlier line', () => {
    const rules = [
      { source: 'plugins/.gitignore', line: 1, pattern: 'cache/' },
      { source: '.gitignore', line: 2, pattern: 'cache/' },
      { source: '.gitignore', line: 1, pattern: '*cache/' },
    ];
    const owner = inspection(
      ['plugins/cache', 'plugins/deep/cache'].map((path) =>
        fact(path, { ignoreRule: rules[0], ignoreRules: rules }),
      ),
    );
    expect(buildExclusionSuggestions(input(owner)).groups).toEqual([
      expect.objectContaining({ patterns: ['(?d)*cache'], pathCount: 2 }),
    ]);
  });
  it('drops nested cache rules after the root rule covers every candidate', () => {
    const rootRule = { source: '.gitignore', line: 16, pattern: '*__pycache__/' };
    const owner = inspection(
      ['plugins/a/__pycache__', 'plugins/b/__pycache__', 'other__pycache__'].map((path) => {
        const nested = {
          source: path.split('/').slice(0, -1).join('/') + '/.gitignore',
          line: 1,
          pattern: '__pycache__/',
        };
        return fact(path, { ignoreRule: nested, ignoreRules: [rootRule, nested] });
      }),
    );
    const result = buildExclusionSuggestions(input(owner));
    expect(result.groups).toEqual([
      expect.objectContaining({
        patterns: ['(?d)*__pycache__'],
        pathCount: 3,
        patternChecksPassed: true,
      }),
    ]);
  });

  it('uses the atomic own-name rule for a single ignored repo', () => {
    const owner = inspection([
      fact('device-type-importer/repo', {
        ignoreRule: { source: 'device-type-importer/.gitignore', line: 135, pattern: 'repo' },
      }),
    ]);
    expect(buildExclusionSuggestions(input(owner)).groups).toEqual([
      expect.objectContaining({
        patterns: ['(?d)/device-type-importer/repo', '(?d)/device-type-importer/**/repo'],
        pathCount: 1,
        patternChecksPassed: true,
      }),
    ]);
  });

  it('rejects a rule that matches a proper ancestor and checks the narrower literal', () => {
    const owner = inspection([
      fact('data/cache', { ignoreRule: { source: '.gitignore', line: 1, pattern: '/data/' } }),
    ]);
    const initial = input(owner);
    expect(proposeExclusionPatterns(initial)).toEqual(['(?d)/data/cache']);
    expect(buildExclusionSuggestions(initial).groups).toEqual([
      expect.objectContaining({ patterns: ['(?d)/data/cache'], patternChecksPassed: true }),
    ]);
  });

  it.each(['home', 'vm'] as const)(
    'rejects a literal fallback with a Git-kept match on %s',
    (side) => {
      const owner = inspection([
        fact('a.egg-info', {
          ignoreRule: { source: '/global-ignore', line: 1, pattern: '*.egg-info/' },
        }),
      ]);
      const initial = input(owner, owner);
      const check = initial.patternChecks![side] as SyncPatternChecks;
      check.results[0].kept = { count: 1, sample: ['a.egg-info/keep'] };
      expect(buildExclusionSuggestions(initial).groups).toEqual([
        expect.objectContaining({
          selected: false,
          patterns: [],
          patternChecksPassed: false,
          patternError: expect.any(String),
        }),
      ]);
    },
  );

  it('retries coverage with the next rule before using literal fallbacks', () => {
    const rootRule = { source: '.gitignore', line: 1, pattern: 'cache/' };
    const localRule = { source: 'plugins/.gitignore', line: 1, pattern: 'cache/' };
    const owner = inspection(
      ['plugins/cache', 'plugins/deep/cache'].map((path) =>
        fact(path, { ignoreRule: localRule, ignoreRules: [rootRule, localRule] }),
      ),
    );
    const initial = input(owner, owner);
    const home = initial.patternChecks!.home as SyncPatternChecks;
    home.results.find((result) => result.pattern === '(?d)cache')!.kept = {
      count: 1,
      sample: ['scratch/cache/keep'],
    };
    expect(buildExclusionSuggestions(initial).groups).toEqual([
      expect.objectContaining({
        patterns: ['(?d)/plugins/cache', '(?d)/plugins/**/cache'],
        pathCount: 2,
        patternChecksPassed: true,
      }),
    ]);
  });

  it('reports over-budget literal paths in one bounded error group', () => {
    const owner = inspection(
      Array.from({ length: 10 }, (_, index) => fact(`output-${index}`, { ignoreRule: null })),
    );
    const initial = {
      ...input(owner),
      userIgnores: Array.from({ length: 199 }, (_, index) => `/saved-${index}`),
    };
    const result = buildExclusionSuggestions(initial);
    expect(result.groups).toHaveLength(2);
    expect(result.groups[0]).toMatchObject({
      patterns: ['(?d)/output-0'],
      patternChecksPassed: true,
    });
    expect(result.groups[1]).toMatchObject({
      patterns: [],
      selected: false,
      pathCount: 9,
      pathSample: ['output-1', 'output-2', 'output-3', 'output-4', 'output-5'],
      patternError: expect.any(String),
    });
    expect(result.groups[1]).not.toHaveProperty('paths');
    expect(result.overLimit).toBe(false);
  });
  it.each(['home', 'vm'] as const)(
    'merges 23 NetBox folders under the %s rule after safety checks',
    (ownerSide) => {
      const owner = netbox();
      for (const entry of owner.entries) {
        entry.ignoreRules = [
          entry.ignoreRule!,
          {
            source: entry.path.split('/').slice(0, -1).join('/') + '/.gitignore',
            line: 1,
            pattern: '*.egg-info/',
          },
        ];
        entry.ignoreRule = entry.ignoreRules[1];
      }
      const peer = inspection(
        owner.entries.map((entry) => ({ ...entry, ignoreRule: null, ignored: false })),
      );
      const initial = {
        ...input(ownerSide === 'home' ? owner : peer, ownerSide === 'vm' ? owner : peer),
        ownerSide,
      };
      expect(proposeExclusionPatterns(initial)[0]).toBe('(?d)*.egg-info');
      const result = buildExclusionSuggestions({
        ...initial,
        patternChecks: { home: checked(['(?d)*.egg-info']), vm: checked(['(?d)*.egg-info']) },
      });
      expect(result.groups).toEqual([
        expect.objectContaining({
          pathCount: 23,
          pathSample: owner.entries
            .map((entry) => entry.path)
            .sort()
            .slice(0, 5),
          fileCount: 69,
          owner: { uid: 0, name: 'root' },
          selected: true,
          reason: 'Written by another user (root)',
          patterns: ['(?d)*.egg-info'],
        }),
      ]);
    },
  );

  it('merges nested rules as an atomic pair and deduplicates tracked exceptions from both lines and sides', () => {
    const owner = inspection(
      ['packages/a.egg-info', 'packages/deep/b.egg-info'].map((path) =>
        fact(path, {
          ignoreRule: { source: 'packages/.gitignore', line: 1, pattern: '*.egg-info/' },
        }),
      ),
    );
    const initial = input(owner, owner);
    const patterns = proposeExclusionPatterns(initial);
    const rulePatterns = ['(?d)/packages/*.egg-info', '(?d)/packages/**/*.egg-info'];
    expect(patterns.slice(0, 2)).toEqual(rulePatterns);
    const files = Array.from({ length: 6 }, (_, i) => `packages/other-${i}.egg-info/keep.txt`);
    const result = buildExclusionSuggestions({
      ...initial,
      patternChecks: {
        home: checked(patterns, files.slice(0, 5)),
        vm: checked(patterns, files.slice(3)),
      },
    });
    expect(result.groups).toEqual([
      expect.objectContaining({
        patterns: [...files.map((file) => `!/${file}`), ...rulePatterns],
        pathCount: 2,
        pathSample: ['packages/a.egg-info', 'packages/deep/b.egg-info'],
      }),
    ]);
  });

  it.each(['a/**/b', '[^a]', '{a,b}', '!*.egg-info', 'different-name'])(
    'keeps per-path groups when rule %s cannot safely cover the paths',
    (pattern) => {
      const owner = netbox();
      for (const entry of owner.entries) entry.ignoreRule!.pattern = pattern;
      const initial = input(owner);
      expect(proposeExclusionPatterns(initial)).toEqual(
        owner.entries.map((entry) => `(?d)/${entry.path}`).sort(),
      );
      expect(buildExclusionSuggestions(initial).groups.map((group) => group.pattern)).toEqual(
        owner.entries.map((entry) => `(?d)/${entry.path}`).sort(),
      );
    },
  );

  it.each([
    'kept',
    'incomplete',
    'too-many',
    'union-too-many',
    'no-repo',
    'error',
    'late-unavailable',
    'missing-result',
  ] as const)('falls back to per-path groups for %s safety data', (failure) => {
    const initial = finalInput();
    const check = initial.patternChecks!.vm as SyncPatternChecks;
    const result = check.results[0];
    if (failure === 'kept') result.kept = { count: 1, sample: ['scratch.egg-info/keep'] };
    if (failure === 'incomplete') result.tracked.complete = false;
    if (failure === 'too-many') result.tracked = { count: 51, files: [], complete: false };
    if (failure === 'union-too-many') {
      result.tracked = {
        count: 26,
        files: Array.from({ length: 26 }, (_, i) => `vm-${i}.egg-info`),
        complete: true,
      };
      initial.patternChecks!.home = checked(
        proposeExclusionPatterns(initial),
        Array.from({ length: 26 }, (_, i) => `home-${i}.egg-info`),
      );
    }
    if (failure === 'no-repo' || failure === 'error')
      initial.patternChecks!.vm = { state: failure, results: [] };
    if (failure === 'late-unavailable') initial.patternChecks!.vm = 'unavailable';
    if (failure === 'missing-result') check.results = check.results.slice(1);
    const built = buildExclusionSuggestions(initial);
    expect(built.groups).toHaveLength(23);
    expect(
      built.groups.every(
        (group) =>
          !group.pathCount &&
          (['no-repo', 'error', 'late-unavailable'].includes(failure)
            ? group.gitUnchecked && group.patterns.length === 0
            : group.patternChecksPassed && group.pattern?.startsWith('(?d)/plugins/')),
      ),
    ).toBe(true);
  });

  it.each(['no-root', 'unavailable'] as const)(
    'merges for Connect when the peer was already %s',
    (state) => {
      const vm =
        state === 'unavailable'
          ? 'unavailable'
          : { ...inspection([]), exists: false, gitState: 'no-repo' as const };
      const initial = finalInput(netbox(), vm);
      initial.patternChecks!.vm = state === 'unavailable' ? 'unavailable' : { state, results: [] };
      expect(buildExclusionSuggestions(initial).groups[0].patterns).toEqual(['(?d)*.egg-info']);
      expect(buildExclusionSuggestions(initial).groups).toHaveLength(1);
    },
  );

  it.each([198, 199])(
    'keeps a nested pair atomic within the line budget after %i single rules',
    (singles) => {
      const entries = Array.from({ length: singles }, (_, i) =>
        ['a', 'b'].map((child) =>
          fact(`${child}/rule-${String(i).padStart(3, '0')}`, {
            ignoreRule: {
              source: '.gitignore',
              line: i + 1,
              pattern: `rule-${String(i).padStart(3, '0')}`,
            },
          }),
        ),
      ).flat();
      entries.push(
        ...['zpair/cache', 'zpair/deep/cache'].map((path) =>
          fact(path, {
            ignoreRule: { source: 'zpair/.gitignore', line: 1, pattern: 'cache' },
          }),
        ),
      );
      const initial = input(inspection(entries));
      const patterns = proposeExclusionPatterns(initial);
      expect(patterns.length).toBeGreaterThan(200);
      expect(patterns.includes('(?d)/zpair/cache')).toBe(true);
      expect(patterns.includes('(?d)/zpair/**/cache')).toBe(true);
      initial.patternChecks = { home: checked(patterns), vm: 'unavailable' };
      const result = buildExclusionSuggestions(initial);
      expect(result.groups.filter((group) => group.path.startsWith('zpair/'))).toHaveLength(
        singles === 198 ? 1 : 2,
      );
      expect(result.groups.filter((group) => group.patternError)).toHaveLength(
        singles === 198 ? 0 : 1,
      );
      expect(new Set(result.groups.flatMap((group) => group.patterns)).size).toBe(200);
      expect(result.overLimit).toBe(false);
    },
  );

  it.each(['scan', 'explicit'])(
    'protects both indexes before a %s folder pattern and uses only the owner ignore state',
    (mode) => {
      const home = inspection([
        fact('templates_c', {
          trackedDescendants: ['templates_c/.gitignore'],
          ignored: false,
        }),
      ]);
      const vm = inspection([
        fact('templates_c', {
          trackedDescendants: ['templates_c/staged.txt'],
          ignored: true,
          ignoreRules: [],
        }),
      ]);
      if (mode === 'explicit') {
        home.candidates = vm.candidates = [];
        home.requestedPaths = vm.requestedPaths = ['templates_c'];
      }
      const result = buildExclusionSuggestions(input(home, vm, 'vm'));
      expect(result.groups[0]).toMatchObject({
        selected: true,
        patterns: ['!/templates_c/.gitignore', '!/templates_c/staged.txt', '(?d)/templates_c'],
      });
      expect(buildExclusionSuggestions(input(home, vm)).groups[0].selected).toBe(false);
    },
  );

  it('offers no exclusion for a file staged only on the VM and quotes ownership commands', () => {
    const path = "logs/it's.txt";
    const home = inspection([fact(path, { kind: 'file', ignored: false })]);
    const vm = inspection([fact(path, { kind: 'file', tracked: true })]);
    const result = buildExclusionSuggestions(input(home, vm, 'vm'));
    expect(result.groups[0]).toMatchObject({
      patterns: [],
      selected: false,
      chown: { vm: "sudo chown -R alice '/home/alice/project/logs/it'\\''s.txt'" },
    });
    expect(result.groups[0].pattern).toBeUndefined();
  });

  it('keeps a requested VM-staged file repair beside its untracked sibling folder exclusion', () => {
    const staged = 'logs/staged.txt';
    const runtime = 'logs/runtime.txt';
    const home = inspection([
      fact('logs'),
      fact(staged, { kind: 'file', ignoredAncestor: 'logs' }),
      fact(runtime, { kind: 'file', ignoredAncestor: 'logs' }),
    ]);
    const vm = inspection([
      fact('logs', { ignored: false, trackedDescendants: [staged] }),
      fact(staged, { kind: 'file', tracked: true, ignored: false }),
      fact(runtime, { kind: 'file' }),
    ]);
    home.candidates = vm.candidates = [];
    home.requestedPaths = vm.requestedPaths = [staged, runtime];
    const result = buildExclusionSuggestions(input(home, vm));
    expect(result.groups).toEqual([
      expect.objectContaining({
        path: 'logs',
        selected: true,
        patterns: ['!/logs/staged.txt', '(?d)logs'],
      }),
      expect.objectContaining({
        path: staged,
        selected: false,
        patterns: [],
        chown: {
          home: "sudo chown -R alice '/home/alice/project/logs/staged.txt'",
          vm: "sudo chown -R alice '/home/alice/project/logs/staged.txt'",
        },
      }),
    ]);
    expect(result.groups[1].pattern).toBeUndefined();
  });

  it.each(['no-repo', 'error'] as const)('preserves the %s owner-side decision', (state) => {
    const home = inspection(
      [
        fact('logs', { foreignOwner: false, foreignOwners: [] }),
        fact('output', {
          foreignOwner: true,
          foreignOwners: [{ uid: 48, name: 'apache' }],
        }),
      ],
      state,
    );
    const result = buildExclusionSuggestions(input(home));
    if (state === 'no-repo')
      expect(result.groups).toEqual([
        expect.objectContaining({
          path: 'output',
          selected: false,
          patterns: [],
          gitUnchecked: true,
        }),
      ]);
    else
      expect(
        result.groups.every((group) => group.gitUnchecked && group.patterns.length === 0),
      ).toBe(true);
  });

  it.each(['!/logs', '!/logs/child.txt', '!/', '!/**/*.txt', ' (?i)!/LOGS ', ' !(?i)** '])(
    'names the earlier negation %s that blocks an atomic group',
    (negation) => {
      const result = buildExclusionSuggestions({
        ...input(),
        userIgnores: [negation, '(?d)/logs'],
      });
      expect(result.groups[0]).toMatchObject({
        path: 'logs',
        blockedBy: negation,
        patterns: [],
        selected: false,
      });
    },
  );

  it('skips paths the list already excludes, managed paths and nested candidates', () => {
    expect(
      buildExclusionSuggestions({ ...input(), userIgnores: ['(?d)/logs', '!/logs'] }).groups,
    ).toEqual([]);
    const rules = input(
      inspection([
        fact('src/__pycache__', {
          ignoreRule: { source: '.gitignore', line: 2, pattern: '__pycache__/' },
        }),
        fact('plugins/p.egg-info', {
          ignoreRule: { source: '.gitignore', line: 3, pattern: '*.egg-info/' },
        }),
      ]),
    );
    expect(buildExclusionSuggestions(rules).groups).toHaveLength(2);
    expect(
      buildExclusionSuggestions({ ...rules, userIgnores: ['(?d)__pycache__', '(?d)*.egg-info'] })
        .groups,
    ).toEqual([]);
    expect(
      buildExclusionSuggestions({ ...input(), managedExclusions: ['(?d)/logs'] }).groups,
    ).toEqual([]);
    const home = inspection([fact('logs'), fact('logs/deep')]);
    expect(buildExclusionSuggestions(input(home)).groups.map((group) => group.path)).toEqual([
      'logs',
    ]);
  });
});
