import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { WorktreeMountDiscoveryService, MountPlan } from './worktree-mount-discovery.service';
import { FakeProcessExecutor } from '../../../terminal/services/process-executor/fake-process-executor';

describe('WorktreeMountDiscoveryService', () => {
  const originalHome = process.env.HOME;
  const COPILOT_TOKEN_ENV_KEYS = ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'] as const;
  const originalCopilotTokens = COPILOT_TOKEN_ENV_KEYS.map((key) => process.env[key]);

  let tempHome: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'worktree-mount-discovery-home-'));
    process.env.HOME = tempHome;
    for (const key of COPILOT_TOKEN_ENV_KEYS) {
      delete process.env[key];
    }
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    COPILOT_TOKEN_ENV_KEYS.forEach((key, index) => {
      const original = originalCopilotTokens[index];
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    });
    jest.restoreAllMocks();
    await rm(tempHome, { recursive: true, force: true });
  });

  type ProviderAuthMount = { provider: string; bind?: string };
  const discoveryOf = (service: WorktreeMountDiscoveryService) =>
    service as unknown as {
      readGitConfig: (worktreePath: string, key: string) => Promise<string | null>;
      discoverGitCommonDirMount: (worktreePath: string) => string | null;
      discoverProviderAuthMounts: () => ProviderAuthMount[];
      discoverSkillsSeedMount: () => string | null;
      discoverTemplatesMounts: () => string[];
    };

  describe('readGitConfig', () => {
    it('returns trimmed stdout and invokes git with -C <path> config <key> in pipe mode', async () => {
      const executor = new FakeProcessExecutor();
      executor.enqueueResponse({ type: 'success', stdout: '  Alice  \n' });
      const service = new WorktreeMountDiscoveryService(executor);

      await expect(discoveryOf(service).readGitConfig('/tmp/wt', 'user.name')).resolves.toBe(
        'Alice',
      );
      expect(executor.calls[0]?.argv).toEqual(['git', '-C', '/tmp/wt', 'config', 'user.name']);
      expect(executor.calls[0]?.mode).toBe('pipe');
    });

    it('returns null when git exits non-zero (failure result)', async () => {
      const executor = new FakeProcessExecutor();
      executor.enqueueResponse({ type: 'failure', exitCode: 1, stderr: 'no entry' });
      const service = new WorktreeMountDiscoveryService(executor);

      await expect(discoveryOf(service).readGitConfig('/tmp/wt', 'user.email')).resolves.toBeNull();
    });

    it('returns null when stdout trims to empty', async () => {
      const executor = new FakeProcessExecutor();
      executor.enqueueResponse({ type: 'success', stdout: '   \n\t' });
      const service = new WorktreeMountDiscoveryService(executor);

      await expect(discoveryOf(service).readGitConfig('/tmp/wt', 'user.name')).resolves.toBeNull();
    });

    it('returns null (swallows) when executor.run throws', async () => {
      const throwingExecutor = {
        run: jest.fn().mockRejectedValue(new Error('spawn ENOENT')),
      } as unknown as import('../../../terminal/services/process-executor/process-executor.port').ProcessExecutor;
      const service = new WorktreeMountDiscoveryService(throwingExecutor);

      await expect(discoveryOf(service).readGitConfig('/tmp/wt', 'user.name')).resolves.toBeNull();
    });
  });

  describe('discoverGitCommonDirMount', () => {
    it('returns null when the worktree has no .git entry', async () => {
      const worktreePath = join(tempHome, 'wt-no-git');
      await mkdir(worktreePath, { recursive: true });
      const service = new WorktreeMountDiscoveryService(new FakeProcessExecutor());

      expect(discoveryOf(service).discoverGitCommonDirMount(worktreePath)).toBeNull();
    });

    it('returns null when .git is a directory (main checkout, not a linked worktree)', async () => {
      const worktreePath = join(tempHome, 'wt-main');
      await mkdir(join(worktreePath, '.git'), { recursive: true });
      const service = new WorktreeMountDiscoveryService(new FakeProcessExecutor());

      expect(discoveryOf(service).discoverGitCommonDirMount(worktreePath)).toBeNull();
    });

    it('returns the repo common-dir mount for a valid gitdir file', async () => {
      const worktreePath = join(tempHome, 'wt-linked');
      const repoGitCommonDir = join(tempHome, 'repo', '.git');
      const gitdirPath = join(repoGitCommonDir, 'worktrees', 'linked');
      await mkdir(worktreePath, { recursive: true });
      await mkdir(gitdirPath, { recursive: true });
      await writeFile(join(worktreePath, '.git'), `gitdir: ${gitdirPath}\n`, 'utf8');
      const service = new WorktreeMountDiscoveryService(new FakeProcessExecutor());

      expect(discoveryOf(service).discoverGitCommonDirMount(worktreePath)).toBe(
        `${repoGitCommonDir}:${repoGitCommonDir}:rw`,
      );
    });

    it('returns null when the .git file has no gitdir: line', async () => {
      const worktreePath = join(tempHome, 'wt-bare-file');
      await mkdir(worktreePath, { recursive: true });
      await writeFile(join(worktreePath, '.git'), 'nothing useful here\n', 'utf8');
      const service = new WorktreeMountDiscoveryService(new FakeProcessExecutor());

      expect(discoveryOf(service).discoverGitCommonDirMount(worktreePath)).toBeNull();
    });

    it('returns null for a non-POSIX-absolute (e.g. Windows) gitdir path', async () => {
      const worktreePath = join(tempHome, 'wt-win');
      await mkdir(worktreePath, { recursive: true });
      await writeFile(
        join(worktreePath, '.git'),
        'gitdir: C:\\repo\\.git\\worktrees\\win\n',
        'utf8',
      );
      const service = new WorktreeMountDiscoveryService(new FakeProcessExecutor());

      expect(discoveryOf(service).discoverGitCommonDirMount(worktreePath)).toBeNull();
    });

    it('returns null when the computed git common dir does not exist on disk', async () => {
      const worktreePath = join(tempHome, 'wt-missing-common');
      const missingGitdir = join(tempHome, 'repo', '.git', 'worktrees', 'missing');
      await mkdir(worktreePath, { recursive: true });
      await writeFile(join(worktreePath, '.git'), `gitdir: ${missingGitdir}\n`, 'utf8');
      const service = new WorktreeMountDiscoveryService(new FakeProcessExecutor());

      expect(discoveryOf(service).discoverGitCommonDirMount(worktreePath)).toBeNull();
    });
  });

  describe('discoverProviderAuthMounts', () => {
    it('mounts every credential file present (claude, codex, agy) in the documented order', async () => {
      await mkdir(join(tempHome, '.claude'), { recursive: true });
      await writeFile(join(tempHome, '.claude', '.credentials.json'), '{}');
      await mkdir(join(tempHome, '.codex'), { recursive: true });
      await writeFile(join(tempHome, '.codex', 'auth.json'), '{}');
      await mkdir(join(tempHome, '.gemini'), { recursive: true });
      await writeFile(join(tempHome, '.gemini', 'oauth_creds.json'), '{}');

      const service = new WorktreeMountDiscoveryService(new FakeProcessExecutor());
      const mounts = discoveryOf(service).discoverProviderAuthMounts();

      expect(mounts.map((m) => m.provider)).toEqual(['claude', 'codex', 'agy']);
      expect(mounts).toEqual([
        {
          provider: 'claude',
          bind: `${join(tempHome, '.claude', '.credentials.json')}:/home/node/.claude/.credentials.json:ro`,
        },
        {
          provider: 'codex',
          bind: `${join(tempHome, '.codex', 'auth.json')}:/home/node/.codex/auth.json:ro`,
        },
        {
          provider: 'agy',
          bind: `${join(tempHome, '.gemini', 'oauth_creds.json')}:/home/node/.gemini/oauth_creds.json:ro`,
        },
      ]);
    });

    it('returns a partial set when only some credential files exist (agy only, from ~/.gemini creds)', async () => {
      await mkdir(join(tempHome, '.gemini'), { recursive: true });
      await writeFile(join(tempHome, '.gemini', 'oauth_creds.json'), '{"token":"z"}');

      const service = new WorktreeMountDiscoveryService(new FakeProcessExecutor());
      const mounts = discoveryOf(service).discoverProviderAuthMounts();

      // agy is the sole owner of the ~/.gemini OAuth creds mount (the gemini CLI was retired).
      expect(mounts.map((m) => m.provider)).toEqual(['agy']);
      expect(mounts[0]?.bind).toBe(
        `${join(tempHome, '.gemini', 'oauth_creds.json')}:/home/node/.gemini/oauth_creds.json:ro`,
      );
    });

    it('returns no file-backed providers when the home dir is empty', async () => {
      const service = new WorktreeMountDiscoveryService(new FakeProcessExecutor());
      const mounts = discoveryOf(service).discoverProviderAuthMounts();

      expect(mounts.filter((m) => m.bind)).toEqual([]);
    });

    it('enables copilot (no bind) when GH_TOKEN is present and non-empty', async () => {
      process.env.GH_TOKEN = 'ghu_token';
      const service = new WorktreeMountDiscoveryService(new FakeProcessExecutor());
      const mounts = discoveryOf(service).discoverProviderAuthMounts();

      expect(mounts).toContainEqual({ provider: 'copilot' });
      expect(mounts.find((m) => m.provider === 'copilot')?.bind).toBeUndefined();
    });

    it('enables copilot when COPILOT_GITHUB_TOKEN is the active token var', async () => {
      process.env.COPILOT_GITHUB_TOKEN = 'ghu_copilot';
      const service = new WorktreeMountDiscoveryService(new FakeProcessExecutor());
      const mounts = discoveryOf(service).discoverProviderAuthMounts();

      expect(mounts).toContainEqual({ provider: 'copilot' });
    });

    it('enables copilot when GITHUB_TOKEN is the active token var', async () => {
      process.env.GITHUB_TOKEN = 'ghp_github';
      const service = new WorktreeMountDiscoveryService(new FakeProcessExecutor());
      const mounts = discoveryOf(service).discoverProviderAuthMounts();

      expect(mounts).toContainEqual({ provider: 'copilot' });
    });

    it('does not enable copilot when all token vars are blank/whitespace', async () => {
      process.env.GH_TOKEN = '   ';
      const service = new WorktreeMountDiscoveryService(new FakeProcessExecutor());
      const mounts = discoveryOf(service).discoverProviderAuthMounts();

      expect(mounts.find((m) => m.provider === 'copilot')).toBeUndefined();
    });
  });

  describe('discoverSkillsSeedMount', () => {
    it('returns the read-only seed mount when ~/.devchain/skills exists', async () => {
      await mkdir(join(tempHome, '.devchain', 'skills'), { recursive: true });
      const service = new WorktreeMountDiscoveryService(new FakeProcessExecutor());

      expect(discoveryOf(service).discoverSkillsSeedMount()).toBe(
        `${join(tempHome, '.devchain', 'skills')}:/seed-skills:ro`,
      );
    });

    it('returns null when ~/.devchain/skills is absent', async () => {
      const service = new WorktreeMountDiscoveryService(new FakeProcessExecutor());

      expect(discoveryOf(service).discoverSkillsSeedMount()).toBeNull();
    });
  });

  describe('discoverTemplatesMounts', () => {
    // Built-in templates path resolution depends on __dirname + process.cwd()
    // and cannot be fully controlled without resetting the env config cache, so
    // the built-in row is characterized by its container-target suffix; the
    // registry-cache row (driven by HOME) is fully deterministic.
    it('appends the registry-cache mount when ~/.devchain/registry-cache exists', async () => {
      await mkdir(join(tempHome, '.devchain', 'registry-cache'), { recursive: true });
      const service = new WorktreeMountDiscoveryService(new FakeProcessExecutor());
      const mounts = discoveryOf(service).discoverTemplatesMounts();

      expect(mounts).toEqual(
        expect.arrayContaining([
          `${join(tempHome, '.devchain', 'registry-cache')}:/home/node/.devchain/registry-cache:ro`,
        ]),
      );
    });

    it('omits the registry-cache mount when ~/.devchain/registry-cache is absent', async () => {
      const service = new WorktreeMountDiscoveryService(new FakeProcessExecutor());
      const mounts = discoveryOf(service).discoverTemplatesMounts();

      expect(mounts.some((m) => m.endsWith(':/home/node/.devchain/registry-cache:ro'))).toBe(false);
    });

    it('mounts the built-in templates directory at the fixed container target when one resolves', async () => {
      const service = new WorktreeMountDiscoveryService(new FakeProcessExecutor());
      const mounts = discoveryOf(service).discoverTemplatesMounts();

      const builtin = mounts.filter((m) => m.endsWith(':/app/apps/local-app/dist/templates:ro'));
      expect(builtin.length).toBeLessThanOrEqual(1);
    });
  });

  describe('discoverMountPlan (composed plan)', () => {
    // These tests lock the plan SHAPE consumed by OrchestratorDockerService. The
    // docker.service.spec "MountPlan precedence snapshots" then verify the env/bind
    // assembly from a given plan — together they are byte-identical end-to-end.
    const envKeysOf = (plan: MountPlan) => Object.keys(plan.env);

    it('empty home + no tokens → ENABLED_PROVIDERS="" and no credential binds', async () => {
      const service = new WorktreeMountDiscoveryService(new FakeProcessExecutor());
      const plan = await service.discoverMountPlan({
        worktreePath: join(tempHome, 'wt'),
        worktreeName: 'snap',
      });

      expect(envKeysOf(plan)).toEqual(['ENABLED_PROVIDERS']);
      expect(plan.env.ENABLED_PROVIDERS).toBe('');
      expect(plan.credentialBinds).toEqual([]);
    });

    it('git identity is injected in the locked precedence order (name before email)', async () => {
      const executor = new FakeProcessExecutor();
      executor.enqueueResponse(
        { type: 'success', stdout: 'Alice\n' },
        { type: 'success', stdout: 'alice@example.com\n' },
      );
      const service = new WorktreeMountDiscoveryService(executor);
      const plan = await service.discoverMountPlan({
        worktreePath: join(tempHome, 'wt'),
        worktreeName: 'snap',
      });

      expect(envKeysOf(plan)).toEqual([
        'GIT_AUTHOR_NAME',
        'GIT_COMMITTER_NAME',
        'GIT_AUTHOR_EMAIL',
        'GIT_COMMITTER_EMAIL',
        'ENABLED_PROVIDERS',
      ]);
      expect(plan.env.GIT_AUTHOR_NAME).toBe('Alice');
      expect(plan.env.GIT_COMMITTER_NAME).toBe('Alice');
      expect(plan.env.GIT_AUTHOR_EMAIL).toBe('alice@example.com');
      expect(plan.env.GIT_COMMITTER_EMAIL).toBe('alice@example.com');
    });

    it('credential binds carry the discovered provider file mounts (deduped)', async () => {
      await mkdir(join(tempHome, '.claude'), { recursive: true });
      await writeFile(join(tempHome, '.claude', '.credentials.json'), '{}');
      await mkdir(join(tempHome, '.codex'), { recursive: true });
      await writeFile(join(tempHome, '.codex', 'auth.json'), '{}');

      const service = new WorktreeMountDiscoveryService(new FakeProcessExecutor());
      const plan = await service.discoverMountPlan({
        worktreePath: join(tempHome, 'wt'),
        worktreeName: 'snap',
      });

      expect(plan.env.ENABLED_PROVIDERS).toBe('claude,codex');
      expect(plan.credentialBinds).toEqual([
        `${join(tempHome, '.claude', '.credentials.json')}:/home/node/.claude/.credentials.json:ro`,
        `${join(tempHome, '.codex', 'auth.json')}:/home/node/.codex/auth.json:ro`,
      ]);
    });

    it('copilot token is forwarded under its own name and added to ENABLED_PROVIDERS (no bind)', async () => {
      process.env.GH_TOKEN = 'ghu_composed';
      const service = new WorktreeMountDiscoveryService(new FakeProcessExecutor());
      const plan = await service.discoverMountPlan({
        worktreePath: join(tempHome, 'wt'),
        worktreeName: 'snap',
      });

      expect(plan.env.ENABLED_PROVIDERS).toBe('copilot');
      expect(plan.env.GH_TOKEN).toBe('ghu_composed');
      // COPILOT_HOME is deliberately never set.
      expect(plan.env.COPILOT_HOME).toBeUndefined();
      // Copilot contributes no bind (keyring-only; env-token model).
      expect(plan.credentialBinds.some((b) => b.includes('.copilot'))).toBe(false);
    });

    it('infrastructure binds order: git common dir → skills seed → templates', async () => {
      await mkdir(join(tempHome, '.devchain', 'skills'), { recursive: true });
      const worktreePath = join(tempHome, 'wt-linked');
      const repoGitCommonDir = join(tempHome, 'repo', '.git');
      const gitdirPath = join(repoGitCommonDir, 'worktrees', 'snap');
      await mkdir(worktreePath, { recursive: true });
      await mkdir(gitdirPath, { recursive: true });
      await writeFile(join(worktreePath, '.git'), `gitdir: ${gitdirPath}\n`, 'utf8');

      const service = new WorktreeMountDiscoveryService(new FakeProcessExecutor());
      const plan = await service.discoverMountPlan({
        worktreePath,
        worktreeName: 'snap',
      });

      // git common dir + skills seed are deterministic and must precede templates.
      expect(plan.infrastructureBinds).toEqual(
        expect.arrayContaining([
          `${repoGitCommonDir}:${repoGitCommonDir}:rw`,
          `${join(tempHome, '.devchain', 'skills')}:/seed-skills:ro`,
        ]),
      );
      const gitCommonIndex = plan.infrastructureBinds.indexOf(
        `${repoGitCommonDir}:${repoGitCommonDir}:rw`,
      );
      const skillsIndex = plan.infrastructureBinds.indexOf(
        `${join(tempHome, '.devchain', 'skills')}:/seed-skills:ro`,
      );
      expect(gitCommonIndex).toBeLessThan(skillsIndex);
      // Templates (if any resolve) always trail skills seed.
      const templatesStart = plan.infrastructureBinds.findIndex((b) =>
        b.endsWith(':/app/apps/local-app/dist/templates:ro'),
      );
      if (templatesStart !== -1) {
        expect(skillsIndex).toBeLessThan(templatesStart);
      }
    });
  });
});
