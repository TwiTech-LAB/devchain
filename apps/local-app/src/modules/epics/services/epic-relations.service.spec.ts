import {
  ForbiddenError,
  RelationConfirmationRequiredError,
} from '../../../common/errors/error-types';
import type { EventsService } from '../../events/services/events.service';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import type { EpicRelationListItem } from '../../storage/models/domain.models';
import { EpicRelationsService } from './epic-relations.service';

describe('EpicRelationsService', () => {
  const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
  const EPIC_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
  const RELATED_ID = 'bbbbbbbb-2222-4222-8222-222222222222';
  let storage: {
    listEpicRelations: jest.Mock;
    listEpicRelationCandidates: jest.Mock;
    summarizeEpicRelationsBatch: jest.Mock;
    setEpicRelation: jest.Mock;
    deleteEpicRelation: jest.Mock;
  };
  let events: { publish: jest.Mock };
  let service: EpicRelationsService;

  const relationRow: EpicRelationListItem = {
    relationId: 'relation-1',
    epicId: RELATED_ID,
    projectId: 'project-2',
    projectName: 'Peer Project',
    title: 'Peer Epic',
    statusId: 'status-1',
    statusLabel: 'In Progress',
    statusColor: '#123456',
    statusMcpHidden: false,
    type: 'blocked_by',
    sourceEpicId: null,
    targetEpicId: null,
    createdAt: '2026-08-29T00:00:00.000Z',
    updatedAt: '2026-08-29T00:00:00.000Z',
  };

  beforeEach(() => {
    storage = {
      listEpicRelations: jest.fn().mockResolvedValue({
        items: [relationRow],
        total: 1,
        limit: 50,
        offset: 0,
      }),
      listEpicRelationCandidates: jest.fn().mockResolvedValue({
        items: [],
        total: 0,
        limit: 50,
        offset: 0,
      }),
      summarizeEpicRelationsBatch: jest.fn().mockResolvedValue(new Map()),
      setEpicRelation: jest.fn(),
      deleteEpicRelation: jest.fn(),
    };
    events = { publish: jest.fn().mockResolvedValue(null) };
    service = new EpicRelationsService(
      storage as unknown as StorageService,
      events as unknown as EventsService,
    );
  });

  it('projects focal-relative relation storage rows into the REST DTO', async () => {
    storage.listEpicRelations.mockResolvedValueOnce({
      items: [relationRow],
      total: 17,
      limit: 25,
      offset: 5,
    });
    await expect(
      service.listRelations(EPIC_ID, { excludeMcpHidden: true, limit: 25, offset: 5 }),
    ).resolves.toEqual({
      items: [
        {
          relationId: 'relation-1',
          type: 'blocked_by',
          sourceEpicId: null,
          targetEpicId: null,
          relatedEpic: {
            id: RELATED_ID,
            shortId: RELATED_ID.slice(0, 8),
            title: 'Peer Epic',
            status: { id: 'status-1', label: 'In Progress', color: '#123456' },
            project: { id: 'project-2', name: 'Peer Project' },
          },
          createdAt: relationRow.createdAt,
          updatedAt: relationRow.updatedAt,
        },
      ],
      total: 17,
      limit: 25,
      offset: 5,
    });
    expect(storage.listEpicRelations).toHaveBeenCalledWith(EPIC_ID, {
      excludeMcpHidden: true,
      limit: 25,
      offset: 5,
    });
  });

  it('exposes the stored semantic source and target on reads from either side of the pair', async () => {
    storage.listEpicRelations.mockResolvedValueOnce({
      items: [{ ...relationRow, sourceEpicId: EPIC_ID, targetEpicId: RELATED_ID }],
      total: 1,
      limit: 50,
      offset: 0,
    });
    await expect(service.listRelations(EPIC_ID)).resolves.toMatchObject({
      items: [{ sourceEpicId: EPIC_ID, targetEpicId: RELATED_ID }],
    });

    storage.listEpicRelations.mockResolvedValueOnce({
      items: [{ ...relationRow, epicId: EPIC_ID, sourceEpicId: RELATED_ID, targetEpicId: EPIC_ID }],
      total: 1,
      limit: 50,
      offset: 0,
    });
    // Source and target are row-level facts; they do not flip with the focal
    // Epic, only the focal-relative type does.
    await expect(service.listRelations(RELATED_ID)).resolves.toMatchObject({
      items: [{ sourceEpicId: RELATED_ID, targetEpicId: EPIC_ID }],
    });
  });

  it('returns only nonzero storage summaries without per-Epic reads', async () => {
    const summary = {
      epicId: EPIC_ID,
      related: 1,
      blocks: 2,
      blockedBy: 0,
      total: 3,
      relatedSources: 1,
      relatedTargets: 0,
      relatedNeutral: 0,
    };
    storage.summarizeEpicRelationsBatch.mockResolvedValue(new Map([[EPIC_ID, summary]]));

    await expect(service.summarizeBatch([EPIC_ID, RELATED_ID])).resolves.toEqual([summary]);
    expect(storage.summarizeEpicRelationsBatch).toHaveBeenCalledTimes(1);
    expect(storage.summarizeEpicRelationsBatch).toHaveBeenCalledWith([EPIC_ID, RELATED_ID], {});
    expect(storage.listEpicRelations).not.toHaveBeenCalled();
  });

  it('publishes one IDs-only invalidation after a changed set', async () => {
    storage.setEpicRelation.mockResolvedValue({
      id: 'relation-1',
      leftEpicId: EPIC_ID,
      rightEpicId: RELATED_ID,
      type: 'blocks',
      direction: 'right_to_left',
      createdBy: 'agent',
      createdByAgentId: 'agent-1',
      createdAt: relationRow.createdAt,
      updatedAt: relationRow.updatedAt,
      changed: true,
      workspaceId: WORKSPACE_ID,
    });

    await service.setRelation(EPIC_ID, RELATED_ID, 'blocked_by', {
      actor: { type: 'agent', id: 'agent-1' },
    });

    expect(storage.setEpicRelation).toHaveBeenCalledWith(
      expect.objectContaining({
        epicId: EPIC_ID,
        relatedEpicId: RELATED_ID,
        type: 'blocked_by',
        createdBy: 'agent',
        createdByAgentId: 'agent-1',
      }),
      { actor: { type: 'agent', id: 'agent-1' } },
    );
    expect(events.publish).toHaveBeenCalledWith('epic.relations.invalidated', {
      workspaceId: WORKSPACE_ID,
    });
    expect(storage.listEpicRelations).toHaveBeenLastCalledWith(EPIC_ID, {
      relatedEpicId: RELATED_ID,
      limit: 1,
      offset: 0,
    });
  });

  it('passes endpoint order and write context to storage without any route field', async () => {
    storage.setEpicRelation.mockResolvedValue({
      changed: false,
      workspaceId: WORKSPACE_ID,
    });

    // The write's first Epic is the source; storage derives the stored
    // direction, so the service sends no direction-like field at all.
    await service.setRelation(EPIC_ID, RELATED_ID, 'related');
    await service.setRelation(RELATED_ID, EPIC_ID, 'related');

    expect(storage.setEpicRelation).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        epicId: EPIC_ID,
        relatedEpicId: RELATED_ID,
        type: 'related',
        createdBy: 'user',
      }),
      { trustedLocalHuman: true },
    );
    expect(storage.setEpicRelation).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        epicId: RELATED_ID,
        relatedEpicId: EPIC_ID,
        type: 'related',
      }),
      { trustedLocalHuman: true },
    );
    expect(storage.setEpicRelation).not.toHaveBeenCalledWith(
      expect.objectContaining({ timeDirection: expect.anything() }),
      expect.anything(),
    );
  });

  it('does not publish invalidation for no-op set or delete', async () => {
    storage.setEpicRelation.mockResolvedValue({
      id: 'relation-1',
      leftEpicId: EPIC_ID,
      rightEpicId: RELATED_ID,
      type: 'blocks',
      direction: 'right_to_left',
      createdBy: 'user',
      createdByAgentId: null,
      createdAt: relationRow.createdAt,
      updatedAt: relationRow.updatedAt,
      changed: false,
      workspaceId: WORKSPACE_ID,
    });
    storage.deleteEpicRelation.mockResolvedValue({ deleted: false, workspaceId: WORKSPACE_ID });

    await service.setRelation(EPIC_ID, RELATED_ID, 'blocked_by');
    await expect(service.deleteRelation(EPIC_ID, RELATED_ID)).resolves.toBe(false);

    expect(events.publish).not.toHaveBeenCalled();
  });

  it('publishes after a changed delete and rejects guests before storage', async () => {
    storage.deleteEpicRelation.mockResolvedValue({ deleted: true, workspaceId: WORKSPACE_ID });

    await expect(service.deleteRelation(EPIC_ID, RELATED_ID)).resolves.toBe(true);
    expect(events.publish).toHaveBeenCalledWith('epic.relations.invalidated', {
      workspaceId: WORKSPACE_ID,
    });

    await expect(
      service.setRelation(EPIC_ID, RELATED_ID, 'related', {
        actor: { type: 'guest', id: 'guest-1' },
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(storage.setEpicRelation).not.toHaveBeenCalled();
  });

  it('publishes nothing when a relation transaction fails or rolls back', async () => {
    storage.setEpicRelation.mockRejectedValue(new Error('rolled back relation'));
    storage.deleteEpicRelation.mockRejectedValue(new Error('failed delete'));

    await expect(service.setRelation(EPIC_ID, RELATED_ID, 'related')).rejects.toThrow(
      'rolled back relation',
    );
    await expect(service.deleteRelation(EPIC_ID, RELATED_ID)).rejects.toThrow('failed delete');

    expect(events.publish).not.toHaveBeenCalled();
  });

  it('forwards accepted route facts into set and delete writes', async () => {
    storage.setEpicRelation.mockResolvedValue({
      changed: false,
      workspaceId: WORKSPACE_ID,
    });
    storage.deleteEpicRelation.mockResolvedValue({ deleted: false, workspaceId: WORKSPACE_ID });
    const acceptedRouteEffect = { sourceEpicId: EPIC_ID, targetEpicId: RELATED_ID };

    await service.setRelation(EPIC_ID, RELATED_ID, 'related', undefined, {
      confirmation: { acceptedRouteEffect },
    });
    await service.deleteRelation(EPIC_ID, RELATED_ID);

    expect(storage.setEpicRelation).toHaveBeenCalledWith(
      expect.objectContaining({ acceptedRouteEffect }),
      { trustedLocalHuman: true },
    );
    // Explicit pair deletion carries no confirmation: it is the remedy for a
    // blocked replacement on both surfaces.
    expect(storage.deleteEpicRelation).toHaveBeenCalledWith(EPIC_ID, RELATED_ID, {
      trustedLocalHuman: true,
    });
  });

  it('propagates the confirmation requirement without publishing invalidation', async () => {
    const confirmationRequired = new RelationConfirmationRequiredError({
      sourceEpicId: EPIC_ID,
      targetEpicId: RELATED_ID,
    });
    storage.setEpicRelation.mockRejectedValue(confirmationRequired);

    await expect(service.setRelation(EPIC_ID, RELATED_ID, 'related')).rejects.toBe(
      confirmationRequired,
    );

    expect(events.publish).not.toHaveBeenCalled();
  });
});
