import type { DirtyFile } from './worktrees.types';

export function parsePorcelain(output: string): DirtyFile[] {
  const records = output.split('\0');
  const files: DirtyFile[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    const status = record.slice(0, 2);
    const file: DirtyFile = { status, path: record.slice(3) };
    if (/[RC]/.test(status)) file.originalPath = records[++i];
    files.push(file);
  }
  return files;
}

export function parseMergeTreeConflicts(output: string): string[] {
  const records = output.split('\0');
  const files: string[] = [];
  // The tree OID precedes paths; an empty record starts informational messages.
  for (let i = 1; i < records.length && records[i] !== ''; i++) files.push(records[i]);
  return files;
}

export function parseUnmergedFiles(output: string): string[] {
  return [
    ...new Set(
      output
        .split('\0')
        .filter(Boolean)
        .map((record) => record.slice(record.indexOf('\t') + 1)),
    ),
  ].sort();
}

export function conflictMarkerFiles(diagnostics: string, stagedFiles: string[]): string[] {
  const candidates = [...stagedFiles].sort((a, b) => b.length - a.length);
  const files = new Set<string>();
  for (const match of diagnostics.matchAll(/:\d+: leftover conflict marker(?:\r?\n|$)/g)) {
    const end = match.index;
    const file = candidates.find((path) => {
      const start = end - path.length;
      return (
        start >= 0 &&
        (start === 0 || diagnostics[start - 1] === '\n') &&
        diagnostics.slice(start, end) === path
      );
    });
    if (file !== undefined) files.add(file);
  }
  return [...files].sort();
}
