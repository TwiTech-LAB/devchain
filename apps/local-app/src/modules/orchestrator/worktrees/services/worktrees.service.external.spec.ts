import { execFile } from 'child_process';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { existsSync } from 'fs';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import Database from 'better-sqlite3';
import { OrchestratorDockerService } from '../../docker/services/docker.service';
import { SeedPreparationService } from '../../docker/services/seed-preparation.service';
import { GitWorktreeService } from '../../git/services/git-worktree.service';
import { EventLogService } from '../../../events/services/event-log.service';
import {
  CreateWorktreeRecordInput,
  UpdateWorktreeRecordInput,
  WorktreeRecord,
  WorktreesStore,
} from '../worktrees.store';
import { WorktreesService } from './worktrees.service';

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 10 * 1024 * 1024;

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, {
    cwd,
    maxBuffer: MAX_BUFFER,
  });
}

class IntegrationStore implements WorktreesStore {
  private rows = new Map<string, WorktreeRecord>();
  private seq = 0;

  async create(data: CreateWorktreeRecordInput): Promise<WorktreeRecord> {
    this.seq += 1;
    const now = new Date();
    const row: WorktreeRecord = {
      id: `wt-${this.seq}`,
      name: data.name as string,
      branchName: data.branchName as string,
      baseBranch: data.baseBranch as string,
      repoPath: data.repoPath as string,
      worktreePath: (data.worktreePath as string | null | undefined) ?? null,
      containerId: (data.containerId as string | null | undefined) ?? null,
      containerPort: (data.containerPort as number | null | undefined) ?? null,
      templateSlug: data.templateSlug as string,
      ownerProjectId: (data.ownerProjectId as string | undefined) ?? 'project-1',
      status: (data.status as string) ?? 'creating',
      description: (data.description as string | null | undefined) ?? null,
      devchainProjectId: (data.devchainProjectId as string | null | undefined) ?? null,
      mergeCommit: null,
      mergeConflicts: null,
      errorMessage: (data.errorMessage as string | null | undefined) ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(row.id, row);
    return row;
  }

  async list(): Promise<WorktreeRecord[]> {
    return [...this.rows.values()];
  }

  async listByOwnerProject(ownerProjectId: string): Promise<WorktreeRecord[]> {
    return [...this.rows.values()].filter((row) => row.ownerProjectId === ownerProjectId);
  }

  async getById(id: string): Promise<WorktreeRecord | null> {
    return this.rows.get(id) ?? null;
  }

  async getByName(name: string): Promise<WorktreeRecord | null> {
    return [...this.rows.values()].find((row) => row.name === name) ?? null;
  }

  async getByContainerId(containerId: string): Promise<WorktreeRecord | null> {
    return [...this.rows.values()].find((row) => row.containerId === containerId) ?? null;
  }

  async listMonitored(): Promise<WorktreeRecord[]> {
    return [...this.rows.values()].filter(
      (row) => row.status === 'running' || row.status === 'error',
    );
  }

  async update(id: string, patch: UpdateWorktreeRecordInput): Promise<WorktreeRecord | null> {
    const existing = this.rows.get(id);
    if (!existing) {
      return null;
    }
    const updated: WorktreeRecord = {
      ...existing,
      ...(patch as Partial<WorktreeRecord>),
      updatedAt: new Date(),
    };
    this.rows.set(id, updated);
    return updated;
  }

  async remove(id: string): Promise<void> {
    this.rows.delete(id);
  }
}

describe('WorktreesService integration', () => {
  const originalFetch = global.fetch;

  let tempRoot: string;
  let repoPath: string;
  let store: IntegrationStore;
  let gitService: GitWorktreeService;
  let docker: jest.Mocked<Partial<OrchestratorDockerService>>;
  let seedPreparation: jest.Mocked<Partial<SeedPreparationService>>;
  let eventEmitter: jest.Mocked<Pick<EventEmitter2, 'emitAsync' | 'emit'>>;
  let eventLogService: jest.Mocked<Pick<EventLogService, 'recordPublished'>>;
  let service: WorktreesService;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'orchestrator-worktrees-integration-'));
    repoPath = join(tempRoot, 'repo');
    await mkdir(repoPath, { recursive: true });
    await git(repoPath, ['init']);
    await git(repoPath, ['config', 'user.name', 'Integration Test']);
    await git(repoPath, ['config', 'user.email', 'integration@example.com']);
    await writeFile(join(repoPath, 'README.md'), '# integration\n');
    await git(repoPath, ['add', '.']);
    await git(repoPath, ['commit', '-m', 'initial']);
    await git(repoPath, ['branch', '-M', 'main']);

    store = new IntegrationStore();
    gitService = new GitWorktreeService();

    docker = {
      cleanupWorktreeProjectContainers: jest.fn().mockResolvedValue(undefined),
      removeWorktreeNetwork: jest.fn().mockResolvedValue(undefined),
      ensureWorktreeOnComposeNetwork: jest.fn().mockResolvedValue(undefined),
      createContainer: jest.fn().mockResolvedValue({
        id: 'container-1',
        name: 'devchain-wt-feature-auth',
        image: 'devchain:latest',
        hostPort: 42001,
        state: 'running',
      }),
      waitForHealthy: jest.fn().mockResolvedValue(true),
      stopContainer: jest.fn().mockResolvedValue(undefined),
      removeContainer: jest.fn().mockResolvedValue(undefined),
      getContainerLogs: jest.fn().mockResolvedValue('ok'),
      subscribeToContainerEvents: jest.fn(async () => () => undefined),
    };
    seedPreparation = {
      prepareSeedData: jest.fn().mockResolvedValue(undefined),
    };
    eventEmitter = {
      emitAsync: jest
        .fn()
        .mockResolvedValue([{ worktreeId: 'wt-1', epicsMerged: 2, agentsMerged: 2 }]),
      emit: jest.fn().mockReturnValue(true),
    };
    eventLogService = {
      recordPublished: jest
        .fn()
        .mockResolvedValue({ id: 'event-1', publishedAt: '2026-02-18T00:00:00.000Z' }),
    };

    service = new WorktreesService(
      store,
      docker as unknown as OrchestratorDockerService,
      gitService,
      seedPreparation as unknown as SeedPreparationService,
      eventEmitter as unknown as EventEmitter2,
      eventLogService as unknown as EventLogService,
    );

    global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/templates')) {
        return {
          ok: true,
          json: async () => ({ templates: [{ slug: '3-agent-dev' }] }),
        } as Response;
      }
      if (url.endsWith('/api/projects/from-template')) {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
        return {
          ok: true,
          json: async () => ({ success: true, project: { id: body.projectId ?? 'project-1' } }),
        } as Response;
      }
      return {
        ok: false,
        json: async () => ({}),
      } as Response;
    }) as unknown as typeof fetch;
  });

  afterEach(async () => {
    global.fetch = originalFetch;
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('create -> running -> delete lifecycle with seeded data available to container', async () => {
    let containerProjectId: string | undefined;
    seedPreparation.prepareSeedData = jest.fn(async (dataPath: string) => {
      await mkdir(dataPath, { recursive: true });

      const sqlite = new Database(join(dataPath, 'devchain.db'));
      sqlite.exec(`
        CREATE TABLE settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
      sqlite
        .prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`)
        .run('registry.url', JSON.stringify('https://registry.seeded.devchain.local'));
      sqlite.close();

      const skillDir = join(dataPath, 'skills', 'seeded-local', 'existing-skill');
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, 'SKILL.md'), '# seeded skill\n', 'utf-8');
    });
    docker.createContainer?.mockImplementation(async (config) => {
      containerProjectId = config.env?.CONTAINER_PROJECT_ID;
      expect(containerProjectId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );

      const dbPath = join(config.dataPath, 'devchain.db');
      expect(existsSync(dbPath)).toBe(true);

      const sqlite = new Database(dbPath, { readonly: true });
      const row = sqlite.prepare('SELECT value FROM settings WHERE key = ?').get('registry.url') as
        | { value: string }
        | undefined;
      sqlite.close();
      expect(row?.value).toBe(JSON.stringify('https://registry.seeded.devchain.local'));

      const skillFile = join(
        config.dataPath,
        'skills',
        'seeded-local',
        'existing-skill',
        'SKILL.md',
      );
      expect(existsSync(skillFile)).toBe(true);

      return {
        id: 'container-1',
        name: 'devchain-wt-feature-auth',
        image: 'devchain:latest',
        hostPort: 42001,
        state: 'running',
      };
    });

    const created = await service.createWorktree({
      name: 'feature-auth',
      branchName: 'feature/auth',
      baseBranch: 'main',
      templateSlug: '3-agent-dev',
      ownerProjectId: 'project-main',
      repoPath,
    });
    expect(created.status).toBe('running');
    expect(created.containerId).toBe('container-1');
    expect(created.ownerProjectId).toBe('project-main');
    expect(created.devchainProjectId).toBe(containerProjectId);
    expect(existsSync(created.worktreePath!)).toBe(true);

    const createProjectCall = (global.fetch as jest.Mock).mock.calls.find((call) =>
      String(call[0]).endsWith('/api/projects/from-template'),
    );
    const createProjectBody = JSON.parse((createProjectCall?.[1]?.body as string) ?? '{}') as {
      projectId?: string;
    };
    expect(createProjectBody.projectId).toBe(containerProjectId);

    const listed = await service.listWorktrees();
    expect(listed).toHaveLength(1);
    expect(listed[0].name).toBe('feature-auth');

    const ownerScoped = await service.listByOwnerProject('project-main');
    expect(ownerScoped).toHaveLength(1);
    expect(ownerScoped[0].ownerProjectId).toBe('project-main');

    const details = await service.getWorktree(created.id);
    expect(details.commitsAhead).toBe(0);
    expect(details.commitsBehind).toBe(0);

    const deleted = await service.deleteWorktree(created.id);
    expect(deleted).toEqual({ success: true });
    expect(docker.cleanupWorktreeProjectContainers).toHaveBeenCalledWith(
      'feature-auth',
      'container-1',
    );
    expect(docker.stopContainer).toHaveBeenCalledWith('container-1');
    expect(docker.removeContainer).toHaveBeenCalledWith('container-1', true);
    expect(docker.removeWorktreeNetwork).toHaveBeenCalledWith('feature-auth');
  });
});
