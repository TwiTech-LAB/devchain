// Service units own the two-pass request contract; Git matching and translation have separate tests.
import type {
  SyncInspectRequest,
  SyncPathInspection,
} from '../../file-sync/sync-path-inspection.dto';
import type { SyncPathInspector } from '../../file-sync/sync-path-inspector';
import { FileSyncSuggestionsService } from './file-sync-suggestions.service';

const owner = { uid: 1000, name: 'alice' };
function inspection(paths: string[]): SyncPathInspection {
  return {
    rootPath: '/checkout',
    exists: true,
    repository: true,
    projectOwner: owner,
    gitState: 'repo',
    candidates: paths,
    requestedPaths: [],
    entries: paths.map((path) => ({
      path,
      kind: 'folder',
      owner,
      foreignOwner: false,
      foreignOwners: [{ uid: 48, name: 'apache' }],
      fileCount: 1,
      ignored: true,
      ignoreRule: { source: '.gitignore', line: 1, pattern: '*.egg-info/' },
      ignoredAncestor: null,
      ignoreRules: [],
      tracked: false,
      trackedDescendants: [],
    })),
  };
}

function setup(paths = ['a.egg-info', 'b.egg-info']) {
  const home = inspection(paths);
  const inspector = {
    inspect: jest.fn<Promise<SyncPathInspection>, Parameters<SyncPathInspector['inspect']>>(),
  };
  const checked = (
    base: SyncPathInspection,
    patterns: readonly string[] = [],
  ): SyncPathInspection => ({
    ...base,
    patternChecks: {
      state: base.exists ? 'checked' : 'no-root',
      results: patterns.map((pattern) => ({
        pattern,
        tracked: { count: 0, files: [], complete: true },
        kept: { count: 0, sample: [] },
      })),
    },
  });
  inspector.inspect.mockImplementation(async (_root, _scan, _paths, patterns) =>
    patterns ? checked(home, patterns) : home,
  );
  const host = {
    syncInspect: jest.fn<Promise<SyncPathInspection>, [string, SyncInspectRequest]>(),
  };
  const service = new FileSyncSuggestionsService(
    { getProject: async () => ({ rootPath: '/checkout' }) } as never,
    inspector as never,
    host as never,
    { getIgnores: () => [] } as never,
    { get: () => [] } as never,
  );
  return { service, inspector, host, home, checked };
}

describe('FileSyncSuggestionsService', () => {
  it.each(['no-root', 'unavailable', 'late-unavailable'] as const)(
    'finalizes Connect proposals with a %s peer',
    async (state) => {
      const s = setup();
      const vm = inspection([]);
      if (state === 'unavailable') s.host.syncInspect.mockRejectedValue(new Error('offline'));
      else {
        if (state === 'no-root') Object.assign(vm, { exists: false, gitState: 'no-repo' });
        s.host.syncInspect.mockResolvedValueOnce(vm);
        if (state === 'late-unavailable')
          s.host.syncInspect.mockRejectedValueOnce(new Error('offline'));
        else
          s.host.syncInspect.mockImplementation(async (_remote, request) =>
            s.checked(vm, request.patterns),
          );
      }
      const result = await s.service.suggestions('p', 'r');
      expect(result.groups.map((group) => group.patterns)).toEqual(
        state === 'late-unavailable' ? [[], []] : [['(?d)*.egg-info']],
      );
      expect(s.inspector.inspect).toHaveBeenLastCalledWith(
        '/checkout',
        false,
        [],
        ['(?d)*.egg-info', '(?d)/a.egg-info', '(?d)/b.egg-info'],
      );
      expect(s.host.syncInspect).toHaveBeenCalledTimes(state === 'unavailable' ? 1 : 2);
      if (state !== 'unavailable')
        expect(s.host.syncInspect).toHaveBeenLastCalledWith('r', {
          path: '/checkout',
          scan: false,
          paths: [],
          patterns: ['(?d)*.egg-info', '(?d)/a.egg-info', '(?d)/b.egg-info'],
        });
    },
  );

  it('checks a single literal fallback before offering it', async () => {
    const s = setup(['a.egg-info']);
    s.home.entries[0].ignoreRule = null;
    s.host.syncInspect.mockImplementation(async (_remote, request) =>
      s.checked(inspection([]), request.patterns),
    );
    const result = await s.service.suggestions('p', 'r');
    expect(result.groups.map((group) => group.patterns)).toEqual([['(?d)/a.egg-info']]);
    expect(result.groups[0].patternChecksPassed).toBe(true);
    expect(s.inspector.inspect).toHaveBeenLastCalledWith(
      '/checkout',
      false,
      [],
      ['(?d)/a.egg-info'],
    );
    expect(s.host.syncInspect).toHaveBeenLastCalledWith('r', {
      path: '/checkout',
      scan: false,
      paths: [],
      patterns: ['(?d)/a.egg-info'],
    });
  });

  it.each([false, true])(
    'checks all alternatives in batches and closes exclusions when a later batch fails=%s',
    async (fail) => {
      const s = setup(Array.from({ length: 201 }, (_, index) => `output-${index}`));
      let calls = 0;
      s.host.syncInspect.mockImplementation(async (_remote, request) => {
        if (request.patterns && ++calls === 2 && fail) throw new Error('VM disappeared');
        return request.patterns ? s.checked(inspection([]), request.patterns) : inspection([]);
      });
      const result = await s.service.suggestions('p', 'r');
      expect(
        s.inspector.inspect.mock.calls.filter((call) => call[3]).map((call) => call[3]!.length),
      ).toEqual([200, 1]);
      expect(
        s.host.syncInspect.mock.calls
          .filter((call) => call[1].patterns)
          .map((call) => call[1].patterns!.length),
      ).toEqual([200, 1]);
      if (fail)
        expect(
          result.groups.every((group) => group.patterns.length === 0 && group.gitUnchecked),
        ).toBe(true);
      else {
        expect(result.groups.filter((group) => group.patternChecksPassed)).toHaveLength(200);
        expect(result.groups.filter((group) => group.patternError)).toHaveLength(1);
      }
    },
  );
});
