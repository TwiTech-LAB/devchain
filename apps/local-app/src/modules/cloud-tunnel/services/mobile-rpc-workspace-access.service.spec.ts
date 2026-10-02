import { AppError, ForbiddenError, NotFoundError } from '../../../common/errors/error-types';
import { DEFAULT_PROJECT_WORKSPACE_ID } from '../../storage/db/schema';
import { MOBILE_RPC_METHODS } from './mobile-rpc-contract.generated';
import {
  MOBILE_RPC_WORKSPACE_SCOPES,
  MobileRpcWorkspaceAccessService,
} from './mobile-rpc-workspace-access.service';
import { TunnelHandlerService } from './tunnel-handler.service';

const WORKSPACE_A = DEFAULT_PROJECT_WORKSPACE_ID;
const WORKSPACE_B = '20000000-0000-4000-8000-000000000002';
const PROJECT_A = '30000000-0000-4000-8000-000000000001';
const PROJECT_B = '30000000-0000-4000-8000-000000000002';
const STATUS_B = '40000000-0000-4000-8000-000000000002';
const EPIC_B = '50000000-0000-4000-8000-000000000002';
const SUBSCRIPTION_B = 'vp-b';

function createAccessHarness(options?: {
  multiWorkspaceMode?: boolean;
  failClosedPending?: boolean;
}) {
  const storage = {
    getProject: jest.fn(async (projectId: string) => ({
      id: projectId,
      workspaceId: projectId === PROJECT_A ? WORKSPACE_A : WORKSPACE_B,
    })),
    getEpic: jest.fn(async () => ({ id: EPIC_B, projectId: PROJECT_B })),
    getStatus: jest.fn(async () => ({ id: STATUS_B, projectId: PROJECT_B })),
  };
  const workspaceMode = {
    getSnapshot: jest.fn(async () => ({
      multiWorkspaceMode: options?.multiWorkspaceMode ?? true,
      failClosedPending: options?.failClosedPending ?? false,
    })),
  };
  const deviceAccess = {
    getAccess: jest.fn((kid: string) => ({
      kid,
      explicit: true,
      workspaceIds: kid === 'kid-a' ? [WORKSPACE_A] : [WORKSPACE_B],
    })),
  };
  const keypair = { exportPublic: jest.fn(async () => ({ kid: 'pc-kid', publicKeyB64: 'key' })) };
  const viewport = {
    resolveSubscriptionProjectId: jest.fn(async () => PROJECT_B),
  };
  const service = new MobileRpcWorkspaceAccessService(
    storage as never,
    workspaceMode as never,
    deviceAccess as never,
    keypair as never,
    viewport as never,
  );
  return { service, storage, workspaceMode, deviceAccess, keypair, viewport };
}

describe('MobileRpcWorkspaceAccessService classification', () => {
  it('classifies every one of the 39 non-E2EE methods exactly once', () => {
    const nonE2eeMethods = MOBILE_RPC_METHODS.filter((method) => !method.startsWith('e2ee.'));
    expect(Object.keys(MOBILE_RPC_WORKSPACE_SCOPES)).toEqual(nonE2eeMethods);
    expect(nonE2eeMethods).toHaveLength(39);

    const scopes = Object.values(MOBILE_RPC_WORKSPACE_SCOPES);
    expect(scopes.filter((scope) => scope === 'projectId')).toHaveLength(33);
    expect(
      scopes.filter((scope) =>
        ['parentId', 'statusId-or-projectId', 'epicId', 'subscriptionId'].includes(scope),
      ),
    ).toHaveLength(4);
    expect(
      scopes.filter((scope) => ['authorized-workspaces', 'authorized-projects'].includes(scope)),
    ).toHaveLength(2);
  });

  it('preserves the unrestricted plaintext path while exactly one workspace is stable', async () => {
    const harness = createAccessHarness({ multiWorkspaceMode: false });

    await expect(
      harness.service.authorize('chat.listAgents', { projectId: PROJECT_B }),
    ).resolves.toEqual({ allowedWorkspaceIds: null });
    expect(harness.keypair.exportPublic).not.toHaveBeenCalled();
    expect(harness.deviceAccess.getAccess).not.toHaveBeenCalled();
    expect(harness.storage.getProject).not.toHaveBeenCalled();
  });

  it('requires the verified sender during multi-workspace and pending transitions', async () => {
    const multi = createAccessHarness();
    await expect(
      multi.service.authorize('chat.listAgents', { projectId: PROJECT_A }),
    ).rejects.toMatchObject<Partial<AppError>>({ code: 'WORKSPACE_DEVICE_PAIRING_REQUIRED' });

    const pending = createAccessHarness({ multiWorkspaceMode: false, failClosedPending: true });
    await expect(
      pending.service.authorize('chat.listAgents', { projectId: PROJECT_A }),
    ).rejects.toMatchObject<Partial<AppError>>({ code: 'WORKSPACE_DEVICE_PAIRING_REQUIRED' });
  });

  it('distinguishes desktop encryption unavailability from an outdated or unpaired phone', async () => {
    const harness = createAccessHarness();
    harness.keypair.exportPublic.mockRejectedValueOnce(new Error('secure storage unavailable'));

    await expect(
      harness.service.authorize('chat.listAgents', { projectId: PROJECT_A }),
    ).rejects.toMatchObject<Partial<AppError>>({ code: 'WORKSPACE_E2EE_UNAVAILABLE' });
  });

  it('treats an unknown verified sender key as a re-pair requirement without exposing it', async () => {
    const harness = createAccessHarness();
    harness.deviceAccess.getAccess.mockImplementationOnce(() => {
      throw new NotFoundError('E2EE device', 'unknown-kid');
    });

    await expect(
      harness.service.authorize(
        'chat.listAgents',
        { projectId: PROJECT_A },
        { senderKid: 'unknown-kid' },
      ),
    ).rejects.toMatchObject<Partial<AppError>>({
      code: 'WORKSPACE_DEVICE_PAIRING_REQUIRED',
      details: undefined,
    });
  });

  it('uses inverse device subsets for direct board, chat, and terminal scopes', async () => {
    const harness = createAccessHarness();
    const directCalls = [
      ['board.listStatuses', { projectId: PROJECT_A }],
      ['chat.listAgents', { projectId: PROJECT_A }],
      ['terminal.sendKey', { projectId: PROJECT_A }],
    ] as const;

    for (const [method, params] of directCalls) {
      await expect(
        harness.service.authorize(method, params, { senderKid: 'kid-a' }),
      ).resolves.toBeDefined();
      await expect(
        harness.service.authorize(method, params, { senderKid: 'kid-b' }),
      ).rejects.toMatchObject<Partial<ForbiddenError>>({
        code: 'forbidden',
        message: 'Workspace access denied',
        details: undefined,
      });
    }
  });

  it('derives and denies foreign parent, status, epic, and subscription identifiers', async () => {
    const harness = createAccessHarness();
    const derivedCalls = [
      ['board.listParentChildren', { parentId: EPIC_B }],
      ['board.listEpicsByStatus', { statusId: STATUS_B }],
      ['board.getEpicDetail', { epicId: EPIC_B }],
      ['terminal.viewport.unsubscribe', { subscriptionId: SUBSCRIPTION_B }],
    ] as const;

    for (const [method, params] of derivedCalls) {
      await expect(
        harness.service.authorize(method, params, { senderKid: 'kid-a' }),
      ).rejects.toMatchObject({ message: 'Workspace access denied', details: undefined });
    }
    expect(harness.viewport.resolveSubscriptionProjectId).toHaveBeenCalledWith(SUBSCRIPTION_B);
  });

  it('authorizes only the effective workspace subset for both list methods', async () => {
    const harness = createAccessHarness();

    const workspacesA = await harness.service.authorize(
      'board.listWorkspaces',
      {},
      { senderKid: 'kid-a' },
    );
    expect([...workspacesA.allowedWorkspaceIds!]).toEqual([WORKSPACE_A]);

    await expect(
      harness.service.authorize('board.listProjects', {}, { senderKid: 'kid-a' }),
    ).resolves.toMatchObject({ projectListWorkspaceId: WORKSPACE_A });
    await expect(
      harness.service.authorize(
        'board.listProjects',
        { workspaceId: WORKSPACE_B },
        { senderKid: 'kid-a' },
      ),
    ).rejects.toMatchObject({ message: 'Workspace access denied' });

    await expect(
      harness.service.authorize(
        'board.listProjects',
        { workspaceId: WORKSPACE_B },
        { senderKid: 'kid-b' },
      ),
    ).resolves.toMatchObject({ projectListWorkspaceId: WORKSPACE_B });
    await expect(
      harness.service.authorize('board.listProjects', {}, { senderKid: 'kid-b' }),
    ).rejects.toMatchObject({ message: 'Workspace access denied' });
  });

  it('re-resolves a project workspace on every call so moves take effect immediately', async () => {
    const harness = createAccessHarness();
    harness.storage.getProject
      .mockResolvedValueOnce({ id: PROJECT_A, workspaceId: WORKSPACE_A })
      .mockResolvedValueOnce({ id: PROJECT_A, workspaceId: WORKSPACE_B });

    await expect(
      harness.service.authorize(
        'chat.listAgents',
        { projectId: PROJECT_A },
        { senderKid: 'kid-a' },
      ),
    ).resolves.toBeDefined();
    await expect(
      harness.service.authorize(
        'chat.listAgents',
        { projectId: PROJECT_A },
        { senderKid: 'kid-a' },
      ),
    ).rejects.toMatchObject({ message: 'Workspace access denied' });
    expect(harness.storage.getProject).toHaveBeenCalledTimes(2);
  });

  it('does not disclose whether an unresolved identifier exists', async () => {
    const harness = createAccessHarness();
    harness.storage.getEpic.mockRejectedValueOnce(new NotFoundError('Epic', EPIC_B));

    await expect(
      harness.service.authorize('board.getEpicDetail', { epicId: EPIC_B }, { senderKid: 'kid-a' }),
    ).rejects.toEqual(
      expect.objectContaining({ message: 'Workspace access denied', details: undefined }),
    );
  });
});

describe('TunnelHandlerService workspace pre-dispatch integration', () => {
  function createHandler(
    storage: Record<string, jest.Mock>,
    workspaceAccess: { authorize: jest.Mock },
  ) {
    const mobileChat = { listAgents: jest.fn() };
    const mobileBoard = {};
    const viewport = { unsubscribe: jest.fn() };
    const terminalKey = { sendKey: jest.fn() };
    const handler = new TunnelHandlerService(
      storage,
      mobileChat as never,
      mobileBoard as never,
      viewport as never,
      {} as never,
      terminalKey as never,
      {} as never,
      workspaceAccess as never,
    );
    return { handler, mobileChat, viewport, terminalKey };
  }

  it('runs params validation before workspace authorization', async () => {
    const workspaceAccess = { authorize: jest.fn() };
    const { handler } = createHandler({}, workspaceAccess);

    const response = await handler.handle({
      jsonrpc: '2.0',
      id: 'invalid',
      method: 'chat.listAgents',
      params: { projectId: 'not-a-uuid' },
    });

    expect(response.error?.code).toBe(-32602);
    expect(workspaceAccess.authorize).not.toHaveBeenCalled();
  });

  it('fails closed outside tests if the authorization provider is unavailable', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const handler = new TunnelHandlerService(
        {},
        { listAgents: jest.fn() } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
      );
      const response = await handler.handle({
        jsonrpc: '2.0',
        id: 'missing-gate',
        method: 'chat.listAgents',
        params: { projectId: PROJECT_A },
      });
      expect(response.error).toEqual({
        code: -32603,
        message: 'Mobile RPC workspace authorization is unavailable',
      });
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
  });

  it('filters ordered workspace results and keeps authorized empty workspaces', async () => {
    const storage = {
      listProjectWorkspaces: jest.fn(async () => [
        {
          id: WORKSPACE_A,
          name: 'Default',
          isDefault: true,
          position: 0,
          projectCount: 4,
        },
        {
          id: WORKSPACE_B,
          name: 'Empty authorized workspace',
          isDefault: false,
          position: 1,
          projectCount: 0,
        },
      ]),
    };
    const workspaceAccess = {
      authorize: jest.fn(async () => ({ allowedWorkspaceIds: new Set([WORKSPACE_B]) })),
    };
    const { handler } = createHandler(storage, workspaceAccess);

    const response = await handler.handle({
      jsonrpc: '2.0',
      id: 'workspaces',
      method: 'board.listWorkspaces',
      params: {},
    });

    expect(response.result).toEqual([
      {
        id: WORKSPACE_B,
        name: 'Empty authorized workspace',
        isDefault: false,
        position: 1,
        projectCount: 0,
      },
    ]);
  });

  it('defaults legacy project listings to Default and honors an explicit workspace only', async () => {
    const storage = { listProjects: jest.fn(async () => ({ items: [], total: 0 })) };
    const workspaceAccess = {
      authorize: jest
        .fn()
        .mockResolvedValueOnce({
          allowedWorkspaceIds: new Set([WORKSPACE_A]),
          projectListWorkspaceId: WORKSPACE_A,
        })
        .mockResolvedValueOnce({
          allowedWorkspaceIds: new Set([WORKSPACE_B]),
          projectListWorkspaceId: WORKSPACE_B,
        }),
    };
    const { handler } = createHandler(storage, workspaceAccess);

    await handler.handle({ jsonrpc: '2.0', id: 'old', method: 'board.listProjects', params: {} });
    await handler.handle({
      jsonrpc: '2.0',
      id: 'new',
      method: 'board.listProjects',
      params: { workspaceId: WORKSPACE_B },
    });

    expect(storage.listProjects).toHaveBeenNthCalledWith(1, { workspaceId: WORKSPACE_A });
    expect(storage.listProjects).toHaveBeenNthCalledWith(2, { workspaceId: WORKSPACE_B });
  });

  it('returns an authorization error before board, chat, or terminal domain handlers run', async () => {
    const denial = new ForbiddenError('Workspace access denied');
    const workspaceAccess = { authorize: jest.fn(async () => Promise.reject(denial)) };
    const storage = { listStatuses: jest.fn() };
    const { handler, mobileChat, terminalKey } = createHandler(storage, workspaceAccess);
    const requests = [
      ['board.listStatuses', { projectId: PROJECT_B }],
      ['chat.listAgents', { projectId: PROJECT_B }],
      ['terminal.sendKey', { projectId: PROJECT_B, sessionId: PROJECT_A, key: 'Enter' }],
    ] as const;

    for (const [method, params] of requests) {
      const response = await handler.handle({ jsonrpc: '2.0', id: method, method, params });
      expect(response.error).toMatchObject({
        message: 'Workspace access denied',
        data: { code: 'forbidden' },
      });
    }
    expect(storage.listStatuses).not.toHaveBeenCalled();
    expect(mobileChat.listAgents).not.toHaveBeenCalled();
    expect(terminalKey.sendKey).not.toHaveBeenCalled();
  });
});
