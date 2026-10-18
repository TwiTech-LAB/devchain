import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { McpHttpController } from '../mcp/controllers/mcp-http.controller';
import { McpService } from '../mcp/services/mcp.service';
import { McpToolBindingRegistry } from '../mcp/services/mcp-tool-binding.registry';
import { createMcpToolBindingRegistryFixture } from '../mcp/services/testing/mcp-tool-binding-registry.fixture';
import type { StorageService } from '../storage/interfaces/storage.interface';
import type { SessionsService } from '../sessions/services/sessions.service';
import type {
  CreatedLane,
  CommittedLane,
  MergedLane,
  LaneList,
  RemovedLane,
} from './worktrees.types';
import { FileSyncService } from '../file-sync/file-sync.service';
import { FakeFileSyncService } from '../file-sync/testing/fake-file-sync.service';
// Disposable real repositories are needed to prove worktree, commit, merge and ignore behavior;
// SQLite plus the actual Nest module also proves reservation rollback and provider wiring.
import { Test, type TestingModule } from '@nestjs/testing';
import crypto from 'node:crypto';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createTestDatabase } from '../../common/test/test-database.helper';
import { DB_CONNECTION } from '../storage/db/db.provider';
import { STORAGE_SERVICE } from '../storage/interfaces/storage.interface';
import { LocalStorageService } from '../storage/local/local-storage.service';
import { TeamsStore } from '../teams/storage/teams.store';
import { ChildProcessExecutor } from '../terminal/services/process-executor/child-process-executor';
import { ProcessExecutor } from '../terminal/services/process-executor/process-executor.port';
import { GitCoordinatorService } from '../remotes/git-coordinator/git-coordinator.service';
import { GitCoordinatorIndexService } from '../remotes/git-coordinator/git-coordinator-index.service';
import { GitCoordinatorStore } from '../remotes/git-coordinator/git-coordinator.store';
import { WorktreeGitRunner } from './worktree-git-runner';
import { WorktreesModule } from './worktrees.module';
import { WorktreesService } from './worktrees.service';

describe('WorktreesService real Git lanes', () => {
  let module: TestingModule;
  let mcpApp: NestFastifyApplication | undefined;
  let database: ReturnType<typeof createTestDatabase>;
  let service: WorktreesService;
  let files: FakeFileSyncService;
  let storage: LocalStorageService;
  let directory: string;
  let root: string;
  let projectId: string;
  let leadId: string;

  function git(path: string, ...args: string[]): string {
    return execFileSync('git', ['-C', path, '-c', 'commit.gpgsign=false', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  }

  async function file(path: string, relative: string, contents: string): Promise<void> {
    const target = join(path, relative);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }

  async function epic(title: string) {
    return storage.createEpic({
      projectId,
      title,
      description: null,
      data: null,
      tags: [],
      statusId: (await storage.listStatuses(projectId)).items[0].id,
      agentId: leadId,
    });
  }

  beforeEach(async () => {
    directory = await mkdtemp(join(os.tmpdir(), 'devchain-lanes-'));
    jest.spyOn(os, 'homedir').mockReturnValue(directory);
    root = join(directory, 'root');
    await mkdir(root);
    git(root, 'init', '-b', 'main');
    git(root, 'config', 'user.name', 'Lane Tests');
    git(root, 'config', 'user.email', 'lanes@example.test');
    git(root, 'config', 'commit.gpgsign', 'false');
    git(root, 'config', 'core.hooksPath', join(directory, 'hooks'));
    await file(root, 'file.txt', 'base\n');
    await file(root, '.gitignore', 'node_modules/\n*.tsbuildinfo\n.env*\n');
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'base');
    database = createTestDatabase();
    files = new FakeFileSyncService();
    module = await Test.createTestingModule({ imports: [WorktreesModule] })
      .overrideProvider(FileSyncService)
      .useValue(files)
      .overrideProvider(DB_CONNECTION)
      .useValue(database.db)
      .overrideProvider(ProcessExecutor)
      .useClass(ChildProcessExecutor)
      .compile();
    service = module.get(WorktreesService);
    storage = module.get(STORAGE_SERVICE);
    projectId = (
      await storage.createProject({
        name: 'lane-test',
        rootPath: root,
        description: null,
        isTemplate: false,
      })
    ).id;
    const profile = await storage.createAgentProfile({ projectId, name: 'lead' });
    const provider = await storage.createProvider({ name: 'fixture' });
    const config = await storage.createProfileProviderConfig({
      profileId: profile.id,
      providerId: provider.id,
      name: 'default',
      options: null,
      env: null,
    });
    leadId = (
      await storage.createAgent({
        projectId,
        profileId: profile.id,
        providerConfigId: config.id,
        name: 'Lead',
      })
    ).id;
    await module
      .get(TeamsStore)
      .createTeam({ projectId, name: 'Builders', teamLeadAgentId: leadId, memberAgentIds: [] });
  });

  afterEach(async () => {
    await mcpApp?.close();
    mcpApp = undefined;
    jest.restoreAllMocks();
    await module?.close();
    database?.sqlite.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('creates a real lane only after the local sender has the worktree metadata ignore', async () => {
    await files.ensureFolder({
      projectId,
      kind: 'git',
      type: 'sendonly',
      peerDeviceId: 'home',
      ignores: ['*.lock'],
    });
    await expect(service.create(projectId, leadId, { name: 'guarded' })).rejects.toMatchObject({
      code: 'GIT_SYNC_IGNORES_PENDING',
    });
    expect(await storage.listWorktrees(projectId)).toHaveLength(0);
    await files.updateFolder(`git:${projectId}`, {
      ignores: ['*.lock', '/hooks', '/index', '/worktrees'],
    });
    const lane = await service.create(projectId, leadId, { name: 'guarded' });
    expect(git(lane.path, 'rev-parse', 'HEAD')).toBe(git(root, 'rev-parse', 'HEAD'));
    expect((await service.listOnHost(projectId)).lanes[0].dirty).toBe(false);
    await file(lane.path, 'new.txt', 'dirty');
    expect((await service.listOnHost(projectId)).lanes[0].dirty).toBe(true);
  });

  it('creates at the managed home path from the base SHA and allows name reuse after removal', async () => {
    const base = git(root, 'rev-parse', 'HEAD');
    const first = await service.create(projectId, leadId, { name: 'storage' });
    expect(first).toMatchObject({
      path: join(directory, '.devchain/worktrees', projectId, 'storage'),
      branch: `devchain/storage-${first.id.slice(0, 6)}`,
      baseBranch: 'main',
      baseSha: base,
      projectRootPath: root,
    });
    expect(git(first.path, 'branch', '--show-current')).toBe(first.branch);
    expect(git(first.path, 'rev-parse', 'HEAD')).toBe(base);
    await service.remove(projectId, leadId, 'storage');
    expect(git(root, 'rev-parse', first.branch)).toBe(base);
    const second = await service.create(projectId, leadId, { name: 'storage' });
    expect(second.path).toBe(first.path);
    expect(second.branch).not.toBe(first.branch);
    expect(git(second.path, 'rev-parse', 'HEAD')).toBe(base);
  });

  it('derives an epic slug and returns live epic and assignee details', async () => {
    const linked = await epic('Storage: Add Tablés!');
    const lane = await service.create(projectId, leadId, { epicId: linked.id });
    expect(lane.name).toBe('storage-add-tables');
    expect((await service.list(projectId, leadId)).lanes[0].epic).toEqual({
      id: linked.id,
      title: linked.title,
      agentName: 'Lead',
    });
  });

  it('serializes default names and refuses the sixth concurrent lane at the fixed cap', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => service.create(projectId, leadId)),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(5);
    expect(results.filter((result) => result.status === 'rejected')).toMatchObject([
      { reason: { code: 'WORKTREE_LIMIT_REACHED' } },
    ]);
    expect((await storage.listWorktrees(projectId)).map((row) => row.name)).toEqual([
      'lane-1',
      'lane-2',
      'lane-3',
      'lane-4',
      'lane-5',
    ]);
    expect(git(root, 'worktree', 'list', '--porcelain').match(/worktree /g)).toHaveLength(6);
  });

  it('refuses existing names and filesystem paths without adding a row', async () => {
    const lane = await service.create(projectId, leadId, { name: 'taken' });
    await expect(service.create(projectId, leadId, { name: 'taken' })).rejects.toMatchObject({
      code: 'WORKTREE_NAME_EXISTS',
    });
    await mkdir(join(directory, '.devchain/worktrees', projectId, 'occupied'));
    await expect(service.create(projectId, leadId, { name: 'occupied' })).rejects.toMatchObject({
      code: 'WORKTREE_PATH_EXISTS',
    });
    expect(await storage.listWorktrees(projectId)).toEqual([laneWithoutRoot(lane)]);
  });

  function laneWithoutRoot(lane: Awaited<ReturnType<WorktreesService['create']>>) {
    const { projectRootPath: _root, ...row } = lane;
    return row;
  }

  it('deletes a reserved row when Git rejects an existing branch', async () => {
    git(root, 'branch', 'devchain/failure-000000');
    jest.spyOn(crypto, 'randomUUID').mockReturnValueOnce('00000000-0000-4000-8000-000000000000');
    await expect(service.create(projectId, leadId, { name: 'failure' })).rejects.toMatchObject({
      code: 'WORKTREE_GIT_FAILED',
      details: { exitCode: 255 },
    });
    expect(await storage.listWorktrees(projectId)).toEqual([]);
    expect(existsSync(join(directory, '.devchain/worktrees', projectId, 'failure'))).toBe(false);
  });

  // Real Git registers the worktree before a failing post-checkout hook returns.
  it('keeps a registered lane managed when its checkout hook fails', async () => {
    await file(
      directory,
      'hooks/post-checkout',
      '#!/bin/sh\nprintf "hook output\\n" > hook-created.txt\nprintf "HOOK=value\\n" > .env\nprintf "checkout hook rejected fixture\\n" >&2\nexit 1\n',
    );
    await chmod(join(directory, 'hooks/post-checkout'), 0o755);
    const path = join(directory, '.devchain/worktrees', projectId, 'hook-failure');
    await expect(service.create(projectId, leadId, { name: 'hook-failure' })).rejects.toMatchObject(
      {
        code: 'WORKTREE_SETUP_FAILED',
        statusCode: 409,
        message:
          'Git created the lane, but a checkout hook failed. Inspect the lane, or remove it with devchain_worktrees_remove.',
        details: {
          name: 'hook-failure',
          path,
          branch: expect.stringMatching(/^devchain\/hook-failure-/),
          stderr: expect.stringContaining('checkout hook rejected fixture'),
        },
      },
    );
    const rows = await storage.listWorktrees(projectId);
    expect(rows).toHaveLength(1);
    const lane = rows[0];
    expect(lane.path).toBe(path);
    expect(git(root, 'worktree', 'list', '--porcelain').split('\n')).toContain(`worktree ${path}`);
    expect(git(path, 'branch', '--show-current')).toBe(lane.branch);
    expect(await readFile(join(path, 'hook-created.txt'), 'utf8')).toBe('hook output\n');
    expect(await readFile(join(path, '.env'), 'utf8')).toBe('HOOK=value\n');

    const sessionId = crypto.randomUUID();
    const mcp = new McpService(
      storage,
      createMcpToolBindingRegistryFixture(storage, {
        worktreesService: service,
        sessionsService: {
          listActiveSessions: async () => [
            {
              id: sessionId,
              agentId: leadId,
              status: 'running',
              startedAt: new Date().toISOString(),
            },
          ],
        } as SessionsService,
      }),
    );
    async function call<T>(name: string): Promise<T> {
      const result = await mcp.handleToolCall(name, { sessionId, name: lane.name });
      if (!result.success)
        throw Object.assign(new Error(result.error?.message), {
          code: result.error?.code,
          details: result.error?.data,
        });
      return result.data as T;
    }
    expect((await call<LaneList>('devchain_worktrees_list')).lanes).toEqual([
      expect.objectContaining({
        name: lane.name,
        path,
        branch: lane.branch,
        status: 'present',
        dirtyFiles: [{ path: 'hook-created.txt', status: '??' }],
      }),
    ]);
    expect((await service.listOnHost(projectId)).lanes).toEqual([
      { name: lane.name, path, branch: lane.branch, dirty: true },
    ]);
    await expect(service.create(projectId, leadId, { name: lane.name })).rejects.toMatchObject({
      code: 'WORKTREE_NAME_EXISTS',
    });
    await expect(call('devchain_worktrees_remove')).rejects.toMatchObject({
      code: 'WORKTREE_DIRTY',
    });
    expect(await readFile(join(path, 'hook-created.txt'), 'utf8')).toBe('hook output\n');
    await rename(join(path, 'hook-created.txt'), join(directory, 'saved-hook-output.txt'));
    await expect(call('devchain_worktrees_remove')).rejects.toMatchObject({
      code: 'WORKTREE_LOCAL_ENV',
    });
    expect(await readFile(join(path, '.env'), 'utf8')).toBe('HOOK=value\n');
    await file(root, '.env', 'HOOK=value\n');
    expect(await call<RemovedLane>('devchain_worktrees_remove')).toMatchObject({
      status: 'removed',
      branch: lane.branch,
    });
    expect(await storage.listWorktrees(projectId)).toEqual([]);
    expect(existsSync(path)).toBe(false);
    expect(git(root, 'worktree', 'list', '--porcelain')).not.toContain(path);
    expect(git(root, 'rev-parse', lane.branch)).toBe(lane.baseSha);
    expect(await readFile(join(directory, 'saved-hook-output.txt'), 'utf8')).toBe('hook output\n');
  });

  it('requires a branch base, supports explicit branches and handles a detached root', async () => {
    const base = git(root, 'rev-parse', 'HEAD');
    git(root, 'tag', 'tag-base');
    for (const baseRef of [base, 'tag-base']) {
      await expect(
        service.create(projectId, leadId, { name: 'invalid', baseRef }),
      ).rejects.toMatchObject({ code: 'BASE_MUST_BE_BRANCH' });
    }
    git(root, 'checkout', '--detach', base);
    await expect(service.create(projectId, leadId, { name: 'detached' })).rejects.toMatchObject({
      code: 'BASE_REF_REQUIRED',
    });
    const lane = await service.create(projectId, leadId, { name: 'explicit', baseRef: 'main' });
    expect(lane).toMatchObject({ baseBranch: 'main', baseSha: base });
    expect(git(lane.path, 'rev-parse', 'HEAD')).toBe(base);
  });

  it('computes live drift and ahead/behind and previews conflicts only when named', async () => {
    const lane = await service.create(projectId, leadId, { name: 'conflict' });
    await file(root, 'file.txt', 'root commit\n');
    git(root, 'add', 'file.txt');
    git(root, 'commit', '-m', 'root advance');
    await file(lane.path, 'file.txt', 'lane commit\n');
    git(lane.path, 'add', 'file.txt');
    git(lane.path, 'commit', '-m', 'lane advance');
    await file(root, 'root-new.txt', 'root drift');
    await file(lane.path, 'lane\nnew.txt', 'lane drift');
    const runner = module.get(WorktreeGitRunner);
    const run = jest.spyOn(runner, 'run');
    const listed = await service.list(projectId, leadId);
    expect(listed.lanes[0]).toMatchObject({
      status: 'present',
      headSha: git(lane.path, 'rev-parse', 'HEAD'),
      ahead: 1,
      behind: 1,
      dirtyFiles: [{ status: '??', path: 'lane\nnew.txt' }],
    });
    expect(listed.rootDirtyFiles).toEqual([{ status: '??', path: 'root-new.txt' }]);
    expect(listed.preview).toBeUndefined();
    expect(run.mock.calls.some(([, args]) => args[0] === 'merge-tree')).toBe(false);
    const preview = (await service.list(projectId, leadId, 'conflict')).preview;
    expect(preview).toEqual({ status: 'conflicts', files: ['file.txt'] });
  });

  it('returns clean and unavailable previews according to real Git results', async () => {
    git(root, 'branch', 'temporary-base');
    const lane = await service.create(projectId, leadId, {
      name: 'preview',
      baseRef: 'temporary-base',
    });
    expect((await service.list(projectId, leadId, 'preview')).preview).toEqual({
      status: 'clean',
      files: [],
    });
    git(lane.path, 'checkout', '--orphan', 'unrelated');
    git(lane.path, 'commit', '-m', 'unrelated history');
    expect((await service.list(projectId, leadId, 'preview')).preview).toMatchObject({
      status: 'unavailable',
      stderr: expect.stringContaining('unrelated'),
    });
    git(root, 'branch', '-d', 'temporary-base');
    expect((await service.list(projectId, leadId, 'preview')).preview).toMatchObject({
      status: 'unavailable',
      stderr: expect.stringContaining('temporary-base'),
    });
  });

  it.each(['tracked', 'untracked'])(
    'refuses removal with %s changes and includes the dirty files',
    async (kind) => {
      const lane = await service.create(projectId, leadId, { name: 'dirty' });
      const path = kind === 'tracked' ? 'file.txt' : 'new file.txt';
      await file(lane.path, path, 'changed');
      await expect(service.remove(projectId, leadId, 'dirty')).rejects.toMatchObject({
        code: 'WORKTREE_DIRTY',
        details: { files: [{ path }] },
      });
      expect(existsSync(lane.path)).toBe(true);
      expect(await storage.getWorktree(lane.id)).toEqual(laneWithoutRoot(lane));
    },
  );

  it.each([
    { path: '.env.local', rootCopy: 'missing', isSymlink: false },
    { path: 'nested/.env.production', rootCopy: 'different', isSymlink: false },
    { path: '.env.symlink', rootCopy: 'matching', isSymlink: true },
  ])('protects unsafe ignored environment file $path', async ({ path, rootCopy, isSymlink }) => {
    const lane = await service.create(projectId, leadId, { name: 'env' });
    if (isSymlink) {
      await file(directory, 'outside-env', 'lane-only fixture');
      await symlink(join(directory, 'outside-env'), join(lane.path, path));
    } else {
      await file(lane.path, path, 'lane-only fixture');
    }
    if (rootCopy !== 'missing')
      await file(
        root,
        path,
        rootCopy === 'matching' ? 'lane-only fixture' : 'different root fixture',
      );
    await expect(service.remove(projectId, leadId, 'env')).rejects.toMatchObject({
      code: 'WORKTREE_LOCAL_ENV',
      details: { files: [path] },
    });
    expect(await readFile(join(lane.path, path), 'utf8')).toBe('lane-only fixture');
    expect(await storage.getWorktree(lane.id)).toEqual(laneWithoutRoot(lane));
  });

  it('deletes disposable ignored files, retains identical root env copies and keeps the branch', async () => {
    const lane = await service.create(projectId, leadId, { name: 'ignored' });
    await file(root, 'nested/.env', 'same fixture');
    await file(lane.path, 'nested/.env', 'same fixture');
    await file(lane.path, 'tsconfig.tsbuildinfo', 'generated');
    await file(lane.path, 'node_modules/pkg/index.js', 'installed');
    const removed = await service.remove(projectId, leadId, 'ignored');
    expect(removed).toMatchObject({
      status: 'removed',
      path: lane.path,
      branch: lane.branch,
      deletedIgnoredPaths: ['nested', 'node_modules', 'tsconfig.tsbuildinfo'],
      ignoredPathsTruncated: false,
    });
    expect(existsSync(lane.path)).toBe(false);
    expect(await readFile(join(root, 'nested/.env'), 'utf8')).toBe('same fixture');
    expect(git(root, 'rev-parse', lane.branch)).toBe(lane.baseSha);
    expect(await storage.getWorktreeByName(projectId, 'ignored')).toBeNull();
  });

  it('caps the deleted ignored top-level path report', async () => {
    const lane = await service.create(projectId, leadId, { name: 'cap-report' });
    for (let i = 0; i < 55; i++) await file(lane.path, `cache-${i}.tsbuildinfo`, 'generated');
    const removed = await service.remove(projectId, leadId, 'cap-report');
    expect(removed.deletedIgnoredPaths).toHaveLength(50);
    expect(removed).toMatchObject({ deletedIgnoredPathCount: 55, ignoredPathsTruncated: true });
    expect(existsSync(lane.path)).toBe(false);
  });

  it('lists a missing directory and prunes its registration without deleting the branch', async () => {
    const lane = await service.create(projectId, leadId, { name: 'missing' });
    await rm(lane.path, { recursive: true, force: true });
    expect((await service.list(projectId, leadId, 'missing')).lanes[0]).toMatchObject({
      status: 'missing',
      headSha: null,
      ahead: null,
      behind: null,
    });
    expect(await service.remove(projectId, leadId, 'missing')).toMatchObject({
      status: 'pruned',
      path: lane.path,
    });
    expect(git(root, 'worktree', 'list', '--porcelain')).not.toContain(lane.path);
    expect(git(root, 'rev-parse', lane.branch)).toBe(lane.baseSha);
    expect(await storage.getWorktreeByName(projectId, 'missing')).toBeNull();
  });

  async function snapshot(path: string) {
    const gitDir = git(path, 'rev-parse', '--absolute-git-dir');
    const mergeHeadPath = join(gitDir, 'MERGE_HEAD');
    return {
      head: git(path, 'rev-parse', 'HEAD'),
      branch: git(path, 'rev-parse', '--abbrev-ref', 'HEAD'),
      staged: git(path, 'ls-files', '--stage', '-z'),
      status: git(path, '--no-optional-locks', 'status', '--porcelain=v1', '-z'),
      file: await readFile(join(path, 'file.txt'), 'utf8'),
      mergeHead: existsSync(mergeHeadPath) ? await readFile(mergeHeadPath, 'utf8') : null,
    };
  }

  it('refuses nothing to commit and commits whitespace findings with a literal message', async () => {
    const lane = await service.create(projectId, leadId, { name: 'commit' });
    await expect(service.commit(projectId, leadId, 'commit', 'empty')).rejects.toMatchObject({
      code: 'NOTHING_TO_COMMIT',
    });
    await file(lane.path, 'file.txt', 'allowed whitespace   \n');
    await file(lane.path, 'new\nfile:part.txt', 'new file\n');
    const message = 'literal $(echo test); "quoted" message';
    const committed = await service.commit(projectId, leadId, 'commit', message);
    expect(committed.sha).toBe(git(lane.path, 'rev-parse', 'HEAD'));
    expect(committed.files).toEqual(['file.txt', 'new\nfile:part.txt']);
    expect(git(lane.path, 'log', '-1', '--pretty=%B')).toBe(message);
    expect(git(lane.path, 'status', '--porcelain')).toBe('');
  });

  // The real protocol boundary must preserve Git refusals and task lane fields across the whole workflow.
  it('runs the parallel pilot and reviewed-head/removal lifecycle through MCP', async () => {
    git(root, 'branch', '-m', 'phase/x');
    const sessionId = crypto.randomUUID();
    const mcpModule = await Test.createTestingModule({
      controllers: [McpHttpController],
      providers: [
        McpService,
        { provide: STORAGE_SERVICE, useValue: storage },
        {
          provide: McpToolBindingRegistry,
          useValue: createMcpToolBindingRegistryFixture(storage as StorageService, {
            worktreesService: service,
            sessionsService: {
              listActiveSessions: async () => [
                {
                  id: sessionId,
                  agentId: leadId,
                  status: 'running',
                  startedAt: new Date().toISOString(),
                },
              ],
            } as SessionsService,
          }),
        },
      ],
    }).compile();
    mcpApp = mcpModule.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await mcpApp.init();
    await mcpApp.getHttpAdapter().getInstance().ready();
    async function call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
      const response = await mcpApp!.inject({
        method: 'POST',
        url: '/mcp/rpc',
        payload: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name, arguments: { sessionId, ...args } },
        },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<{
        result?: { content: Array<{ text: string }> };
        error?: { message: string; data: { code: string } };
      }>();
      if (body.error)
        throw Object.assign(new Error(body.error.message), {
          code: body.error.data.code,
          details: body.error.data,
        });
      return JSON.parse(body.result!.content[0].text) as T;
    }
    const firstEpic = await epic('First lane task');
    const secondEpic = await epic('Second lane task');
    const first = await call<CreatedLane>('devchain_worktrees_create', {
      name: 'first',
      epicId: firstEpic.id,
    });
    const second = await call<CreatedLane>('devchain_worktrees_create', {
      name: 'second',
      epicId: secondEpic.id,
    });
    for (const [task, lane] of [
      [firstEpic, first],
      [secondEpic, second],
    ] as const) {
      const detail = await call<{
        worktrees: Array<{ path: string; branch: string }>;
        worktreeInstruction: string;
      }>('devchain_get_epic_by_id', { id: task.id });
      expect(detail.worktrees).toEqual([
        expect.objectContaining({ path: lane.path, branch: lane.branch }),
      ]);
      expect(detail.worktreeInstruction).toContain('Work in it by path');
    }
    const assigned = await call<{ epics: Array<{ id: string; worktreePath?: string }> }>(
      'devchain_list_assigned_epics_tasks',
      { agentName: 'Lead' },
    );
    expect(assigned.epics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: secondEpic.id, worktreePath: second.path }),
      ]),
    );
    await file(first.path, 'file.txt', 'first lane\n');
    await file(second.path, 'file.txt', 'second lane\n');
    const firstCommit = await call<CommittedLane>('devchain_worktrees_commit', {
      name: 'first',
      message: 'first change',
    });
    const secondCommit = await call<CommittedLane>('devchain_worktrees_commit', {
      name: 'second',
      message: 'second change',
    });
    await file(root, 'root-drift.txt', 'root edit\n');
    expect((await call<LaneList>('devchain_worktrees_list')).rootDirtyFiles).toEqual([
      expect.objectContaining({ path: 'root-drift.txt' }),
    ]);
    expect(
      await call<MergedLane>('devchain_worktrees_merge', {
        name: 'first',
        expectedHead: firstCommit.sha,
      }),
    ).toEqual({ baseBranch: 'phase/x', oldSha: first.baseSha, newSha: firstCommit.sha });
    const rootBeforeBehind = await snapshot(root);
    const laneBeforeBehind = await snapshot(second.path);
    await expect(
      call('devchain_worktrees_merge', { name: 'second', expectedHead: secondCommit.sha }),
    ).rejects.toMatchObject({
      code: 'BEHIND',
      details: {
        ahead: 1,
        behind: 1,
        preview: { status: 'conflicts', files: ['file.txt'] },
        recovery: expect.stringContaining('devchain_worktrees_commit'),
      },
    });
    expect(await snapshot(root)).toEqual(rootBeforeBehind);
    expect(await snapshot(second.path)).toEqual(laneBeforeBehind);
    expect(() => git(second.path, 'merge', 'phase/x')).toThrow();
    const gitDir = git(second.path, 'rev-parse', '--absolute-git-dir');
    const unmergedIndex = await readFile(join(gitDir, 'index'));
    const mergeHead = await readFile(join(gitDir, 'MERGE_HEAD'));
    await expect(
      call('devchain_worktrees_commit', { name: 'second', message: 'unresolved' }),
    ).rejects.toMatchObject({ code: 'UNMERGED_PATHS', details: { files: ['file.txt'] } });
    expect(await readFile(join(gitDir, 'index'))).toEqual(unmergedIndex);
    expect(await readFile(join(gitDir, 'MERGE_HEAD'))).toEqual(mergeHead);
    git(second.path, 'add', 'file.txt');
    await file(second.path, 'extra.txt', 'not staged by a refused commit\n');
    const markerIndex = await readFile(join(gitDir, 'index'));
    await expect(
      call('devchain_worktrees_commit', { name: 'second', message: 'markers remain' }),
    ).rejects.toMatchObject({ code: 'CONFLICT_MARKERS', details: { files: ['file.txt'] } });
    expect(await readFile(join(gitDir, 'index'))).toEqual(markerIndex);
    expect(await readFile(join(gitDir, 'MERGE_HEAD'))).toEqual(mergeHead);
    expect(git(second.path, 'ls-files', 'extra.txt')).toBe('');
    await file(second.path, 'file.txt', 'first and second resolved\n');
    const resolved = await call<CommittedLane>('devchain_worktrees_commit', {
      name: 'second',
      message: 'resolve both lanes',
    });
    expect(git(second.path, 'rev-list', '--parents', '-n', '1', resolved.sha).split(' ')).toEqual([
      resolved.sha,
      secondCommit.sha,
      firstCommit.sha,
    ]);
    expect(existsSync(join(gitDir, 'MERGE_HEAD'))).toBe(false);
    expect(
      await call<MergedLane>('devchain_worktrees_merge', {
        name: 'second',
        expectedHead: resolved.sha,
      }),
    ).toEqual({ baseBranch: 'phase/x', oldSha: firstCommit.sha, newSha: resolved.sha });
    expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('first and second resolved\n');
    expect(await readFile(join(root, 'root-drift.txt'), 'utf8')).toBe('root edit\n');
    await file(second.path, 'later.txt', 'post-review edit\n');
    await expect(
      call('devchain_worktrees_merge', { name: 'second', expectedHead: resolved.sha }),
    ).rejects.toMatchObject({ code: 'WORKTREE_DIRTY' });
    await expect(call('devchain_worktrees_remove', { name: 'second' })).rejects.toMatchObject({
      code: 'WORKTREE_DIRTY',
    });
    const later = await call<CommittedLane>('devchain_worktrees_commit', {
      name: 'second',
      message: 'extra commit',
    });
    await expect(
      call('devchain_worktrees_merge', { name: 'second', expectedHead: resolved.sha }),
    ).rejects.toMatchObject({ code: 'HEAD_MISMATCH', details: { currentHead: later.sha } });
    await file(root, '.env', 'ROOT=value\n');
    await file(second.path, '.env', 'LANE=different\n');
    await expect(call('devchain_worktrees_remove', { name: 'second' })).rejects.toMatchObject({
      code: 'WORKTREE_LOCAL_ENV',
    });
    await file(second.path, '.env', 'ROOT=value\n');
    await file(second.path, 'tsconfig.tsbuildinfo', 'build output');
    await file(second.path, 'node_modules/package/output.js', 'dependency output');
    const removed = await call<RemovedLane>('devchain_worktrees_remove', { name: 'second' });
    expect(removed.status).toBe('removed');
    expect(removed.deletedIgnoredPaths).toEqual(
      expect.arrayContaining(['.env', 'tsconfig.tsbuildinfo', 'node_modules']),
    );
    expect(git(root, 'rev-parse', second.branch)).toBe(later.sha);
    const reused = await call<CreatedLane>('devchain_worktrees_create', {
      name: 'second',
      epicId: secondEpic.id,
    });
    expect(reused.path).toBe(second.path);
    expect(reused.branch).not.toBe(second.branch);
    expect(reused.branch).toBe(`devchain/second-${reused.id.slice(0, 6)}`);
    await rm(reused.path, { recursive: true });
    expect(await call<RemovedLane>('devchain_worktrees_remove', { name: 'second' })).toMatchObject({
      status: 'pruned',
    });
    await call('devchain_worktrees_remove', { name: 'first' });
    expect((await call<LaneList>('devchain_worktrees_list')).lanes).toEqual([]);
    expect(git(root, 'worktree', 'list', '--porcelain')).not.toContain(second.path);
  });

  it.each(['tracked', 'untracked'])(
    'refuses %s edits made after a reviewed commit without changing either checkout',
    async (kind) => {
      const lane = await service.create(projectId, leadId, { name: 'dirty-review' });
      await file(lane.path, 'file.txt', 'reviewed\n');
      const reviewed = await service.commit(projectId, leadId, lane.name, 'reviewed');
      await file(lane.path, kind === 'tracked' ? 'file.txt' : 'later.txt', 'later edit\n');
      const beforeRoot = await snapshot(root);
      const beforeLane = await snapshot(lane.path);
      await expect(service.merge(projectId, leadId, lane.name, reviewed.sha)).rejects.toMatchObject(
        { code: 'WORKTREE_DIRTY' },
      );
      expect(await snapshot(root)).toEqual(beforeRoot);
      expect(await snapshot(lane.path)).toEqual(beforeLane);
    },
  );

  it('refuses a clean merge in progress before checking head identity and can commit its unchanged tree', async () => {
    const lane = await service.create(projectId, leadId, { name: 'merge-state' });
    git(root, 'commit', '--allow-empty', '-m', 'base advance');
    git(lane.path, 'merge', '--no-ff', '--no-commit', 'main');
    expect(git(lane.path, 'status', '--porcelain')).toBe('');
    const beforeRoot = await snapshot(root);
    const beforeLane = await snapshot(lane.path);
    await expect(service.merge(projectId, leadId, lane.name, '0'.repeat(40))).rejects.toMatchObject(
      { code: 'MERGE_IN_PROGRESS' },
    );
    expect(await snapshot(root)).toEqual(beforeRoot);
    expect(await snapshot(lane.path)).toEqual(beforeLane);
    const committed = await service.commit(projectId, leadId, lane.name, 'finish empty-tree merge');
    expect(committed.files).toEqual([]);
    expect(
      git(lane.path, 'rev-list', '--parents', '-n', '1', committed.sha).split(' '),
    ).toHaveLength(3);
    expect((await snapshot(lane.path)).mergeHead).toBeNull();
  });

  it('refuses an extra commit after review and reports the current lane head', async () => {
    const lane = await service.create(projectId, leadId, { name: 'head-review' });
    await file(lane.path, 'file.txt', 'reviewed\n');
    const reviewed = await service.commit(projectId, leadId, lane.name, 'reviewed');
    await file(lane.path, 'file.txt', 'another commit\n');
    const current = await service.commit(projectId, leadId, lane.name, 'unreviewed');
    const beforeRoot = await snapshot(root);
    const beforeLane = await snapshot(lane.path);
    await expect(service.merge(projectId, leadId, lane.name, reviewed.sha)).rejects.toMatchObject({
      code: 'HEAD_MISMATCH',
      details: { currentHead: current.sha, expectedHead: reviewed.sha },
    });
    expect(await snapshot(root)).toEqual(beforeRoot);
    expect(await snapshot(lane.path)).toEqual(beforeLane);
  });

  it.each(['other', 'detached'])(
    'refuses landing when root target is %s and preserves both checkouts',
    async (target) => {
      const lane = await service.create(projectId, leadId, { name: 'target' });
      await file(lane.path, 'file.txt', 'lane\n');
      const committed = await service.commit(projectId, leadId, lane.name, 'lane change');
      if (target === 'other') git(root, 'checkout', '-b', 'other');
      else git(root, 'checkout', '--detach');
      const beforeRoot = await snapshot(root);
      const beforeLane = await snapshot(lane.path);
      await expect(
        service.merge(projectId, leadId, lane.name, committed.sha),
      ).rejects.toMatchObject({
        code: 'TARGET_NOT_CHECKED_OUT',
        details: { baseBranch: 'main', rootBranch: target === 'other' ? 'other' : null },
      });
      expect(await snapshot(root)).toEqual(beforeRoot);
      expect(await snapshot(lane.path)).toEqual(beforeLane);
    },
  );

  it.each([false, true])(
    'passes through a root refusal without overwriting an overlapping dirty root file (merge.autostash=%s)',
    async (autostash) => {
      git(root, 'config', 'merge.autostash', String(autostash));
      const lane = await service.create(projectId, leadId, { name: 'root-dirty' });
      await file(lane.path, 'file.txt', 'lane change\n');
      const committed = await service.commit(projectId, leadId, lane.name, 'lane');
      await file(root, 'file.txt', 'uncommitted root contents\n');
      const beforeRoot = await snapshot(root);
      const beforeLane = await snapshot(lane.path);
      await expect(
        service.merge(projectId, leadId, lane.name, committed.sha),
      ).rejects.toMatchObject({
        code: 'ROOT_REFUSED',
        details: { stderr: expect.stringContaining('local changes') },
      });
      expect(await snapshot(root)).toEqual(beforeRoot);
      expect(await snapshot(lane.path)).toEqual(beforeLane);
      expect(git(root, 'stash', 'list')).toBe('');
    },
  );

  it.each(['hook', 'identity', 'signing'])(
    'surfaces %s commit failure once with stderr and leaves HEAD unchanged',
    async (failure) => {
      const lane = await service.create(projectId, leadId, { name: 'failure' });
      await file(lane.path, 'file.txt', 'pending commit\n');
      if (failure === 'hook') {
        await file(
          directory,
          'hooks/pre-commit',
          '#!/bin/sh\nprintf "hook rejected fixture\\n" >&2\nexit 1\n',
        );
        await chmod(join(directory, 'hooks/pre-commit'), 0o755);
      } else if (failure === 'identity') {
        git(root, 'config', 'user.name', '');
      } else {
        git(root, 'config', 'commit.gpgsign', 'true');
        git(root, 'config', 'gpg.format', 'openpgp');
        git(root, 'config', 'gpg.program', '/nonexistent/devchain-fixture-signer');
      }
      const run = jest.spyOn(module.get(WorktreeGitRunner), 'run');
      await expect(
        service.commit(projectId, leadId, lane.name, 'attempt once'),
      ).rejects.toMatchObject({
        code: 'COMMIT_FAILED',
        details: {
          stderr: expect.stringMatching(
            failure === 'hook'
              ? /hook rejected fixture/
              : failure === 'identity'
                ? /ident|name|email/
                : /gpg|signer|sign/,
          ),
        },
      });
      expect(run.mock.calls.filter(([, args]) => args[0] === 'commit')).toHaveLength(1);
      expect(git(lane.path, 'rev-parse', 'HEAD')).toBe(lane.baseSha);
      expect(git(lane.path, 'diff', '--cached', '--name-only')).toBe('file.txt');
    },
  );

  describe('on a VM that syncs Git', () => {
    let coordinator: GitCoordinatorService;

    beforeEach(async () => {
      files.codeRoots.set(projectId, root);
      await files.ensureFolder({
        projectId,
        kind: 'git',
        type: 'sendonly',
        peerDeviceId: 'home',
        ignores: ['/worktrees'],
      });
      coordinator = module.get(GitCoordinatorService);
    });

    it('publishes the branches of managed and unmanaged linked worktrees', async () => {
      const lane = await service.create(projectId, leadId, { name: 'storage' });
      git(root, 'worktree', 'add', '-b', 'ci-check', join(directory, 'devchain-ci-1'));
      git(root, 'worktree', 'add', '--detach', join(directory, 'detached'));
      expect((await coordinator.status(projectId)).worktreeBranches).toEqual(
        [`refs/heads/${lane.branch}`, 'refs/heads/ci-check'].sort(),
      );
    });

    it('waits while the PC owns Git without holding the Git lock, then commits after the VM reclaims', async () => {
      const lane = await service.create(projectId, leadId, { name: 'waiting' });
      await file(lane.path, 'file.txt', 'lane change\n');
      const store = module.get(GitCoordinatorStore);
      const pcOwned = { ...store.read(projectId), owner: 'home' as const, homeName: 'my-PC' };
      store.write(projectId, { ...pcOwned, homeWrites: { write: Date.now() } });
      await files.updateFolder(`git:${projectId}`, { type: 'receiveonly' });
      let settled = false;
      const commit = service.commit(projectId, leadId, lane.name, 'after reclaim').finally(() => {
        settled = true;
      });
      await expect(service.listOnHost(projectId)).resolves.toMatchObject({
        lanes: [{ name: lane.name, dirty: true }],
      });
      expect(settled).toBe(false);
      // The PC confirms its write: the VM keeps its index snapshot and checkpoint.
      await module
        .get(GitCoordinatorIndexService)
        .save(projectId, await readFile(join(root, '.git/index')));
      store.write(projectId, {
        ...pcOwned,
        checkpoint: { writeId: 'write', generation: 0, refsDigest: 'refs', at: Date.now() },
      });
      const committed = await commit;
      expect(git(lane.path, 'log', '-1', '--format=%s')).toBe('after reclaim');
      expect(committed.files).toEqual(['file.txt']);
      expect(await coordinator.status(projectId)).toMatchObject({ owner: 'vm', generation: 1 });
    });

    it('holds one coordinator permit through the root fast-forward', async () => {
      const lane = await service.create(projectId, leadId, { name: 'landing' });
      await file(lane.path, 'file.txt', 'lane change\n');
      const committed = await service.commit(projectId, leadId, lane.name, 'lane change');
      const runner = module.get(WorktreeGitRunner);
      const run = runner.run.bind(runner);
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let reachMerge!: () => void;
      const reachedMerge = new Promise<void>((resolve) => {
        reachMerge = resolve;
      });
      jest.spyOn(runner, 'run').mockImplementation(async (path, args, options) => {
        if (args[0] === 'merge') {
          reachMerge();
          await released;
        }
        return run(path, args, options);
      });
      const order: string[] = [];
      const merged = service
        .merge(projectId, leadId, lane.name, committed.sha)
        .then(() => order.push('merged'));
      await reachedMerge;
      const handover = coordinator
        .beginHandover(projectId, {
          expectedGeneration: 0,
          transitionId: null,
          id: 'handover',
          homeName: 'my-PC',
        })
        .then(() => order.push('handover'));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(order).toEqual([]);
      release();
      await Promise.all([merged, handover]);
      expect(order).toEqual(['merged', 'handover']);
      expect(git(root, 'rev-parse', 'HEAD')).toBe(committed.sha);
    });
  });
});
