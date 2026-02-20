import { HttpAdapterHost } from '@nestjs/core';
import { FastifyReply, FastifyRequest } from 'fastify';
import { WorktreeRecord, WorktreesStore } from '../../worktrees/worktrees.store';
import { OrchestratorProxyService } from './orchestrator-proxy.service';

jest.mock('../../../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

type ProxyPluginOptions = {
  preHandler: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  replyOptions: {
    getUpstream: (request: FastifyRequest, base: string) => string;
    rewriteRequestHeaders: (
      request: FastifyRequest,
      headers: Record<string, string>,
    ) => Record<string, string>;
  };
};

function buildWorktreeRow(
  patch: Partial<WorktreeRecord> = {},
  status: string = 'running',
  containerPort: number | null = 41001,
): WorktreeRecord {
  const now = new Date();
  return {
    id: 'wt-1',
    name: 'feature-auth',
    branchName: 'feature/auth',
    baseBranch: 'main',
    repoPath: '/repo',
    worktreePath: '/repo/worktrees/feature-auth',
    containerId: 'container-1',
    containerPort,
    templateSlug: '3-agent-dev',
    ownerProjectId: 'project-1',
    status,
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

function createReplyMock() {
  return {
    code: jest.fn().mockReturnThis(),
    type: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
    header: jest.fn().mockReturnThis(),
  };
}

describe('OrchestratorProxyService', () => {
  let register: jest.Mock;
  let store: jest.Mocked<Pick<WorktreesStore, 'getByName'>>;
  let service: OrchestratorProxyService;
  let options: ProxyPluginOptions;
  let server: {
    listeners: jest.Mock;
    removeListener: jest.Mock;
    on: jest.Mock;
  };

  beforeEach(async () => {
    register = jest.fn(async (_plugin, proxyOptions: ProxyPluginOptions) => {
      options = proxyOptions;
    });
    const proxyUpgradeHandler = jest.fn();
    server = {
      listeners: jest.fn().mockReturnValue([proxyUpgradeHandler]),
      removeListener: jest.fn(),
      on: jest.fn(),
    };

    const adapterHost = {
      httpAdapter: {
        getType: () => 'fastify',
        getInstance: () => ({ register, server }),
      },
    } as unknown as HttpAdapterHost;

    store = {
      getByName: jest.fn(),
    };

    service = new OrchestratorProxyService(adapterHost, store as unknown as WorktreesStore);

    await service.onModuleInit();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('registers http proxy with worktree prefix', () => {
    expect(register).toHaveBeenCalledTimes(1);
    expect(options).toBeDefined();
  });

  it('resolves running worktree upstream and injects tracing header', async () => {
    store.getByName.mockResolvedValue(buildWorktreeRow());

    const request = {
      params: { name: 'feature-auth' },
      headers: { accept: 'text/html' },
      url: '/wt/feature-auth/',
      raw: {},
    } as unknown as FastifyRequest;
    const reply = createReplyMock() as unknown as FastifyReply;

    await options.preHandler(request, reply);

    expect(store.getByName).toHaveBeenCalledWith('feature-auth');
    expect(options.replyOptions.getUpstream(request, '')).toBe('http://127.0.0.1:41001');
    expect(options.replyOptions.rewriteRequestHeaders(request, {})).toMatchObject({
      'x-worktree-name': 'feature-auth',
    });
    expect((reply as unknown as ReturnType<typeof createReplyMock>).send).not.toHaveBeenCalled();
  });

  it('returns html unavailable page for stopped worktree ui routes', async () => {
    store.getByName.mockResolvedValue(buildWorktreeRow({}, 'stopped', 41001));

    const request = {
      params: { name: 'feature-auth' },
      headers: { accept: 'text/html' },
      url: '/wt/feature-auth/',
      raw: {},
    } as unknown as FastifyRequest;
    const replyMock = createReplyMock();

    await options.preHandler(request, replyMock as unknown as FastifyReply);

    expect(replyMock.code).toHaveBeenCalledWith(503);
    expect(replyMock.type).toHaveBeenCalledWith('text/html; charset=utf-8');
    expect(replyMock.send).toHaveBeenCalledWith(expect.stringContaining('Worktree unavailable'));
  });

  it('returns json unavailable payload for api routes', async () => {
    store.getByName.mockResolvedValue(buildWorktreeRow({}, 'stopped', 41001));

    const request = {
      params: { name: 'feature-auth' },
      headers: { accept: 'application/json' },
      url: '/wt/feature-auth/api/projects',
      raw: {},
    } as unknown as FastifyRequest;
    const replyMock = createReplyMock();

    await options.preHandler(request, replyMock as unknown as FastifyReply);

    expect(replyMock.code).toHaveBeenCalledWith(503);
    expect(replyMock.send).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 503,
        worktreeName: 'feature-auth',
      }),
    );
  });

  it('returns 404 when worktree is unknown', async () => {
    store.getByName.mockResolvedValue(null);

    const request = {
      params: { name: 'missing-worktree' },
      headers: { accept: 'application/json' },
      url: '/wt/missing-worktree/api/projects',
      raw: {},
    } as unknown as FastifyRequest;
    const replyMock = createReplyMock();

    await options.preHandler(request, replyMock as unknown as FastifyReply);

    expect(replyMock.code).toHaveBeenCalledWith(404);
    expect(replyMock.send).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 404,
      }),
    );
  });
});
