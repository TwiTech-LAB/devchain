import { Inject, Injectable } from '@nestjs/common';
import {
  STORAGE_SERVICE,
  type StorageService,
  type AgentStorage,
  type StatusStorage,
} from '../../storage/interfaces/storage.interface';
import { EpicsService } from '../../epics/services/epics.service';
import { NotFoundError } from '../../../common/errors/error-types';
import type { Epic, EpicComment } from '../../storage/models/domain.models';
import type { ListResult } from '../../storage/interfaces/storage.interface';
import { toEpicDto, toStatusMap } from './epic-dto.util';
import { ProjectWriteGate } from '../../storage/write-gate/project-write-gate';

/**
 * Single composition point for the mobile `board.*` MUTATION + comment RPCs
 * (parallel to {@link MobileChatRpcService}). All mutations go through
 * {@link EpicsService} so domain events/invariants fire (never raw storage);
 * reads go to storage ONLY after project validation.
 *
 * Every method is PROJECT-SCOPED: it loads the epic and asserts
 * `epic.projectId === projectId` first (the bridge proves instance ownership,
 * not per-project — the local-app holds many projects). A cross-project epic is
 * reported as a clean not-found so existence is never leaked.
 *
 * Errors propagate as-is to `toJsonRpcError`, preserving the domain code under
 * `error.data.code`:
 *  - assignee ∈ project is enforced by the storage `updateEpic` path
 *    (`ensureValidAgent`) → `ValidationError` (`validation_error`); NOT duplicated here.
 *  - version conflicts → `OptimisticLockError` (`optimistic_lock_error`); NOT remapped.
 */
@Injectable()
export class MobileBoardRpcService {
  constructor(
    @Inject(STORAGE_SERVICE)
    private readonly storage: AgentStorage &
      StatusStorage &
      Pick<StorageService, 'getEpic' | 'listEpicComments'>,
    private readonly epicsService: EpicsService,
    private readonly gate?: ProjectWriteGate,
  ) {}

  /**
   * `board.updateEpicAssignment({ projectId, epicId, agentId, version })` — set or
   * clear (`agentId: null`) the MAIN epic's assignee under optimistic lock.
   * Routes through `EpicsService.updateEpic` (publishes `epic.updated`, enforces
   * assignee∈project). Returns the updated epic DTO — shape-identical to the
   * read path (`board.getEpicDetail`): resolved status fields (statusName/Color/
   * Position/status) + new `version` + resolved `agentName`. Status enrichment is
   * load-bearing: the client does a full `EpicDetail` replace on the response, so
   * an unenriched DTO would degrade the status tile until the next refetch.
   */
  async updateEpicAssignment(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const projectId = params['projectId'] as string;
    const epicId = params['epicId'] as string;
    const agentId = params['agentId'] as string | null;
    const version = params['version'] as number;

    this.assertProjectNotRemoteOwned(projectId);
    await this.assertEpicInProject(epicId, projectId);
    const updated = await this.epicsService.updateEpic(epicId, { agentId }, version);

    // Enrich exactly like the read path so the mutation DTO is shape-identical:
    // resolve the project's statuses (statusName/Color/Position) and the new
    // assignee's display name. Only the assignee needs name resolution.
    const [statusesResult, assignee] = await Promise.all([
      this.storage.listStatuses(projectId, { limit: 1000, offset: 0 }),
      updated.agentId ? this.storage.getAgent(updated.agentId) : Promise.resolve(null),
    ]);
    const statusMap = toStatusMap(
      statusesResult.items as unknown as Array<Record<string, unknown>>,
    );
    const agentNameById = assignee ? new Map([[assignee.id, assignee.name]]) : undefined;

    return toEpicDto(updated as unknown as Record<string, unknown>, statusMap, agentNameById);
  }

  /**
   * `board.listEpicComments({ projectId, epicId, limit?, offset? })` — the epic's
   * comments (oldest first), paged. Read-only via storage AFTER project validation.
   */
  async listEpicComments(params: Record<string, unknown>): Promise<ListResult<EpicComment>> {
    const projectId = params['projectId'] as string;
    const epicId = params['epicId'] as string;
    const limit = params['limit'] as number | undefined;
    const offset = params['offset'] as number | undefined;

    this.assertProjectNotRemoteOwned(projectId);
    await this.assertEpicInProject(epicId, projectId);
    return this.storage.listEpicComments(epicId, { limit, offset });
  }

  /**
   * `board.addEpicComment({ projectId, epicId, authorName, content })` — append a
   * comment. Routes through `EpicsService.addEpicCommentFromRest` (publishes
   * `epic.comment.created`, actor null — matches the web REST path). `authorName`
   * is client-passed: the tunnel JSON-RPC envelope carries no user identity.
   */
  async addEpicComment(params: Record<string, unknown>): Promise<EpicComment> {
    const projectId = params['projectId'] as string;
    const epicId = params['epicId'] as string;
    const authorName = params['authorName'] as string;
    const content = params['content'] as string;

    this.assertProjectNotRemoteOwned(projectId);
    await this.assertEpicInProject(epicId, projectId);
    return this.epicsService.addEpicCommentFromRest(epicId, authorName, content);
  }

  /**
   * `board.deleteEpicComment({ projectId, epicId, commentId })` — scoped delete via
   * `EpicsService.deleteEpicComment` (verifies epic∈project, deletes
   * `WHERE id=? AND epic_id=?`, clean not-found for a comment from another epic).
   */
  async deleteEpicComment(params: Record<string, unknown>): Promise<{ deleted: true }> {
    const projectId = params['projectId'] as string;
    const epicId = params['epicId'] as string;
    const commentId = params['commentId'] as string;

    this.assertProjectNotRemoteOwned(projectId);
    await this.epicsService.deleteEpicComment(projectId, epicId, commentId);
    return { deleted: true };
  }

  /**
   * Load the epic and enforce it belongs to `projectId`. Cross-project (or
   * unknown) → `NotFoundError` (`not_found`), never leaking the epic's existence.
   */
  private async assertEpicInProject(epicId: string, projectId: string): Promise<Epic> {
    const epic = await this.storage.getEpic(epicId);
    if (epic.projectId !== projectId) {
      throw new NotFoundError('Epic', epicId);
    }
    return epic;
  }

  /**
   * A remote-owned project's mirror here is a stale copy; the phone reaches the
   * live project on the host instance. Such projects answer with the same
   * not-found as a missing project, before any epic existence is checked.
   */
  private assertProjectNotRemoteOwned(projectId: string): void {
    if (this.gate?.getRemoteOwner(projectId)) {
      throw new NotFoundError('Project', projectId);
    }
  }
}
