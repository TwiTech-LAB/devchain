import { Inject, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { basename, resolve } from 'path';
import { getEnvConfig } from '../../../common/config/env.config';
import { createLogger } from '../../../common/logging/logger';
import { STORAGE_SERVICE, StorageService } from '../../storage/interfaces/storage.interface';

const logger = createLogger('MainProjectBootstrapService');

@Injectable()
export class MainProjectBootstrapService implements OnApplicationBootstrap {
  private mainProjectId: string | null = null;

  constructor(@Inject(STORAGE_SERVICE) private readonly storage: StorageService) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.ensureMainProjectId();
  }

  getMainProjectId(): string | null {
    return this.mainProjectId;
  }

  async ensureMainProjectId(): Promise<string | null> {
    if (this.mainProjectId) {
      return this.mainProjectId;
    }

    const env = getEnvConfig();
    if (env.DEVCHAIN_MODE !== 'main') {
      this.mainProjectId = null;
      return null;
    }

    const repoRoot = resolve(env.REPO_ROOT ?? process.cwd());
    const projects = await this.storage.listProjects({ limit: 1000, offset: 0 });

    const byRepoRoot = projects.items.find((project) => resolve(project.rootPath) === repoRoot);
    if (byRepoRoot) {
      this.mainProjectId = byRepoRoot.id;
      logger.info(
        { projectId: byRepoRoot.id, projectName: byRepoRoot.name, repoRoot },
        'Using existing main project for current repository root',
      );
      return this.mainProjectId;
    }

    if (projects.total > 0 && projects.items.length > 0) {
      this.mainProjectId = projects.items[0].id;
      logger.info(
        { projectId: this.mainProjectId, repoRoot },
        'Using existing project as main merge target',
      );
      return this.mainProjectId;
    }

    const created = await this.storage.createProject({
      name: this.deriveMainProjectName(repoRoot),
      description: 'Auto-created main project for merged worktree epics',
      rootPath: repoRoot,
      isTemplate: false,
    });

    this.mainProjectId = created.id;
    logger.info(
      { projectId: created.id, projectName: created.name, repoRoot },
      'Created main project bootstrap target',
    );
    return this.mainProjectId;
  }

  private deriveMainProjectName(repoRoot: string): string {
    const name = basename(repoRoot).trim();
    return name.length > 0 ? name : 'Main';
  }
}
