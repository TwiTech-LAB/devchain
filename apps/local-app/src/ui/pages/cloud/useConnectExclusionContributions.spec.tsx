import { renderHook, waitFor } from '@testing-library/react';
import { useState } from 'react';
import {
  buildExclusionSuggestions,
  proposeExclusionPatterns,
  type BuildExclusionSuggestionsInput,
} from '@/modules/file-sync/build-exclusion-suggestions';
import type {
  ProjectExclusionSuggestions,
  SyncPathFacts,
  SyncPathInspection,
  SyncPatternChecks,
} from '@/modules/file-sync/sync-path-inspection.dto';
import { useConnectExclusionContributions } from './useConnectExclusionContributions';

const alice = { uid: 1000, name: 'alice' };
const root = { uid: 0, name: 'root' };

function eggInfo(index: number, owner = root): SyncPathFacts {
  return {
    path: `plugins/plugin-${index}/plugin_${index}.egg-info`,
    kind: 'folder',
    owner,
    foreignOwner: owner === root,
    foreignOwners: owner === root ? [root] : [],
    fileCount: 3,
    ignored: true,
    ignoreRule: { source: '.gitignore', line: 17, pattern: '*.egg-info/' },
    ignoredAncestor: null,
    ignoreRules: [],
    tracked: false,
    trackedDescendants: [],
  };
}

function inspection(entries: SyncPathFacts[]): SyncPathInspection {
  return {
    rootPath: '/home/alice/project',
    exists: true,
    repository: true,
    projectOwner: alice,
    gitState: 'repo',
    candidates: entries.filter((entry) => entry.foreignOwner).map((entry) => entry.path),
    requestedPaths: [],
    entries,
  };
}

const passed = (patterns: string[]): SyncPatternChecks => ({
  state: 'checked',
  results: patterns.map((pattern) => ({
    pattern,
    tracked: { count: 0, files: [], complete: true },
    kept: { count: 0, sample: [] },
  })),
});

/** The real builder's answer, as the suggestions route returns it. */
function scan(home: SyncPathFacts[], vm: SyncPathFacts[]): ProjectExclusionSuggestions {
  const input: BuildExclusionSuggestionsInput = {
    ownerSide: 'home',
    home: inspection(home),
    vm: inspection(vm),
    userIgnores: [],
    managedExclusions: [],
  };
  const patterns = proposeExclusionPatterns(input);
  input.patternChecks = { home: passed(patterns), vm: passed(patterns) };
  return { ownerSide: 'home', home: input.home, vm: input.vm, ...buildExclusionSuggestions(input) };
}

const all = (owner = root) => Array.from({ length: 23 }, (_, index) => eggInfo(index, owner));

it.each([
  ['one path is fixed on both sides', () => scan(all().slice(1), all().slice(1))],
  ['this PC is fixed but the VM still fails', () => scan(all(alice), all())],
])('keeps a rule that still covers failing paths after a rescan when %s', async (_name, after) => {
  const first = scan(all(), all());
  const second = after();
  expect(first.groups).toHaveLength(1);
  expect(second.groups[0].pattern).toBe('(?d)*.egg-info');
  expect(`${second.groups[0].side}:${second.groups[0].path}`).not.toBe(
    `${first.groups[0].side}:${first.groups[0].path}`,
  );
  const { result, rerender } = renderHook(
    ({ suggestions }) => {
      const [list, setList] = useState<string[]>([]);
      const card = useConnectExclusionContributions(suggestions, list, [], (patterns, selected) =>
        setList((previous) =>
          selected
            ? [...new Set([...previous, ...patterns])]
            : previous.filter((pattern) => !patterns.includes(pattern)),
        ),
      );
      return { list, card };
    },
    { initialProps: { suggestions: first } },
  );
  await waitFor(() => expect(result.current.list).toEqual(['(?d)*.egg-info']));
  rerender({ suggestions: second });
  await waitFor(() => expect(result.current.card.checked(second.groups[0])).toBe(true));
  expect(result.current.list).toEqual(['(?d)*.egg-info']);
});

it('keeps a VM-tracked keep rule when the rescan cannot read the VM', async () => {
  const keep = '!/plugins/plugin-0/plugin_0.egg-info/keep.txt';
  const exclusion = '(?d)*.egg-info';
  const input: BuildExclusionSuggestionsInput = {
    ownerSide: 'home',
    home: inspection(all()),
    vm: inspection(all()),
    userIgnores: [],
    managedExclusions: [],
  };
  const patterns = proposeExclusionPatterns(input);
  const vmCheck = passed(patterns);
  for (const check of vmCheck.results)
    check.tracked = { count: 1, files: [keep.slice(2)], complete: true };
  input.patternChecks = { home: passed(patterns), vm: vmCheck };
  const first = {
    ownerSide: 'home' as const,
    home: input.home,
    vm: input.vm,
    ...buildExclusionSuggestions(input),
  };
  const partial: BuildExclusionSuggestionsInput = {
    ...input,
    vm: 'unavailable',
    patternChecks: { home: passed(patterns), vm: 'unavailable' },
  };
  const second = {
    ownerSide: 'home' as const,
    home: input.home,
    vm: 'unavailable' as const,
    ...buildExclusionSuggestions(partial),
  };
  expect(first.groups[0].patterns).toEqual([keep, exclusion]);
  expect(second.groups[0].patterns).toEqual([exclusion]);
  const { result, rerender } = renderHook(
    ({ suggestions }: { suggestions: ProjectExclusionSuggestions }) => {
      const [list, setList] = useState<string[]>([]);
      useConnectExclusionContributions(suggestions, list, [], (changed, selected) =>
        setList((previous) =>
          selected
            ? [...new Set([...previous, ...changed])]
            : previous.filter((pattern) => !changed.includes(pattern)),
        ),
      );
      return list;
    },
    { initialProps: { suggestions: first } },
  );
  await waitFor(() => expect(result.current).toEqual([keep, exclusion]));
  rerender({ suggestions: second });
  expect(result.current).toEqual([keep, exclusion]);
});
