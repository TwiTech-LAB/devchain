import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  buildGlobalGitConfigFile,
  renderGitConfigFile,
  type GitConfigRecord,
} from './git-global-config';
import { FakeProcessExecutor } from '../../terminal/services/process-executor/fake-process-executor';
import type { ProcessExecutorOptions } from '../../terminal/services/process-executor/process-executor.port';

const exec = promisify(execFile);

/**
 * Round-trips through git itself: git's own parser is the authority on config
 * file syntax, so the renderer is proven by reading the file back with
 * `git config -f <file> --list -z` — the same listing format the builder reads.
 */
async function readBackWithGit(content: string): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), 'devchain-gitconfig-'));
  try {
    const file = join(dir, 'gitconfig');
    await writeFile(file, content, 'utf8');
    const { stdout } = await exec('git', ['config', '-f', file, '--list', '-z']);
    return stdout.split('\0').filter((record) => record !== '');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function parseRecords(records: readonly string[]): GitConfigRecord[] {
  return records.map((record) => {
    const newline = record.indexOf('\n');
    return newline === -1
      ? { key: record, value: null }
      : { key: record.slice(0, newline), value: record.slice(newline + 1) };
  });
}

/** Keys mirror git's `--list -z` form: lowercase section and name, cased subsection. */
const ROUND_TRIP_RECORDS: GitConfigRecord[] = [
  { key: 'user.name', value: 'Alice Example' },
  { key: 'user.email', value: 'alice@example.com' },
  { key: 'user.empty', value: '' },
  { key: 'core.sshcommand', value: null },
  { key: 'user.multiline', value: 'first line\nsecond line' },
  { key: 'user.tabbed', value: 'left\tright' },
  { key: 'user.backspaced', value: 'left\x08right' },
  { key: 'user.quoted', value: 'say "hi"' },
  { key: 'user.backslashed', value: 'C:\\Users\\alice' },
  { key: 'user.hash', value: 'value # not a comment' },
  { key: 'user.semicolon', value: 'value ; not a comment' },
  { key: 'alias.remote-sync', value: 'push' },
  { key: 'alias.remote-sync', value: 'fetch --prune' },
  { key: 'url.ssh://git@example.com:2222/~/mine.git.insteadof', value: 'https://example.com' },
  { key: 'http.Example"Proxy/.sslverify', value: 'false' },
];

describe('renderGitConfigFile read back by git', () => {
  it('reproduces every record, apart from dropped include records', async () => {
    const content = renderGitConfigFile([
      ...ROUND_TRIP_RECORDS,
      { key: 'include.path', value: '~/.gitconfig-work' },
      { key: 'includeif.gitdir:~/work/.path', value: '~/.gitconfig-work' },
      { key: 'includeif.onbranch.main.path', value: '~/.gitconfig-branch' },
    ]);

    const readBack = parseRecords(await readBackWithGit(content));
    expect(readBack).toEqual(ROUND_TRIP_RECORDS);
  });

  it('groups consecutive records under one section header without reordering', () => {
    expect(renderGitConfigFile(ROUND_TRIP_RECORDS.slice(0, 2))).toBe(
      '[user]\n\tname = "Alice Example"\n\temail = "alice@example.com"\n',
    );
  });

  it('renders an empty record set as an empty file', () => {
    expect(renderGitConfigFile([])).toBe('');
  });
});

describe('buildGlobalGitConfigFile', () => {
  it('reads the effective global list outside any repository', async () => {
    const executor = new FakeProcessExecutor();
    executor.setDefaultResponse({ type: 'success', stdout: '' });

    await buildGlobalGitConfigFile(executor);

    expect(executor.calls).toEqual([
      {
        argv: ['git', 'config', '--global', '--includes', '--list', '-z'],
        mode: 'pipe',
        cwd: '/',
        env: undefined,
        outputLimits: undefined,
      },
    ] satisfies ProcessExecutorOptions[]);
  });

  it.each([
    ['a failed read', { type: 'failure' as const, exitCode: 1 }],
    ['a timed-out read', { type: 'timeout' as const }],
  ])('returns null on %s', async (_label, response) => {
    const executor = new FakeProcessExecutor();
    executor.setDefaultResponse(response);

    await expect(buildGlobalGitConfigFile(executor)).resolves.toBeNull();
  });

  it('returns null when the global config is empty', async () => {
    const executor = new FakeProcessExecutor();
    executor.setDefaultResponse({ type: 'success', stdout: '' });

    await expect(buildGlobalGitConfigFile(executor)).resolves.toBeNull();
  });

  it('renders a valueless key as a bare key line, never as an empty value', async () => {
    const executor = new FakeProcessExecutor();
    executor.setDefaultResponse({
      type: 'success',
      stdout: 'core.sshcommand\0user.name\nAlice Example\0',
    });

    await expect(buildGlobalGitConfigFile(executor)).resolves.toBe(
      '[core]\n\tsshcommand\n[user]\n\tname = "Alice Example"\n',
    );
  });
});
