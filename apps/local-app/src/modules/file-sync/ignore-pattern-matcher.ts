import { IGNORE_PATTERNS_MAX, IGNORE_PATTERN_MAX_LENGTH } from './file-sync.dto';

export type CompiledIgnorePattern =
  | {
      kind: 'pattern';
      ignored: boolean;
      deletable: boolean;
      matches: (path: string) => boolean;
    }
  | { kind: 'comment' }
  | { kind: 'include' }
  | { kind: 'error'; error: string };

export type IgnoreMatch =
  | { kind: 'matched'; index: number; ignored: boolean; deletable: boolean }
  | { kind: 'none' }
  | { kind: 'unknown'; index: number; reason: 'include' | 'syntax'; error?: string };

const literal = (value: string): string => value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
const classLiteral = (value: string): string => value.replace(/[\\\]\[\^\-]/g, '\\$&');

/** Translate gobwas/glob syntax, with '/' as the wildcard separator. */
function globExpression(pattern: string): string {
  const chars = [...pattern];
  let cursor = 0;
  const sequence = (inTerms: boolean): string => {
    let result = '';
    while (cursor < chars.length) {
      const char = chars[cursor++];
      if (inTerms && (char === ',' || char === '}')) {
        cursor--;
        break;
      }
      switch (char) {
        case '\\':
          if (cursor < chars.length) result += literal(chars[cursor++]);
          break;
        case '*':
          if (chars[cursor] === '*') {
            cursor++;
            result += '[\\s\\S]*';
          } else result += '[^/]*';
          break;
        case '?':
          result += '[^/]';
          break;
        case '{': {
          const alternatives = [sequence(true)];
          while (chars[cursor] === ',') {
            cursor++;
            alternatives.push(sequence(true));
          }
          // gobwas accepts an unfinished brace group at end of input.
          if (chars[cursor] === '}') cursor++;
          result += `(?:${alternatives.join('|')})`;
          break;
        }
        case '[': {
          const negated = chars[cursor] === '!';
          if (negated) cursor++;
          let content = '';
          if (chars[cursor + 1] === '-') {
            const low = chars[cursor];
            const high = chars[cursor + 2];
            cursor += 3;
            if (!high || chars[cursor] !== ']') throw new Error('Expected closing bracket.');
            if (high.codePointAt(0)! < low.codePointAt(0)!) {
              throw new Error('Character range is reversed.');
            }
            content = `${classLiteral(low)}-${classLiteral(high)}`;
          } else {
            while (cursor < chars.length && chars[cursor] !== ']') {
              const next = chars[cursor++];
              if (next === '\\') {
                if (cursor < chars.length) content += classLiteral(chars[cursor++]);
              } else content += classLiteral(next);
            }
          }
          if (!content || chars[cursor] !== ']')
            throw new Error('Expected a nonempty character class and closing bracket.');
          cursor++;
          result += `[${negated ? '^' : ''}${content}]`;
          break;
        }
        default:
          result += literal(char);
      }
    }
    return result;
  };
  return sequence(false);
}

export function compileIgnorePattern(line: string): CompiledIgnorePattern {
  let pattern = line.trim().normalize('NFC');
  if (!pattern || pattern.startsWith('//')) return { kind: 'comment' };
  if (pattern.startsWith('#include')) {
    const space = pattern.indexOf(' ');
    return space >= 0 && pattern.slice(space + 1).trim()
      ? { kind: 'include' }
      : { kind: 'error', error: 'Invalid ignore pattern: #include needs a file.' };
  }
  let ignored = true;
  let folded = false;
  let deletable = false;
  const seen = new Set<string>();
  while (true) {
    const prefix = ['!', '(?i)', '(?d)'].find(
      (item) => pattern.startsWith(item) && !seen.has(item),
    );
    if (!prefix) break;
    seen.add(prefix);
    pattern = pattern.slice(prefix.length);
    if (prefix === '!') ignored = false;
    if (prefix === '(?i)') folded = true;
    if (prefix === '(?d)') deletable = true;
  }
  if (!pattern) return { kind: 'error', error: 'Invalid ignore pattern: missing pattern.' };
  if (folded) pattern = pattern.toLowerCase();
  const expanded = pattern.endsWith('/**')
    ? [pattern]
    : pattern.endsWith('/')
      ? [pattern + '**']
      : [pattern, pattern + '/**'];
  try {
    const expressions = expanded.flatMap((item) => {
      if (item.startsWith('/')) return [item.slice(1)];
      if (item.startsWith('**/')) return item.length === 3 ? [item] : [item, item.slice(3)];
      return [item, '**/' + item];
    });
    const regexes = expressions.map(
      (item) => new RegExp(`^(?:${globExpression(item)})(?![\\s\\S])`, 'u'),
    );
    return {
      kind: 'pattern',
      ignored,
      deletable: ignored && deletable,
      matches: (path: string): boolean => {
        const normalized = path.normalize('NFC');
        const candidate = folded ? normalized.toLowerCase() : normalized;
        return regexes.some((regex) => regex.test(candidate));
      },
    };
  } catch (error: unknown) {
    return {
      kind: 'error',
      error: `Invalid ignore pattern: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Compiles an ordered list once; the returned function gives each path's first match. */
export function compileIgnoreList(lines: readonly string[]): (path: string) => IgnoreMatch {
  const compiled = lines.map(compileIgnorePattern);
  return (path) => {
    for (const [index, line] of compiled.entries()) {
      if (line.kind === 'include') return { kind: 'unknown', index, reason: 'include' };
      if (line.kind === 'error')
        return { kind: 'unknown', index, reason: 'syntax', error: line.error };
      if (line.kind === 'pattern' && line.matches(path)) {
        return { kind: 'matched', index, ignored: line.ignored, deletable: line.deletable };
      }
    }
    return { kind: 'none' };
  };
}

export function firstMatch(lines: readonly string[], path: string): IgnoreMatch {
  return compileIgnoreList(lines)(path);
}

export function ignorePatternProblem(list: readonly string[], pattern: string): string | null {
  const trimmed = pattern.trim();
  if (!trimmed) return 'Enter a pattern.';
  if (list.includes(trimmed)) return `${trimmed} is already in the list.`;
  if (trimmed.length > IGNORE_PATTERN_MAX_LENGTH)
    return `A pattern can have at most ${IGNORE_PATTERN_MAX_LENGTH} characters.`;
  if (list.length >= IGNORE_PATTERNS_MAX)
    return `The list can hold at most ${IGNORE_PATTERNS_MAX} patterns.`;
  const compiled = compileIgnorePattern(trimmed);
  return compiled.kind === 'error' ? compiled.error : null;
}
