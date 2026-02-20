import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import Fastify, { FastifyInstance } from 'fastify';
import { AddressInfo } from 'node:net';
import { NormalAppModule } from '../../../../app.normal.module';
import { OrchestratorProxyModule } from '../orchestrator-proxy.module';
import { WorktreeRecord, WORKTREES_STORE, WorktreesStore } from '../../worktrees/worktrees.store';
import { OrchestratorProxyService } from './orchestrator-proxy.service';

jest.mock('../../../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

function buildWorktreeRecord(patch: Partial<WorktreeRecord> = {}): WorktreeRecord {
  const now = new Date();
  return {
    id: 'wt-1',
    name: 'feature-auth',
    branchName: 'feature/auth',
    baseBranch: 'main',
    repoPath: '/repo',
    worktreePath: '/repo/worktrees/feature-auth',
    containerId: 'container-1',
    containerPort: 41001,
    templateSlug: '3-agent-dev',
    ownerProjectId: 'project-1',
    status: 'running',
    description: null,
    devchainProjectId: 'project-1',
    mergeCommit: null,
    mergeConflicts: null,
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
    ...patch,
  };
}

describe('OrchestratorProxyService integration', () => {
  const originalDevchainMode = process.env.DEVCHAIN_MODE;

  let upstream: FastifyInstance;
  let app: NestFastifyApplication;
  let currentWorktree: WorktreeRecord | null;
  let store: jest.Mocked<Pick<WorktreesStore, 'getByName'>>;
  let upstreamPort = 0;

  beforeEach(async () => {
    process.env.DEVCHAIN_MODE = 'main';

    upstream = Fastify({ logger: false });
    upstream.get('/api/ping', async (request) => {
      return {
        ok: true,
        tracedWorktree: request.headers['x-worktree-name'] ?? null,
      };
    });
    await upstream.listen({ host: '127.0.0.1', port: 0 });
    upstreamPort = (upstream.server.address() as AddressInfo).port;

    currentWorktree = buildWorktreeRecord({
      name: 'feature-auth',
      containerPort: upstreamPort,
      status: 'running',
    });
    store = {
      getByName: jest.fn(async () => currentWorktree),
    };

    @Module({
      providers: [
        OrchestratorProxyService,
        {
          provide: WORKTREES_STORE,
          useValue: store,
        },
      ],
    })
    class ProxySmokeModule {}

    app = await NestFactory.create<NestFastifyApplication>(ProxySmokeModule, new FastifyAdapter(), {
      logger: false,
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await app?.close();
    await upstream?.close();

    if (originalDevchainMode === undefined) {
      delete process.env.DEVCHAIN_MODE;
    } else {
      process.env.DEVCHAIN_MODE = originalDevchainMode;
    }
  });

  it('bootstraps in main mode and proxies /wt/:name/api routes', async () => {
    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'GET',
        url: '/wt/feature-auth/api/ping',
        headers: {
          accept: 'application/json',
        },
      });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.payload)).toEqual({
      ok: true,
      tracedWorktree: 'feature-auth',
    });
  });

  it('returns unavailable response when worktree is stopped', async () => {
    currentWorktree = buildWorktreeRecord({
      name: 'feature-auth',
      containerPort: upstreamPort,
      status: 'stopped',
    });

    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'GET',
        url: '/wt/feature-auth/api/ping',
        headers: {
          accept: 'application/json',
        },
      });

    expect(response.statusCode).toBe(503);
    const payload = JSON.parse(response.payload) as { message?: string; worktreeName?: string };
    expect(payload.worktreeName).toBe('feature-auth');
    expect(payload.message).toContain('not running');
  });

  it('does not load proxy module in normal mode module imports', () => {
    const normalImports =
      (Reflect.getMetadata(MODULE_METADATA.IMPORTS, NormalAppModule) as unknown[]) ?? [];

    expect(normalImports).not.toContain(OrchestratorProxyModule);
  });
});
