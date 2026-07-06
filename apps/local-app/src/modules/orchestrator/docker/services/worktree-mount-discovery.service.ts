import { Injectable } from '@nestjs/common';
import { existsSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, posix } from 'path';
import { createLogger } from '../../../../common/logging/logger';
import { resolveTemplatesDirectory } from '../../../../common/templates-directory';
import { ProcessExecutor } from '../../../terminal/services/process-executor/process-executor.port';

const logger = createLogger('WorktreeMountDiscoveryService');

const DEFAULT_CONTAINER_HOME_PATH = '/home/node';
const DEFAULT_CONTAINER_SKILLS_SEED_PATH = '/seed-skills';
const DEFAULT_CONTAINER_TEMPLATES_PATH = '/app/apps/local-app/dist/templates';
const DEFAULT_CONTAINER_REGISTRY_CACHE_PATH = `${DEFAULT_CONTAINER_HOME_PATH}/.devchain/registry-cache`;

// GitHub Copilot auth tokens, in copilot's documented precedence order (spike S1,
// epic 3be9ec57). Unlike claude/codex/agy — which store a plaintext credential
// FILE that we mount read-only — copilot keeps its host credential in the OS keyring,
// so there is NO file to mount. The containerized `copilot` CLI must instead receive a
// token via env; we forward whichever of these the orchestrator has set.
const COPILOT_TOKEN_ENV_KEYS = ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'] as const;

interface ProviderAuthMount {
  provider: string;
  /**
   * Host→container bind string (`src:dst:ro`). Omitted for providers that are
   * enabled but have no mountable credential file (e.g. copilot authenticates via
   * a forwarded token env var, not a file — see COPILOT_TOKEN_ENV_KEYS).
   */
  bind?: string;
}

/**
 * Declarative mount + env plan produced by infrastructure discovery. The docker
 * service consumes this without knowing how the entries were derived.
 *
 * Bind positioning is fixed by the consumer (`OrchestratorDockerService.buildBindMounts`):
 * `credentialBinds` slot in between the data mount and any caller `additionalBinds`;
 * `infrastructureBinds` are appended after the docker socket mount. This split
 * preserves the byte-identical bind order locked by the MountPlan precedence
 * snapshots (see docs/worktree-runtime-matrix.md).
 *
 * `env` entries are merged into the container env via `??=` semantics — an
 * explicit caller/user value always wins. Key insertion order is the precedence
 * order (git identity → ENABLED_PROVIDERS → copilot tokens).
 */
export interface MountPlan {
  readonly env: Readonly<Record<string, string>>;
  readonly credentialBinds: readonly string[];
  readonly infrastructureBinds: readonly string[];
}

@Injectable()
export class WorktreeMountDiscoveryService {
  constructor(private readonly executor: ProcessExecutor) {}

  /**
   * Resolve all discovery-derived env entries and bind mounts for a worktree
   * container. Pure function of the host filesystem, the orchestrator process
   * env, and the worktree's git config — no Docker calls.
   */
  async discoverMountPlan(input: {
    worktreePath: string;
    worktreeName: string;
  }): Promise<MountPlan> {
    const env: Record<string, string> = {};

    // Resolve host git identity so commits made in the container attribute back
    // to the host user. An explicit caller/user value is never clobbered — the
    // merge in OrchestratorDockerService.buildEnvMap applies these via ??=.
    const gitUserName = await this.readGitConfig(input.worktreePath, 'user.name');
    const gitUserEmail = await this.readGitConfig(input.worktreePath, 'user.email');
    if (gitUserName) {
      env.GIT_AUTHOR_NAME = gitUserName;
      env.GIT_COMMITTER_NAME = gitUserName;
    }
    if (gitUserEmail) {
      env.GIT_AUTHOR_EMAIL = gitUserEmail;
      env.GIT_COMMITTER_EMAIL = gitUserEmail;
    }

    const authMounts = this.discoverProviderAuthMounts();
    env.ENABLED_PROVIDERS = authMounts.map((mount) => mount.provider).join(',');

    // Forward the GitHub Copilot token(s) so the containerized `copilot` CLI can
    // authenticate — it cannot reach the host OS keyring where copilot stores its
    // credential (spike S1). Each set var is passed through under its own name so
    // the CLI applies its own precedence; an explicit caller/user value is never
    // clobbered (??= at merge time).
    // NOTE: COPILOT_HOME is deliberately NOT set (R4 preflight-rejects a relocated store).
    for (const key of COPILOT_TOKEN_ENV_KEYS) {
      const value = process.env[key];
      if (value && value.trim().length > 0) {
        env[key] = value;
      }
    }

    const credentialBinds = [
      // De-dupe bind strings before mounting: agy is now the SOLE owner of the
      // ~/.gemini/oauth_creds.json mount (the gemini CLI was retired), so this Set normally
      // passes a single element through. It is retained as a safeguard against any future
      // provider sharing a credential target — Docker rejects duplicate mount targets.
      // Mountless providers (copilot) contribute no bind — they are enabled via a
      // forwarded token env var, not a file mount.
      ...new Set(
        authMounts.map((mount) => mount.bind).filter((bind): bind is string => Boolean(bind)),
      ),
    ];

    const infrastructureBinds: string[] = [];
    const gitCommonDirMount = this.discoverGitCommonDirMount(input.worktreePath);
    if (gitCommonDirMount) {
      infrastructureBinds.push(gitCommonDirMount);
    }
    const skillsSeedMount = this.discoverSkillsSeedMount();
    if (skillsSeedMount) {
      infrastructureBinds.push(skillsSeedMount);
    }
    infrastructureBinds.push(...this.discoverTemplatesMounts());

    return { env, credentialBinds, infrastructureBinds };
  }

  private async readGitConfig(worktreePath: string, key: string): Promise<string | null> {
    try {
      const result = await this.executor.run({
        argv: ['git', '-C', worktreePath, 'config', key],
        mode: 'pipe',
      });
      return result.success ? result.stdout.trim() || null : null;
    } catch {
      return null;
    }
  }

  private discoverGitCommonDirMount(worktreePath: string): string | null {
    const gitPath = join(worktreePath, '.git');
    if (!existsSync(gitPath)) {
      return null;
    }

    let gitPathStats: ReturnType<typeof statSync>;
    try {
      gitPathStats = statSync(gitPath);
    } catch (error) {
      logger.warn({ error, gitPath }, 'Failed to stat .git path while resolving bind mounts');
      return null;
    }

    if (gitPathStats.isDirectory()) {
      return null;
    }
    if (!gitPathStats.isFile()) {
      logger.warn({ gitPath }, 'Skipping git metadata mount: .git is not a file or directory');
      return null;
    }

    let gitdirPath: string | null = null;
    try {
      const gitFileContents = readFileSync(gitPath, 'utf8');
      const gitdirLine = gitFileContents
        .split(/\r?\n/)
        .find((line) => line.trimStart().toLowerCase().startsWith('gitdir:'));
      if (gitdirLine) {
        gitdirPath = gitdirLine.slice(gitdirLine.indexOf(':') + 1).trim();
      }
    } catch (error) {
      logger.warn({ error, gitPath }, 'Failed to read .git file while resolving bind mounts');
      return null;
    }

    if (!gitdirPath) {
      logger.warn({ gitPath }, 'Skipping git metadata mount: .git file missing gitdir entry');
      return null;
    }
    if (!posix.isAbsolute(gitdirPath)) {
      logger.warn(
        { gitPath, gitdirPath },
        'Skipping git metadata mount: gitdir path is not POSIX-absolute',
      );
      return null;
    }

    const repoGitCommonDir = dirname(dirname(gitdirPath));
    try {
      const commonDirStats = statSync(repoGitCommonDir);
      if (!commonDirStats.isDirectory()) {
        logger.warn(
          { gitPath, gitdirPath, repoGitCommonDir },
          'Skipping git metadata mount: computed git common dir is not a directory',
        );
        return null;
      }
    } catch (error) {
      logger.warn(
        { error, gitPath, gitdirPath, repoGitCommonDir },
        'Skipping git metadata mount: computed git common dir does not exist',
      );
      return null;
    }

    return `${repoGitCommonDir}:${repoGitCommonDir}:rw`;
  }

  private discoverProviderAuthMounts(): ProviderAuthMount[] {
    const home = this.getHostHomeDir();
    const providers = [
      {
        provider: 'claude',
        source: join(home, '.claude', '.credentials.json'),
        target: `${DEFAULT_CONTAINER_HOME_PATH}/.claude/.credentials.json`,
      },
      {
        provider: 'codex',
        source: join(home, '.codex', 'auth.json'),
        target: `${DEFAULT_CONTAINER_HOME_PATH}/.codex/auth.json`,
      },
      {
        // agy (Antigravity CLI) authenticates via the OAuth creds stored under ~/.gemini.
        // The shared ~/.gemini home dir is retained after the gemini CLI was retired; agy is
        // now the sole owner of this mount target.
        provider: 'agy',
        source: join(home, '.gemini', 'oauth_creds.json'),
        target: `${DEFAULT_CONTAINER_HOME_PATH}/.gemini/oauth_creds.json`,
      },
    ];

    const mounts: ProviderAuthMount[] = providers
      .filter((provider) => existsSync(provider.source))
      .map((provider) => ({
        provider: provider.provider,
        bind: `${provider.source}:${provider.target}:ro`,
      }));

    // Copilot has no mountable credential file (keyring-only; spike S1). Enable it for
    // the container — so it lands in ENABLED_PROVIDERS and the in-container preflight
    // validates it — whenever a forwardable token is present. No bind: session-state is
    // written to the container's own writable ~/.copilot and read there by the co-located
    // session-reader, so no host mount of ~/.copilot is needed (auth-only, env-token model).
    if (COPILOT_TOKEN_ENV_KEYS.some((key) => (process.env[key] ?? '').trim().length > 0)) {
      mounts.push({ provider: 'copilot' });
    }

    return mounts;
  }

  private discoverSkillsSeedMount(): string | null {
    const hostSkillsPath = join(this.getHostHomeDir(), '.devchain', 'skills');
    if (!existsSync(hostSkillsPath)) {
      return null;
    }
    return `${hostSkillsPath}:${DEFAULT_CONTAINER_SKILLS_SEED_PATH}:ro`;
  }

  private discoverTemplatesMounts(): string[] {
    const mounts: string[] = [];

    // Built-in templates directory
    const hostTemplatesDir = resolveTemplatesDirectory(__dirname);
    if (hostTemplatesDir) {
      mounts.push(`${hostTemplatesDir}:${DEFAULT_CONTAINER_TEMPLATES_PATH}:ro`);
    }

    // Registry-cached templates (nested mount inside the dataPath → ~/.devchain bind)
    const hostRegistryCache = join(this.getHostHomeDir(), '.devchain', 'registry-cache');
    if (existsSync(hostRegistryCache)) {
      mounts.push(`${hostRegistryCache}:${DEFAULT_CONTAINER_REGISTRY_CACHE_PATH}:ro`);
    }

    return mounts;
  }

  private getHostHomeDir(): string {
    return process.env.HOME?.trim() || homedir();
  }
}
