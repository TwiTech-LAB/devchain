import { Test, TestingModule } from '@nestjs/testing';
import { ZodError } from 'zod';
import { EpicsController } from './epics.controller';
import { EpicsService } from '../services/epics.service';
import { EpicRelationsService } from '../services/epic-relations.service';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';

describe('EpicsController - skillsRequired validation', () => {
  let controller: EpicsController;
  let epicsService: {
    createEpic: jest.Mock;
    updateEpic: jest.Mock;
  };
  let epicRelations: {
    listRelations: jest.Mock;
    listCandidates: jest.Mock;
    summarizeBatch: jest.Mock;
    setRelation: jest.Mock;
    deleteRelation: jest.Mock;
  };

  beforeEach(async () => {
    epicsService = {
      createEpic: jest.fn().mockResolvedValue({ id: 'epic-1' }),
      updateEpic: jest.fn().mockResolvedValue({ id: 'epic-1' }),
    };
    epicRelations = {
      listRelations: jest.fn(),
      listCandidates: jest.fn(),
      summarizeBatch: jest.fn(),
      setRelation: jest.fn(),
      deleteRelation: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [EpicsController],
      providers: [
        {
          provide: EpicsService,
          useValue: epicsService,
        },
        {
          provide: EpicRelationsService,
          useValue: epicRelations,
        },
      ],
    }).compile();

    controller = module.get(EpicsController);
  });

  it('normalizes and deduplicates skillsRequired on create', async () => {
    await controller.createEpic({
      projectId: 'project-1',
      title: 'Epic',
      statusId: 'status-1',
      skillsRequired: [' OpenAI/Review ', 'openai/review', 'anthropic/pdf'],
    });

    expect(epicsService.createEpic).toHaveBeenCalledWith(
      expect.objectContaining({
        skillsRequired: ['openai/review', 'anthropic/pdf'],
      }),
    );
  });

  it('rejects malformed skillsRequired on create', async () => {
    await expect(
      controller.createEpic({
        projectId: 'project-1',
        title: 'Epic',
        statusId: 'status-1',
        skillsRequired: ['openai'],
      }),
    ).rejects.toThrow(ZodError);
  });

  it('does not accept caller-supplied createdBy on create', async () => {
    await controller.createEpic({
      projectId: 'project-1',
      title: 'Epic',
      statusId: 'status-1',
      createdBy: 'Spoofed Creator',
    });

    expect(epicsService.createEpic).toHaveBeenCalledWith(
      expect.not.objectContaining({ createdBy: expect.anything() }),
    );
  });

  it('normalizes and deduplicates skillsRequired on update', async () => {
    await controller.updateEpic('epic-1', {
      version: 3,
      skillsRequired: [' OpenAI/Review ', 'openai/review'],
    });

    expect(epicsService.updateEpic).toHaveBeenCalledWith(
      'epic-1',
      expect.objectContaining({
        skillsRequired: ['openai/review'],
      }),
      3,
    );
  });

  it('rejects malformed skillsRequired on update', async () => {
    await expect(
      controller.updateEpic('epic-1', {
        version: 1,
        skillsRequired: ['openai/review!'],
      }),
    ).rejects.toThrow(ZodError);
  });

  it('does not accept caller-supplied createdBy on update', async () => {
    await controller.updateEpic('epic-1', {
      version: 3,
      title: 'Updated',
      createdBy: 'Spoofed Creator',
    });

    expect(epicsService.updateEpic).toHaveBeenCalledWith(
      'epic-1',
      expect.not.objectContaining({ createdBy: expect.anything() }),
      3,
    );
  });

  it('passes tag replacement through and returns the stored epic', async () => {
    epicsService.updateEpic.mockResolvedValue({
      id: 'epic-1',
      version: 4,
      tags: ['stored-tag'],
    });

    const result = await controller.updateEpic('epic-1', {
      version: 3,
      tags: ['stored-tag'],
    });

    expect(epicsService.updateEpic).toHaveBeenCalledWith(
      'epic-1',
      expect.objectContaining({ tags: ['stored-tag'] }),
      3,
    );
    expect(result).toMatchObject({ id: 'epic-1', version: 4, tags: ['stored-tag'] });
  });

  describe('relation resources', () => {
    const EPIC_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
    const RELATED_ID = 'bbbbbbbb-2222-4222-8222-222222222222';

    it('returns focal relation items and bounded candidate pages', async () => {
      epicRelations.listRelations.mockResolvedValue({
        items: [{ relationId: 'relation-1' }],
        total: 1,
        limit: 50,
        offset: 0,
      });
      epicRelations.listCandidates.mockResolvedValue({
        items: [{ id: RELATED_ID }],
        total: 1,
        limit: 25,
        offset: 5,
      });

      await expect(controller.listEpicRelations(EPIC_ID)).resolves.toEqual({
        items: [{ relationId: 'relation-1' }],
        total: 1,
        limit: 50,
        offset: 0,
      });
      expect(epicRelations.listRelations).toHaveBeenCalledWith(EPIC_ID, {});
      await controller.listEpicRelations(EPIC_ID, '25', '5');
      expect(epicRelations.listRelations).toHaveBeenLastCalledWith(EPIC_ID, {
        limit: 25,
        offset: 5,
      });
      await expect(
        controller.listEpicRelationCandidates(EPIC_ID, ' peer ', '25', '5'),
      ).resolves.toMatchObject({ total: 1, limit: 25, offset: 5 });
      expect(epicRelations.listCandidates).toHaveBeenCalledWith(EPIC_ID, {
        q: 'peer',
        limit: 25,
        offset: 5,
      });
      await expect(
        controller.listEpicRelationCandidates(EPIC_ID, undefined, '101'),
      ).rejects.toThrow(ZodError);
      await expect(controller.listEpicRelations(EPIC_ID, '101')).rejects.toThrow(ZodError);
      await expect(controller.listEpicRelations(EPIC_ID, '0')).rejects.toThrow(ZodError);
      await expect(controller.listEpicRelations(EPIC_ID, '1.5')).rejects.toThrow(ZodError);
      await expect(controller.listEpicRelations(EPIC_ID, '1', '-1')).rejects.toThrow(ZodError);
    });

    it('validates the strict 1-1000 UUID batch and returns nonzero summaries', async () => {
      const summary = {
        epicId: EPIC_ID,
        related: 1,
        blocks: 0,
        blockedBy: 0,
        total: 1,
        relatedSources: 0,
        relatedTargets: 1,
        relatedNeutral: 0,
      };
      epicRelations.summarizeBatch.mockResolvedValue([summary]);

      await expect(controller.summarizeEpicRelationsBatch({ epicIds: [EPIC_ID] })).resolves.toEqual(
        { items: [summary] },
      );
      expect(epicRelations.summarizeBatch).toHaveBeenCalledWith([EPIC_ID]);
      await expect(
        controller.summarizeEpicRelationsBatch({ epicIds: [], extra: true }),
      ).rejects.toThrow(ZodError);
      await expect(
        controller.summarizeEpicRelationsBatch({
          epicIds: Array.from({ length: 1001 }, () => EPIC_ID),
        }),
      ).rejects.toThrow(ZodError);
    });

    it('validates focal UUIDs and strict relation values for PUT and DELETE', async () => {
      epicRelations.setRelation.mockResolvedValue({ relationId: 'relation-1' });
      epicRelations.deleteRelation.mockResolvedValue(true);

      await controller.setEpicRelation(EPIC_ID, RELATED_ID, { type: 'blocked_by' });
      expect(epicRelations.setRelation).toHaveBeenCalledWith(
        EPIC_ID,
        RELATED_ID,
        'blocked_by',
        undefined,
        { confirmation: undefined },
      );
      await expect(
        controller.setEpicRelation(EPIC_ID, RELATED_ID, {
          type: 'related',
          extra: true,
        }),
      ).rejects.toThrow(ZodError);
      await expect(
        controller.setEpicRelation('not-a-uuid', RELATED_ID, { type: 'related' }),
      ).rejects.toThrow(ZodError);

      await controller.deleteEpicRelation(EPIC_ID, RELATED_ID);
      expect(epicRelations.deleteRelation).toHaveBeenCalledWith(EPIC_ID, RELATED_ID);
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, controller.deleteEpicRelation)).toBe(204);
    });

    it('accepts the destructive-effect precondition and rejects the removed timeRoute field', async () => {
      epicRelations.setRelation.mockResolvedValue({ relationId: 'relation-1' });
      const confirmation = {
        acceptedRouteEffect: {
          sourceEpicId: EPIC_ID,
          targetEpicId: RELATED_ID,
        },
      };

      await controller.setEpicRelation(EPIC_ID, RELATED_ID, {
        type: 'related',
        confirmation,
      });
      expect(epicRelations.setRelation).toHaveBeenCalledWith(
        EPIC_ID,
        RELATED_ID,
        'related',
        undefined,
        { confirmation },
      );

      await controller.setEpicRelation(EPIC_ID, RELATED_ID, { type: 'related' });
      expect(epicRelations.setRelation).toHaveBeenLastCalledWith(
        EPIC_ID,
        RELATED_ID,
        'related',
        undefined,
        { confirmation: undefined },
      );

      // timeRoute is gone from the contract; the strict schema rejects it as an
      // unknown key instead of accepting a silently ignored value.
      await expect(
        controller.setEpicRelation(EPIC_ID, RELATED_ID, {
          type: 'related',
          timeRoute: 'focal_to_related',
        } as never),
      ).rejects.toThrow(ZodError);
      await expect(
        controller.setEpicRelation(EPIC_ID, RELATED_ID, {
          type: 'related',
          confirmation: {
            acceptedRouteEffect: { sourceEpicId: 'not-a-uuid', targetEpicId: RELATED_ID },
          },
        }),
      ).rejects.toThrow(ZodError);
    });
  });
});
