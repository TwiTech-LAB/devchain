import { Inject, Injectable, Optional } from '@nestjs/common';
import * as fs from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { projectRepository } from './project-repository';
import { ValidationError } from '../../common/errors/error-types';
import { SYNCTHING_GIT_EXCLUDES } from '../../common/constants/syncthing-markers';
import { ProcessExecutor } from '../terminal/services/process-executor/process-executor.port';
import { compileIgnorePattern, type CompiledIgnorePattern } from './ignore-pattern-matcher';
import { translateGitIgnoreRule } from './translate-git-ignore-rule';
import {
  SYNC_PATTERN_KEPT_SAMPLE_MAX,
  SYNC_PATTERN_TRACKED_FILES_MAX,
  SyncInspectRequestSchema,
  SyncRelativePathSchema,
  type SyncPathFacts,
  type SyncPathInspection,
  type SyncPathOwner,
  ancestors,
  within,
} from './sync-path-inspection.dto';

export const SYNC_PATH_FILESYSTEM = Symbol('SYNC_PATH_FILESYSTEM');
const SYNC_INFO_EXCLUDES = new Set(SYNCTHING_GIT_EXCLUDES);
type Filesystem = Pick<typeof fs, 'lstat' | 'readFile' | 'readdir'>;
interface PathTree {
  stat: Stats | null;
  fileCount: number;
  foreignUids: Set<number>;
  children: string[];
}
type IgnoreRule = NonNullable<SyncPathFacts['ignoreRule']>;
interface CatalogueRule {
  rule: IgnoreRule;
  patterns: CompiledIgnorePattern[];
}

function skipped(path: string): boolean {
  return path
    .split('/')
    .some(
      (part) =>
        ['.git', '.stfolder', '.stignore', '.stversions'].includes(part) ||
        /^\.syncthing\..*\.tmp$/.test(part) ||
        /^~syncthing~.*\.tmp$/.test(part),
    );
}
function kindOf(info: Stats | null): SyncPathFacts['kind'] {
  if (!info) return 'missing';
  return info.isDirectory() ? 'folder' : 'file';
}

const ignores = (rule: IgnoreRule | null | undefined): boolean =>
  !!rule && !rule.pattern.startsWith('!');

@Injectable()
export class SyncPathInspector {
  constructor(
    private readonly executor: ProcessExecutor,
    @Optional() @Inject(SYNC_PATH_FILESYSTEM) private readonly files: Filesystem = fs,
  ) {}

  async inspect(
    root: string,
    scan: boolean,
    paths: readonly string[] = [],
    patterns?: readonly string[],
  ): Promise<SyncPathInspection> {
    if (!isAbsolute(root))
      throw new ValidationError('The inspection root must be an absolute path.');
    const request = SyncInspectRequestSchema.parse({ path: root, scan, paths, patterns });
    root = resolve(request.path);
    const stat = async (path: string): Promise<Stats | null> =>
      this.files.lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
    const rootStat = await stat(root);
    const result: SyncPathInspection = {
      rootPath: root,
      exists: rootStat !== null,
      repository: false,
      projectOwner: null,
      gitState: 'no-repo',
      candidates: [],
      requestedPaths: request.paths.filter((path) => !skipped(path)),
      entries: [],
      ...(request.patterns !== undefined && {
        patternChecks: { state: rootStat ? 'no-repo' : 'no-root', results: [] },
      }),
    };
    if (!rootStat) return result;
    if (!rootStat.isDirectory())
      throw new ValidationError('The inspection root must be a folder, not a link.');
    result.repository = (await projectRepository(root)) === 'repository';
    const names = new Map<number, string>();
    const passwd = await this.files.readFile('/etc/passwd', 'utf8').catch(() => '');
    for (const line of passwd.split('\n')) {
      const [name, , uid] = line.split(':');
      if (name && /^\d+$/.test(uid ?? '')) names.set(Number(uid), name);
    }
    const owner = (uid: number): SyncPathOwner => ({ uid, name: names.get(uid) ?? `uid ${uid}` });
    result.projectOwner = owner(rootStat.uid);
    const trees = new Map<string, Promise<PathTree>>();
    const tree = (name: string): Promise<PathTree> => {
      const found = trees.get(name);
      if (found) return found;
      const read = async (): Promise<PathTree> => {
        const info = await stat(join(root, name));
        const item: PathTree = { stat: info, fileCount: 0, foreignUids: new Set(), children: [] };
        if (!info || info.isSymbolicLink()) return item;
        if (info.uid !== rootStat.uid) item.foreignUids.add(info.uid);
        if (info.isFile()) item.fileCount = 1;
        if (info.isDirectory()) {
          const children = await this.files
            .readdir(join(root, name))
            .catch((error: NodeJS.ErrnoException) => {
              if (error.code === 'EACCES' || error.code === 'EPERM') return [];
              throw error;
            });
          for (const child of children) {
            const childName = name ? `${name}/${child}` : child;
            if (skipped(childName)) continue;
            const nested = await tree(childName);
            if (nested.stat?.isSymbolicLink()) continue;
            item.children.push(childName);
            item.fileCount += nested.fileCount;
            for (const uid of nested.foreignUids) item.foreignUids.add(uid);
          }
        }
        return item;
      };
      const pending = read();
      trees.set(name, pending);
      return pending;
    };
    const checkLinks = async (name: string): Promise<void> => {
      for (const part of [...ancestors(name), name]) {
        if ((await stat(join(root, part)))?.isSymbolicLink())
          throw new ValidationError('Inspected paths must not contain links.');
      }
    };
    const given: string[] = [];
    const hidden: string[] = [];
    for (const name of result.requestedPaths) {
      try {
        await checkLinks(name);
        given.push(name);
      } catch (error) {
        // A parent folder this user cannot search hides only this path; inspect the others.
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EACCES' && code !== 'EPERM') throw error;
        hidden.push(name);
      }
    }
    if (hidden.length) result.hiddenPaths = hidden;
    const gitDirectory = (await stat(join(root, '.git')))?.isDirectory() ?? false;
    const git = async (argv: string[], input?: string, noMatch = false): Promise<string> => {
      const answer = await this.executor.run({
        argv: ['git', ...argv],
        cwd: root,
        mode: 'pipe',
        timeout: 10_000,
        outputLimits: { maxBytes: 16 * 1024 * 1024 },
        ...(input !== undefined && { input }),
      });
      if (
        answer.truncated ||
        answer.timedOut ||
        (!answer.success && !(noMatch && answer.exitCode === 1))
      )
        throw new Error(answer.stderr.trim() || 'Git could not be checked.');
      return answer.stdout;
    };
    let tracked: string[] = [];
    let kept: string[] | undefined;
    let hits: string[] = [];
    const rules = new Map<string, IgnoreRule>();
    const gitFailed = (error: unknown) => {
      result.gitState = 'error';
      result.gitError = error instanceof Error ? error.message : 'Git could not be checked.';
      if (request.patterns !== undefined)
        result.patternChecks = { state: 'error', error: result.gitError, results: [] };
      rules.clear();
      tracked = [];
    };
    const topIgnored = (name: string): string | null =>
      ancestors(name).find((parent) => ignores(rules.get(parent))) ?? null;
    if (gitDirectory) {
      result.gitState = 'repo';
      try {
        tracked = (await git(['ls-files', '-z'])).split('\0').filter(Boolean);
        if (request.patterns !== undefined)
          kept = (await git(['ls-files', '-z', '--others', '--exclude-standard']))
            .split('\0')
            .filter(Boolean);
        if (scan) {
          const ignored = (
            await git([
              'ls-files',
              '-z',
              '--others',
              '--ignored',
              '--exclude-standard',
              '--directory',
            ])
          )
            .split('\0')
            .filter(Boolean)
            .map((name) => name.replace(/\/$/, ''));
          for (const name of ignored) {
            if (!SyncRelativePathSchema.safeParse(name).success || skipped(name)) continue;
            try {
              await checkLinks(name);
            } catch (error) {
              if (error instanceof ValidationError) continue;
              throw error;
            }
            const item = await tree(name);
            if (item.foreignUids.size > 0) hits.push(name);
          }
        }
        // Git reads an existing path's type itself; `name/` would let `data/*` match `data`.
        const names = new Set([...given, ...hits].flatMap((name) => [...ancestors(name), name]));
        const checks: string[] = [];
        for (const name of names) checks.push((await stat(join(root, name))) ? name : `${name}/`);
        if (checks.length) {
          const output = (
            await git(['check-ignore', '-z', '-v', '--stdin'], checks.join('\0') + '\0', true)
          ).split('\0');
          for (let i = 0; i + 3 < output.length; i += 4)
            rules.set(output[i + 3].replace(/\/$/, ''), {
              source: output[i],
              line: Number(output[i + 1]),
              pattern: output[i + 2],
            });
        }
        // --directory can list a Git-kept folder whose descendants are all ignored.
        hits = hits.filter((name) => ignores(rules.get(name)));
      } catch (error) {
        gitFailed(error);
        hits = [];
      }
    }
    if (scan && result.gitState !== 'repo') {
      const discover = async (name: string): Promise<void> => {
        const item = await tree(name);
        if (name && item.stat && item.stat.uid !== rootStat.uid) {
          hits.push(name);
          return;
        }
        for (const child of item.children) await discover(child);
      };
      await discover('');
    }
    // One pass over the index; a later Git failure sets gitState to 'error', so entries ignore it.
    const trackedFiles = new Set(tracked);
    const trackedBelow = new Map<string, string[]>();
    for (const file of tracked)
      for (const parent of ancestors(file)) {
        const files = trackedBelow.get(parent);
        if (files) files.push(file);
        else trackedBelow.set(parent, [file]);
      }
    const candidatePaths = hits.map((name) => topIgnored(name) ?? name);
    result.candidates = [...new Set(candidatePaths)]
      .sort()
      .filter((name, _, all) => !all.some((parent) => parent !== name && within(name, parent)));
    const inspected = new Set([...given, ...result.candidates]);
    for (const name of given) {
      // The peer's ignore authority may choose an ancestor this index does not ignore.
      for (const parent of ancestors(name)) inspected.add(parent);
    }
    const catalogue = new Map<string, Promise<CatalogueRule[]>>();
    const sourceRules = (source: string): Promise<CatalogueRule[]> => {
      const found = catalogue.get(source);
      if (found) return found;
      const read = async (): Promise<CatalogueRule[]> => {
        const content = await this.files.readFile(join(root, source), 'utf8').catch(() => '');
        const entries: CatalogueRule[] = [];
        for (const [index, line] of content.split(/\r?\n/).entries()) {
          const pattern = line.trim();
          if (
            !pattern ||
            pattern.startsWith('#') ||
            pattern.startsWith('!') ||
            (source === '.git/info/exclude' && SYNC_INFO_EXCLUDES.has(pattern))
          )
            continue;
          const rule = { source, line: index + 1, pattern };
          const translated = translateGitIgnoreRule(rule);
          if (translated) entries.push({ rule, patterns: translated.map(compileIgnorePattern) });
        }
        return entries;
      };
      const pending = read();
      catalogue.set(source, pending);
      return pending;
    };
    const matchingRules = async (name: string): Promise<IgnoreRule[]> => {
      if (result.gitState !== 'repo') return [];
      const matches: IgnoreRule[] = [];
      for (const source of [
        '.gitignore',
        ...ancestors(name).map((parent) => `${parent}/.gitignore`),
        '.git/info/exclude',
      ])
        for (const entry of await sourceRules(source))
          if (entry.patterns.some((pattern) => pattern.kind === 'pattern' && pattern.matches(name)))
            matches.push(entry.rule);
      return matches;
    };
    for (const name of [...inspected].sort()) {
      const item = await tree(name);
      let parentStat = item.stat;
      if (!parentStat) {
        for (let parent = dirname(name); ; parent = dirname(parent)) {
          parentStat = await stat(join(root, parent));
          if (parentStat?.isDirectory()) break;
          if (parent === '.') {
            parentStat = rootStat;
            break;
          }
        }
      }
      const rule = rules.get(name) ?? null;
      result.entries.push({
        path: name,
        kind: kindOf(item.stat),
        owner: owner(parentStat!.uid),
        foreignOwner: parentStat!.uid !== rootStat.uid,
        foreignOwners: [...item.foreignUids].map(owner),
        fileCount: item.fileCount,
        ignored: result.gitState === 'error' ? null : ignores(rule),
        ignoreRule: rule,
        ignoreRules: await matchingRules(name),
        ignoredAncestor: topIgnored(name),
        tracked: result.gitState === 'error' ? null : trackedFiles.has(name),
        trackedDescendants: result.gitState === 'error' ? null : (trackedBelow.get(name) ?? []),
      });
    }
    if (request.patterns !== undefined && result.gitState === 'repo') {
      const compiled = request.patterns.map(compileIgnorePattern);
      const unknown = compiled.find(
        (pattern) => pattern.kind === 'error' || pattern.kind === 'include',
      );
      if (unknown) {
        result.patternChecks = {
          state: 'error',
          error:
            unknown.kind === 'error' ? unknown.error : 'Included ignore files cannot be checked.',
          results: [],
        };
      } else {
        result.patternChecks = {
          state: 'checked',
          results: request.patterns.map((pattern, index) => {
            const rule = compiled[index];
            const matches = (file: string): boolean =>
              rule.kind === 'pattern' && rule.ignored && rule.matches(file);
            const trackedMatches = tracked.filter(matches);
            const keptMatches = kept!.filter(matches);
            const complete = trackedMatches.length <= SYNC_PATTERN_TRACKED_FILES_MAX;
            return {
              pattern,
              tracked: {
                count: trackedMatches.length,
                files: complete ? trackedMatches : [],
                complete,
              },
              kept: {
                count: keptMatches.length,
                sample: keptMatches.slice(0, SYNC_PATTERN_KEPT_SAMPLE_MAX),
              },
            };
          }),
        };
      }
    }
    return result;
  }
}
