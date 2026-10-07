import { quoteShellArg } from '../terminal/services/terminal-io/quote-shell-arg';
import { SYNCTHING_GIT_EXCLUDES } from '../../common/constants/syncthing-markers';
import { IGNORE_PATTERN_MAX_LENGTH, IGNORE_PATTERNS_MAX } from './file-sync.dto';
import { compileIgnoreList, compileIgnorePattern } from './ignore-pattern-matcher';
import { nestedGitignoreBase, translateGitIgnoreRule } from './translate-git-ignore-rule';
import {
  SYNC_PATTERN_TRACKED_FILES_MAX,
  SYNC_PATTERN_KEPT_SAMPLE_MAX,
  EXCLUSION_LIMIT_ERROR,
  ancestors,
  isSelectableExclusion,
  within,
  type ExclusionSuggestion,
  type ExclusionSuggestions,
  type SyncPathFacts,
  type SyncPathInspection,
  type SyncPatternChecks,
} from './sync-path-inspection.dto';

type Side = 'home' | 'vm';
const escapePath = (path: string) => path.replace(/[\\*?\[\]{}]/g, '\\$&');
const MANAGED_GIT_EXCLUDES = new Set(SYNCTHING_GIT_EXCLUDES);
const PATTERN_TOO_LONG = 'An exclusion pattern exceeds the maximum length.';
const tooLong = (patterns: readonly string[]): boolean =>
  patterns.some((pattern) => pattern.length > IGNORE_PATTERN_MAX_LENGTH);

function literalPattern(
  pattern: string,
): { path: string; negated: boolean; rooted: boolean; insensitive: boolean } | null {
  pattern = pattern.trim();
  let negated = false;
  let insensitive = false;
  while (pattern.startsWith('!') || /^\(\?[id]\)/.test(pattern)) {
    if (pattern.startsWith('!')) {
      negated = true;
      pattern = pattern.slice(1);
    } else {
      insensitive ||= pattern.startsWith('(?i)');
      pattern = pattern.slice(4);
    }
  }
  let path = '';
  for (let i = 0; i < pattern.length; i += 1) {
    if (pattern[i] === '\\' && i + 1 < pattern.length) path += pattern[++i];
    else if ('*?[]{}'.includes(pattern[i])) return null;
    else path += pattern[i];
  }
  const rooted = path.startsWith('/');
  return { path: path.replace(/^\//, '').replace(/\/$/, ''), negated, rooted, insensitive };
}

function blocks(pattern: string, path: string): boolean {
  pattern = pattern.trim();
  if (!pattern.includes('!')) return false;
  const literal = literalPattern(pattern);
  if (!literal) return /^((\(\?[id]\))*!|!(\(\?[id]\))*)/.test(pattern);
  if (!literal.negated) return false;
  const target = literal.insensitive ? path.toLowerCase() : path;
  const ignored = literal.insensitive ? literal.path.toLowerCase() : literal.path;
  if (!ignored || within(target, ignored) || within(ignored, target)) return true;
  return !literal.rooted && `/${target}/`.includes(`/${ignored}/`);
}

export interface BuildExclusionSuggestionsInput {
  ownerSide: Side;
  home: SyncPathInspection;
  vm: SyncPathInspection | 'unavailable';
  userIgnores: readonly string[];
  managedExclusions: readonly string[];
  patternChecks?: Record<Side, SyncPatternChecks | 'unavailable'>;
}

function reasonFor(
  foreign: SyncPathFacts['foreignOwners'],
  entry: SyncPathFacts,
): Pick<ExclusionSuggestion, 'reason' | 'reasonKind'> {
  if (foreign.length) {
    const names = [...new Set(foreign.map((owner) => owner.name))].join(', ');
    return { reason: `Written by another user (${names})`, reasonKind: 'foreignOwner' };
  }
  if (entry.foreignOwner)
    return { reason: `Written by another user (${entry.owner.name})`, reasonKind: 'foreignOwner' };
  return { reason: 'Untracked path', reasonKind: 'untracked' };
}

/** Ignore authority follows ownership; tracked protection uses every available index. */
function buildPerPathSuggestions(input: BuildExclusionSuggestionsInput): ExclusionSuggestion[] {
  const { ownerSide, home, vm, userIgnores, managedExclusions } = input;
  const sides: Partial<Record<Side, SyncPathInspection>> = {
    home,
    ...(vm !== 'unavailable' && { vm }),
  };
  const facts: Partial<Record<Side, Map<string, SyncPathFacts>>> = {};
  for (const side of ['home', 'vm'] as const)
    facts[side] = new Map(sides[side]?.entries.map((entry) => [entry.path, entry]));
  const candidates = new Set(Object.values(sides).flatMap((side) => side.candidates));
  const requested = new Set(Object.values(sides).flatMap((side) => side.requestedPaths));
  const hidden = Object.values(sides).flatMap((side) => side.hiddenPaths ?? []);
  const isTracked = (path: string) =>
    Boolean(facts.home?.get(path)?.tracked || facts.vm?.get(path)?.tracked);
  const trackedRequests = [...requested].filter(isTracked);
  const paths = [
    ...new Set(
      candidates.size
        ? candidates
        : [...requested].map((path) => {
            if (isTracked(path)) return path;
            return facts[ownerSide]?.get(path)?.ignoredAncestor ?? path;
          }),
    ),
  ].sort();
  // Requested ownership repairs remain visible alongside an enclosing exclusion.
  const topmost = [
    ...new Set([
      ...paths.filter((path) => !paths.some((parent) => parent !== path && within(path, parent))),
      ...trackedRequests,
    ]),
  ].sort();
  const listed = compileIgnoreList(userIgnores);
  const managedPaths = managedExclusions.flatMap((pattern) => {
    const literal = literalPattern(pattern);
    return literal && !literal.negated ? [literal.path] : [];
  });
  const groups: ExclusionSuggestion[] = [];
  for (const path of topmost) {
    if (managedPaths.some((managed) => within(path, managed))) continue;
    const entries = { home: facts.home?.get(path) ?? null, vm: facts.vm?.get(path) ?? null };
    const side =
      (['home', 'vm'] as const).find(
        (side) => entries[side]?.foreignOwner || entries[side]?.foreignOwners.length,
      ) ??
      (['home', 'vm'] as const).find((side) => sides[side]?.candidates.includes(path)) ??
      ownerSide;
    const entry = entries[side] ?? entries.home ?? entries.vm;
    if (!entry) continue;
    const authority = sides[ownerSide];
    const ownerFacts = entries[ownerSide];
    const foreign = [...(entries.home?.foreignOwners ?? []), ...(entries.vm?.foreignOwners ?? [])];
    if (
      authority?.gitState === 'no-repo' &&
      !foreign.length &&
      !entries.home?.foreignOwner &&
      !entries.vm?.foreignOwner
    )
      continue;
    const group: ExclusionSuggestion = {
      path,
      side,
      owner: entry.owner,
      ...entries,
      fileCount: Math.max(entries.home?.fileCount ?? 0, entries.vm?.fileCount ?? 0),
      ...reasonFor(foreign, entry),
      selected: false,
      patterns: [],
    };
    groups.push(group);
    if (
      !authority ||
      Object.values(sides).some((side) => side.gitState === 'error') ||
      // A hidden path on either side may hold files that only that side tracks.
      hidden.some((name) => within(name, path) || within(path, name))
    ) {
      group.gitUnchecked = true;
      continue;
    }
    if (isTracked(path)) {
      group.chown = {};
      for (const current of ['home', 'vm'] as const) {
        const result = sides[current];
        const facts = entries[current];
        if (!result?.projectOwner || !facts || facts.kind === 'missing') continue;
        const user =
          result.projectOwner.name === `uid ${result.projectOwner.uid}`
            ? String(result.projectOwner.uid)
            : result.projectOwner.name;
        const userArg = /^[A-Za-z0-9_.-]+$/.test(user) ? user : quoteShellArg(user);
        group.chown[current] =
          `sudo chown -R ${userArg} ${quoteShellArg(`${result.rootPath.replace(/\/$/, '')}/${path}`)}`;
      }
      continue;
    }
    if (authority.gitState !== 'repo' || ownerFacts?.ignored === null) {
      group.gitUnchecked = true;
      continue;
    }
    if (ownerFacts?.ignored !== true) continue;
    const pattern = `(?d)/${escapePath(path)}`;
    // The list line that already excludes the path. When an #include hides the answer, only an
    // exact duplicate counts.
    const match = listed(path);
    const excludedAt =
      match.kind !== 'matched' ? userIgnores.indexOf(pattern) : match.ignored ? match.index : -1;
    const before = excludedAt < 0 ? userIgnores : userIgnores.slice(0, excludedAt);
    const blockedBy = before.find((pattern) => blocks(pattern, path));
    if (blockedBy) {
      group.blockedBy = blockedBy;
      continue;
    }
    if (excludedAt >= 0) {
      groups.pop();
      continue;
    }
    const descendants = [
      ...new Set([
        ...(entries.home?.trackedDescendants ?? []),
        ...(entries.vm?.trackedDescendants ?? []),
      ]),
    ].sort();
    const patterns = [...descendants.map((file) => `!/${escapePath(file)}`), pattern];
    if (tooLong(patterns)) {
      group.patternError = PATTERN_TOO_LONG;
      continue;
    }
    group.pattern = pattern;
    group.patterns = patterns;
    group.selected = true;
  }
  return groups;
}

interface RuleProposal {
  members: ExclusionSuggestion[];
  patterns: string[];
  depth: number;
  line: number;
  source: string;
}

const sourceOrder = (a: RuleProposal, b: RuleProposal): number =>
  a.depth - b.depth || a.line - b.line || Number(a.source > b.source) - Number(a.source < b.source);
const coverageOrder = (a: RuleProposal, b: RuleProposal): number =>
  b.members.length - a.members.length || sourceOrder(a, b);

function ruleProposals(
  input: BuildExclusionSuggestionsInput,
  groups: ExclusionSuggestion[],
): RuleProposal[] {
  const eligible = groups.filter(isSelectableExclusion);
  const buckets = new Map<string, RuleProposal>();
  for (const group of eligible) {
    const facts = group[input.ownerSide]!;
    for (const rule of [...facts.ignoreRules, ...(facts.ignoreRule ? [facts.ignoreRule] : [])]) {
      if (rule.source === '.git/info/exclude' && MANAGED_GIT_EXCLUDES.has(rule.pattern.trim()))
        continue;
      if (
        !['.gitignore', '.git/info/exclude'].includes(rule.source) &&
        nestedGitignoreBase(rule.source) === null
      )
        continue;
      const patterns = translateGitIgnoreRule(rule);
      if (!patterns || tooLong(patterns)) continue;
      const compiled = patterns.map(compileIgnorePattern);
      const matches = (path: string) =>
        compiled.some((line) => line.kind === 'pattern' && line.matches(path));
      const members = eligible.filter((member) => matches(member.path));
      if (!members.length || members.some((member) => ancestors(member.path).some(matches)))
        continue;
      const proposal = {
        members,
        patterns,
        depth: rule.source.split('/').length - 1,
        line: rule.line,
        source: rule.source,
      };
      const key = JSON.stringify(patterns);
      const prior = buckets.get(key);
      if (!prior || sourceOrder(proposal, prior) < 0) buckets.set(key, proposal);
    }
  }
  return [...buckets.values()].sort(coverageOrder);
}

export function proposeExclusionPatterns(input: BuildExclusionSuggestionsInput): string[] {
  const groups = buildPerPathSuggestions(input);
  return [
    ...new Set([
      ...ruleProposals(input, groups).flatMap((proposal) => proposal.patterns),
      ...groups.flatMap((group) => group.patterns.filter((pattern) => !pattern.startsWith('!'))),
    ]),
  ];
}

type PatternInspect = (batch: string[]) => Promise<SyncPathInspection | null>;

/** One side's second pass: a failed or skipped read is unavailable; no checks is an error. */
async function checkExclusionPatterns(
  patterns: readonly string[],
  inspect: PatternInspect,
): Promise<SyncPatternChecks | 'unavailable'> {
  let combined: SyncPatternChecks | undefined;
  for (let start = 0; start < patterns.length; start += IGNORE_PATTERNS_MAX) {
    const read = await inspect(patterns.slice(start, start + IGNORE_PATTERNS_MAX)).catch(
      () => null,
    );
    if (!read) return 'unavailable';
    const checked = read.patternChecks ?? { state: 'error', results: [] };
    if (checked.state !== 'checked' && checked.state !== 'no-root') return checked;
    if (combined && combined.state !== checked.state) return { state: 'error', results: [] };
    combined ??= { state: checked.state, results: [] };
    combined.results.push(...checked.results);
  }
  return combined ?? { state: 'checked', results: [] };
}

/** Checks the proposed patterns on both sides and stores the answers for the builder. */
export async function attachPatternChecks(
  input: BuildExclusionSuggestionsInput,
  inspect: Record<Side, PatternInspect>,
): Promise<void> {
  const patterns = proposeExclusionPatterns(input);
  if (!patterns.length) return;
  const [home, vm] = await Promise.all([
    checkExclusionPatterns(patterns, inspect.home),
    checkExclusionPatterns(patterns, inspect.vm),
  ]);
  input.patternChecks = { home, vm };
}

type SafetyProof =
  | { state: 'checked'; patterns: string[] }
  | { state: 'unknown' }
  | { state: 'unsafe'; error: string };
const UNKNOWN: SafetyProof = { state: 'unknown' };

function safetyProof(input: BuildExclusionSuggestionsInput, exclusions: string[]): SafetyProof {
  if (!input.patternChecks) return UNKNOWN;
  const tracked = new Set<string>();
  for (const side of ['home', 'vm'] as const) {
    if (side === 'vm' && input.vm === 'unavailable' && input.ownerSide !== 'vm') continue;
    const check = input.patternChecks[side];
    if (check === 'unavailable') return UNKNOWN;
    if (check.state === 'no-root') continue;
    if (check.state !== 'checked') return UNKNOWN;
    for (const pattern of exclusions) {
      const result = check.results.find((result) => result.pattern === pattern);
      if (!result) return UNKNOWN;
      if (result.kept.count > 0)
        return { state: 'unsafe', error: 'This exclusion would also ignore files that Git keeps.' };
      if (
        !result.tracked.complete ||
        result.tracked.count > SYNC_PATTERN_TRACKED_FILES_MAX ||
        result.tracked.files.length !== result.tracked.count
      )
        return UNKNOWN;
      for (const file of result.tracked.files) tracked.add(file);
    }
  }
  if (tracked.size > SYNC_PATTERN_TRACKED_FILES_MAX) return UNKNOWN;
  const patterns = [...[...tracked].sort().map((file) => `!/${escapePath(file)}`), ...exclusions];
  if (tooLong(patterns)) return { state: 'unsafe', error: PATTERN_TOO_LONG };
  return { state: 'checked', patterns };
}

/** The count, sample and file total of the paths that one group covers. */
const coverage = (members: readonly ExclusionSuggestion[]) => ({
  pathCount: members.length,
  pathSample: members.slice(0, SYNC_PATTERN_KEPT_SAMPLE_MAX).map((group) => group.path),
  fileCount: members.reduce((count, group) => count + group.fileCount, 0),
});
const withoutExclusion = (
  group: ExclusionSuggestion,
  extra: Partial<ExclusionSuggestion>,
): ExclusionSuggestion => ({
  ...group,
  pattern: undefined,
  patterns: [],
  selected: false,
  ...extra,
});

function mergedSuggestion(
  input: BuildExclusionSuggestionsInput,
  proposal: RuleProposal,
  patterns: string[],
): ExclusionSuggestion {
  const first = proposal.members[0];
  const mergedFacts = (side: Side): SyncPathFacts | null => {
    const entries = proposal.members.flatMap((group) => group[side] ?? []);
    if (!entries.length) return null;
    return {
      ...entries[0],
      fileCount: entries.reduce((count, entry) => count + entry.fileCount, 0),
      foreignOwners: [
        ...new Map(
          entries
            .flatMap((entry) => [
              ...(entry.foreignOwner ? [entry.owner] : []),
              ...entry.foreignOwners,
            ])
            .map((owner) => [owner.uid, owner]),
        ).values(),
      ],
    };
  };
  const home = mergedFacts('home');
  const vm = mergedFacts('vm');
  const foreign = [...(home?.foreignOwners ?? []), ...(vm?.foreignOwners ?? [])];
  return {
    ...first,
    home,
    vm,
    ...coverage(proposal.members),
    patternChecksPassed: true,
    ...reasonFor(foreign, (first.side === 'home' ? home : vm)!),
    selected: proposal.members.every((group) => group.selected),
    pattern: proposal.patterns[0],
    patterns,
  };
}

export function buildExclusionSuggestions(
  input: BuildExclusionSuggestionsInput,
): ExclusionSuggestions {
  const perPath = buildPerPathSuggestions(input);
  const remaining = new Set(perPath.filter(isSelectableExclusion));
  const proposals = ruleProposals(input, perPath);
  const used = new Set(input.userIgnores);
  const fits = (patterns: string[]): boolean =>
    new Set([...used, ...patterns]).size <= IGNORE_PATTERNS_MAX;
  const groups: ExclusionSuggestion[] = [];
  while (remaining.size) {
    const choices = proposals
      .map((proposal) => ({
        ...proposal,
        members: proposal.members.filter((member) => remaining.has(member)),
      }))
      .filter((proposal) => proposal.members.length)
      .sort(coverageOrder);
    let chosen: RuleProposal | undefined;
    for (const proposal of choices) {
      const proof = safetyProof(input, proposal.patterns);
      if (proof.state !== 'checked' || !fits(proof.patterns)) continue;
      groups.push(mergedSuggestion(input, proposal, proof.patterns));
      for (const pattern of proof.patterns) used.add(pattern);
      chosen = proposal;
      break;
    }
    if (!chosen) break;
    for (const member of chosen.members) remaining.delete(member);
  }
  const overflow: ExclusionSuggestion[] = [];
  for (const group of perPath) {
    if (!isSelectableExclusion(group)) {
      groups.push(group);
      continue;
    }
    if (!remaining.has(group)) continue;
    const proof = safetyProof(input, [group.pattern!]);
    if (proof.state !== 'checked') {
      groups.push(
        withoutExclusion(group, {
          patternChecksPassed: false,
          ...(proof.state === 'unknown' ? { gitUnchecked: true } : { patternError: proof.error }),
        }),
      );
    } else if (fits(proof.patterns)) {
      groups.push({ ...group, patterns: proof.patterns, patternChecksPassed: true });
      for (const pattern of proof.patterns) used.add(pattern);
    } else overflow.push(group);
  }
  if (overflow.length)
    groups.push(
      withoutExclusion(overflow[0], {
        ...coverage(overflow),
        patternError: EXCLUSION_LIMIT_ERROR,
      }),
    );
  return { groups, overLimit: used.size > IGNORE_PATTERNS_MAX };
}
