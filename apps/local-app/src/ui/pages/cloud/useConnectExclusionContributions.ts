import { useEffect, useRef, useState } from 'react';
import { IGNORE_PATTERNS_MAX } from '@/modules/file-sync/file-sync.dto';
import { compileIgnoreList } from '@/modules/file-sync/ignore-pattern-matcher';
import {
  exclusionGroupKey as groupKey,
  isSelectableExclusion,
} from '@/modules/file-sync/sync-path-inspection.dto';
import type {
  ExclusionSuggestion,
  ProjectExclusionSuggestions,
} from '@/modules/file-sync/sync-path-inspection.dto';

interface Contribution {
  patterns: string[];
  /** The group had VM facts, so a scan without the VM cannot prove it resolved. */
  vm: boolean;
}
interface Contributions {
  owned: Set<string>;
  groups: Map<string, Contribution>;
}

const contribution = (group: ExclusionSuggestion): Contribution => ({
  patterns: group.patterns,
  vm: group.side === 'vm' || group.vm !== null,
});
const exclusionLines = (patterns: readonly string[]) =>
  JSON.stringify(patterns.filter((pattern) => !pattern.startsWith('!')));

/**
 * Carries the card's selections into a rescan. A rule group can return under another
 * representative path or side, and a path that still fails keeps every pattern that covers it,
 * so a selection is resolved only when the rescan shows none of these.
 */
function carryOver(
  groups: ReadonlyMap<string, Contribution>,
  result: ProjectExclusionSuggestions,
): Map<string, Contribution> {
  const next = new Map<string, Contribution>();
  const add = (key: string, item: Contribution) => {
    const prior = next.get(key);
    next.set(key, {
      patterns: [...new Set([...(prior?.patterns ?? []), ...item.patterns])],
      vm: item.vm || (prior?.vm ?? false),
    });
  };
  const failing = result.groups.flatMap((group) => [group.path, ...(group.pathSample ?? [])]);
  for (const [key, item] of groups) {
    const successors = result.groups.filter(
      (group) =>
        isSelectableExclusion(group) &&
        exclusionLines(group.patterns) === exclusionLines(item.patterns),
    );
    // The rescan's group carries the keep rules that the rule needs now. A scan without the VM
    // cannot show that a VM-tracked file no longer needs its keep rule, so earlier keeps stay.
    const keeps =
      result.vm === 'unavailable' ? item.patterns.filter((pattern) => pattern.startsWith('!')) : [];
    for (const group of successors)
      add(groupKey(group), {
        patterns: [...keeps, ...group.patterns],
        vm: item.vm || contribution(group).vm,
      });
    if (successors.length) continue;
    const match = compileIgnoreList(item.patterns);
    if (
      result.groups.some((group) => groupKey(group) === key) ||
      (result.vm === 'unavailable' && item.vm) ||
      failing.some((path) => {
        const found = match(path);
        return found.kind === 'unknown' || (found.kind === 'matched' && found.ignored);
      })
    )
      add(key, item);
  }
  return next;
}

export function useConnectExclusionContributions(
  result: ProjectExclusionSuggestions | null,
  list: readonly string[] | undefined,
  manualPatterns: readonly string[],
  onPatterns: (patterns: string[], selected: boolean) => void,
) {
  const initialized = useRef(false);
  const lastResult = useRef<ProjectExclusionSuggestions | null>(null);
  const [contributions, setContributions] = useState<Contributions>(() => ({
    owned: new Set(),
    groups: new Map(),
  }));
  const [limitPatterns, setLimitPatterns] = useState<string[]>([]);

  useEffect(() => {
    if (!list) return;
    if (!result) lastResult.current = null;
    if (result && !initialized.current) {
      initialized.current = true;
      lastResult.current = result;
      const selectable = result.groups.filter(isSelectableExclusion);
      const defaults = selectable.filter((group) => group.selected);
      const proposed = [...new Set(defaults.flatMap((group) => group.patterns))];
      const patterns = [
        ...proposed.filter((pattern) => pattern.startsWith('!')),
        ...proposed.filter((pattern) => !pattern.startsWith('!')),
      ];
      const fits = new Set([...list, ...patterns]).size <= IGNORE_PATTERNS_MAX;
      setLimitPatterns(fits ? [] : patterns);
      const selected = selectable.filter(
        (group) =>
          (fits && group.selected) || group.patterns.every((pattern) => list.includes(pattern)),
      );
      setContributions({
        owned: new Set(fits ? patterns.filter((pattern) => !list.includes(pattern)) : []),
        groups: new Map(selected.map((group) => [groupKey(group), contribution(group)])),
      });
      if (fits && patterns.some((pattern) => !list.includes(pattern))) onPatterns(patterns, true);
      return;
    }
    const owned = new Set(
      [...contributions.owned].filter(
        (pattern) => list.includes(pattern) && !manualPatterns.includes(pattern),
      ),
    );
    let groups = contributions.groups;
    if (result && result !== lastResult.current) {
      lastResult.current = result;
      groups = carryOver(groups, result);
      const needed = new Set([...groups.values()].flatMap((item) => item.patterns));
      const removed = [...owned].filter((pattern) => !needed.has(pattern));
      removed.forEach((pattern) => owned.delete(pattern));
      if (removed.length) onPatterns(removed, false);
    }
    if (owned.size !== contributions.owned.size || groups !== contributions.groups)
      setContributions({ owned, groups });
  }, [result, list, manualPatterns, onPatterns, contributions]);

  const checked = (group: ExclusionSuggestion) =>
    contributions.groups.has(groupKey(group)) &&
    group.patterns.every((pattern) => list?.includes(pattern));

  const toggle = (group: ExclusionSuggestion, selected: boolean) => {
    if (!list) return;
    if (selected && new Set([...list, ...group.patterns]).size > IGNORE_PATTERNS_MAX) {
      setLimitPatterns(group.patterns);
      return;
    }
    setLimitPatterns([]);
    const groups = new Map(contributions.groups);
    const owned = new Set(contributions.owned);
    if (selected) {
      groups.set(groupKey(group), contribution(group));
      group.patterns
        .filter((pattern) => !list.includes(pattern))
        .forEach((pattern) => owned.add(pattern));
      setContributions({ groups, owned });
      onPatterns(group.patterns, true);
    } else {
      const previous = groups.get(groupKey(group))?.patterns ?? group.patterns;
      groups.delete(groupKey(group));
      const needed = new Set(
        [...groups.values()]
          .filter((item) => item.patterns.every((pattern) => list.includes(pattern)))
          .flatMap((item) => item.patterns),
      );
      const removed = previous.filter(
        (pattern) =>
          owned.has(pattern) && !manualPatterns.includes(pattern) && !needed.has(pattern),
      );
      removed.forEach((pattern) => owned.delete(pattern));
      setContributions({ groups, owned });
      if (removed.length) onPatterns(removed, false);
    }
  };

  return {
    checked,
    toggle,
    overLimit: new Set([...(list ?? []), ...limitPatterns]).size > IGNORE_PATTERNS_MAX,
  };
}
