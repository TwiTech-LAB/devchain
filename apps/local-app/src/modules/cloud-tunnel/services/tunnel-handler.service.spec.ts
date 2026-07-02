import { TunnelHandlerService } from './tunnel-handler.service';
import { MobileChatRpcService } from './mobile-chat-rpc.service';
import { MobileBoardRpcService } from './mobile-board-rpc.service';
import { ViewportStreamerService } from './viewport-streamer.service';
import { E2eeTrustService } from '../../e2ee/services/e2ee-trust.service';
import {
  AppError,
  ConflictError,
  NotFoundError,
  OptimisticLockError,
  ValidationError,
} from '../../../common/errors/error-types';

describe('TunnelHandlerService', () => {
  // board.* read handlers never touch the seam services; bare stubs suffice for
  // those tests. The board.* mutation tests inject a purpose-built mobileBoard.
  const mobileChat = {} as MobileChatRpcService;
  const mobileBoard = {} as MobileBoardRpcService;
  // Viewport lease control is not exercised by these board/chat tests; a bare stub
  // suffices. The viewport RPC delegation is covered in its own describe block below.
  const mobileViewport = {} as ViewportStreamerService;
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

  it('returns mobile board DTOs and uses parent-only project counts for status counts', async () => {
    const storage = {
      listProjects: jest.fn().mockResolvedValue({
        items: [{ id: 'project-1', name: 'Project One', rootPath: '/tmp/project-one' }],
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
    const service = new TunnelHandlerService(storage, mobileChat, mobileBoard, mobileViewport);

    await expect(
      service.handle({ jsonrpc: '2.0', id: '1', method: 'board.listProjects', params: {} }),
    ).resolves.toMatchObject({
      result: [{ id: 'project-1', name: 'Project One' }],
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
        items: [
          {
            id: EPIC_ID,
            title: 'Fix mobile board',
            statusId: STATUS_ID,
            agentId: AGENT_ID,
            updatedAt: '2026-05-10T18:00:00.000Z',
          },
        ],
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
    const service = new TunnelHandlerService(storage, mobileChat, mobileBoard, mobileViewport);

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
    const service = new TunnelHandlerService(storage, mobileChat, mobileBoard, mobileViewport);

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
      getEpic: jest.fn().mockResolvedValue({
        id: EPIC_ID,
        title: 'Fix mobile board',
        statusId: STATUS_ID,
        projectId: PROJECT_ID,
        agentId: AGENT_ID,
        createdAt: '2026-05-09T12:00:00.000Z',
        updatedAt: '2026-05-10T18:00:00.000Z',
        tags: ['bridge'],
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
    const service = new TunnelHandlerService(storage, mobileChat, mobileBoard, mobileViewport);

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
          {
            id: PARENT_ID,
            title: 'Parent one',
            statusId: STATUS_ID,
            agentId: AGENT_ID,
            updatedAt: '2026-05-10T18:00:00.000Z',
            tags: ['alpha'],
          },
          {
            id: PARENT_ID_2,
            title: 'Parent two',
            statusId: STATUS_ID,
            agentId: null,
            updatedAt: '2026-05-10T19:00:00.000Z',
            tags: [],
          },
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
    const service = new TunnelHandlerService(storage, mobileChat, mobileBoard, mobileViewport);

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
          items: [{ id: PARENT_ID, title: 'Parent one', statusId: STATUS_ID, agentId: AGENT_ID }],
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
    const service = new TunnelHandlerService(storage, mobileChat, mobileBoard, mobileViewport);

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
        items: [
          {
            id: PARENT_ID,
            title: 'Parent one',
            statusId: STATUS_ID,
            agentId: AGENT_ID,
            updatedAt: '2026-05-10T18:00:00.000Z',
          },
        ],
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
    const service = new TunnelHandlerService(storage, mobileChat, mobileBoard, mobileViewport);

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
          {
            id: CHILD_ID,
            title: 'Child one',
            description: 'A child epic',
            statusId: STATUS_ID,
            parentId: PARENT_ID,
            agentId: AGENT_ID,
            tags: ['bridge'],
            updatedAt: '2026-05-11T00:00:00.000Z',
          },
          {
            id: CHILD_ID_2,
            title: 'Child two',
            description: null,
            statusId: STATUS_ID,
            parentId: PARENT_ID,
            agentId: null,
            tags: [],
            updatedAt: '2026-05-10T23:59:00.000Z',
          },
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
    const service = new TunnelHandlerService(storage, mobileChat, mobileBoard, mobileViewport);

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
        items: [{ id: CHILD_ID, statusId: STATUS_ID, parentId: PARENT_ID }],
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
    const service = new TunnelHandlerService(storage, mobileChat, mobileBoard, mobileViewport);

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

  it('returns invalid params for malformed board.listParentChildren payload', async () => {
    const service = new TunnelHandlerService({}, mobileChat, mobileBoard, mobileViewport);

    await expect(
      service.handle({
        jsonrpc: '2.0',
        id: '10',
        method: 'board.listParentChildren',
        params: { parentId: 'not-a-uuid', limit: -1 },
      }),
    ).resolves.toMatchObject({
      error: { code: -32602, message: 'Invalid params' },
    });
  });

  it('delegates chat.listAgents to MobileChatRpcService and returns its result', async () => {
    const listAgents = jest
      .fn()
      .mockResolvedValue([
        { id: AGENT_ID, name: 'Coder', type: 'agent', online: true, sessionId: 'sess-1' },
      ]);
    const chat = { listAgents } as unknown as MobileChatRpcService;
    const service = new TunnelHandlerService({}, chat, mobileBoard, mobileViewport);

    await expect(
      service.handle({
        jsonrpc: '2.0',
        id: '11',
        method: 'chat.listAgents',
        params: { projectId: PROJECT_ID },
      }),
    ).resolves.toMatchObject({
      result: [{ id: AGENT_ID, name: 'Coder', type: 'agent', online: true, sessionId: 'sess-1' }],
    });

    expect(listAgents).toHaveBeenCalledWith({ projectId: PROJECT_ID });
  });

  it('rejects chat.listAgents with a non-uuid projectId before delegating', async () => {
    const listAgents = jest.fn();
    const chat = { listAgents } as unknown as MobileChatRpcService;
    const service = new TunnelHandlerService({}, chat, mobileBoard, mobileViewport);

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
    const service = new TunnelHandlerService({}, chat, mobileBoard, mobileViewport);

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

  it('delegates chat.getTranscriptSummary to MobileChatRpcService', async () => {
    const SESSION_ID = '12121212-1212-4212-8212-121212121212';
    const getTranscriptSummary = jest
      .fn()
      .mockResolvedValue({ sessionId: SESSION_ID, cursor: 'CUR' });
    const chat = { getTranscriptSummary } as unknown as MobileChatRpcService;
    const service = new TunnelHandlerService({}, chat, mobileBoard, mobileViewport);

    await expect(
      service.handle({
        jsonrpc: '2.0',
        id: '14',
        method: 'chat.getTranscriptSummary',
        params: { sessionId: SESSION_ID, projectId: PROJECT_ID },
      }),
    ).resolves.toMatchObject({ result: { sessionId: SESSION_ID, cursor: 'CUR' } });

    expect(getTranscriptSummary).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      projectId: PROJECT_ID,
    });
  });

  it('rejects chat.getTranscriptChunks when limit exceeds 100 before delegating', async () => {
    const SESSION_ID = '12121212-1212-4212-8212-121212121212';
    const getTranscriptChunks = jest.fn();
    const chat = { getTranscriptChunks } as unknown as MobileChatRpcService;
    const service = new TunnelHandlerService({}, chat, mobileBoard, mobileViewport);

    await expect(
      service.handle({
        jsonrpc: '2.0',
        id: '15',
        method: 'chat.getTranscriptChunks',
        params: { sessionId: SESSION_ID, projectId: PROJECT_ID, limit: 500 },
      }),
    ).resolves.toMatchObject({ error: { code: -32602, message: 'Invalid params' } });
    expect(getTranscriptChunks).not.toHaveBeenCalled();
  });

  it('delegates chat.sendMessage to MobileChatRpcService', async () => {
    const sendMessage = jest.fn().mockResolvedValue({ status: 'queued' });
    const chat = { sendMessage } as unknown as MobileChatRpcService;
    const service = new TunnelHandlerService({}, chat, mobileBoard, mobileViewport);

    await expect(
      service.handle({
        jsonrpc: '2.0',
        id: '16',
        method: 'chat.sendMessage',
        params: { agentId: AGENT_ID, projectId: PROJECT_ID, text: 'hello' },
      }),
    ).resolves.toMatchObject({ result: { status: 'queued' } });

    expect(sendMessage).toHaveBeenCalledWith({
      agentId: AGENT_ID,
      projectId: PROJECT_ID,
      text: 'hello',
    });
  });

  it('rejects chat.sendMessage with empty/whitespace text before delegating', async () => {
    const sendMessage = jest.fn();
    const chat = { sendMessage } as unknown as MobileChatRpcService;
    const service = new TunnelHandlerService({}, chat, mobileBoard, mobileViewport);

    await expect(
      service.handle({
        jsonrpc: '2.0',
        id: '17',
        method: 'chat.sendMessage',
        params: { agentId: AGENT_ID, projectId: PROJECT_ID, text: '   ' },
      }),
    ).resolves.toMatchObject({ error: { code: -32602, message: 'Invalid params' } });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('maps a SESSION_NOT_RUNNING AppError from chat.sendMessage to error.data.code', async () => {
    const sendMessage = jest
      .fn()
      .mockRejectedValue(new AppError('Launch the agent first.', 'SESSION_NOT_RUNNING', 409));
    const chat = { sendMessage } as unknown as MobileChatRpcService;
    const service = new TunnelHandlerService({}, chat, mobileBoard, mobileViewport);

    await expect(
      service.handle({
        jsonrpc: '2.0',
        id: '18',
        method: 'chat.sendMessage',
        params: { agentId: AGENT_ID, projectId: PROJECT_ID, text: 'hi' },
      }),
    ).resolves.toMatchObject({
      error: { code: -32603, data: { code: 'SESSION_NOT_RUNNING' } },
    });
  });

  it('delegates chat.launchAgent and returns the operation handle', async () => {
    const launchAgent = jest.fn().mockResolvedValue({ operationId: 'op-1', status: 'launching' });
    const chat = { launchAgent } as unknown as MobileChatRpcService;
    const service = new TunnelHandlerService({}, chat, mobileBoard, mobileViewport);

    await expect(
      service.handle({
        jsonrpc: '2.0',
        id: '19',
        method: 'chat.launchAgent',
        params: { agentId: AGENT_ID, projectId: PROJECT_ID },
      }),
    ).resolves.toMatchObject({ result: { operationId: 'op-1', status: 'launching' } });
    expect(launchAgent).toHaveBeenCalledWith({ agentId: AGENT_ID, projectId: PROJECT_ID });
  });

  it('maps a synchronous ConflictError from a lifecycle RPC to error.data (code + details)', async () => {
    const launchAgent = jest
      .fn()
      .mockRejectedValue(new ConflictError('already running', { code: 'SESSION_ALREADY_RUNNING' }));
    const chat = { launchAgent } as unknown as MobileChatRpcService;
    const service = new TunnelHandlerService({}, chat, mobileBoard, mobileViewport);

    await expect(
      service.handle({
        jsonrpc: '2.0',
        id: '20',
        method: 'chat.launchAgent',
        params: { agentId: AGENT_ID, projectId: PROJECT_ID },
      }),
    ).resolves.toMatchObject({
      // top-level domain code is 'conflict'; the specific reason rides in data.details.code
      error: {
        code: -32603,
        data: { code: 'conflict', details: { code: 'SESSION_ALREADY_RUNNING' } },
      },
    });
  });

  it('rejects chat.getOperationStatus with a non-uuid operationId', async () => {
    const getOperationStatus = jest.fn();
    const chat = { getOperationStatus } as unknown as MobileChatRpcService;
    const service = new TunnelHandlerService({}, chat, mobileBoard, mobileViewport);

    await expect(
      service.handle({
        jsonrpc: '2.0',
        id: '21',
        method: 'chat.getOperationStatus',
        params: { operationId: 'nope', projectId: PROJECT_ID },
      }),
    ).resolves.toMatchObject({ error: { code: -32602, message: 'Invalid params' } });
    expect(getOperationStatus).not.toHaveBeenCalled();
  });

  it('rejects chat.getOperationStatus when projectId is missing', async () => {
    const getOperationStatus = jest.fn();
    const chat = { getOperationStatus } as unknown as MobileChatRpcService;
    const service = new TunnelHandlerService({}, chat, mobileBoard, mobileViewport);

    await expect(
      service.handle({
        jsonrpc: '2.0',
        id: '21b',
        method: 'chat.getOperationStatus',
        params: { operationId: '00000000-0000-4000-8000-000000000000' },
      }),
    ).resolves.toMatchObject({ error: { code: -32602, message: 'Invalid params' } });
    expect(getOperationStatus).not.toHaveBeenCalled();
  });

  it('delegates chat.getAgentStatus with { agentId, projectId } and passes through a null result', async () => {
    const getAgentStatus = jest.fn().mockResolvedValue(null);
    const chat = { getAgentStatus } as unknown as MobileChatRpcService;
    const service = new TunnelHandlerService({}, chat, mobileBoard, mobileViewport);

    await expect(
      service.handle({
        jsonrpc: '2.0',
        id: '22',
        method: 'chat.getAgentStatus',
        params: { agentId: AGENT_ID, projectId: PROJECT_ID },
      }),
    ).resolves.toMatchObject({ result: null });
    expect(getAgentStatus).toHaveBeenCalledWith({ agentId: AGENT_ID, projectId: PROJECT_ID });
  });

  it('rejects chat.getAgentStatus when projectId is missing', async () => {
    const getAgentStatus = jest.fn();
    const chat = { getAgentStatus } as unknown as MobileChatRpcService;
    const service = new TunnelHandlerService({}, chat, mobileBoard, mobileViewport);

    await expect(
      service.handle({
        jsonrpc: '2.0',
        id: '22b',
        method: 'chat.getAgentStatus',
        params: { agentId: AGENT_ID },
      }),
    ).resolves.toMatchObject({ error: { code: -32602, message: 'Invalid params' } });
    expect(getAgentStatus).not.toHaveBeenCalled();
  });

  it('rejects chat.getAgentStatus with a non-uuid agentId', async () => {
    const getAgentStatus = jest.fn();
    const chat = { getAgentStatus } as unknown as MobileChatRpcService;
    const service = new TunnelHandlerService({}, chat, mobileBoard, mobileViewport);

    await expect(
      service.handle({
        jsonrpc: '2.0',
        id: '23',
        method: 'chat.getAgentStatus',
        params: { agentId: 'nope', projectId: PROJECT_ID },
      }),
    ).resolves.toMatchObject({ error: { code: -32602, message: 'Invalid params' } });
    expect(getAgentStatus).not.toHaveBeenCalled();
  });

  it('delegates chat.listPendingAskQuestions to MobileChatRpcService and returns its result', async () => {
    const SESSION_ID = '12121212-1212-4212-8212-121212121212';
    const listPendingAskQuestions = jest
      .fn()
      .mockResolvedValue([{ toolUseId: 'toolu_1', questions: [], createdAt: 1, expiresAt: 2 }]);
    const chat = { listPendingAskQuestions } as unknown as MobileChatRpcService;
    const service = new TunnelHandlerService({}, chat, mobileBoard, mobileViewport);

    await expect(
      service.handle({
        jsonrpc: '2.0',
        id: '24',
        method: 'chat.listPendingAskQuestions',
        params: { sessionId: SESSION_ID, projectId: PROJECT_ID },
      }),
    ).resolves.toMatchObject({
      result: [{ toolUseId: 'toolu_1', questions: [], createdAt: 1, expiresAt: 2 }],
    });

    expect(listPendingAskQuestions).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      projectId: PROJECT_ID,
    });
  });

  it('rejects chat.listPendingAskQuestions with a non-uuid sessionId before delegating', async () => {
    const listPendingAskQuestions = jest.fn();
    const chat = { listPendingAskQuestions } as unknown as MobileChatRpcService;
    const service = new TunnelHandlerService({}, chat, mobileBoard, mobileViewport);

    await expect(
      service.handle({
        jsonrpc: '2.0',
        id: '25',
        method: 'chat.listPendingAskQuestions',
        params: { sessionId: 'not-a-uuid', projectId: PROJECT_ID },
      }),
    ).resolves.toMatchObject({ error: { code: -32602, message: 'Invalid params' } });
    expect(listPendingAskQuestions).not.toHaveBeenCalled();
  });

  it('rejects chat.listPendingAskQuestions when projectId is missing before delegating', async () => {
    const SESSION_ID = '12121212-1212-4212-8212-121212121212';
    const listPendingAskQuestions = jest.fn();
    const chat = { listPendingAskQuestions } as unknown as MobileChatRpcService;
    const service = new TunnelHandlerService({}, chat, mobileBoard, mobileViewport);

    await expect(
      service.handle({
        jsonrpc: '2.0',
        id: '26',
        method: 'chat.listPendingAskQuestions',
        params: { sessionId: SESSION_ID },
      }),
    ).resolves.toMatchObject({ error: { code: -32602, message: 'Invalid params' } });
    expect(listPendingAskQuestions).not.toHaveBeenCalled();
  });

  describe('board.* mutations', () => {
    const AGENT_ID_2 = 'abababab-abab-4bab-8bab-abababababab';

    it('delegates board.updateEpicAssignment to mobileBoard and returns its DTO', async () => {
      const updateEpicAssignment = jest
        .fn()
        .mockResolvedValue({ id: EPIC_ID, version: 4, agentId: AGENT_ID, agentName: 'Coder' });
      const board = { updateEpicAssignment } as unknown as MobileBoardRpcService;
      const service = new TunnelHandlerService({}, mobileChat, board, mobileViewport);

      await expect(
        service.handle({
          jsonrpc: '2.0',
          id: 'b1',
          method: 'board.updateEpicAssignment',
          params: { projectId: PROJECT_ID, epicId: EPIC_ID, agentId: AGENT_ID, version: 3 },
        }),
      ).resolves.toMatchObject({
        result: { id: EPIC_ID, version: 4, agentName: 'Coder' },
      });
      expect(updateEpicAssignment).toHaveBeenCalledWith({
        projectId: PROJECT_ID,
        epicId: EPIC_ID,
        agentId: AGENT_ID,
        version: 3,
      });
    });

    it('accepts a null agentId (unassign) on board.updateEpicAssignment', async () => {
      const updateEpicAssignment = jest.fn().mockResolvedValue({ id: EPIC_ID, agentId: null });
      const board = { updateEpicAssignment } as unknown as MobileBoardRpcService;
      const service = new TunnelHandlerService({}, mobileChat, board, mobileViewport);

      await expect(
        service.handle({
          jsonrpc: '2.0',
          id: 'b2',
          method: 'board.updateEpicAssignment',
          params: { projectId: PROJECT_ID, epicId: EPIC_ID, agentId: null, version: 0 },
        }),
      ).resolves.toMatchObject({ result: { agentId: null } });
      expect(updateEpicAssignment).toHaveBeenCalled();
    });

    it('surfaces an OptimisticLockError as error.data.code === optimistic_lock_error', async () => {
      const updateEpicAssignment = jest
        .fn()
        .mockRejectedValue(new OptimisticLockError('Epic', EPIC_ID));
      const board = { updateEpicAssignment } as unknown as MobileBoardRpcService;
      const service = new TunnelHandlerService({}, mobileChat, board, mobileViewport);

      await expect(
        service.handle({
          jsonrpc: '2.0',
          id: 'b3',
          method: 'board.updateEpicAssignment',
          params: { projectId: PROJECT_ID, epicId: EPIC_ID, agentId: AGENT_ID, version: 1 },
        }),
      ).resolves.toMatchObject({
        error: { code: -32603, data: { code: 'optimistic_lock_error' } },
      });
    });

    it('surfaces a cross-project agent ValidationError as -32602 / validation_error', async () => {
      const updateEpicAssignment = jest
        .fn()
        .mockRejectedValue(new ValidationError('Agent does not belong to project'));
      const board = { updateEpicAssignment } as unknown as MobileBoardRpcService;
      const service = new TunnelHandlerService({}, mobileChat, board, mobileViewport);

      await expect(
        service.handle({
          jsonrpc: '2.0',
          id: 'b4',
          method: 'board.updateEpicAssignment',
          params: { projectId: PROJECT_ID, epicId: EPIC_ID, agentId: AGENT_ID_2, version: 3 },
        }),
      ).resolves.toMatchObject({
        error: { code: -32602, data: { code: 'validation_error' } },
      });
    });

    it('rejects board.updateEpicAssignment with a non-int version (strict schema)', async () => {
      const updateEpicAssignment = jest.fn();
      const board = { updateEpicAssignment } as unknown as MobileBoardRpcService;
      const service = new TunnelHandlerService({}, mobileChat, board, mobileViewport);

      await expect(
        service.handle({
          jsonrpc: '2.0',
          id: 'b5',
          method: 'board.updateEpicAssignment',
          params: { projectId: PROJECT_ID, epicId: EPIC_ID, agentId: AGENT_ID, version: 1.5 },
        }),
      ).resolves.toMatchObject({ error: { code: -32602, message: 'Invalid params' } });
      expect(updateEpicAssignment).not.toHaveBeenCalled();
    });

    it('rejects board.addEpicComment with empty content (strict schema)', async () => {
      const addEpicComment = jest.fn();
      const board = { addEpicComment } as unknown as MobileBoardRpcService;
      const service = new TunnelHandlerService({}, mobileChat, board, mobileViewport);

      await expect(
        service.handle({
          jsonrpc: '2.0',
          id: 'b6',
          method: 'board.addEpicComment',
          params: { projectId: PROJECT_ID, epicId: EPIC_ID, authorName: 'User', content: '   ' },
        }),
      ).resolves.toMatchObject({ error: { code: -32602, message: 'Invalid params' } });
      expect(addEpicComment).not.toHaveBeenCalled();
    });

    it('delegates board.listEpicComments / board.addEpicComment / board.deleteEpicComment', async () => {
      const listEpicComments = jest.fn().mockResolvedValue({ items: [], total: 0 });
      const addEpicComment = jest.fn().mockResolvedValue({ id: 'c1' });
      const deleteEpicComment = jest.fn().mockResolvedValue({ deleted: true });
      const board = {
        listEpicComments,
        addEpicComment,
        deleteEpicComment,
      } as unknown as MobileBoardRpcService;
      const service = new TunnelHandlerService({}, mobileChat, board, mobileViewport);

      await expect(
        service.handle({
          jsonrpc: '2.0',
          id: 'b7',
          method: 'board.listEpicComments',
          params: { projectId: PROJECT_ID, epicId: EPIC_ID },
        }),
      ).resolves.toMatchObject({ result: { items: [], total: 0 } });

      await expect(
        service.handle({
          jsonrpc: '2.0',
          id: 'b8',
          method: 'board.addEpicComment',
          params: { projectId: PROJECT_ID, epicId: EPIC_ID, authorName: 'User', content: 'hi' },
        }),
      ).resolves.toMatchObject({ result: { id: 'c1' } });

      await expect(
        service.handle({
          jsonrpc: '2.0',
          id: 'b9',
          method: 'board.deleteEpicComment',
          params: { projectId: PROJECT_ID, epicId: EPIC_ID, commentId: AGENT_ID },
        }),
      ).resolves.toMatchObject({ result: { deleted: true } });

      expect(listEpicComments).toHaveBeenCalled();
      expect(addEpicComment).toHaveBeenCalled();
      expect(deleteEpicComment).toHaveBeenCalled();
    });
  });

  describe('session-history chat.* RPCs', () => {
    const SESSION_ID = '12121212-1212-4212-8212-121212121212';

    it('delegates chat.listSessions to MobileChatRpcService and returns the history DTO', async () => {
      const listSessions = jest.fn().mockResolvedValue({
        items: [{ id: SESSION_ID }],
        nextCursor: 'N',
        hasMore: true,
        total: 1,
      });
      const chat = { listSessions } as unknown as MobileChatRpcService;
      const service = new TunnelHandlerService({}, chat, mobileBoard, mobileViewport);

      await expect(
        service.handle({
          jsonrpc: '2.0',
          id: 's1',
          method: 'chat.listSessions',
          params: { agentId: AGENT_ID, projectId: PROJECT_ID, cursor: 'C', limit: 50 },
        }),
      ).resolves.toMatchObject({
        result: { items: [{ id: SESSION_ID }], nextCursor: 'N', hasMore: true, total: 1 },
      });
      expect(listSessions).toHaveBeenCalledWith({
        agentId: AGENT_ID,
        projectId: PROJECT_ID,
        cursor: 'C',
        limit: 50,
      });
    });

    it('rejects chat.listSessions with a non-uuid agentId before delegating', async () => {
      const listSessions = jest.fn();
      const chat = { listSessions } as unknown as MobileChatRpcService;
      const service = new TunnelHandlerService({}, chat, mobileBoard, mobileViewport);

      await expect(
        service.handle({
          jsonrpc: '2.0',
          id: 's2',
          method: 'chat.listSessions',
          params: { agentId: 'nope', projectId: PROJECT_ID },
        }),
      ).resolves.toMatchObject({ error: { code: -32602, message: 'Invalid params' } });
      expect(listSessions).not.toHaveBeenCalled();
    });

    it('rejects chat.listSessions when limit exceeds 100 before delegating', async () => {
      const listSessions = jest.fn();
      const chat = { listSessions } as unknown as MobileChatRpcService;
      const service = new TunnelHandlerService({}, chat, mobileBoard, mobileViewport);

      await expect(
        service.handle({
          jsonrpc: '2.0',
          id: 's3',
          method: 'chat.listSessions',
          params: { agentId: AGENT_ID, projectId: PROJECT_ID, limit: 500 },
        }),
      ).resolves.toMatchObject({ error: { code: -32602, message: 'Invalid params' } });
      expect(listSessions).not.toHaveBeenCalled();
    });

    it('delegates chat.deleteSessionRecord and returns { deleted }', async () => {
      const deleteSessionRecord = jest.fn().mockResolvedValue({ deleted: true });
      const chat = { deleteSessionRecord } as unknown as MobileChatRpcService;
      const service = new TunnelHandlerService({}, chat, mobileBoard, mobileViewport);

      await expect(
        service.handle({
          jsonrpc: '2.0',
          id: 's4',
          method: 'chat.deleteSessionRecord',
          params: { sessionId: SESSION_ID, projectId: PROJECT_ID },
        }),
      ).resolves.toMatchObject({ result: { deleted: true } });
      expect(deleteSessionRecord).toHaveBeenCalledWith({
        sessionId: SESSION_ID,
        projectId: PROJECT_ID,
      });
    });

    it('maps a STATUS_RUNNING ConflictError from chat.deleteSessionRecord to error.data', async () => {
      const deleteSessionRecord = jest
        .fn()
        .mockRejectedValue(
          new ConflictError('Cannot delete a running session', { code: 'STATUS_RUNNING' }),
        );
      const chat = { deleteSessionRecord } as unknown as MobileChatRpcService;
      const service = new TunnelHandlerService({}, chat, mobileBoard, mobileViewport);

      await expect(
        service.handle({
          jsonrpc: '2.0',
          id: 's5',
          method: 'chat.deleteSessionRecord',
          params: { sessionId: SESSION_ID, projectId: PROJECT_ID },
        }),
      ).resolves.toMatchObject({
        error: { code: -32603, data: { code: 'conflict', details: { code: 'STATUS_RUNNING' } } },
      });
    });

    it('delegates chat.renameSession and accepts a null name (clear)', async () => {
      const renameSession = jest.fn().mockResolvedValue({ id: SESSION_ID, name: null });
      const chat = { renameSession } as unknown as MobileChatRpcService;
      const service = new TunnelHandlerService({}, chat, mobileBoard, mobileViewport);

      await expect(
        service.handle({
          jsonrpc: '2.0',
          id: 's6',
          method: 'chat.renameSession',
          params: { sessionId: SESSION_ID, projectId: PROJECT_ID, name: null },
        }),
      ).resolves.toMatchObject({ result: { id: SESSION_ID, name: null } });
      expect(renameSession).toHaveBeenCalledWith({
        sessionId: SESSION_ID,
        projectId: PROJECT_ID,
        name: null,
      });
    });

    it('rejects chat.renameSession when name exceeds 120 chars before delegating', async () => {
      const renameSession = jest.fn();
      const chat = { renameSession } as unknown as MobileChatRpcService;
      const service = new TunnelHandlerService({}, chat, mobileBoard, mobileViewport);

      await expect(
        service.handle({
          jsonrpc: '2.0',
          id: 's7',
          method: 'chat.renameSession',
          params: { sessionId: SESSION_ID, projectId: PROJECT_ID, name: 'x'.repeat(121) },
        }),
      ).resolves.toMatchObject({ error: { code: -32602, message: 'Invalid params' } });
      expect(renameSession).not.toHaveBeenCalled();
    });

    it('rejects chat.renameSession when name is omitted (nullable, not optional)', async () => {
      const renameSession = jest.fn();
      const chat = { renameSession } as unknown as MobileChatRpcService;
      const service = new TunnelHandlerService({}, chat, mobileBoard, mobileViewport);

      await expect(
        service.handle({
          jsonrpc: '2.0',
          id: 's8',
          method: 'chat.renameSession',
          params: { sessionId: SESSION_ID, projectId: PROJECT_ID },
        }),
      ).resolves.toMatchObject({ error: { code: -32602, message: 'Invalid params' } });
      expect(renameSession).not.toHaveBeenCalled();
    });
  });

  describe('terminal.viewport.* lease control', () => {
    const SESSION_ID = '12121212-1212-4212-8212-121212121212';

    it('delegates terminal.viewport.subscribe and returns the subscriptionId', async () => {
      const subscribe = jest.fn().mockResolvedValue({ subscriptionId: 'vp-1' });
      const viewport = { subscribe } as unknown as ViewportStreamerService;
      const service = new TunnelHandlerService({}, mobileChat, mobileBoard, viewport);

      await expect(
        service.handle({
          jsonrpc: '2.0',
          id: 'v1',
          method: 'terminal.viewport.subscribe',
          params: { sessionId: SESSION_ID, projectId: PROJECT_ID },
        }),
      ).resolves.toMatchObject({ result: { subscriptionId: 'vp-1' } });
      expect(subscribe).toHaveBeenCalledWith({ sessionId: SESSION_ID, projectId: PROJECT_ID });
    });

    it('rejects terminal.viewport.subscribe with a non-uuid sessionId before delegating', async () => {
      const subscribe = jest.fn();
      const viewport = { subscribe } as unknown as ViewportStreamerService;
      const service = new TunnelHandlerService({}, mobileChat, mobileBoard, viewport);

      await expect(
        service.handle({
          jsonrpc: '2.0',
          id: 'v2',
          method: 'terminal.viewport.subscribe',
          params: { sessionId: 'not-a-uuid', projectId: PROJECT_ID },
        }),
      ).resolves.toMatchObject({ error: { code: -32602, message: 'Invalid params' } });
      expect(subscribe).not.toHaveBeenCalled();
    });

    it('rejects terminal.viewport.subscribe when projectId is missing before delegating', async () => {
      const subscribe = jest.fn();
      const viewport = { subscribe } as unknown as ViewportStreamerService;
      const service = new TunnelHandlerService({}, mobileChat, mobileBoard, viewport);

      await expect(
        service.handle({
          jsonrpc: '2.0',
          id: 'v3',
          method: 'terminal.viewport.subscribe',
          params: { sessionId: SESSION_ID },
        }),
      ).resolves.toMatchObject({ error: { code: -32602, message: 'Invalid params' } });
      expect(subscribe).not.toHaveBeenCalled();
    });

    it('surfaces a SESSION_NOT_RUNNING AppError from subscribe as error.data.code', async () => {
      const subscribe = jest
        .fn()
        .mockRejectedValue(new AppError('No running session', 'SESSION_NOT_RUNNING', 409));
      const viewport = { subscribe } as unknown as ViewportStreamerService;
      const service = new TunnelHandlerService({}, mobileChat, mobileBoard, viewport);

      await expect(
        service.handle({
          jsonrpc: '2.0',
          id: 'v4',
          method: 'terminal.viewport.subscribe',
          params: { sessionId: SESSION_ID, projectId: PROJECT_ID },
        }),
      ).resolves.toMatchObject({ error: { code: -32603, data: { code: 'SESSION_NOT_RUNNING' } } });
    });

    it('delegates terminal.viewport.unsubscribe and returns { ok }', async () => {
      const unsubscribe = jest.fn().mockReturnValue({ ok: true });
      const viewport = { unsubscribe } as unknown as ViewportStreamerService;
      const service = new TunnelHandlerService({}, mobileChat, mobileBoard, viewport);

      await expect(
        service.handle({
          jsonrpc: '2.0',
          id: 'v5',
          method: 'terminal.viewport.unsubscribe',
          params: { subscriptionId: 'vp-1' },
        }),
      ).resolves.toMatchObject({ result: { ok: true } });
      expect(unsubscribe).toHaveBeenCalledWith({ subscriptionId: 'vp-1' });
    });

    it('rejects terminal.viewport.unsubscribe with an empty subscriptionId before delegating', async () => {
      const unsubscribe = jest.fn();
      const viewport = { unsubscribe } as unknown as ViewportStreamerService;
      const service = new TunnelHandlerService({}, mobileChat, mobileBoard, viewport);

      await expect(
        service.handle({
          jsonrpc: '2.0',
          id: 'v6',
          method: 'terminal.viewport.unsubscribe',
          params: { subscriptionId: '' },
        }),
      ).resolves.toMatchObject({ error: { code: -32602, message: 'Invalid params' } });
      expect(unsubscribe).not.toHaveBeenCalled();
    });
  });

  describe('e2ee.adoptDeviceKey — installId supersede threading (M2)', () => {
    const KID = 'a'.repeat(32);
    const PUB = Buffer.from(new Uint8Array(32).fill(1)).toString('base64');
    const INSTALL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

    const makeHandler = (adopt: jest.Mock) => {
      const e2eeTrust = { adoptPeerKeyTofu: adopt } as unknown as E2eeTrustService;
      return new TunnelHandlerService({}, mobileChat, mobileBoard, mobileViewport, e2eeTrust);
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

    it('is backward compatible: an old client omitting installId still adopts (installId undefined)', async () => {
      const adopt = jest.fn().mockReturnValue({ kid: KID, trust: 'unverified' });
      const service = makeHandler(adopt);

      await expect(
        service.handle({
          jsonrpc: '2.0',
          id: 'e2',
          method: 'e2ee.adoptDeviceKey',
          params: { kid: KID, publicKeyB64: PUB },
        }),
      ).resolves.toMatchObject({ result: { kid: KID } });
      expect(adopt).toHaveBeenCalledWith({ kid: KID, publicKeyB64: PUB }, undefined);
    });
  });

  describe('e2ee.revokeDeviceKey — sealed-only, trusted sender kid (M3)', () => {
    const SENDER_KID = 'sender'.repeat(5) + 'ss'; // 32 chars
    const VICTIM_KID = 'victim'.repeat(5) + 'vv';

    const makeHandler = (revoke: jest.Mock) => {
      const e2eeTrust = { revokeDevice: revoke } as unknown as E2eeTrustService;
      return new TunnelHandlerService({}, mobileChat, mobileBoard, mobileViewport, e2eeTrust);
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

    it('returns cleanly (removed:false) for a replayed/already-revoked kid — no throw', async () => {
      const revoke = jest.fn().mockReturnValue({ kid: SENDER_KID, removed: false });
      const service = makeHandler(revoke);

      await expect(
        service.handle(
          { jsonrpc: '2.0', id: 'rv2', method: 'e2ee.revokeDeviceKey', params: {} },
          { senderKid: SENDER_KID },
        ),
      ).resolves.toMatchObject({ result: { kid: SENDER_KID, removed: false } });
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
});
