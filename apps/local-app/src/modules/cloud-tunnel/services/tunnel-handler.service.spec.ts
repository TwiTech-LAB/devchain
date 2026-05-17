import { TunnelHandlerService } from './tunnel-handler.service';

describe('TunnelHandlerService', () => {
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
    const service = new TunnelHandlerService(storage);

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
    const service = new TunnelHandlerService(storage);

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
    const service = new TunnelHandlerService(storage);

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
    const service = new TunnelHandlerService(storage);

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
    const service = new TunnelHandlerService(storage);

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
    const service = new TunnelHandlerService(storage);

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
    const service = new TunnelHandlerService(storage);

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
    const service = new TunnelHandlerService(storage);

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
    const service = new TunnelHandlerService(storage);

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
    const service = new TunnelHandlerService({});

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
});
