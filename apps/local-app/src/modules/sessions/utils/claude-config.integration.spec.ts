jest.mock('os', () => {
  const actualOs = jest.requireActual('os');
  return {
    ...actualOs,
    homedir: jest.fn(),
  };
});

import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'fs/promises';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { lock } from 'proper-lockfile';
import { disableClaudeAutoCompact, ensureClaudeProjectTrusted } from './claude-config';

const mockHomedir = homedir as jest.MockedFunction<typeof homedir>;

/**
 * Real-filesystem coverage for the ~/.claude.json mutation path: the
 * proper-lockfile directory lock, atomic rename, and realpath identity
 * resolution cannot be proven with mocked fs calls.
 */
describe('claude-config integration', () => {
  let homeDir: string;
  let configPath: string;
  let projectRoot: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'claude-config-home-'));
    configPath = join(homeDir, '.claude.json');
    projectRoot = await mkdtemp(join(tmpdir(), 'claude-config-project-'));
    mockHomedir.mockReturnValue(homeDir);
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });

  function readConfig(): Promise<Record<string, unknown>> {
    return readFile(configPath, 'utf-8').then((raw) => JSON.parse(raw));
  }

  describe('external lock holder', () => {
    it('blocks trust writes until the external holder releases the lock', async () => {
      const release = await lock(configPath, { realpath: false });

      let settled = false;
      const pending = ensureClaudeProjectTrusted(projectRoot).then((result) => {
        settled = true;
        return result;
      });

      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(settled).toBe(false);
      await expect(readFile(configPath, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });

      await release();
      const result = await pending;

      expect(result).toEqual({ success: true });
      const config = await readConfig();
      expect(config.projects).toEqual({
        [projectRoot]: { hasTrustDialogAccepted: true },
      });
    }, 20_000);

    it('blocks auto-compact writes until the external holder releases the lock', async () => {
      await writeFile(configPath, JSON.stringify({ theme: 'dark' }), { mode: 0o600 });
      const release = await lock(configPath, { realpath: false });

      let settled = false;
      const pending = disableClaudeAutoCompact().then((result) => {
        settled = true;
        return result;
      });

      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(settled).toBe(false);
      expect(JSON.parse(await readFile(configPath, 'utf-8'))).toEqual({ theme: 'dark' });

      await release();
      const result = await pending;

      expect(result).toEqual({ success: true });
      expect(await readConfig()).toEqual({ theme: 'dark', autoCompactEnabled: false });
    }, 20_000);
  });

  describe('project roots', () => {
    it('records trust for an ordinary root and performs no write when already trusted', async () => {
      const first = await ensureClaudeProjectTrusted(projectRoot);
      expect(first).toEqual({ success: true });

      const config = await readConfig();
      expect(config.projects).toEqual({ [projectRoot]: { hasTrustDialogAccepted: true } });
      expect((await stat(configPath)).mode & 0o777).toBe(0o600);

      const before = await stat(configPath);
      const second = await ensureClaudeProjectTrusted(projectRoot);
      expect(second).toEqual({ success: true });
      const after = await stat(configPath);
      expect(after.mtimeMs).toBe(before.mtimeMs);
    });

    it('records both identities for a symlinked root and fills only the missing one', async () => {
      const linkPath = join(homeDir, 'project-link');
      await symlink(projectRoot, linkPath);
      const physicalRoot = await realpath(projectRoot);

      const first = await ensureClaudeProjectTrusted(linkPath);
      expect(first).toEqual({ success: true });
      expect((await readConfig()).projects).toEqual({
        [linkPath]: { hasTrustDialogAccepted: true },
        [physicalRoot]: { hasTrustDialogAccepted: true },
      });

      // One-of-two pre-trusted state: registered identity trusted, physical missing.
      await rm(configPath, { force: true });
      await writeFile(
        configPath,
        JSON.stringify({
          projects: { [linkPath]: { hasTrustDialogAccepted: true, history: ['keep'] } },
        }),
        { mode: 0o600 },
      );

      const second = await ensureClaudeProjectTrusted(linkPath);
      expect(second).toEqual({ success: true });
      expect((await readConfig()).projects).toEqual({
        [linkPath]: { hasTrustDialogAccepted: true, history: ['keep'] },
        [physicalRoot]: { hasTrustDialogAccepted: true },
      });
    });

    it('records trust for a Git-worktree root as an ordinary exact root', async () => {
      const worktreeRoot = await mkdtemp(join(tmpdir(), 'claude-config-worktree-'));
      try {
        await mkdir(join(projectRoot, '.git', 'worktrees', 'wt-1'), { recursive: true });
        await writeFile(
          join(worktreeRoot, '.git'),
          `gitdir: ${join(projectRoot, '.git', 'worktrees', 'wt-1')}\n`,
        );

        const result = await ensureClaudeProjectTrusted(worktreeRoot);

        expect(result).toEqual({ success: true });
        expect((await readConfig()).projects).toEqual({
          [worktreeRoot]: { hasTrustDialogAccepted: true },
        });
      } finally {
        await rm(worktreeRoot, { recursive: true, force: true });
      }
    });

    it('preserves unrelated top-level keys and sibling projects end to end', async () => {
      const existing = {
        autoCompactEnabled: true,
        theme: 'dark',
        projects: {
          '/unrelated/project': { hasTrustDialogAccepted: false, allowedTools: ['bash'] },
        },
      };
      await writeFile(configPath, JSON.stringify(existing), { mode: 0o600 });

      const result = await ensureClaudeProjectTrusted(projectRoot);

      expect(result).toEqual({ success: true });
      expect(await readConfig()).toEqual({
        ...existing,
        projects: {
          '/unrelated/project': { hasTrustDialogAccepted: false, allowedTools: ['bash'] },
          [projectRoot]: { hasTrustDialogAccepted: true },
        },
      });
    });

    it('returns invalid_config and preserves a malformed config file', async () => {
      await writeFile(configPath, '{ not valid json', { mode: 0o600 });

      const result = await ensureClaudeProjectTrusted(projectRoot);

      expect(result.success).toBe(false);
      expect(result.errorType).toBe('invalid_config');
      expect(await readFile(configPath, 'utf-8')).toBe('{ not valid json');
    });

    it('returns invalid_config and preserves the file when an unrelated sibling record is malformed', async () => {
      const raw = JSON.stringify({
        theme: 'dark',
        projects: {
          '/unrelated/project': 'not-an-object',
        },
      });
      await writeFile(configPath, raw, { mode: 0o600 });

      const result = await ensureClaudeProjectTrusted(projectRoot);

      expect(result.success).toBe(false);
      expect(result.errorType).toBe('invalid_config');
      expect(await readFile(configPath, 'utf-8')).toBe(raw);
      // No abandoned temporary file or lock directory may remain behind.
      const leftovers = (await readdir(homeDir)).filter(
        (entry) => entry !== '.claude.json' && !entry.startsWith('project-link'),
      );
      expect(leftovers).toEqual([]);
    });
  });
});
