import { compileIgnorePattern } from './ignore-pattern-matcher';
import { SyncRelativePathSchema, type SyncPathFacts } from './sync-path-inspection.dto';

/** A nested `.gitignore` source's folder; null for any other source. */
export function nestedGitignoreBase(source: string): string | null {
  return source.endsWith('/.gitignore') && SyncRelativePathSchema.safeParse(source).success
    ? source.slice(0, -'/.gitignore'.length)
    : null;
}

export function translateGitIgnoreRule(
  rule: NonNullable<SyncPathFacts['ignoreRule']>,
): string[] | null {
  let pattern = rule.pattern;
  if (pattern.startsWith('!') || !/^[A-Za-z0-9._ /\-*?\[\]\\]+$/.test(pattern)) return null;
  if (pattern.includes('/**/') || pattern.includes('[^') || pattern.endsWith('\\')) return null;
  pattern = pattern.replace(/\/$/, '').replace(/^\*\*\//, '');
  if (!pattern) return null;
  const base = nestedGitignoreBase(rule.source) ?? '';
  const rootedBase = base ? `${base.replace(/[\\*?\[\]{}]/g, '\\$&')}/` : '';
  const patterns = pattern.includes('/')
    ? [`(?d)/${rootedBase}${pattern.replace(/^\//, '')}`]
    : base
      ? [`(?d)/${rootedBase}${pattern}`, `(?d)/${rootedBase}**/${pattern}`]
      : [`(?d)${pattern}`];
  return patterns.every((line) => compileIgnorePattern(line).kind === 'pattern') ? patterns : null;
}
