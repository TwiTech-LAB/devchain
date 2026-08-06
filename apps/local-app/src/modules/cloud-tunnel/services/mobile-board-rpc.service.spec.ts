import { MobileBoardRpcService } from './mobile-board-rpc.service';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import type { EpicsService } from '../../epics/services/epics.service';
import type { Epic } from '../../storage/models/domain.models';
import {
  NotFoundError,
  OptimisticLockError,
  ValidationError,
} from '../../../common/errors/error-types';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const EPIC_ID = '44444444-4444-4444-8444-444444444444';
const AGENT_ID = '55555555-5555-4555-8555-555555555555';
const COMMENT_ID = '66666666-6666-4666-8666-666666666666';

// Raw status row (storage uses `label`); the epic factory references its id.
const STATUS_ROW = { id: 'status-1', label: 'In Progress', color: '#f59e0b', position: 2 };

function epic(over: Partial<Epic> = {}): Epic {
  return {
    id: EPIC_ID,
    projectId: PROJECT_ID,
    title: 'Epic title',
    description: null,
    statusId: 'status-1',
    parentId: null,
    agentId: null,
    createdBy: null,
    version: 3,
    data: null,
    skillsRequired: null,
    tags: [],
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    ...over,
  };
}

function build(
  overrides: {
    storage?: Partial<StorageService>;
    epicsService?: Partial<EpicsService>;
  } = {},
) {
  const storage = {
    getEpic: jest.fn(),
    getAgent: jest.fn(),
    listEpicComments: jest.fn(),
    listStatuses: jest.fn().mockResolvedValue({
      items: [STATUS_ROW],
      total: 1,
      limit: 1000,
      offset: 0,
    }),
    ...overrides.storage,
  } as unknown as jest.Mocked<StorageService>;

  const epicsService = {
    updateEpic: jest.fn(),
    addEpicCommentFromRest: jest.fn(),
    deleteEpicComment: jest.fn(),
    ...overrides.epicsService,
  } as unknown as jest.Mocked<EpicsService>;

  const service = new MobileBoardRpcService(storage, epicsService);
  return { service, storage, epicsService };
}

describe('MobileBoardRpcService', () => {
  describe('updateEpicAssignment', () => {
    it('updates via EpicsService and returns the DTO with new version + agentName', async () => {
      const { service, storage, epicsService } = build({
        storage: {
          getEpic: jest.fn().mockResolvedValue(epic()),
          getAgent: jest.fn().mockResolvedValue({ id: AGENT_ID, name: 'Coder' }),
        },
        epicsService: {
          updateEpic: jest.fn().mockResolvedValue(epic({ agentId: AGENT_ID, version: 4 })),
        },
      });

      const result = (await service.updateEpicAssignment({
        projectId: PROJECT_ID,
        epicId: EPIC_ID,
        agentId: AGENT_ID,
        version: 3,
      })) as Record<string, unknown>;

      expect(epicsService.updateEpic).toHaveBeenCalledWith(EPIC_ID, { agentId: AGENT_ID }, 3);
      expect(result).toMatchObject({
        id: EPIC_ID,
        projectId: PROJECT_ID,
        agentId: AGENT_ID,
        agentName: 'Coder',
        version: 4,
      });
      expect(storage.getAgent).toHaveBeenCalledWith(AGENT_ID);
    });

    it('enriches the returned DTO with resolved status fields (read-parity)', async () => {
      const { service, storage } = build({
        storage: {
          getEpic: jest.fn().mockResolvedValue(epic()),
          getAgent: jest.fn().mockResolvedValue({ id: AGENT_ID, name: 'Coder' }),
        },
        epicsService: {
          updateEpic: jest.fn().mockResolvedValue(epic({ agentId: AGENT_ID, version: 4 })),
        },
      });

      const result = (await service.updateEpicAssignment({
        projectId: PROJECT_ID,
        epicId: EPIC_ID,
        agentId: AGENT_ID,
        version: 3,
      })) as Record<string, unknown>;

      // Mutation DTO must carry the same status fields as the read path so the
      // client's full EpicDetail replace doesn't degrade the status tile.
      expect(storage.listStatuses).toHaveBeenCalledWith(PROJECT_ID, { limit: 1000, offset: 0 });
      expect(result).toMatchObject({
        statusId: 'status-1',
        statusName: 'In Progress',
        statusColor: '#f59e0b',
        statusPosition: 2,
        status: { id: 'status-1', name: 'In Progress', color: '#f59e0b', position: 2 },
      });
    });

    it('supports unassign (agentId null) without resolving an agent name', async () => {
      const { service, storage, epicsService } = build({
        storage: { getEpic: jest.fn().mockResolvedValue(epic({ agentId: AGENT_ID })) },
        epicsService: {
          updateEpic: jest.fn().mockResolvedValue(epic({ agentId: null, version: 4 })),
        },
      });

      const result = (await service.updateEpicAssignment({
        projectId: PROJECT_ID,
        epicId: EPIC_ID,
        agentId: null,
        version: 3,
      })) as Record<string, unknown>;

      expect(epicsService.updateEpic).toHaveBeenCalledWith(EPIC_ID, { agentId: null }, 3);
      expect(result).toMatchObject({ agentId: null, version: 4 });
      expect(result.agentName).toBeUndefined();
      expect(storage.getAgent).not.toHaveBeenCalled();
    });

    it('rejects a cross-project epic with a clean not-found (no update)', async () => {
      const { service, epicsService } = build({
        storage: {
          getEpic: jest.fn().mockResolvedValue(epic({ projectId: OTHER_PROJECT_ID })),
        },
      });

      await expect(
        service.updateEpicAssignment({
          projectId: PROJECT_ID,
          epicId: EPIC_ID,
          agentId: AGENT_ID,
          version: 3,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(epicsService.updateEpic).not.toHaveBeenCalled();
    });

    it('propagates OptimisticLockError unchanged (version conflict)', async () => {
      const { service } = build({
        storage: { getEpic: jest.fn().mockResolvedValue(epic()) },
        epicsService: {
          updateEpic: jest.fn().mockRejectedValue(new OptimisticLockError('Epic', EPIC_ID)),
        },
      });

      await expect(
        service.updateEpicAssignment({
          projectId: PROJECT_ID,
          epicId: EPIC_ID,
          agentId: AGENT_ID,
          version: 2,
        }),
      ).rejects.toBeInstanceOf(OptimisticLockError);
    });

    it('propagates ValidationError for a cross-project agentId (storage-enforced)', async () => {
      const { service } = build({
        storage: { getEpic: jest.fn().mockResolvedValue(epic()) },
        epicsService: {
          updateEpic: jest
            .fn()
            .mockRejectedValue(new ValidationError('Agent does not belong to project')),
        },
      });

      await expect(
        service.updateEpicAssignment({
          projectId: PROJECT_ID,
          epicId: EPIC_ID,
          agentId: AGENT_ID,
          version: 3,
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe('listEpicComments', () => {
    it('lists comments after project validation', async () => {
      const page = { items: [{ id: COMMENT_ID }], total: 1, limit: 50, offset: 0 };
      const { service, storage } = build({
        storage: {
          getEpic: jest.fn().mockResolvedValue(epic()),
          listEpicComments: jest.fn().mockResolvedValue(page),
        },
      });

      const result = await service.listEpicComments({
        projectId: PROJECT_ID,
        epicId: EPIC_ID,
        limit: 50,
        offset: 0,
      });

      expect(storage.listEpicComments).toHaveBeenCalledWith(EPIC_ID, { limit: 50, offset: 0 });
      expect(result).toBe(page);
    });

    it('rejects a cross-project epic without reading comments', async () => {
      const { service, storage } = build({
        storage: {
          getEpic: jest.fn().mockResolvedValue(epic({ projectId: OTHER_PROJECT_ID })),
          listEpicComments: jest.fn(),
        },
      });

      await expect(
        service.listEpicComments({ projectId: PROJECT_ID, epicId: EPIC_ID }),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(storage.listEpicComments).not.toHaveBeenCalled();
    });
  });

  describe('addEpicComment', () => {
    it('adds a comment via EpicsService after project validation', async () => {
      const created = { id: COMMENT_ID, epicId: EPIC_ID, authorName: 'User', content: 'hi' };
      const { service, epicsService } = build({
        storage: { getEpic: jest.fn().mockResolvedValue(epic()) },
        epicsService: { addEpicCommentFromRest: jest.fn().mockResolvedValue(created) },
      });

      const result = await service.addEpicComment({
        projectId: PROJECT_ID,
        epicId: EPIC_ID,
        authorName: 'User',
        content: 'hi',
      });

      expect(epicsService.addEpicCommentFromRest).toHaveBeenCalledWith(EPIC_ID, 'User', 'hi');
      expect(result).toBe(created);
    });

    it('rejects a cross-project epic without adding a comment', async () => {
      const { service, epicsService } = build({
        storage: {
          getEpic: jest.fn().mockResolvedValue(epic({ projectId: OTHER_PROJECT_ID })),
        },
      });

      await expect(
        service.addEpicComment({
          projectId: PROJECT_ID,
          epicId: EPIC_ID,
          authorName: 'User',
          content: 'hi',
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(epicsService.addEpicCommentFromRest).not.toHaveBeenCalled();
    });
  });

  describe('deleteEpicComment', () => {
    it('delegates to the scoped EpicsService.deleteEpicComment and returns { deleted: true }', async () => {
      const { service, epicsService } = build({
        epicsService: { deleteEpicComment: jest.fn().mockResolvedValue(undefined) },
      });

      const result = await service.deleteEpicComment({
        projectId: PROJECT_ID,
        epicId: EPIC_ID,
        commentId: COMMENT_ID,
      });

      expect(epicsService.deleteEpicComment).toHaveBeenCalledWith(PROJECT_ID, EPIC_ID, COMMENT_ID);
      expect(result).toEqual({ deleted: true });
    });

    it('propagates a not-found when the scoped delete refuses (wrong epic/missing)', async () => {
      const { service } = build({
        epicsService: {
          deleteEpicComment: jest.fn().mockRejectedValue(new NotFoundError('Comment', COMMENT_ID)),
        },
      });

      await expect(
        service.deleteEpicComment({
          projectId: PROJECT_ID,
          epicId: EPIC_ID,
          commentId: COMMENT_ID,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});
