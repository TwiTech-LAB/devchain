import { posix as path } from 'node:path';
import type { ProviderAuthClaimFile } from '../../provider-auth/provider-auth-adapters';
import type { ProcessExecutor } from '../../terminal/services/process-executor/process-executor.port';

const GIT_CONFIG_TIMEOUT_MS = 5_000;

/**
 * Runs outside any repository, so no `includeIf "gitdir:…"` rule of the
 * global config can match and expand into the listing.
 */
const NEUTRAL_CWD = '/';

/** One `git config --list -z` record; a null value is a key without a value. */
export interface GitConfigRecord {
  readonly key: string;
  readonly value: string | null;
}

/**
 * Renders home's effective global git config into one file the VM can use as
 * its `~/.gitconfig`. Returns null when this PC has none or the read fails,
 * so nothing is sent. The file can hold secrets (for example
 * `http.https://….extraheader`); its content must never be logged.
 */
export async function buildGlobalGitConfigFile(executor: ProcessExecutor): Promise<string | null> {
  let stdout: string;
  try {
    const result = await executor.run({
      argv: ['git', 'config', '--global', '--includes', '--list', '-z'],
      mode: 'pipe',
      cwd: NEUTRAL_CWD,
      timeout: GIT_CONFIG_TIMEOUT_MS,
    });
    if (!result.success || result.exitCode !== 0 || result.timedOut || result.truncated) {
      return null;
    }
    stdout = result.stdout;
  } catch {
    return null;
  }
  const file = renderGitConfigFile(parseGitConfigList(stdout));
  return file === '' ? null : file;
}

/**
 * The VM's `~/.gitconfig` with this PC's effective global config, or null when
 * there is nothing to send. Mode 0600, because the file can hold secrets.
 */
export async function buildGlobalGitConfigClaimFile(
  executor: ProcessExecutor,
  homePath: string,
): Promise<ProviderAuthClaimFile | null> {
  const content = await buildGlobalGitConfigFile(executor);
  if (content === null) return null;
  return {
    path: path.join(homePath, '.gitconfig'),
    contentBase64: Buffer.from(content, 'utf8').toString('base64'),
    mode: '0600',
  };
}

/**
 * The output, read back with `git config -f <file> --list -z`, yields the same
 * records — except `include.path` and `includeIf.<cond>.path`, which are
 * dropped because `--includes` already inlined their content.
 */
export function renderGitConfigFile(records: readonly GitConfigRecord[]): string {
  const lines: string[] = [];
  let header = '';
  for (const record of records) {
    const key = splitKey(record.key);
    if (!key || isIncludePath(key)) continue;
    const sectionHeader =
      key.subsection === null
        ? `[${key.section}]`
        : `[${key.section} "${escapeBackslashAndQuote(key.subsection)}"]`;
    // Only consecutive records share a header; order is never rearranged.
    if (sectionHeader !== header) {
      lines.push(sectionHeader);
      header = sectionHeader;
    }
    lines.push(
      record.value === null ? `\t${key.name}` : `\t${key.name} = "${escapeValue(record.value)}"`,
    );
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

interface GitConfigKey {
  section: string;
  subsection: string | null;
  name: string;
}

/**
 * Splits a `--list` key: the section runs to the first dot, the name starts
 * after the last dot, and a subsection keeps its case and inner dots. Git
 * lowercases sections and names, so only the subsection can carry capitals.
 */
function splitKey(key: string): GitConfigKey | null {
  const first = key.indexOf('.');
  if (first === -1) return null;
  const last = key.lastIndexOf('.');
  return {
    section: key.slice(0, first),
    subsection: last === first ? null : key.slice(first + 1, last),
    name: key.slice(last + 1),
  };
}

function isIncludePath(key: GitConfigKey): boolean {
  return (
    key.name.toLowerCase() === 'path' &&
    ['include', 'includeif'].includes(key.section.toLowerCase())
  );
}

function escapeBackslashAndQuote(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Inside git's double quotes these five escapes are the ones git unescapes. */
function escapeValue(value: string): string {
  return escapeBackslashAndQuote(value)
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/\x08/g, '\\b');
}

/**
 * `-z` gives one NUL-terminated record per key: `key\nvalue`, or a bare `key`
 * with no newline when the key has no value. A value may itself hold newlines,
 * so the split happens at the first one only.
 */
function parseGitConfigList(stdout: string): GitConfigRecord[] {
  const records: GitConfigRecord[] = [];
  for (const record of stdout.split('\0')) {
    if (record === '') continue;
    const newline = record.indexOf('\n');
    if (newline === -1) {
      records.push({ key: record, value: null });
    } else {
      records.push({ key: record.slice(0, newline), value: record.slice(newline + 1) });
    }
  }
  return records;
}
