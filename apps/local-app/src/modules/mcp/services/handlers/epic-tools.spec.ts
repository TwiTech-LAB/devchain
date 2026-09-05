import {
  handleListEpics,
  handleListAssignedEpicsTasks,
  handleCreateEpic,
  handleGetEpicById,
  handleListEpicRelations,
  handleListEpicRelationCandidates,
  handleSetEpicRelation,
  handleDeleteEpicRelation,
  handleAddEpicComment,
  handleUpdateEpic,
  handleDeleteEpic,
} from './epic-tools';
import type { EpicToolContext } from './epic-context';
import type { AgentSessionContext } from '../../dtos/mcp.dto';
import {
  NotFoundError,
  OptimisticLockError,
  RelationConfirmationRequiredError,
  ValidationError,
  ForbiddenError,
} from '../../../../common/errors/error-types';
import { ServiceUnavailableError } from '../../../../common/errors/service-unavailable.error';

jest.mock('../../../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

jest.mock('../utils/resolve-epic-id', () => ({
  resolveEpicId: jest
    .fn()
    .mockImplementation(async (_storage: unknown, _projectId: string, id: string) => ({
      success: true,
      data: { epicId: id },
    })),
}));

jest.mock('../mappers/dto-mappers', () => ({
  mapStatusSummary: jest.fn().mockImplementation((s) => ({
    id: s.id,
    label: s.label,
    color: s.color,
    position: s.position,
  })),
  mapEpicSummary: jest.fn().mockImplementation((e) => ({
    id: e.id,
    title: e.title,
    parentId: e.parentId,
    agentId: e.agentId,
    agentName: e.agentName,
    version: e.version,
    tags: e.tags || [],
  })),
  mapEpicChild: jest.fn().mockImplementation((e) => ({ id: e.id, title: e.title })),
  mapEpicParent: jest.fn().mockImplementation((e) => ({ id: e.id, title: e.title })),
  mapEpicComment: jest.fn().mockImplementation((c) => ({
    id: c.id,
    content: c.content,
    authorName: c.authorName,
    createdAt: c.createdAt,
  })),
}));

const { resolveEpicId: resolveEpicIdMock } = jest.requireMock('../utils/resolve-epic-id') as {
  resolveEpicId: jest.Mock;
};

const PROJECT_ID = '00000000-0000-0000-0000-000000000001';
const AGENT_ID = '00000000-0000-0000-0000-000000000002';
const AGENT_NAME = 'Agent-A';
const SESSION_ID = '00000000-0000-0000-0000-000000000003';
const EPIC_ID = '00000000-0000-0000-0000-000000000004';
const STATUS_ID = '00000000-0000-0000-0000-000000000005';
const COMMENT_ID = '00000000-0000-0000-0000-000000000006';
const RELATED_ID = '00000000-0000-0000-0000-000000000007';

function makeAgentCtx(): AgentSessionContext {
  return {
    type: 'agent',
    session: {
      id: SESSION_ID,
      agentId: AGENT_ID,
      status: 'active',
      startedAt: '2024-01-01T00:00:00Z',
    },
    agent: { id: AGENT_ID, name: AGENT_NAME, projectId: PROJECT_ID },
    project: { id: PROJECT_ID, name: 'Test Project', rootPath: '/tmp/test' },
  };
}

function makeStorageMock() {
  return {
    listAgents: jest.fn().mockResolvedValue({
      items: [
        {
          id: AGENT_ID,
          name: AGENT_NAME,
          profileId: 'p1',
          providerConfigId: 'config-1',
          description: null,
        },
      ],
      total: 1,
    }),
    listGuests: jest.fn().mockResolvedValue([]),
    getAgent: jest
      .fn()
      .mockResolvedValue({ id: AGENT_ID, name: AGENT_NAME, projectId: PROJECT_ID }),
    getAgentByName: jest.fn().mockResolvedValue({
      id: AGENT_ID,
      name: AGENT_NAME,
      projectId: PROJECT_ID,
      profileId: 'p1',
      providerConfigId: 'config-1',
      description: null,
      profile: { id: 'p1', name: 'Profile', instructions: '' },
    }),
    getProfileProviderConfig: jest.fn().mockResolvedValue({
      id: 'config-1',
      name: 'Claude Sonnet',
    }),
    listAssignedEpics: jest.fn().mockResolvedValue({
      items: [],
      total: 0,
      limit: 100,
      offset: 0,
    }),
    listStatuses: jest.fn().mockResolvedValue({
      items: [{ id: STATUS_ID, label: 'New', color: '#ccc', position: 0, projectId: PROJECT_ID }],
    }),
    listProjectEpics: jest.fn().mockResolvedValue({
      items: [
        {
          id: EPIC_ID,
          title: 'Test Epic',
          statusId: STATUS_ID,
          parentId: null,
          agentId: null,
          agentName: null,
          version: 1,
          tags: [],
        },
      ],
      total: 1,
      limit: 100,
      offset: 0,
    }),
    listAssignedEpics: jest.fn().mockResolvedValue({
      items: [],
      total: 0,
      limit: 100,
      offset: 0,
    }),
    findStatusByName: jest.fn().mockImplementation(async (_projectId: string, name: string) => {
      if (name.toLowerCase() === 'new')
        return { id: STATUS_ID, label: 'New', color: '#ccc', position: 0, projectId: PROJECT_ID };
      return null;
    }),
    listSubEpics: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    listSubEpicsForParents: jest.fn().mockResolvedValue(new Map()),
    createEpicComment: jest.fn().mockResolvedValue({
      id: COMMENT_ID,
      epicId: EPIC_ID,
      content: 'Test',
      authorName: AGENT_NAME,
      createdAt: '2024-01-01T00:00:00Z',
    }),
    getEpic: jest.fn().mockResolvedValue({
      id: EPIC_ID,
      projectId: PROJECT_ID,
      title: 'Test Epic',
      description: 'desc',
      statusId: STATUS_ID,
      parentId: null,
      agentId: AGENT_ID,
      version: 1,
      tags: ['tag1'],
      data: null,
      skillsRequired: null,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    }),
    getStatus: jest.fn().mockResolvedValue({
      id: STATUS_ID,
      label: 'New',
      color: '#ccc',
      position: 0,
      projectId: PROJECT_ID,
    }),
    listEpicComments: jest.fn().mockResolvedValue({ items: [] }),
    listEpicRelations: jest.fn().mockResolvedValue({
      items: [],
      total: 0,
      limit: 50,
      offset: 0,
    }),
    listEpicRelationCandidates: jest.fn().mockResolvedValue({
      items: [],
      total: 0,
      limit: 50,
      offset: 0,
    }),
    getWorkspaceEpicsByIdPrefix: jest.fn().mockResolvedValue([]),
    addEpicComment: jest.fn().mockResolvedValue({
      id: COMMENT_ID,
      epicId: EPIC_ID,
      content: 'Test',
      authorName: AGENT_NAME,
      createdAt: '2024-01-01T00:00:00Z',
    }),
    updateEpic: jest.fn().mockResolvedValue({
      id: EPIC_ID,
      projectId: PROJECT_ID,
      title: 'Updated',
      description: null,
      statusId: STATUS_ID,
      parentId: null,
      agentId: null,
      version: 2,
      tags: [],
      data: null,
      skillsRequired: null,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:01Z',
    }),
  } as never;
}

function makeEpicsServiceMock() {
  return {
    createEpicForProject: jest.fn().mockResolvedValue({
      id: EPIC_ID,
      projectId: PROJECT_ID,
      title: 'New Epic',
      description: null,
      statusId: STATUS_ID,
      parentId: null,
      agentId: null,
      version: 1,
      tags: [],
      data: null,
      skillsRequired: null,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    }),
    updateEpic: jest.fn().mockResolvedValue({
      id: EPIC_ID,
      projectId: PROJECT_ID,
      title: 'Updated',
      description: null,
      statusId: STATUS_ID,
      parentId: null,
      agentId: null,
      version: 2,
      tags: [],
      data: null,
      skillsRequired: null,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:01Z',
    }),
    addEpicComment: jest.fn().mockResolvedValue({
      id: COMMENT_ID,
      epicId: EPIC_ID,
      content: 'Test comment',
      authorName: AGENT_NAME,
      createdAt: '2024-01-01T00:00:00Z',
    }),
    updateEpicWithOutcome: jest.fn().mockResolvedValue({
      epic: {
        id: EPIC_ID,
        projectId: PROJECT_ID,
        title: 'Updated',
        description: null,
        statusId: STATUS_ID,
        parentId: null,
        agentId: null,
        version: 2,
        tags: [],
        data: null,
        skillsRequired: null,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:01Z',
      },
      outcome: { statusChanged: false, agentUnchanged: true, previousAssigneeAgent: null },
    }),
    deleteEpic: jest.fn().mockResolvedValue(undefined),
  } as never;
}

function makeEpicCtx(overrides: Partial<EpicToolContext> = {}): EpicToolContext {
  return {
    storage: makeStorageMock(),
    epicsService: makeEpicsServiceMock(),
    epicRelationsService: {
      setRelation: jest.fn(),
      deleteRelation: jest.fn(),
    } as never,
    resolveSessionContext: jest.fn().mockResolvedValue({ success: true, data: makeAgentCtx() }),
    ...overrides,
  };
}

describe('epic-tools handlers', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('handleListEpics', () => {
    it('returns epics list', async () => {
      const ctx = makeEpicCtx();
      const result = await handleListEpics(ctx, { sessionId: SESSION_ID });
      expect(result.success).toBe(true);
      expect(result.data.epics).toHaveLength(1);
    });
  });

  describe('handleListAssignedEpicsTasks', () => {
    it('returns error when no project associated', async () => {
      const agentCtx = makeAgentCtx();
      (agentCtx as Record<string, unknown>).project = null;
      const ctx = makeEpicCtx();
      (ctx.resolveSessionContext as jest.Mock).mockResolvedValue({ success: true, data: agentCtx });

      const result = await handleListAssignedEpicsTasks(ctx, {
        sessionId: SESSION_ID,
        agentName: AGENT_NAME,
      });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('PROJECT_NOT_FOUND');
    });
  });

  describe('handleCreateEpic', () => {
    it('creates epic with title and status', async () => {
      const ctx = makeEpicCtx();
      const result = await handleCreateEpic(ctx, {
        sessionId: SESSION_ID,
        title: 'New Epic',
        statusName: 'New',
      });
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ id: EPIC_ID, version: 1 });
      expect(ctx.epicsService.createEpicForProject).toHaveBeenCalled();
    });

    it('forwards parent and required skills with the creator context', async () => {
      const ctx = makeEpicCtx();

      await handleCreateEpic(ctx, {
        sessionId: SESSION_ID,
        title: 'Child Epic',
        parentId: '00000000-0000-0000-0000-000000000099',
        skillsRequired: ['source/testing'],
      });

      expect(ctx.epicsService.createEpicForProject).toHaveBeenCalledWith(
        PROJECT_ID,
        expect.objectContaining({
          parentId: '00000000-0000-0000-0000-000000000099',
          skillsRequired: ['source/testing'],
        }),
        { actor: { type: 'agent', id: AGENT_ID }, creatorAgentName: AGENT_NAME },
      );
    });

    it('forwards one focal-relative initial relation to the atomic service workflow', async () => {
      const ctx = makeEpicCtx();

      await handleCreateEpic(ctx, {
        sessionId: SESSION_ID,
        title: 'Atomic Epic',
        relation: { relatedEpicId: RELATED_ID.slice(0, 8), relation: 'blocked_by' },
      });

      expect(ctx.epicsService.createEpicForProject).toHaveBeenCalledWith(
        PROJECT_ID,
        expect.objectContaining({
          relation: {
            relatedEpicId: RELATED_ID.slice(0, 8),
            relation: 'blocked_by',
          },
        }),
        { actor: { type: 'agent', id: AGENT_ID }, creatorAgentName: AGENT_NAME },
      );
    });

    it('returns error when status not found', async () => {
      const ctx = makeEpicCtx();
      const result = await handleCreateEpic(ctx, {
        sessionId: SESSION_ID,
        title: 'New Epic',
        statusName: 'Nonexistent',
      });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('STATUS_NOT_FOUND');
    });

    it.each([
      [new NotFoundError('Related Epic'), 'RELATED_EPIC_NOT_FOUND'],
      [
        new ValidationError('Multiple Epics match the related Epic address.', {
          code: 'AMBIGUOUS_RELATED_EPIC',
        }),
        'AMBIGUOUS_RELATED_EPIC',
      ],
      [new ForbiddenError('Guests cannot write Epic relations.'), 'AGENT_CONTEXT_REQUIRED'],
    ])(
      'maps atomic relation creation errors without exposing a partial Epic',
      async (error, code) => {
        const ctx = makeEpicCtx();
        (ctx.epicsService.createEpicForProject as jest.Mock).mockRejectedValue(error);

        const result = await handleCreateEpic(ctx, {
          sessionId: SESSION_ID,
          title: 'Atomic Epic',
          relation: { relatedEpicId: RELATED_ID, relation: 'related' },
        });

        expect(result.error?.code).toBe(code);
      },
    );
  });

  describe('handleGetEpicById', () => {
    it('returns epic with children and comments', async () => {
      const ctx = makeEpicCtx();
      (ctx.storage.listSubEpics as jest.Mock).mockResolvedValue({ items: [], total: 0 });
      (ctx.storage.listEpicRelations as jest.Mock).mockResolvedValue({
        items: [],
        total: 51,
        limit: 50,
        offset: 0,
      });

      const result = await handleGetEpicById(ctx, { sessionId: SESSION_ID, id: EPIC_ID });
      expect(result.success).toBe(true);
      expect(result.data.epic.id).toBe(EPIC_ID);
      expect(result.data.relations).toMatchObject({
        items: [],
        total: 51,
        limit: 50,
        offset: 0,
        truncated: true,
      });
      expect(ctx.storage.listEpicRelations).toHaveBeenCalledWith(EPIC_ID, {
        excludeMcpHidden: true,
        limit: 50,
        offset: 0,
      });
    });

    it('returns error when epic not found', async () => {
      const ctx = makeEpicCtx();
      (ctx.storage.getEpic as jest.Mock).mockRejectedValue(new NotFoundError('Epic', EPIC_ID));

      const result = await handleGetEpicById(ctx, { sessionId: SESSION_ID, id: EPIC_ID });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('EPIC_NOT_FOUND');
    });
  });

  describe('Epic relation resources', () => {
    const relationRow = {
      relationId: 'relation-1',
      epicId: RELATED_ID,
      projectId: PROJECT_ID,
      projectName: 'Test Project',
      title: 'Related Epic',
      statusId: STATUS_ID,
      statusLabel: 'New',
      statusColor: '#ccc',
      statusMcpHidden: false,
      type: 'blocked_by',
      sourceEpicId: null,
      targetEpicId: null,
      createdAt: '2026-08-29T00:00:00.000Z',
      updatedAt: '2026-08-29T00:00:00.000Z',
    } as const;
    const candidate = {
      id: RELATED_ID,
      projectId: PROJECT_ID,
      projectName: 'Test Project',
      title: 'Related Epic',
      statusId: STATUS_ID,
      statusLabel: 'New',
      statusColor: '#ccc',
      statusMcpHidden: false,
      parentId: null,
    };

    it('lists bounded focal-relative rows with MCP-hidden filtering', async () => {
      const ctx = makeEpicCtx();
      (ctx.storage.listEpicRelations as jest.Mock).mockResolvedValue({
        items: [relationRow],
        total: 3,
        limit: 1,
        offset: 1,
      });

      const result = await handleListEpicRelations(ctx, {
        sessionId: SESSION_ID,
        epicId: EPIC_ID,
        limit: 1,
        offset: 1,
      });

      expect(result).toMatchObject({
        success: true,
        data: {
          total: 3,
          limit: 1,
          offset: 1,
          items: [
            {
              relationId: 'relation-1',
              relation: 'blocked_by',
              sourceEpicId: null,
              targetEpicId: null,
              relatedEpic: { id: RELATED_ID, shortId: RELATED_ID.slice(0, 8) },
            },
          ],
        },
      });
      expect(ctx.storage.listEpicRelations).toHaveBeenCalledWith(EPIC_ID, {
        excludeMcpHidden: true,
        limit: 1,
        offset: 1,
      });
    });

    it('reports the stored semantic source and target on list reads', async () => {
      const ctx = makeEpicCtx();
      (ctx.storage.listEpicRelations as jest.Mock).mockResolvedValue({
        items: [{ ...relationRow, sourceEpicId: EPIC_ID, targetEpicId: RELATED_ID }],
        total: 1,
        limit: 50,
        offset: 0,
      });

      const result = await handleListEpicRelations(ctx, {
        sessionId: SESSION_ID,
        epicId: EPIC_ID,
      });

      expect(result).toMatchObject({
        success: true,
        data: { items: [{ sourceEpicId: EPIC_ID, targetEpicId: RELATED_ID }] },
      });
    });

    it('lists workspace candidates with MCP-hidden filtering and paging', async () => {
      const ctx = makeEpicCtx();
      (ctx.storage.listEpicRelationCandidates as jest.Mock).mockResolvedValue({
        items: [candidate],
        total: 1,
        limit: 10,
        offset: 0,
      });

      const result = await handleListEpicRelationCandidates(ctx, {
        sessionId: SESSION_ID,
        epicId: EPIC_ID,
        q: 'related',
        limit: 10,
        offset: 0,
      });

      expect(result).toMatchObject({
        success: true,
        data: { items: [{ id: RELATED_ID, shortId: RELATED_ID.slice(0, 8) }], total: 1 },
      });
      expect(ctx.storage.listEpicRelationCandidates).toHaveBeenCalledWith(EPIC_ID, {
        q: 'related',
        excludeMcpHidden: true,
        limit: 10,
        offset: 0,
      });
    });

    it('resolves a visible workspace target and delegates an agent set to the relation service', async () => {
      const ctx = makeEpicCtx();
      (ctx.storage.getWorkspaceEpicsByIdPrefix as jest.Mock).mockResolvedValue([candidate]);
      (ctx.epicRelationsService.setRelation as jest.Mock).mockResolvedValue({
        type: 'blocks',
        sourceEpicId: EPIC_ID,
        targetEpicId: RELATED_ID,
      });

      const result = await handleSetEpicRelation(ctx, {
        sessionId: SESSION_ID,
        epicId: EPIC_ID,
        relatedEpicId: RELATED_ID.slice(0, 8),
        relation: 'blocks',
      });

      expect(result).toEqual({
        success: true,
        data: {
          epicId: EPIC_ID,
          relatedEpicId: RELATED_ID,
          relation: 'blocks',
          sourceEpicId: EPIC_ID,
          targetEpicId: RELATED_ID,
        },
      });
      expect(ctx.storage.getWorkspaceEpicsByIdPrefix).toHaveBeenCalledWith(
        EPIC_ID,
        RELATED_ID.slice(0, 8),
        { excludeMcpHidden: true },
      );
      expect(ctx.epicRelationsService.setRelation).toHaveBeenCalledWith(
        EPIC_ID,
        RELATED_ID,
        'blocks',
        { actor: { type: 'agent', id: AGENT_ID } },
      );
    });

    it('reports the derived source and target for a Related set', async () => {
      const ctx = makeEpicCtx();
      (ctx.storage.getWorkspaceEpicsByIdPrefix as jest.Mock).mockResolvedValue([candidate]);
      (ctx.epicRelationsService.setRelation as jest.Mock).mockResolvedValue({
        type: 'related',
        sourceEpicId: EPIC_ID,
        targetEpicId: RELATED_ID,
      });

      const result = await handleSetEpicRelation(ctx, {
        sessionId: SESSION_ID,
        epicId: EPIC_ID,
        relatedEpicId: RELATED_ID,
        relation: 'related',
      });

      expect(result).toEqual({
        success: true,
        data: {
          epicId: EPIC_ID,
          relatedEpicId: RELATED_ID,
          relation: 'related',
          sourceEpicId: EPIC_ID,
          targetEpicId: RELATED_ID,
        },
      });
      expect(ctx.epicRelationsService.setRelation).toHaveBeenCalledWith(
        EPIC_ID,
        RELATED_ID,
        'related',
        { actor: { type: 'agent', id: AGENT_ID } },
      );
    });

    it('returns safe ambiguity without invoking a relation mutation', async () => {
      const ctx = makeEpicCtx();
      (ctx.storage.getWorkspaceEpicsByIdPrefix as jest.Mock).mockResolvedValue([
        candidate,
        { ...candidate, id: '00000000-0000-0000-0000-000000000008' },
      ]);

      const result = await handleSetEpicRelation(ctx, {
        sessionId: SESSION_ID,
        epicId: EPIC_ID,
        relatedEpicId: '00000000',
        relation: 'related',
      });

      expect(result.error?.code).toBe('AMBIGUOUS_RELATED_EPIC');
      expect(ctx.epicRelationsService.setRelation).not.toHaveBeenCalled();
    });

    it('returns the current target on a displacing set and demands an explicit delete', async () => {
      const ctx = makeEpicCtx();
      (ctx.storage.getWorkspaceEpicsByIdPrefix as jest.Mock).mockResolvedValue([candidate]);
      const currentEffect = { sourceEpicId: EPIC_ID, targetEpicId: RELATED_ID };
      (ctx.epicRelationsService.setRelation as jest.Mock).mockRejectedValue(
        new RelationConfirmationRequiredError(currentEffect),
      );

      const result = await handleSetEpicRelation(ctx, {
        sessionId: SESSION_ID,
        epicId: EPIC_ID,
        relatedEpicId: '33333333',
        relation: 'related',
      });

      expect(result).toEqual({
        success: false,
        error: {
          code: 'RELATION_CONFIRMATION_REQUIRED',
          message:
            'This change displaces an active relation time route. Delete the existing Related pair explicitly, then retry this command.',
          data: { currentEffect },
        },
      });
    });

    it('delegates delete and maps guest authorization and standalone service errors', async () => {
      const ctx = makeEpicCtx();
      (ctx.storage.getWorkspaceEpicsByIdPrefix as jest.Mock).mockResolvedValue([candidate]);
      (ctx.epicRelationsService.deleteRelation as jest.Mock).mockResolvedValue(true);

      await expect(
        handleDeleteEpicRelation(ctx, {
          sessionId: SESSION_ID,
          epicId: EPIC_ID,
          relatedEpicId: RELATED_ID,
        }),
      ).resolves.toEqual({
        success: true,
        data: { epicId: EPIC_ID, relatedEpicId: RELATED_ID, deleted: true },
      });

      (ctx.epicRelationsService.deleteRelation as jest.Mock).mockRejectedValueOnce(
        new ForbiddenError('Guests cannot write Epic relations.'),
      );
      expect(
        (
          await handleDeleteEpicRelation(ctx, {
            sessionId: SESSION_ID,
            epicId: EPIC_ID,
            relatedEpicId: RELATED_ID,
          })
        ).error?.code,
      ).toBe('AGENT_CONTEXT_REQUIRED');

      (ctx.epicRelationsService.deleteRelation as jest.Mock).mockRejectedValueOnce(
        new ServiceUnavailableError('EpicRelationsService'),
      );
      expect(
        (
          await handleDeleteEpicRelation(ctx, {
            sessionId: SESSION_ID,
            epicId: EPIC_ID,
            relatedEpicId: RELATED_ID,
          })
        ).error?.code,
      ).toBe('SERVICE_UNAVAILABLE');
    });

    it('deletes an exact full target ID without any prefix lookup', async () => {
      const ctx = makeEpicCtx();
      (ctx.epicRelationsService.deleteRelation as jest.Mock).mockResolvedValue(true);

      const result = await handleDeleteEpicRelation(ctx, {
        sessionId: SESSION_ID,
        epicId: EPIC_ID,
        relatedEpicId: RELATED_ID,
      });

      expect(result).toEqual({
        success: true,
        data: { epicId: EPIC_ID, relatedEpicId: RELATED_ID, deleted: true },
      });
      // The exact path resolves no prefix and applies no MCP-hidden filter:
      // a target hidden from reads stays deletable by its server-issued ID.
      expect(ctx.storage.getWorkspaceEpicsByIdPrefix).not.toHaveBeenCalled();
      expect(ctx.epicRelationsService.deleteRelation).toHaveBeenCalledWith(
        EPIC_ID,
        RELATED_ID,
        expect.anything(),
      );
    });

    it('keeps prefix resolution visible-only and never discloses hidden targets', async () => {
      const ctx = makeEpicCtx();
      (ctx.storage.getWorkspaceEpicsByIdPrefix as jest.Mock).mockResolvedValue([]);

      const result = await handleDeleteEpicRelation(ctx, {
        sessionId: SESSION_ID,
        epicId: EPIC_ID,
        relatedEpicId: '22222222',
      });

      expect(result.error?.code).toBe('RELATED_EPIC_NOT_FOUND');
      expect(ctx.storage.getWorkspaceEpicsByIdPrefix).toHaveBeenCalledWith(EPIC_ID, '22222222', {
        excludeMcpHidden: true,
      });
      expect(ctx.epicRelationsService.deleteRelation).not.toHaveBeenCalled();
    });

    it('recovers a blocked replacement through exact deletion and retry', async () => {
      const ctx = makeEpicCtx();
      (ctx.storage.getWorkspaceEpicsByIdPrefix as jest.Mock).mockResolvedValue([candidate]);
      const hiddenTargetId = '44444444-4444-4444-4444-444444444444';
      const setRelation = ctx.epicRelationsService.setRelation as jest.Mock;
      const deleteRelation = ctx.epicRelationsService.deleteRelation as jest.Mock;
      setRelation.mockRejectedValueOnce(
        new RelationConfirmationRequiredError({
          sourceEpicId: EPIC_ID,
          targetEpicId: hiddenTargetId,
        }),
      );
      deleteRelation.mockResolvedValueOnce(true);
      setRelation.mockResolvedValueOnce({
        relationId: 'relation-recovered',
        type: 'related',
        sourceEpicId: EPIC_ID,
        targetEpicId: RELATED_ID,
      });

      // The replacement refusal names the exact hidden current target.
      const refused = await handleSetEpicRelation(ctx, {
        sessionId: SESSION_ID,
        epicId: EPIC_ID,
        relatedEpicId: RELATED_ID,
        relation: 'related',
      });
      expect(refused).toMatchObject({
        success: false,
        error: { code: 'RELATION_CONFIRMATION_REQUIRED' },
      });

      // The agent deletes that exact pair — no prefix lookup, no disclosure.
      (ctx.storage.getWorkspaceEpicsByIdPrefix as jest.Mock).mockClear();
      const deleted = await handleDeleteEpicRelation(ctx, {
        sessionId: SESSION_ID,
        epicId: EPIC_ID,
        relatedEpicId: hiddenTargetId,
      });
      expect(deleted).toEqual({
        success: true,
        data: { epicId: EPIC_ID, relatedEpicId: hiddenTargetId, deleted: true },
      });
      expect(ctx.storage.getWorkspaceEpicsByIdPrefix).not.toHaveBeenCalled();

      // The replacement retry now succeeds.
      const retried = await handleSetEpicRelation(ctx, {
        sessionId: SESSION_ID,
        epicId: EPIC_ID,
        relatedEpicId: RELATED_ID,
        relation: 'related',
      });
      expect(retried).toMatchObject({
        success: true,
        data: { relation: 'related', sourceEpicId: EPIC_ID, targetEpicId: RELATED_ID },
      });
    });

    it('does not let a full focal UUID escape the session project boundary', async () => {
      const ctx = makeEpicCtx();
      (ctx.storage.getEpic as jest.Mock).mockResolvedValueOnce({
        id: EPIC_ID,
        projectId: 'foreign-project',
      });

      const result = await handleListEpicRelations(ctx, {
        sessionId: SESSION_ID,
        epicId: EPIC_ID,
      });

      expect(result.error?.code).toBe('EPIC_NOT_FOUND');
      expect(ctx.storage.listEpicRelations).not.toHaveBeenCalled();
    });
  });

  describe('handleAddEpicComment', () => {
    it('adds comment to epic', async () => {
      const ctx = makeEpicCtx();
      const result = await handleAddEpicComment(ctx, {
        sessionId: SESSION_ID,
        epicId: EPIC_ID,
        content: 'Test comment',
      });
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ id: COMMENT_ID });
      expect(ctx.epicsService.addEpicComment).toHaveBeenCalledWith(
        EPIC_ID,
        PROJECT_ID,
        'Test comment',
        AGENT_ID,
        'agent',
      );
    });

    it('returns error when epic not found', async () => {
      const ctx = makeEpicCtx();
      (ctx.epicsService.addEpicComment as jest.Mock).mockRejectedValue(
        new NotFoundError('Epic', EPIC_ID),
      );

      const result = await handleAddEpicComment(ctx, {
        sessionId: SESSION_ID,
        epicId: EPIC_ID,
        content: 'Test',
      });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('EPIC_NOT_FOUND');
    });
  });

  describe('handleUpdateEpic', () => {
    it('passes computed tag mutations to the service without expanding the response', async () => {
      const ctx = makeEpicCtx();

      const result = await handleUpdateEpic(ctx, {
        sessionId: SESSION_ID,
        id: EPIC_ID,
        version: 1,
        addTags: ['tag2'],
        removeTags: ['tag1'],
      });

      expect(ctx.epicsService.updateEpicWithOutcome).toHaveBeenCalledWith(
        EPIC_ID,
        { tags: ['tag2'] },
        1,
        { actor: { type: 'agent', id: AGENT_ID } },
      );
      expect(result).toEqual({ success: true, data: { id: EPIC_ID, version: 2 } });
    });

    it('passes an explicit empty tag replacement to the service', async () => {
      const ctx = makeEpicCtx();

      const result = await handleUpdateEpic(ctx, {
        sessionId: SESSION_ID,
        id: EPIC_ID,
        version: 1,
        setTags: [],
      });

      expect(ctx.epicsService.updateEpicWithOutcome).toHaveBeenCalledWith(
        EPIC_ID,
        { tags: [] },
        1,
        { actor: { type: 'agent', id: AGENT_ID } },
      );
      expect(result).toEqual({ success: true, data: { id: EPIC_ID, version: 2 } });
    });

    it('maps OptimisticLockError by class to VERSION_CONFLICT with currentVersion', async () => {
      const ctx = makeEpicCtx();
      (ctx.epicsService.updateEpicWithOutcome as jest.Mock).mockRejectedValue(
        new OptimisticLockError('Epic', EPIC_ID, {
          expectedVersion: 1,
          actualVersion: 7,
        }),
      );
      (ctx.storage.getEpic as jest.Mock)
        .mockResolvedValueOnce({
          id: EPIC_ID,
          projectId: PROJECT_ID,
          title: 'Test Epic',
          version: 1,
          tags: [],
        })
        .mockResolvedValueOnce({ id: EPIC_ID, projectId: PROJECT_ID, version: 7 });

      const result = await handleUpdateEpic(ctx, {
        sessionId: SESSION_ID,
        id: EPIC_ID,
        version: 1,
        title: 'Updated',
      });

      expect(result).toEqual({
        success: false,
        error: {
          code: 'VERSION_CONFLICT',
          message: 'Epic version conflict. Expected version 1, but current version is 7.',
          data: { currentVersion: 7 },
        },
      });
    });

    it('returns error when epic not found', async () => {
      const ctx = makeEpicCtx();
      (ctx.storage.getEpic as jest.Mock).mockRejectedValue(new NotFoundError('Epic', EPIC_ID));

      const result = await handleUpdateEpic(ctx, {
        sessionId: SESSION_ID,
        id: EPIC_ID,
        version: 1,
        title: 'Updated',
      });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('EPIC_NOT_FOUND');
    });

    it('returns error when status not found for statusName', async () => {
      const ctx = makeEpicCtx();
      const result = await handleUpdateEpic(ctx, {
        sessionId: SESSION_ID,
        id: EPIC_ID,
        version: 1,
        statusName: 'Nonexistent',
      });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('STATUS_NOT_FOUND');
    });

    it('maps ValidationError from service to HIERARCHY_CONFLICT', async () => {
      const PARENT_B_ID = '00000000-0000-0000-0000-000000000099';
      const ctx = makeEpicCtx();
      (ctx.epicsService.updateEpicWithOutcome as jest.Mock).mockRejectedValue(
        new ValidationError(
          'Cannot move an epic that has sub-epics under another parent (one-level hierarchy).',
          { epicId: EPIC_ID, parentId: PARENT_B_ID },
        ),
      );

      const result = await handleUpdateEpic(ctx, {
        sessionId: SESSION_ID,
        id: EPIC_ID,
        version: 1,
        parentId: PARENT_B_ID,
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('HIERARCHY_CONFLICT');
      expect(result.error?.message).toContain('Cannot move an epic that has sub-epics');
    });
  });

  describe('handleDeleteEpic', () => {
    it('returns PROJECT_NOT_FOUND when session has no project', async () => {
      const agentCtx = makeAgentCtx();
      (agentCtx as Record<string, unknown>).project = null;
      const ctx = makeEpicCtx();
      (ctx.resolveSessionContext as jest.Mock).mockResolvedValue({ success: true, data: agentCtx });

      const result = await handleDeleteEpic(ctx, { sessionId: SESSION_ID, id: EPIC_ID });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('PROJECT_NOT_FOUND');
    });

    it('resolves short IDs and delegates delete to epicsService with actor context', async () => {
      const ctx = makeEpicCtx();
      resolveEpicIdMock.mockResolvedValueOnce({ success: true, data: { epicId: EPIC_ID } });

      const result = await handleDeleteEpic(ctx, { sessionId: SESSION_ID, id: 'abcd1234' });

      expect(result.success).toBe(true);
      expect(resolveEpicIdMock).toHaveBeenCalledWith(ctx.storage, PROJECT_ID, 'abcd1234');
      expect(ctx.epicsService.deleteEpic).toHaveBeenCalledWith(EPIC_ID, {
        actor: { type: 'agent', id: AGENT_ID },
      });
      expect(result.data).toEqual({ id: EPIC_ID, deleted: true });
    });

    it('returns resolver failure when prefix resolution fails', async () => {
      const ctx = makeEpicCtx();
      resolveEpicIdMock.mockResolvedValueOnce({
        success: false,
        error: {
          code: 'EPIC_NOT_FOUND',
          message: 'No epic matched prefix abcd1234',
        },
      });

      const result = await handleDeleteEpic(ctx, { sessionId: SESSION_ID, id: 'abcd1234' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('EPIC_NOT_FOUND');
      expect(ctx.storage.getEpic).not.toHaveBeenCalled();
      expect(ctx.epicsService.deleteEpic).not.toHaveBeenCalled();
    });

    it('returns EPIC_NOT_FOUND when epic lookup fails', async () => {
      const ctx = makeEpicCtx();
      (ctx.storage.getEpic as jest.Mock).mockRejectedValue(new NotFoundError('Epic', EPIC_ID));

      const result = await handleDeleteEpic(ctx, { sessionId: SESSION_ID, id: EPIC_ID });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('EPIC_NOT_FOUND');
      expect(ctx.epicsService.deleteEpic).not.toHaveBeenCalled();
    });

    it('returns EPIC_NOT_FOUND when resolved epic belongs to another project', async () => {
      const ctx = makeEpicCtx();
      (ctx.storage.getEpic as jest.Mock).mockResolvedValue({
        id: EPIC_ID,
        title: 'Wrong project epic',
        projectId: '00000000-0000-0000-0000-000000000099',
        description: null,
        statusId: STATUS_ID,
        parentId: null,
        agentId: null,
        version: 1,
        tags: [],
        data: null,
        skillsRequired: null,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      });

      const result = await handleDeleteEpic(ctx, { sessionId: SESSION_ID, id: EPIC_ID });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('EPIC_NOT_FOUND');
    });
  });
});
