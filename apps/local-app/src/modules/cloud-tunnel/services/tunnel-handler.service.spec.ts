import { TunnelHandlerService } from './tunnel-handler.service';
import { MobileChatRpcService } from './mobile-chat-rpc.service';
import { MobileBoardRpcService } from './mobile-board-rpc.service';
import { ViewportStreamerService } from './viewport-streamer.service';
import { E2eeTrustService } from '../../e2ee/services/e2ee-trust.service';
import { ActiveSessionLookup } from '../../sessions/services/active-session-lookup.service';
import { TerminalKeyInputFacade } from '../../terminal/services/terminal-key-input/terminal-key-input.facade';
import { ProjectWriteAdmissionService } from '../../remotes/admission/project-write-admission.service';
import { NotFoundError } from '../../../common/errors/error-types';

jest.mock('../../../common/logging/logger', () => {
  const testLogger = {
    child: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  };
  testLogger.child.mockReturnValue(testLogger);
  return { logger: testLogger, createLogger: () => testLogger };
});

describe('TunnelHandlerService', () => {
  const mockedLogger = jest.requireMock('../../../common/logging/logger').logger as {
    error: jest.Mock;
  };
  // board.* read handlers never touch the seam services; bare stubs suffice for
  // those tests. The board.* mutation tests inject a purpose-built mobileBoard.
  const mobileChat = {} as MobileChatRpcService;
  const mobileBoard = {} as MobileBoardRpcService;
  // Viewport lease control is not exercised by these board/chat tests; a bare stub
  // suffices. The viewport RPC delegation is covered in its own describe block below.
  const mobileViewport = {} as ViewportStreamerService;
  // Only the terminal.sendKey tests reach these collaborators; they build their own handler.
  const terminalKeyInputStub = {} as TerminalKeyInputFacade;
  const activeSessionsStub = {} as ActiveSessionLookup;
  const buildHandler = (
    storage: object = {},
    {
      chat = mobileChat,
      board = mobileBoard,
      viewport = mobileViewport,
      e2eeTrust = {} as E2eeTrustService,
    }: {
      chat?: MobileChatRpcService;
      board?: MobileBoardRpcService;
      viewport?: ViewportStreamerService;
      e2eeTrust?: E2eeTrustService;
    } = {},
  ) =>
    new TunnelHandlerService(
      storage,
      chat,
      board,
      viewport,
      e2eeTrust,
      terminalKeyInputStub,
      activeSessionsStub,
    );
  const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
  const STATUS_ID = '22222222-2222-4222-8222-222222222222';
  const STATUS_ID_2 = '12121212-1212-4212-8212-121212121212';
  const OTHER_PROJECT_ID = '33333333-3333-4333-8333-333333333333';
  const EPIC_ID = '44444444-4444-4444-8444-444444444444';
  const AGENT_ID = '55555555-5555-4555-8555-555555555555';
  const PARENT_ID = '66666666-6666-4666-8666-666666666666';
  const PARENT_ID_2 = '77777777-7777-4777-8777-777777777777';
  const CHILD_ID = '88888888-8888-4888-8888-888888888888';
  const CHILD_ID_2 = '99999999-9999-4999-8999-999999999999';
  const OPERATION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const COMMENT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const ISO = '2026-05-10T18:00:00.000Z';

  const makeEpic = (overrides: Record<string, unknown> = {}) => ({
    id: EPIC_ID,
    projectId: PROJECT_ID,
    title: 'Fix mobile board',
    statusId: STATUS_ID,
    agentId: null,
    parentId: null,
    version: 1,
    updatedAt: ISO,
    description: null,
    createdAt: ISO,
    tags: [],
    ...overrides,
  });

  const transcriptMetrics = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    totalContextConsumption: 0,
    compactionCount: 0,
    phaseBreakdowns: [],
    visibleContextTokens: 0,
    totalContextTokens: 0,
    contextWindowTokens: 200_000,
    costUsd: 0,
    primaryModel: 'codex',
    durationMs: 0,
    messageCount: 0,
    isOngoing: false,
  };

  const makeTranscriptChunk = () => ({
    id: 'chunk-1',
    type: 'ai' as const,
    startTime: new Date('2026-05-10T18:00:00.000Z'),
    endTime: new Date('2026-05-10T18:00:01.000Z'),
    messages: [
      {
        id: 'message-1',
        parentId: null,
        role: 'assistant' as const,
        timestamp: new Date('2026-05-10T18:00:00.000Z'),
        content: [{ type: 'text' as const, text: 'Done' }],
        toolCalls: [],
        toolResults: [],
        isMeta: false,
        isSidechain: false,
      },
    ],
    metrics: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 0,
      messageCount: 1,
      durationMs: 1000,
      costUsd: 0,
    },
    semanticSteps: [
      {
        id: 'step-1',
        type: 'output' as const,
        startTime: new Date('2026-05-10T18:00:00.500Z'),
        durationMs: 500,
        content: { outputText: 'Done' },
        context: 'main' as const,
      },
    ],
    turns: [
      {
        id: 'turn-1',
        assistantMessageId: 'message-1',
        timestamp: new Date('2026-05-10T18:00:00.000Z'),
        steps: [
          {
            id: 'turn-step-1',
            type: 'thinking' as const,
            startTime: new Date('2026-05-10T18:00:00.250Z'),
            durationMs: 250,
            content: { thinkingText: 'Working' },
            context: 'main' as const,
          },
        ],
        summary: { thinkingCount: 1, toolCallCount: 0, subagentCount: 0, outputCount: 1 },
        durationMs: 1000,
        additiveTurnField: 'preserved',
      },
    ],
    additiveChunkField: 'preserved',
  });

  it('returns mobile board DTOs and uses parent-only project counts for status counts', async () => {
    const storage = {
      listProjects: jest.fn().mockResolvedValue({
        items: [{ id: PROJECT_ID, name: 'Project One', rootPath: '/tmp/project-one' }],
        total: 1,
      }),
      listStatuses: jest.fn().mockResolvedValue({
        items: [{ id: STATUS_ID, label: 'Todo', color: '#123456', position: 1 }],
        total: 1,
      }),
      listProjectEpics: jest.fn().mockResolvedValue({
        items: [{ id: PARENT_ID }],
        total: 7,
        limit: 1,
        offset: 0,
      }),
      listEpicsByStatus: jest.fn(),
    };
    const service = buildHandler(storage);

    await expect(
      service.handle({ jsonrpc: '2.0', id: '1', method: 'board.listProjects', params: {} }),
    ).resolves.toMatchObject({
      result: [{ id: PROJECT_ID, name: 'Project One' }],
    });

    await expect(
      service.handle({
        jsonrpc: '2.0',
        id: '2',
        method: 'board.listStatuses',
        params: { projectId: PROJECT_ID },
      }),
    ).resolves.toMatchObject({
      result: [
        {
          status: { id: STATUS_ID, name: 'Todo', color: '#123456', position: 1 },
          epicCount: 7,
        },
      ],
    });

    expect(storage.listProjectEpics).toHaveBeenCalledWith(PROJECT_ID, {
      statusId: STATUS_ID,
      parentOnly: true,
      limit: 1,
      offset: 0,
    });
    expect(storage.listEpicsByStatus).not.toHaveBeenCalled();
  });

  // Remote-owned projects: home holds only a stale mirror; the phone reaches the
  // live project on the host instance. Service unit tests prove the filter and
  // the not-found shape without a tunnel or a paired device.

  it('routes delegating chat, board and viewport methods to their same-named seam', async () => {
    const session = { projectId: PROJECT_ID, sessionId: AGENT_ID };
    const agent = { projectId: PROJECT_ID, agentId: AGENT_ID };
    const epic = { projectId: PROJECT_ID, epicId: EPIC_ID };
    // Explicit method inventory; detailed transcript projection assertions remain below.
    const routes: Array<{
      method: string;
      seam: 'chat' | 'board' | 'viewport';
      params: Record<string, unknown>;
      context?: boolean;
    }> = [
      { method: 'chat.listAgents', seam: 'chat', params: { projectId: PROJECT_ID } },
      { method: 'chat.listTeams', seam: 'chat', params: { projectId: PROJECT_ID } },
      { method: 'chat.listProfiles', seam: 'chat', params: { projectId: PROJECT_ID } },
      {
        method: 'chat.listProfileConfigs',
        seam: 'chat',
        params: { projectId: PROJECT_ID, profileId: AGENT_ID },
      },
      {
        method: 'chat.createTeamAgent',
        seam: 'chat',
        params: {
          projectId: PROJECT_ID,
          teamId: EPIC_ID,
          name: 'Agent',
          providerConfigId: AGENT_ID,
        },
      },
      {
        method: 'chat.createIndependentAgent',
        seam: 'chat',
        params: {
          projectId: PROJECT_ID,
          name: 'Agent',
          profileId: EPIC_ID,
          providerConfigId: AGENT_ID,
        },
      },
      { method: 'chat.deleteAgent', seam: 'chat', params: agent },
      { method: 'chat.getTranscriptSummary', seam: 'chat', params: session },
      { method: 'chat.getTranscriptChunks', seam: 'chat', params: session },
      { method: 'chat.getTranscriptTail', seam: 'chat', params: { ...session, since: 'cursor-1' } },
      { method: 'chat.listCustomPrompts', seam: 'chat', params: session },
      { method: 'chat.getCustomPrompt', seam: 'chat', params: { ...session, promptId: EPIC_ID } },
      {
        method: 'chat.sendMessage',
        seam: 'chat',
        params: { ...agent, text: 'Hello' },
        context: true,
      },
      {
        method: 'chat.getPendingMessages',
        seam: 'chat',
        params: { ...agent, clientMessageIds: [OPERATION_ID] },
      },
      { method: 'chat.launchAgent', seam: 'chat', params: agent },
      { method: 'chat.restartAgent', seam: 'chat', params: agent },
      { method: 'chat.restoreSession', seam: 'chat', params: session },
      { method: 'chat.terminateSession', seam: 'chat', params: session },
      {
        method: 'chat.getOperationStatus',
        seam: 'chat',
        params: { projectId: PROJECT_ID, operationId: OPERATION_ID },
      },
      { method: 'chat.getAgentStatus', seam: 'chat', params: agent },
      { method: 'chat.listPendingAskQuestions', seam: 'chat', params: session },
      { method: 'chat.listSessions', seam: 'chat', params: agent },
      { method: 'chat.deleteSessionRecord', seam: 'chat', params: session },
      { method: 'chat.renameSession', seam: 'chat', params: { ...session, name: 'Renamed' } },
      {
        method: 'board.updateEpicAssignment',
        seam: 'board',
        params: { ...epic, agentId: AGENT_ID, version: 1 },
      },
      { method: 'board.listEpicComments', seam: 'board', params: epic },
      {
        method: 'board.addEpicComment',
        seam: 'board',
        params: { ...epic, authorName: 'User', content: 'Comment' },
      },
      {
        method: 'board.deleteEpicComment',
        seam: 'board',
        params: { ...epic, commentId: COMMENT_ID },
      },
      { method: 'terminal.viewport.subscribe', seam: 'viewport', params: session, context: true },
      {
        method: 'terminal.viewport.unsubscribe',
        seam: 'viewport',
        params: { subscriptionId: 'lease-1' },
        context: true,
      },
    ];

    const createdAgent = {
      id: AGENT_ID,
      name: 'Agent',
      profileId: EPIC_ID,
      providerConfigId: AGENT_ID,
      description: null,
      teamId: null,
    };
    const results: Record<string, unknown> = {
      'chat.listAgents': [],
      'chat.listTeams': [],
      'chat.listProfiles': [],
      'chat.listProfileConfigs': [],
      'chat.createTeamAgent': createdAgent,
      'chat.createIndependentAgent': createdAgent,
      'chat.deleteAgent': { deleted: true },
      'chat.getTranscriptSummary': {
        sessionId: AGENT_ID,
        providerName: 'claude',
        metrics: transcriptMetrics,
        messageCount: 0,
        isOngoing: false,
        cursor: 'summary-cursor',
      },
      'chat.getTranscriptChunks': { chunks: [], nextCursor: null, prevCursor: null, totalCount: 0 },
      'chat.getTranscriptTail': null,
      'chat.listCustomPrompts': [],
      'chat.getCustomPrompt': { id: EPIC_ID, title: 'Prompt', content: 'Content' },
      'chat.sendMessage': { status: 'queued' },
      'chat.getPendingMessages': [],
      'chat.launchAgent': { operationId: OPERATION_ID, status: 'launching' },
      'chat.restartAgent': { operationId: OPERATION_ID, status: 'restarting' },
      'chat.restoreSession': { operationId: OPERATION_ID, status: 'restoring' },
      'chat.terminateSession': { status: 'terminated' },
      'chat.getOperationStatus': {
        operationId: OPERATION_ID,
        type: 'launch',
        agentId: AGENT_ID,
        sessionId: null,
        projectId: PROJECT_ID,
        status: 'pending',
        createdAt: ISO,
        updatedAt: ISO,
      },
      'chat.getAgentStatus': null,
      'chat.listPendingAskQuestions': [],
      'chat.listSessions': { items: [], nextCursor: null, hasMore: false, total: 0 },
      'chat.deleteSessionRecord': { deleted: true },
      'chat.renameSession': {
        id: AGENT_ID,
        epicId: null,
        agentId: AGENT_ID,
        tmuxSessionId: null,
        status: 'stopped',
        startedAt: ISO,
        endedAt: ISO,
        createdAt: ISO,
        updatedAt: ISO,
        name: 'Renamed',
      },
      'board.updateEpicAssignment': makeEpic(),
      'board.listEpicComments': { items: [], total: 0, limit: 20, offset: 0 },
      'board.addEpicComment': {
        id: COMMENT_ID,
        epicId: EPIC_ID,
        authorName: 'User',
        content: 'Comment',
        createdAt: ISO,
        updatedAt: ISO,
      },
      'board.deleteEpicComment': { deleted: true },
      'terminal.viewport.subscribe': { subscriptionId: 'lease-1' },
      'terminal.viewport.unsubscribe': { ok: true },
    };
    const cryptoContext = { senderKid: 'phone-kid' };
    for (const { method, seam, params, context } of routes) {
      const name = method.slice(method.lastIndexOf('.') + 1);
      const result = results[method];
      const delegate = jest.fn().mockResolvedValue(result);
      const seams = { [seam]: { [name]: delegate } };
      const service = buildHandler(
        {},
        seams as {
          chat?: MobileChatRpcService;
          board?: MobileBoardRpcService;
          viewport?: ViewportStreamerService;
        },
      );
      expect(
        await service.handle({ jsonrpc: '2.0', id: method, method, params }, cryptoContext),
      ).toEqual({ jsonrpc: '2.0', id: method, result });
      expect(delegate).toHaveBeenCalledTimes(1);
      expect(delegate).toHaveBeenCalledWith(...(context ? [params, cryptoContext] : [params]));
    }
  });
  describe('remote-owned projects', () => {
    const BOUND_PROJECT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const admission = {
      listRemoteOwnedProjectIds: () => [BOUND_PROJECT_ID],
      getRemoteOwner: (projectId: string) =>
        projectId === BOUND_PROJECT_ID
          ? { projectId, remoteId: 'r1', remoteName: 'lab-vm', state: 'remote' }
          : null,
    } as unknown as ProjectWriteAdmissionService;

    function makeService(storage: Record<string, jest.Mock>): TunnelHandlerService {
      return new TunnelHandlerService(
        storage,
        mobileChat,
        mobileBoard,
        mobileViewport,
        {} as E2eeTrustService,
        terminalKeyInputStub,
        activeSessionsStub,
        undefined,
        admission,
      );
    }

    it.each([
      ['default workspace (single-workspace path)', {}],
      ['explicit workspaceId (multi-workspace path)', { workspaceId: OTHER_PROJECT_ID }],
    ])('board.listProjects omits bound projects via %s', async (_label, extraParams) => {
      const storage = {
        listProjects: jest.fn().mockResolvedValue({
          items: [
            { id: PROJECT_ID, name: 'Local Project' },
            { id: BOUND_PROJECT_ID, name: 'Moved Project' },
          ],
          total: 2,
        }),
      };
      const service = makeService(storage);

      await expect(
        service.handle({
          jsonrpc: '2.0',
          id: 'p1',
          method: 'board.listProjects',
          params: extraParams,
        }),
      ).resolves.toMatchObject({
        // The returned array length is the total the phone sees.
        result: [{ id: PROJECT_ID, name: 'Local Project' }],
      });
    });

    type NotFoundCase = [
      method: string,
      params: Record<string, unknown>,
      makeStorage: () => Record<string, jest.Mock>,
      assertNoMirrorRead: (storage: Record<string, jest.Mock>) => void,
    ];
    const notFoundCases: NotFoundCase[] = [
      [
        'board.listStatuses',
        { projectId: BOUND_PROJECT_ID },
        () => ({ listStatuses: jest.fn() }),
        (storage) => expect(storage.listStatuses).not.toHaveBeenCalled(),
      ],
      [
        'board.listParentEpics',
        { projectId: BOUND_PROJECT_ID },
        () => ({ listProjectEpics: jest.fn() }),
        (storage) => expect(storage.listProjectEpics).not.toHaveBeenCalled(),
      ],
      [
        'board.listEpicsByStatus',
        { statusId: STATUS_ID },
        () => ({
          getStatus: jest.fn().mockResolvedValue({ id: STATUS_ID, projectId: BOUND_PROJECT_ID }),
          listEpicsByStatus: jest.fn(),
        }),
        (storage) => expect(storage.listEpicsByStatus).not.toHaveBeenCalled(),
      ],
      [
        'board.listParentChildren',
        { parentId: PARENT_ID },
        () => ({
          getEpic: jest.fn().mockResolvedValue(makeEpic({ projectId: BOUND_PROJECT_ID })),
          listParentChildren: jest.fn(),
        }),
        (storage) => expect(storage.listParentChildren).not.toHaveBeenCalled(),
      ],
      [
        'board.getEpicDetail',
        { epicId: EPIC_ID },
        () => ({
          getEpic: jest.fn().mockResolvedValue(makeEpic({ projectId: BOUND_PROJECT_ID })),
          listStatuses: jest.fn(),
        }),
        (storage) => expect(storage.listStatuses).not.toHaveBeenCalled(),
      ],
    ];

    it.each(notFoundCases)(
      '%s for a bound project answers not-found without reading the mirror',
      async (method, params, makeStorage, assertNoMirrorRead) => {
        const storage = makeStorage();
        const service = makeService(storage);

        await expect(
          service.handle({ jsonrpc: '2.0', id: 'nf', method, params }),
        ).resolves.toMatchObject({
          error: { code: -32603, data: { code: 'not_found' } },
        });
        assertNoMirrorRead(storage);
      },
    );

    it('board.listProjects with includeRemotePlaceholders appends bound projects as placeholders', async () => {
      const storage = {
        listProjects: jest.fn().mockResolvedValue({
          items: [
            { id: PROJECT_ID, name: 'Local Project', workspaceId: OTHER_PROJECT_ID },
            { id: BOUND_PROJECT_ID, name: 'Moved Project', workspaceId: OTHER_PROJECT_ID },
          ],
          total: 2,
        }),
      };
      const service = makeService(storage);

      await expect(
        service.handle({
          jsonrpc: '2.0',
          id: 'p2',
          method: 'board.listProjects',
          params: { includeRemotePlaceholders: true },
        }),
      ).resolves.toMatchObject({
        // Real rows first, the placeholder appended; the placeholder carries
        // the owning remote and the workspace, never project data.
        result: [
          { id: PROJECT_ID, name: 'Local Project', workspaceId: OTHER_PROJECT_ID },
          {
            id: BOUND_PROJECT_ID,
            name: 'Moved Project',
            workspaceId: OTHER_PROJECT_ID,
            placeholder: true,
            remote: { name: 'lab-vm', state: 'remote' },
          },
        ],
      });
    });

    it('board.listProjects without the flag keeps hiding bound projects and still adds workspaceId', async () => {
      const storage = {
        listProjects: jest.fn().mockResolvedValue({
          items: [
            { id: PROJECT_ID, name: 'Local Project', workspaceId: OTHER_PROJECT_ID },
            { id: BOUND_PROJECT_ID, name: 'Moved Project', workspaceId: OTHER_PROJECT_ID },
          ],
          total: 2,
        }),
      };
      const service = makeService(storage);

      await expect(
        service.handle({
          jsonrpc: '2.0',
          id: 'p3',
          method: 'board.listProjects',
          params: { includeRemotePlaceholders: false },
        }),
      ).resolves.toEqual({
        jsonrpc: '2.0',
        id: 'p3',
        result: [{ id: PROJECT_ID, name: 'Local Project', workspaceId: OTHER_PROJECT_ID }],
      });
    });
  });

  it('enriches listEpicsByStatus DTO with agent and status metadata', async () => {
    const storage = {
      getStatus: jest.fn().mockResolvedValue({
        id: STATUS_ID,
        projectId: PROJECT_ID,
        label: 'Todo',
        color: '#123456',
        position: 1,
      }),
      listEpicsByStatus: jest.fn().mockResolvedValue({
        items: [makeEpic({ agentId: AGENT_ID })],
        total: 1,
      }),
      listStatuses: jest.fn().mockResolvedValue({
        items: [{ id: STATUS_ID, label: 'Todo', color: '#123456', position: 1 }],
        total: 1,
      }),
      listAgents: jest.fn().mockResolvedValue({
        items: [{ id: AGENT_ID, name: 'Brainstormer' }],
        total: 1,
      }),
    };
    const service = buildHandler(storage);

    await expect(
      service.handle({
        jsonrpc: '2.0',
        id: '3',
        method: 'board.listEpicsByStatus',
        params: { statusId: STATUS_ID },
      }),
    ).resolves.toMatchObject({
      result: [
        {
          id: EPIC_ID,
          title: 'Fix mobile board',
          statusId: STATUS_ID,
          statusName: 'Todo',
          statusColor: '#123456',
          statusPosition: 1,
          status: { id: STATUS_ID, name: 'Todo', color: '#123456', position: 1 },
          agentId: AGENT_ID,
          agentName: 'Brainstormer',
        },
      ],
    });

    expect(storage.getStatus).toHaveBeenCalledWith(STATUS_ID);
    expect(storage.listStatuses).toHaveBeenCalledWith(PROJECT_ID, { limit: 1000, offset: 0 });
    expect(storage.listAgents).toHaveBeenCalledWith(PROJECT_ID, { limit: 1000, offset: 0 });
  });

  it('rejects listEpicsByStatus when provided projectId mismatches status project', async () => {
    const storage = {
      getStatus: jest.fn().mockResolvedValue({
        id: STATUS_ID,
        projectId: PROJECT_ID,
      }),
    };
    const service = buildHandler(storage);

    await expect(
      service.handle({
        jsonrpc: '2.0',
        id: '4',
        method: 'board.listEpicsByStatus',
        params: { statusId: STATUS_ID, projectId: OTHER_PROJECT_ID },
      }),
    ).resolves.toMatchObject({
      error: { code: -32603, message: 'projectId does not match status project' },
    });
  });

  it('enriches getEpicDetail DTO with resolved agent and status metadata', async () => {
    const storage = {
      getEpic: jest.fn().mockResolvedValue(
        makeEpic({
          agentId: AGENT_ID,
          createdAt: '2026-05-09T12:00:00.000Z',
          tags: ['bridge'],
        }),
      ),
      listStatuses: jest.fn().mockResolvedValue({
        items: [{ id: STATUS_ID, label: 'Todo', color: '#123456', position: 1 }],
        total: 1,
      }),
      listAgents: jest.fn().mockResolvedValue({
        items: [{ id: AGENT_ID, name: 'Brainstormer' }],
        total: 1,
      }),
    };
    const service = buildHandler(storage);

    await expect(
      service.handle({
        jsonrpc: '2.0',
        id: '5',
        method: 'board.getEpicDetail',
        params: { epicId: EPIC_ID },
      }),
    ).resolves.toMatchObject({
      result: {
        id: EPIC_ID,
        statusId: STATUS_ID,
        statusName: 'Todo',
        statusColor: '#123456',
        statusPosition: 1,
        agentId: AGENT_ID,
        agentName: 'Brainstormer',
      },
    });
  });

  it('returns board.listParentEpics response with statuses, enriched items, and child summaries', async () => {
    const storage = {
      listProjectEpics: jest.fn().mockResolvedValue({
        items: [
          makeEpic({ id: PARENT_ID, title: 'Parent one', agentId: AGENT_ID, tags: ['alpha'] }),
          makeEpic({
            id: PARENT_ID_2,
            title: 'Parent two',
            updatedAt: '2026-05-10T19:00:00.000Z',
          }),
        ],
        total: 2,
        limit: 20,
        offset: 0,
      }),
      listStatuses: jest.fn().mockResolvedValue({
        items: [{ id: STATUS_ID, label: 'Todo', color: '#123456', position: 1 }],
        total: 1,
      }),
      listAgents: jest.fn().mockResolvedValue({
        items: [{ id: AGENT_ID, name: 'Brainstormer' }],
        total: 1,
      }),
      listSubEpicsForParents: jest.fn().mockResolvedValue(
        new Map([
          [
            PARENT_ID,
            [
              { id: 'child-1', parentId: PARENT_ID, statusId: STATUS_ID },
              { id: 'child-2', parentId: PARENT_ID, statusId: STATUS_ID },
            ],
          ],
          [PARENT_ID_2, []],
        ]),
      ),
      countSubEpicsByStatus: jest.fn(),
    };
    const service = buildHandler(storage);

    await expect(
      service.handle({
        jsonrpc: '2.0',
        id: '6',
        method: 'board.listParentEpics',
        params: { projectId: PROJECT_ID },
      }),
    ).resolves.toMatchObject({
      result: {
        statuses: [{ id: STATUS_ID, name: 'Todo', color: '#123456', position: 1 }],
        items: [
          {
            id: PARENT_ID,
            statusId: STATUS_ID,
            statusName: 'Todo',
            statusColor: '#123456',
            agentId: AGENT_ID,
            agentName: 'Brainstormer',
            childCount: 2,
            childStatusCounts: [
              { statusId: STATUS_ID, statusName: 'Todo', statusColor: '#123456', count: 2 },
            ],
          },
          {
            id: PARENT_ID_2,
            childCount: 0,
            childStatusCounts: [],
          },
        ],
        total: 2,
        limit: 20,
        offset: 0,
      },
    });

    expect(storage.listProjectEpics).toHaveBeenCalledWith(PROJECT_ID, {
      parentOnly: true,
      type: 'active',
      limit: 20,
      offset: 0,
    });
    expect(storage.listSubEpicsForParents).toHaveBeenCalledWith(
      PROJECT_ID,
      [PARENT_ID, PARENT_ID_2],
      { type: 'active', limitPerParent: 1000 },
    );
    expect(storage.countSubEpicsByStatus).not.toHaveBeenCalled();
  });

  it('uses count-safe batch path for parent child summaries when listSubEpicsForParents may truncate', async () => {
    const storage = {
      listProjectEpics: jest
        .fn()
        .mockResolvedValueOnce({
          items: [makeEpic({ id: PARENT_ID, title: 'Parent one', agentId: AGENT_ID })],
          total: 1,
          limit: 20,
          offset: 0,
        })
        .mockResolvedValueOnce({
          items: [
            { id: 'child-1', parentId: PARENT_ID, statusId: STATUS_ID },
            { id: 'child-2', parentId: PARENT_ID, statusId: STATUS_ID },
          ],
          total: 2,
          limit: 500,
          offset: 0,
        }),
      listStatuses: jest.fn().mockResolvedValue({
        items: [{ id: STATUS_ID, label: 'Todo', color: '#123456', position: 1 }],
        total: 1,
      }),
      listAgents: jest.fn().mockResolvedValue({
        items: [{ id: AGENT_ID, name: 'Brainstormer' }],
        total: 1,
      }),
      listSubEpicsForParents: jest
        .fn()
        .mockResolvedValue(
          new Map([[PARENT_ID, [{ id: 'child-1', parentId: PARENT_ID, statusId: STATUS_ID }]]]),
        ),
    };
    const service = buildHandler(storage);

    await expect(
      service.handle({
        jsonrpc: '2.0',
        id: '7',
        method: 'board.listParentEpics',
        params: { projectId: PROJECT_ID, limitPerParent: 1 },
      }),
    ).resolves.toMatchObject({
      result: {
        items: [
          {
            id: PARENT_ID,
            childCount: 2,
            childStatusCounts: [{ statusId: STATUS_ID, count: 2 }],
          },
        ],
      },
    });

    expect(storage.listProjectEpics).toHaveBeenNthCalledWith(2, PROJECT_ID, {
      type: 'active',
      limit: 500,
      offset: 0,
    });
  });

  it('returns board.listParentEpicsByStatus with paginated enriched parent-only items', async () => {
    const storage = {
      getStatus: jest.fn().mockResolvedValue({
        id: STATUS_ID,
        projectId: PROJECT_ID,
      }),
      listProjectEpics: jest.fn().mockResolvedValue({
        items: [makeEpic({ id: PARENT_ID, title: 'Parent one', agentId: AGENT_ID })],
        total: 1,
        limit: 10,
        offset: 5,
      }),
      listStatuses: jest.fn().mockResolvedValue({
        items: [{ id: STATUS_ID, label: 'Todo', color: '#123456', position: 1 }],
        total: 1,
      }),
      listAgents: jest.fn().mockResolvedValue({
        items: [{ id: AGENT_ID, name: 'Brainstormer' }],
        total: 1,
      }),
      listSubEpicsForParents: jest
        .fn()
        .mockResolvedValue(
          new Map([[PARENT_ID, [{ id: CHILD_ID, parentId: PARENT_ID, statusId: STATUS_ID }]]]),
        ),
    };
    const service = buildHandler(storage);

    const response = await service.handle({
      jsonrpc: '2.0',
      id: '7b',
      method: 'board.listParentEpicsByStatus',
      params: { projectId: PROJECT_ID, statusId: STATUS_ID, limit: 10, offset: 5 },
    });

    expect(response).toMatchObject({
      result: {
        items: [
          {
            id: PARENT_ID,
            statusId: STATUS_ID,
            statusName: 'Todo',
            statusColor: '#123456',
            agentId: AGENT_ID,
            agentName: 'Brainstormer',
            childCount: 1,
            childStatusCounts: [
              { statusId: STATUS_ID, statusName: 'Todo', statusColor: '#123456', count: 1 },
            ],
          },
        ],
        total: 1,
        limit: 10,
        offset: 5,
      },
    });
    expect(JSON.stringify(response.result)).not.toContain(CHILD_ID);

    expect(storage.getStatus).toHaveBeenCalledWith(STATUS_ID);
    expect(storage.listProjectEpics).toHaveBeenCalledWith(PROJECT_ID, {
      statusId: STATUS_ID,
      parentOnly: true,
      type: 'active',
      limit: 10,
      offset: 5,
    });
  });

  it('lists parent children with enriched metadata and deterministic pagination envelope', async () => {
    const storage = {
      getEpic: jest.fn().mockResolvedValue({
        id: PARENT_ID,
        projectId: PROJECT_ID,
      }),
      listParentChildren: jest.fn().mockResolvedValue({
        items: [
          makeEpic({
            id: CHILD_ID,
            title: 'Child one',
            description: 'A child epic',
            parentId: PARENT_ID,
            agentId: AGENT_ID,
            tags: ['bridge'],
            updatedAt: '2026-05-11T00:00:00.000Z',
          }),
          makeEpic({
            id: CHILD_ID_2,
            title: 'Child two',
            parentId: PARENT_ID,
            updatedAt: '2026-05-10T23:59:00.000Z',
          }),
        ],
        total: 2,
        limit: 50,
        offset: 0,
      }),
      listStatuses: jest.fn().mockResolvedValue({
        items: [
          { id: STATUS_ID, label: 'Todo', color: '#123456', position: 1 },
          { id: STATUS_ID_2, label: 'Done', color: '#00aa00', position: 2 },
        ],
        total: 2,
      }),
      listAgents: jest.fn().mockResolvedValue({
        items: [{ id: AGENT_ID, name: 'Brainstormer' }],
        total: 1,
      }),
      countSubEpicsByStatus: jest.fn().mockResolvedValue({
        [STATUS_ID_2]: 1,
        [STATUS_ID]: 2,
        '00000000-0000-4000-8000-000000000000': 0,
      }),
    };
    const service = buildHandler(storage);

    await expect(
      service.handle({
        jsonrpc: '2.0',
        id: '8',
        method: 'board.listParentChildren',
        params: { parentId: PARENT_ID },
      }),
    ).resolves.toMatchObject({
      result: {
        items: [
          {
            id: CHILD_ID,
            statusId: STATUS_ID,
            statusName: 'Todo',
            statusColor: '#123456',
            agentId: AGENT_ID,
            agentName: 'Brainstormer',
            parentId: PARENT_ID,
            description: 'A child epic',
            tags: ['bridge'],
          },
          {
            id: CHILD_ID_2,
            parentId: PARENT_ID,
          },
        ],
        total: 2,
        limit: 50,
        offset: 0,
        childStatusCounts: [
          { statusId: STATUS_ID, statusName: 'Todo', statusColor: '#123456', count: 2 },
          { statusId: STATUS_ID_2, statusName: 'Done', statusColor: '#00aa00', count: 1 },
        ],
      },
    });

    expect(storage.listParentChildren).toHaveBeenCalledWith(PARENT_ID, {
      statusId: undefined,
      limit: 50,
      offset: 0,
    });
    expect(storage.countSubEpicsByStatus).toHaveBeenCalledWith(PARENT_ID);
  });

  it('supports status-filter and pagination params while keeping childStatusCounts parent-wide', async () => {
    const storage = {
      getEpic: jest.fn().mockResolvedValue({
        id: PARENT_ID,
        projectId: PROJECT_ID,
      }),
      listParentChildren: jest.fn().mockResolvedValue({
        items: [makeEpic({ id: CHILD_ID, parentId: PARENT_ID })],
        total: 1,
        limit: 10,
        offset: 20,
      }),
      listStatuses: jest.fn().mockResolvedValue({
        items: [
          { id: STATUS_ID, label: 'Todo', color: '#123456', position: 1 },
          { id: STATUS_ID_2, label: 'Done', color: '#00aa00', position: 2 },
        ],
        total: 2,
      }),
      listAgents: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      countSubEpicsByStatus: jest.fn().mockResolvedValue({
        [STATUS_ID]: 1,
        [STATUS_ID_2]: 4,
      }),
    };
    const service = buildHandler(storage);

    await expect(
      service.handle({
        jsonrpc: '2.0',
        id: '9',
        method: 'board.listParentChildren',
        params: { parentId: PARENT_ID, statusId: STATUS_ID, limit: 10, offset: 20 },
      }),
    ).resolves.toMatchObject({
      result: {
        items: [{ id: CHILD_ID, statusId: STATUS_ID, parentId: PARENT_ID }],
        total: 1,
        limit: 10,
        offset: 20,
        childStatusCounts: [
          { statusId: STATUS_ID, statusName: 'Todo', statusColor: '#123456', count: 1 },
          { statusId: STATUS_ID_2, statusName: 'Done', statusColor: '#00aa00', count: 4 },
        ],
      },
    });

    expect(storage.listParentChildren).toHaveBeenCalledWith(PARENT_ID, {
      statusId: STATUS_ID,
      limit: 10,
      offset: 20,
    });
    expect(storage.countSubEpicsByStatus).toHaveBeenCalledWith(PARENT_ID);
  });

  it('validates trimmed params but dispatches the original values and additive keys', async () => {
    const addEpicComment = jest.fn().mockResolvedValue({
      id: COMMENT_ID,
      epicId: EPIC_ID,
      authorName: 'User',
      content: 'comment',
      createdAt: ISO,
      updatedAt: ISO,
    });
    const board = { addEpicComment } as unknown as MobileBoardRpcService;
    const service = buildHandler({}, { board });
    const params = {
      projectId: PROJECT_ID,
      epicId: EPIC_ID,
      authorName: '  User  ',
      content: '  comment  ',
      additiveField: 'preserved',
    };

    await expect(
      service.handle({ jsonrpc: '2.0', id: 'raw-params', method: 'board.addEpicComment', params }),
    ).resolves.toMatchObject({ result: { id: COMMENT_ID } });
    expect(addEpicComment).toHaveBeenCalledWith(params);
  });

  it('returns the same validated result object with additive JSON-compatible fields', async () => {
    const producerResult = { ok: true, additiveField: { preserved: true } };
    const viewport = {
      unsubscribe: jest.fn().mockReturnValue(producerResult),
    } as unknown as ViewportStreamerService;
    const service = buildHandler({}, { viewport });

    const response = await service.handle({
      jsonrpc: '2.0',
      id: 'additive-result',
      method: 'terminal.viewport.unsubscribe',
      params: { subscriptionId: 'vp-1' },
    });

    expect(response.result).toBe(producerResult);
  });

  it('sanitizes invalid producer output and logs only its method and schema paths', async () => {
    mockedLogger.error.mockClear();
    const secretValue = 'must-not-enter-logs';
    const storage = {
      listProjects: jest.fn().mockResolvedValue({
        items: [{ id: secretValue, name: 'Invalid project' }],
        total: 1,
      }),
    };
    const service = buildHandler(storage);

    await expect(
      service.handle({
        jsonrpc: '2.0',
        id: 'invalid-result',
        method: 'board.listProjects',
        params: {},
      }),
    ).resolves.toEqual({
      jsonrpc: '2.0',
      id: 'invalid-result',
      error: { code: -32603, message: 'Internal error' },
    });

    expect(mockedLogger.error).toHaveBeenCalledWith(
      { method: 'board.listProjects', schemaPaths: ['0.id'] },
      'RPC handler returned an invalid result',
    );
    expect(JSON.stringify(mockedLogger.error.mock.calls)).not.toContain(secretValue);
  });

  it('rejects chat.listAgents with a non-uuid projectId before delegating', async () => {
    const listAgents = jest.fn();
    const chat = { listAgents } as unknown as MobileChatRpcService;
    const service = buildHandler({}, { chat });

    await expect(
      service.handle({
        jsonrpc: '2.0',
        id: '12',
        method: 'chat.listAgents',
        params: { projectId: 'not-a-uuid' },
      }),
    ).resolves.toMatchObject({
      error: { code: -32602, message: 'Invalid params' },
    });
    expect(listAgents).not.toHaveBeenCalled();
  });

  it('maps an AppError thrown by a chat.* handler to error.data.code', async () => {
    const chat = {
      listAgents: jest.fn().mockRejectedValue(new NotFoundError('Project', PROJECT_ID)),
    } as unknown as MobileChatRpcService;
    const service = buildHandler({}, { chat });

    await expect(
      service.handle({
        jsonrpc: '2.0',
        id: '13',
        method: 'chat.listAgents',
        params: { projectId: PROJECT_ID },
      }),
    ).resolves.toMatchObject({
      error: { code: -32603, data: { code: 'not_found' } },
    });
  });

  it('projects all transcript chunk and delta-tail dates before result validation', async () => {
    const SESSION_ID = '12121212-1212-4212-8212-121212121212';
    const chunk = makeTranscriptChunk();
    const getTranscriptChunks = jest.fn().mockResolvedValue({
      chunks: [chunk],
      nextCursor: null,
      prevCursor: null,
      totalCount: 1,
    });
    const getTranscriptTail = jest.fn().mockResolvedValue({
      kind: 'delta',
      cursor: 'cursor-2',
      replaceFromChunkId: chunk.id,
      replaceFromChunkIndex: 0,
      deltaChunks: [chunk],
      deltaMessages: chunk.messages,
      metrics: transcriptMetrics,
      totalChunkCount: 1,
      totalMessageCount: 1,
    });
    const chat = { getTranscriptChunks, getTranscriptTail } as unknown as MobileChatRpcService;
    const service = buildHandler({}, { chat });

    const chunksResponse = await service.handle({
      jsonrpc: '2.0',
      id: 'transcript-chunks',
      method: 'chat.getTranscriptChunks',
      params: { sessionId: SESSION_ID, projectId: PROJECT_ID },
    });
    const tailResponse = await service.handle({
      jsonrpc: '2.0',
      id: 'transcript-tail',
      method: 'chat.getTranscriptTail',
      params: { sessionId: SESSION_ID, projectId: PROJECT_ID, since: 'cursor-1' },
    });

    const wireChunk = (chunksResponse.result as { chunks: Array<Record<string, unknown>> })
      .chunks[0];
    const turn = (wireChunk.turns as Array<Record<string, unknown>>)[0];
    const turnStep = (turn.steps as Array<Record<string, unknown>>)[0];
    expect(wireChunk).toMatchObject({
      startTime: ISO,
      endTime: '2026-05-10T18:00:01.000Z',
      additiveChunkField: 'preserved',
    });
    expect((wireChunk.messages as Array<Record<string, unknown>>)[0].timestamp).toBe(ISO);
    expect((wireChunk.semanticSteps as Array<Record<string, unknown>>)[0].startTime).toBe(
      '2026-05-10T18:00:00.500Z',
    );
    expect(turn).toMatchObject({ timestamp: ISO, additiveTurnField: 'preserved' });
    expect(turnStep.startTime).toBe('2026-05-10T18:00:00.250Z');
    expect(
      (tailResponse.result as { deltaMessages: Array<Record<string, unknown>> }).deltaMessages[0]
        .timestamp,
    ).toBe(ISO);
    expect(JSON.parse(JSON.stringify(chunksResponse.result))).toEqual(chunksResponse.result);
    expect(JSON.parse(JSON.stringify(tailResponse.result))).toEqual(tailResponse.result);
  });

  it('threads trusted crypto context separately while accepting spoofed passthrough fields', async () => {
    const sendMessage = jest.fn().mockResolvedValue({ status: 'queued' });
    const chat = { sendMessage } as unknown as MobileChatRpcService;
    const service = buildHandler({}, { chat });
    const cryptoCtx = { senderKid: 'authenticated-kid' };
    const params = {
      agentId: AGENT_ID,
      projectId: PROJECT_ID,
      text: 'hello',
      senderName: 'Spoofed Name',
      deviceName: 'Spoofed Device',
      __senderKid: 'spoofed-kid',
    };

    await expect(
      service.handle({ jsonrpc: '2.0', id: '16a', method: 'chat.sendMessage', params }, cryptoCtx),
    ).resolves.toMatchObject({ result: { status: 'queued' } });

    expect(sendMessage).toHaveBeenCalledWith(params, cryptoCtx);
  });

  describe('terminal.viewport.* lease control', () => {
    const SESSION_ID = '12121212-1212-4212-8212-121212121212';

    it('delegates terminal.viewport.subscribe and returns the subscriptionId', async () => {
      const subscribe = jest.fn().mockResolvedValue({ subscriptionId: 'vp-1' });
      const viewport = { subscribe } as unknown as ViewportStreamerService;
      const service = buildHandler({}, { viewport });

      await expect(
        service.handle(
          {
            jsonrpc: '2.0',
            id: 'v1',
            method: 'terminal.viewport.subscribe',
            params: { sessionId: SESSION_ID, projectId: PROJECT_ID },
          },
          { senderKid: 'verified-device-kid' },
        ),
      ).resolves.toMatchObject({ result: { subscriptionId: 'vp-1' } });
      expect(subscribe).toHaveBeenCalledWith(
        { sessionId: SESSION_ID, projectId: PROJECT_ID },
        { senderKid: 'verified-device-kid' },
      );
    });

    it('delegates terminal.viewport.unsubscribe and returns { ok }', async () => {
      const unsubscribe = jest.fn().mockReturnValue({ ok: true });
      const viewport = { unsubscribe } as unknown as ViewportStreamerService;
      const service = buildHandler({}, { viewport });

      await expect(
        service.handle(
          {
            jsonrpc: '2.0',
            id: 'v5',
            method: 'terminal.viewport.unsubscribe',
            params: { subscriptionId: 'vp-1' },
          },
          { senderKid: 'verified-device-kid' },
        ),
      ).resolves.toMatchObject({ result: { ok: true } });
      expect(unsubscribe).toHaveBeenCalledWith(
        { subscriptionId: 'vp-1' },
        { senderKid: 'verified-device-kid' },
      );
    });
  });

  describe('terminal.sendKey — discrete mobile key input', () => {
    const SESSION_ID = '12121212-1212-4212-8212-121212121212';
    const OTHER_PROJECT_ID = '33333333-3333-4333-8333-333333333333';

    /** Build a handler with only the collaborators terminal.sendKey touches wired. */
    const makeSendKeyHandler = (
      activeSessions: Partial<ActiveSessionLookup>,
      terminalKeyInput: Partial<TerminalKeyInputFacade>,
    ) =>
      new TunnelHandlerService(
        {},
        mobileChat,
        mobileBoard,
        mobileViewport,
        {} as E2eeTrustService,
        terminalKeyInput as TerminalKeyInputFacade,
        activeSessions as ActiveSessionLookup,
      );

    it('delegates a named key to the facade after the scope check passes', async () => {
      const sendKey = jest.fn().mockResolvedValue({ ok: true });
      const activeSessions = {
        getSessionProjectScope: jest
          .fn()
          .mockResolvedValue({ sessionId: SESSION_ID, agentId: 'a1', projectId: PROJECT_ID }),
      };
      const service = makeSendKeyHandler(activeSessions, { sendKey });

      await expect(
        service.handle({
          jsonrpc: '2.0',
          id: 'k1',
          method: 'terminal.sendKey',
          params: { sessionId: SESSION_ID, projectId: PROJECT_ID, key: 'Up' },
        }),
      ).resolves.toMatchObject({ result: { ok: true } });

      expect(activeSessions.getSessionProjectScope).toHaveBeenCalledWith(SESSION_ID);
      expect(sendKey).toHaveBeenCalledWith(SESSION_ID, 'Up');
    });

    it.each([
      ['C-c token', 'C-c'],
      ['raw arrow escape', '\x1b[A'],
    ])(
      'rejects %s (%j) at the schema layer (-32602) before scope check or facade',
      async (_label, key) => {
        const sendKey = jest.fn();
        const getSessionProjectScope = jest.fn();
        const service = makeSendKeyHandler({ getSessionProjectScope }, { sendKey });

        await expect(
          service.handle({
            jsonrpc: '2.0',
            id: 'k3',
            method: 'terminal.sendKey',
            params: { sessionId: SESSION_ID, projectId: PROJECT_ID, key },
          }),
        ).resolves.toMatchObject({ error: { code: -32602, message: 'Invalid params' } });
        expect(getSessionProjectScope).not.toHaveBeenCalled();
        expect(sendKey).not.toHaveBeenCalled();
      },
    );

    it('maps an unknown session (scope null) to NotFoundError → error.data.code not_found', async () => {
      const sendKey = jest.fn();
      const activeSessions = { getSessionProjectScope: jest.fn().mockResolvedValue(null) };
      const service = makeSendKeyHandler(activeSessions, { sendKey });

      await expect(
        service.handle({
          jsonrpc: '2.0',
          id: 'k6',
          method: 'terminal.sendKey',
          params: { sessionId: SESSION_ID, projectId: PROJECT_ID, key: 'Up' },
        }),
      ).resolves.toMatchObject({ error: { code: -32603, data: { code: 'not_found' } } });
      expect(sendKey).not.toHaveBeenCalled();
    });

    it('maps a cross-project session to ForbiddenError SESSION_PROJECT_MISMATCH', async () => {
      const sendKey = jest.fn();
      // The session exists but belongs to a DIFFERENT project.
      const activeSessions = {
        getSessionProjectScope: jest
          .fn()
          .mockResolvedValue({ sessionId: SESSION_ID, agentId: 'a1', projectId: OTHER_PROJECT_ID }),
      };
      const service = makeSendKeyHandler(activeSessions, { sendKey });

      await expect(
        service.handle({
          jsonrpc: '2.0',
          id: 'k7',
          method: 'terminal.sendKey',
          params: { sessionId: SESSION_ID, projectId: PROJECT_ID, key: 'Up' },
        }),
      ).resolves.toMatchObject({
        // ForbiddenError code is 'forbidden'; the specific reason rides in data.details.code
        // (same contract as ViewportStreamerService.assertSessionInProject).
        error: {
          code: -32603,
          data: { code: 'forbidden', details: { code: 'SESSION_PROJECT_MISMATCH' } },
        },
      });
      expect(sendKey).not.toHaveBeenCalled();
    });
  });

  describe('e2ee.adoptDeviceKey metadata threading', () => {
    const KID = 'a'.repeat(32);
    const PUB = Buffer.from(new Uint8Array(32).fill(1)).toString('base64');
    const INSTALL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

    const makeHandler = (adopt: jest.Mock) => {
      const e2eeTrust = { adoptPeerKeyTofu: adopt } as unknown as E2eeTrustService;
      return buildHandler({}, { e2eeTrust });
    };

    it('threads a supplied installId to adoptPeerKeyTofu as the second (separate) arg', async () => {
      const adopt = jest.fn().mockReturnValue({ kid: KID, trust: 'unverified' });
      const service = makeHandler(adopt);

      await expect(
        service.handle({
          jsonrpc: '2.0',
          id: 'e1',
          method: 'e2ee.adoptDeviceKey',
          params: { kid: KID, publicKeyB64: PUB, installId: INSTALL },
        }),
      ).resolves.toMatchObject({ result: { kid: KID, trust: 'unverified' } });
      expect(adopt).toHaveBeenCalledWith({ kid: KID, publicKeyB64: PUB }, INSTALL);
    });

    it('threads the bounded reported label into IncomingPeerKey', async () => {
      const adopt = jest.fn().mockReturnValue({ kid: KID, trust: 'unverified' });
      const service = makeHandler(adopt);

      await service.handle({
        jsonrpc: '2.0',
        id: 'e-label',
        method: 'e2ee.adoptDeviceKey',
        params: { kid: KID, publicKeyB64: PUB, label: 'Pixel' },
      });

      expect(adopt).toHaveBeenCalledWith(
        { kid: KID, publicKeyB64: PUB, label: 'Pixel' },
        undefined,
      );
    });
  });

  describe('e2ee.revokeDeviceKey — sealed-only, trusted sender kid (M3)', () => {
    const SENDER_KID = 'sender'.repeat(5) + 'ss'; // 32 chars
    const VICTIM_KID = 'victim'.repeat(5) + 'vv';

    const makeHandler = (revoke: jest.Mock) => {
      const e2eeTrust = { revokeDevice: revoke } as unknown as E2eeTrustService;
      return buildHandler({}, { e2eeTrust });
    };

    it('revokes EXACTLY the crypto-context sender kid and ignores any client-supplied kid param', async () => {
      const revoke = jest.fn().mockReturnValue({ kid: SENDER_KID, removed: true });
      const service = makeHandler(revoke);

      await expect(
        service.handle(
          // A hostile param naming a DIFFERENT device — must be ignored.
          {
            jsonrpc: '2.0',
            id: 'rv1',
            method: 'e2ee.revokeDeviceKey',
            params: { kid: VICTIM_KID },
          },
          { senderKid: SENDER_KID },
        ),
      ).resolves.toMatchObject({ result: { kid: SENDER_KID, removed: true } });
      expect(revoke).toHaveBeenCalledWith(SENDER_KID);
      expect(revoke).toHaveBeenCalledTimes(1);
    });

    it('errors and revokes NOTHING when the crypto context is absent (off the sealed lane)', async () => {
      const revoke = jest.fn();
      const service = makeHandler(revoke);

      const resp = await service.handle({
        jsonrpc: '2.0',
        id: 'rv3',
        method: 'e2ee.revokeDeviceKey',
        params: {},
      }); // no cryptoCtx

      expect(revoke).not.toHaveBeenCalled();
      expect(resp.error?.code).toBe(-32602); // ValidationError → invalid params
      expect(resp.result).toBeUndefined();
    });
  });

  describe('e2ee.bindNotificationRoutingIdentity — sealed-only, trusted sender kid', () => {
    const SENDER_KID = 'sender'.repeat(5) + 'ss'; // 32 chars
    const VICTIM_KID = 'victim'.repeat(5) + 'vv';
    const ROUTING_KID = 'kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k';

    const makeHandler = (bind: jest.Mock) => {
      const e2eeTrust = {
        bindNotificationRoutingIdentity: bind,
      } as unknown as E2eeTrustService;
      return buildHandler({}, { e2eeTrust });
    };

    it('binds the routing kid to EXACTLY the crypto-context sender kid and ignores caller-supplied sender identity', async () => {
      const bind = jest
        .fn()
        .mockReturnValue({ kid: SENDER_KID, routingKid: ROUTING_KID, bound: true });
      const service = makeHandler(bind);

      await expect(
        service.handle(
          // Hostile sender-naming params — must be ignored entirely.
          {
            jsonrpc: '2.0',
            id: 'bd1',
            method: 'e2ee.bindNotificationRoutingIdentity',
            params: { routingKid: ROUTING_KID, kid: VICTIM_KID, senderKid: VICTIM_KID },
          },
          { senderKid: SENDER_KID },
        ),
      ).resolves.toMatchObject({
        result: { kid: SENDER_KID, routingKid: ROUTING_KID, bound: true },
      });
      expect(bind).toHaveBeenCalledWith(SENDER_KID, ROUTING_KID);
      expect(bind).toHaveBeenCalledTimes(1);
    });

    it('fails closed and binds NOTHING when the crypto context is absent (off the sealed lane)', async () => {
      const bind = jest.fn();
      const service = makeHandler(bind);

      const resp = await service.handle({
        jsonrpc: '2.0',
        id: 'bd4',
        method: 'e2ee.bindNotificationRoutingIdentity',
        params: { routingKid: ROUTING_KID },
      }); // no cryptoCtx

      expect(bind).not.toHaveBeenCalled();
      expect(resp.error?.code).toBe(-32602); // ValidationError → invalid params
      expect(resp.result).toBeUndefined();
    });

    it('rejects a malformed routing kid at the contract schema boundary', async () => {
      const bind = jest.fn();
      const service = makeHandler(bind);

      const resp = await service.handle(
        {
          jsonrpc: '2.0',
          id: 'bd5',
          method: 'e2ee.bindNotificationRoutingIdentity',
          params: { routingKid: 'not-a-thumbprint' },
        },
        { senderKid: SENDER_KID },
      );

      expect(bind).not.toHaveBeenCalled();
      expect(resp.error?.code).toBe(-32602); // schema rejection — invalid params
    });
  });
});
