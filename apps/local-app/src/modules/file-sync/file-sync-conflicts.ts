import { opendir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
  CONFLICT_BASELINE_MAX,
  FILE_SYNC_REPORT_SAMPLE,
  type ConflictBaseline,
  type ConflictReport,
} from './file-sync.dto';

interface IgnoreRule {
  match: RegExp;
  include: boolean;
  /**
   * For a rooted include: its leading literal path, and whether the whole
   * pattern is literal. Null when the include can match at any depth.
   */
  base: { path: string; exact: boolean; insensitive: boolean } | null;
}

/** First-match Syncthing rules, including root/glob patterns and earlier negations. */
async function ignoreRules(root: string, patterns: readonly string[]): Promise<IgnoreRule[]> {
  const rules: IgnoreRule[] = [];
  const loaded = new Set<string>();
  const parse = async (lines: readonly string[], directory: string): Promise<void> => {
    let escape = process.platform === 'win32' ? '|' : '\\';
    for (let pattern of lines) {
      pattern = pattern.trim();
      if (!pattern || pattern.startsWith('//')) continue;
      if (pattern.startsWith('#escape=')) {
        escape = pattern.slice(8);
        continue;
      }
      if (pattern.startsWith('#include ')) {
        const path = resolve(directory, pattern.slice(9).trim());
        if (loaded.has(path)) throw new Error('An ignore file was included more than once.');
        loaded.add(path);
        await parse((await readFile(path, 'utf8')).split(/\r?\n/), dirname(path));
        continue;
      }
      let include = false;
      let insensitive = process.platform === 'win32' || process.platform === 'darwin';
      while (pattern.startsWith('!') || /^\(\?[id]\)/.test(pattern)) {
        if (pattern.startsWith('!')) {
          include = true;
          pattern = pattern.slice(1);
        } else {
          if (pattern.startsWith('(?i)')) insensitive = true;
          pattern = pattern.slice(4);
        }
      }
      const rooted = pattern.startsWith('/');
      const body = rooted ? pattern.slice(1) : pattern;
      const source = globSource(body, escape);
      rules.push({
        include,
        base: include && rooted ? literalBase(body, escape, insensitive) : null,
        match: new RegExp(
          `${rooted ? '^' : '(?:^|/)'}${source}${pattern.endsWith('/') ? '' : '(?:$|/)'}`,
          insensitive ? 'i' : '',
        ),
      });
    }
  };
  await parse(patterns, root);
  return rules;
}

function literalBase(body: string, escape: string, insensitive: boolean): IgnoreRule['base'] {
  const segments: string[] = [];
  let segment = '';
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];
    if (char === escape && i + 1 < body.length) segment += body[++i];
    else if ('*?[{'.includes(char)) return { path: segments.join('/'), exact: false, insensitive };
    else if (char === '/') {
      segments.push(segment);
      segment = '';
    } else segment += char;
  }
  if (segment) segments.push(segment);
  return { path: segments.join('/'), exact: true, insensitive };
}

/** Whether an include rule can match a path inside the folder `name`. */
function reachesInside(rule: IgnoreRule, name: string): boolean {
  if (!rule.base) return true;
  const fold = (value: string) => (rule.base?.insensitive ? value.toLowerCase() : value);
  const path = fold(rule.base.path);
  const folder = fold(name);
  if (path.startsWith(`${folder}/`)) return true;
  // Glob segments start at or above the folder, so they may match below it.
  return !rule.base.exact && (path === '' || folder === path || folder.startsWith(`${path}/`));
}

function globSource(pattern: string, escape: string): string {
  const literal = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let result = '';
  let alternatives = 0;
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === escape && i + 1 < pattern.length) result += literal(pattern[++i]);
    else if (char === '*') {
      if (pattern[i + 1] === '*') {
        i += 1;
        if (pattern[i + 1] === '/') {
          i += 1;
          result += '(?:.*/)?';
        } else result += '.*';
      } else result += '[^/]*';
    } else if (char === '?') result += '[^/]';
    else if (char === '[' && pattern.indexOf(']', i + 1) >= 0) {
      const end = pattern.indexOf(']', i + 1);
      result += pattern.slice(i, end + 1);
      i = end;
    } else if (char === '{') {
      alternatives += 1;
      result += '(?:';
    } else if (char === '}' && alternatives > 0) {
      alternatives -= 1;
      result += ')';
    } else if (char === ',' && alternatives > 0) result += '|';
    else result += literal(char);
  }
  return result;
}

async function walkConflicts(
  root: string,
  ignores: readonly string[],
  visit: (name: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const rules = await ignoreRules(root, ignores);
  const walk = async (path: string): Promise<void> => {
    signal?.throwIfAborted();
    const directory = await opendir(path);
    try {
      for await (const entry of directory) {
        signal?.throwIfAborted();
        const conflictCopy = entry.isFile() && entry.name.includes('.sync-conflict-');
        // Only folders and conflict copies need the ignore rules; other files are never reported.
        if (entry.isSymbolicLink() || (!entry.isDirectory() && !conflictCopy)) continue;
        const fullPath = join(path, entry.name);
        const name = relative(root, fullPath).split(sep).join('/');
        const matched = rules.findIndex((rule) => rule.match.test(name));
        const ignored = matched >= 0 && !rules[matched].include;
        if (entry.isDirectory()) {
          // Only an earlier negation that can match inside an ignored folder needs its contents;
          // other ignored folders are pruned, so unreadable runtime output there is never opened.
          if (
            !ignored ||
            rules.slice(0, matched).some((rule) => rule.include && reachesInside(rule, name))
          )
            await walk(fullPath);
        } else if (!ignored) {
          visit(name);
        }
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
  };
  await walk(root);
}

export async function captureFileSyncConflictBaseline(
  root: string,
  ignores: readonly string[],
  signal?: AbortSignal,
): Promise<ConflictBaseline> {
  const paths: string[] = [];
  let baselineOverCap = false;
  await walkConflicts(
    root,
    ignores,
    (name) => {
      if (baselineOverCap) return;
      if (paths.length === CONFLICT_BASELINE_MAX) {
        baselineOverCap = true;
        paths.length = 0;
      } else paths.push(name);
    },
    signal,
  );
  return baselineOverCap ? { baselineOverCap: true } : { baselineOverCap: false, paths };
}

export async function scanFileSyncConflicts(
  root: string,
  baseline: ConflictBaseline,
  ignores: readonly string[],
  signal?: AbortSignal,
): Promise<ConflictReport> {
  // Rename-based conflict copies retain the losing file's mtime. Only the
  // saved path baseline can distinguish them from copies that already existed.
  const previous = new Set(baseline.baselineOverCap ? [] : baseline.paths);
  const result: ConflictReport = {
    total: 0,
    sample: [],
    ...(baseline.baselineOverCap && { baselineOverCap: true }),
  };
  await walkConflicts(
    root,
    ignores,
    (name) => {
      if (previous.has(name)) return;
      result.total += 1;
      if (result.sample.length < FILE_SYNC_REPORT_SAMPLE) result.sample.push(name);
    },
    signal,
  );
  result.sample.sort();
  return result;
}
