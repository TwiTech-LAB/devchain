import { Inject, Injectable } from '@nestjs/common';
import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '../../../common/logging/logger';
import { FileSyncService } from '../../file-sync/file-sync.service';
import {
  STORAGE_SERVICE,
  type ProjectStorage,
  type RemoteStorage,
} from '../../storage/interfaces/storage.interface';
import { ProcessExecutor } from '../../terminal/services/process-executor/process-executor.port';
import { quoteShellArg } from '../../terminal/services/terminal-io/quote-shell-arg';
import { internalGitEnv } from '../git-coordinator/git-checkpoint';
import { GitCoordinatorStore } from '../git-coordinator/git-coordinator.store';
import { GitOwnerStore } from '../git-owner.store';

const logger = createLogger('GitShimRegistry');
export const GIT_SHIM_HOME = Symbol('GIT_SHIM_HOME');
export const GIT_SHIM_REFRESH_MS = Symbol('GIT_SHIM_REFRESH_MS');
/** Whether this instance is a claimed VM; read on each refresh, because a claim can come later. */
export const GIT_SHIM_ON_VM = Symbol('GIT_SHIM_ON_VM');
const PROJECTS_FILE = 'projects.sh';

interface ShimProject {
  projectId: string;
  side: 'home' | 'vm';
  commonDir: string;
  remoteName: string;
  owner: string;
  generation: number;
}

/**
 * Writes the files the git shim reads: `projects.sh`, a sourced `case` on each connected
 * project's Git common dir, and one `state/<projectId>` line with the owner and generation.
 * On the PC, connected means bound to a VM; on a VM, every project with a Git sync folder.
 * Both are replaced atomically. A Git older than 2.31 gets no project list, so the shim runs
 * real Git everywhere. See docs/git-coordinator.md (Git shim).
 */
@Injectable()
export class GitShimRegistryService implements OnApplicationBootstrap, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private gitSupported?: boolean;

  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: ProjectStorage & RemoteStorage,
    private readonly files: FileSyncService,
    private readonly owners: GitOwnerStore,
    private readonly coordinator: GitCoordinatorStore,
    private readonly executor: ProcessExecutor,
    @Inject(GIT_SHIM_HOME) private readonly home: string,
    @Inject(GIT_SHIM_REFRESH_MS) private readonly refreshMs: number,
    @Inject(GIT_SHIM_ON_VM) private readonly onVm: () => boolean,
  ) {}

  /** A zero interval turns the registry off. */
  onApplicationBootstrap(): void {
    if (this.refreshMs <= 0) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.refreshMs);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    await this.running;
  }

  /** Never overlaps itself; a failed read keeps the files as they were. */
  refresh(): Promise<void> {
    this.running ??= this.write()
      .catch((error: unknown) => logger.warn({ error }, 'Git shim project list not refreshed'))
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }

  private async write(): Promise<void> {
    const projects = (await this.supportsShim()) ? await this.projects() : [];
    await mkdir(join(this.home, 'state'), { recursive: true });
    for (const project of projects)
      await this.replace(
        join(this.home, 'state', project.projectId),
        `${project.owner} ${project.generation}\n`,
      );
    await this.replace(join(this.home, PROJECTS_FILE), this.render(projects));
    const kept = new Set(projects.map((project) => project.projectId));
    for (const name of await readdir(join(this.home, 'state')))
      if (!kept.has(name)) await rm(join(this.home, 'state', name), { force: true });
  }

  private async projects(): Promise<ShimProject[]> {
    const bindings = new Map(
      (await this.storage.listRemoteProjectBindings()).map((binding) => [
        binding.projectId,
        binding,
      ]),
    );
    const onVm = this.onVm();
    const projects: ShimProject[] = [];
    for (const projectId of await this.files.projectsWithFolder('git')) {
      const binding = bindings.get(projectId);
      // Disconnect keeps the sync folders for the next Connect; on the PC such a project
      // runs real Git, even when a connected project shares its folder.
      if (!binding && !onVm) continue;
      let commonDir: string;
      try {
        commonDir = await realpath(
          join((await this.storage.getProject(projectId)).rootPath, '.git'),
        );
      } catch {
        continue;
      }
      if (binding) {
        const remote = await this.storage.getRemote(binding.remoteId).catch(() => null);
        projects.push({
          projectId,
          side: 'home',
          commonDir,
          remoteName: remote?.name ?? binding.remoteId,
          owner: this.owners.get(projectId),
          generation: this.owners.generation(projectId),
        });
      } else {
        const record = this.coordinator.read(projectId);
        projects.push({
          projectId,
          side: 'vm',
          commonDir,
          remoteName: record.homeName ?? 'the PC',
          owner: record.owner,
          generation: record.generation,
        });
      }
    }
    return projects;
  }

  private render(projects: ShimProject[]): string {
    const entries = projects.map((project) => {
      const values = [
        `devchain_project=${quoteShellArg(project.projectId)}`,
        `devchain_side=${project.side}`,
        `devchain_remote=${quoteShellArg(project.remoteName)}`,
        `devchain_state=${quoteShellArg(join(this.home, 'state', project.projectId))}`,
      ];
      return `  ${quoteShellArg(project.commonDir)}) ${values.join(' ')} ;;\n`;
    });
    return `# Written by DevChain for its git shim; do not edit.\ncase $devchain_common in\n${entries.join('')}esac\n`;
  }

  private async replace(path: string, content: string): Promise<void> {
    if ((await readFile(path, 'utf8').catch(() => null)) === content) return;
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, content, 'utf8');
    // The shim reads these at any moment; it must never see a partial file.
    await rename(temporary, path);
  }

  private async supportsShim(): Promise<boolean> {
    if (this.gitSupported !== undefined) return this.gitSupported;
    const result = await this.executor.run({
      argv: ['git', '--version'],
      mode: 'pipe',
      env: internalGitEnv(),
      timeout: 15_000,
    });
    const match = /git version (\d+)\.(\d+)/.exec(result.stdout);
    const [major, minor] = match ? [Number(match[1]), Number(match[2])] : [0, 0];
    this.gitSupported = major > 2 || (major === 2 && minor >= 31);
    if (!this.gitSupported)
      logger.warn(
        { version: result.stdout.trim() },
        'Git is older than 2.31: the git shim does not route Git writes in connected projects',
      );
    return this.gitSupported;
  }
}
