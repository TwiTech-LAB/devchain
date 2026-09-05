import { Inject, Injectable } from '@nestjs/common';
import { ForbiddenError, NotFoundError } from '../../../common/errors/error-types';
import { EventsService } from '../../events/services/events.service';
import {
  STORAGE_SERVICE,
  type EpicRelationReadOptions,
  type ListEpicRelationCandidatesOptions,
  type ListEpicRelationsOptions,
  type ListResult,
  type StorageService,
} from '../../storage/interfaces/storage.interface';
import type {
  EpicRelationCandidate,
  EpicRelationListItem,
  EpicRelationSummary,
  EpicRelationType,
} from '../../storage/models/domain.models';
import type { EpicOperationContext } from './epics.service';
import type { RelationConfirmationPayload } from '../models/epic-relations.models';

export interface SetRelationOptions {
  /**
   * Echo of the facts issued with a `relation_confirmation_required` 409. The
   * destructive-change transaction rechecks these facts; only human writes are
   * gated on them.
   */
  confirmation?: RelationConfirmationPayload;
}

export interface EpicRelationStatusDto {
  id: string;
  label: string;
  color: string;
}

export interface EpicRelationProjectDto {
  id: string;
  name: string;
}

export interface EpicRelationTargetDto {
  id: string;
  shortId: string;
  title: string;
  status: EpicRelationStatusDto;
  project: EpicRelationProjectDto;
}

export interface EpicRelationDto {
  relationId: string;
  type: EpicRelationType;
  /**
   * Semantic source and target derived from the stored canonical direction.
   * Null marks a legacy neutral row (direction 'none') that carries no
   * semantic direction.
   */
  sourceEpicId: string | null;
  targetEpicId: string | null;
  relatedEpic: EpicRelationTargetDto;
  createdAt: string;
  updatedAt: string;
}

export interface EpicRelationCandidateDto extends EpicRelationTargetDto {
  parentId: string | null;
}

export type EpicRelationBatchSummaryDto = EpicRelationSummary;

@Injectable()
export class EpicRelationsService {
  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly events: EventsService,
  ) {}

  async listRelations(
    epicId: string,
    options: ListEpicRelationsOptions = {},
  ): Promise<ListResult<EpicRelationDto>> {
    const result = await this.storage.listEpicRelations(epicId, options);
    return {
      ...result,
      items: result.items.map((row) => this.mapRelation(row)),
    };
  }

  async listCandidates(
    epicId: string,
    options: ListEpicRelationCandidatesOptions = {},
  ): Promise<ListResult<EpicRelationCandidateDto>> {
    const result = await this.storage.listEpicRelationCandidates(epicId, options);
    return {
      ...result,
      items: result.items.map((item) => this.mapCandidate(item)),
    };
  }

  async summarizeBatch(
    epicIds: string[],
    options: EpicRelationReadOptions = {},
  ): Promise<EpicRelationBatchSummaryDto[]> {
    const summaries = await this.storage.summarizeEpicRelationsBatch(epicIds, options);
    const ordered: EpicRelationBatchSummaryDto[] = [];
    const seen = new Set<string>();
    for (const epicId of epicIds) {
      if (seen.has(epicId)) continue;
      seen.add(epicId);
      const summary = summaries.get(epicId);
      if (summary) ordered.push(summary);
    }
    return ordered;
  }

  async setRelation(
    epicId: string,
    relatedEpicId: string,
    type: EpicRelationType,
    context?: EpicOperationContext,
    options: SetRelationOptions = {},
  ): Promise<EpicRelationDto> {
    const writeContext = this.resolveWriteContext(context);
    // For related writes the endpoint order defines direction: epicId is the
    // source and relatedEpicId is the target. blocks and blocked_by stay
    // focal-relative to the first address; storage derives the stored
    // direction in every case.
    const result = await this.storage.setEpicRelation(
      {
        epicId,
        relatedEpicId,
        type,
        createdBy: writeContext.actor?.type === 'agent' ? 'agent' : 'user',
        createdByAgentId: writeContext.actor?.type === 'agent' ? writeContext.actor.id : null,
        acceptedRouteEffect: options.confirmation?.acceptedRouteEffect,
      },
      writeContext,
    );
    if (result.changed) {
      await this.publishInvalidation(result.workspaceId);
    }

    const relation = (await this.listRelations(epicId, { relatedEpicId, limit: 1, offset: 0 }))
      .items[0];
    if (!relation) {
      throw new NotFoundError('Epic relation');
    }
    return relation;
  }

  async deleteRelation(
    epicId: string,
    relatedEpicId: string,
    context?: EpicOperationContext,
  ): Promise<boolean> {
    const result = await this.storage.deleteEpicRelation(
      epicId,
      relatedEpicId,
      this.resolveWriteContext(context),
    );
    if (result.deleted) {
      await this.publishInvalidation(result.workspaceId);
    }
    return result.deleted;
  }

  async publishInvalidation(workspaceId: string): Promise<void> {
    await this.events.publish('epic.relations.invalidated', { workspaceId });
  }

  private resolveWriteContext(context: EpicOperationContext | undefined) {
    if (context?.actor?.type === 'guest') {
      throw new ForbiddenError('Guests cannot write Epic relations.');
    }
    if (context?.actor?.type === 'agent') {
      return { actor: context.actor } as const;
    }
    return { trustedLocalHuman: true } as const;
  }

  private mapRelation(row: EpicRelationListItem): EpicRelationDto {
    return {
      relationId: row.relationId,
      type: row.type,
      sourceEpicId: row.sourceEpicId,
      targetEpicId: row.targetEpicId,
      relatedEpic: this.mapTarget(row),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private mapCandidate(row: EpicRelationCandidate): EpicRelationCandidateDto {
    return {
      ...this.mapTarget(row),
      parentId: row.parentId,
    };
  }

  private mapTarget(row: EpicRelationListItem | EpicRelationCandidate): EpicRelationTargetDto {
    const id = 'epicId' in row ? row.epicId : row.id;
    return {
      id,
      shortId: id.slice(0, 8),
      title: row.title,
      status: {
        id: row.statusId,
        label: row.statusLabel,
        color: row.statusColor,
      },
      project: {
        id: row.projectId,
        name: row.projectName,
      },
    };
  }
}
