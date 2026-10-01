import { NotFoundError, ValidationError } from '../../../common/errors/error-types';
import type { EpicStorage } from '../../storage/interfaces/storage.interface';
import type { EpicRelationCandidate } from '../../storage/models/domain.models';

const EXACT_EPIC_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Resolves a relation target by ID prefix within the focal Epic's workspace.
 * A full canonical UUID is one the caller already holds (the server issued
 * it), so it resolves even when the target's status is hidden from MCP reads:
 * the write returns nothing but that ID, and the storage write still validates
 * existence, workspace, and caller authority. Any shorter address keeps the
 * visible-only resolution and never discloses a hidden target.
 */
export async function resolveEpicRelationTarget(
  storage: Pick<EpicStorage, 'getWorkspaceEpicsByIdPrefix'>,
  focalEpicId: string,
  relatedEpicAddress: string,
  options: { excludeMcpHidden?: boolean } = {},
): Promise<EpicRelationCandidate> {
  const exact = EXACT_EPIC_ID_PATTERN.test(relatedEpicAddress);
  const matches = await storage.getWorkspaceEpicsByIdPrefix(focalEpicId, relatedEpicAddress, {
    excludeMcpHidden: exact ? false : options.excludeMcpHidden,
  });
  if (matches.length === 0) {
    throw new NotFoundError('Related Epic');
  }
  if (matches.length > 1) {
    throw new ValidationError('Multiple Epics match the related Epic address.', {
      code: 'AMBIGUOUS_RELATED_EPIC',
      matchingEpics: matches.slice(0, 10).map((epic) => ({
        id: epic.id,
        title: epic.title,
        projectId: epic.projectId,
        projectName: epic.projectName,
      })),
      totalMatches: matches.length,
    });
  }
  return matches[0];
}

/**
 * Delete-only target resolution. A full canonical UUID addresses one pair
 * exactly, so the deletion path skips the lookup altogether — the server
 * issued that exact ID as the replacement refusal's current target, and the
 * agent must be able to delete it. The storage delete still validates
 * existence, workspace, and caller authority, so nothing is disclosed by the
 * exact path itself. Any shorter or non-canonical address keeps the
 * visible-only prefix resolution and never discloses a hidden target.
 */
export async function resolveEpicRelationDeletionTarget(
  storage: Pick<EpicStorage, 'getWorkspaceEpicsByIdPrefix'>,
  focalEpicId: string,
  relatedEpicAddress: string,
): Promise<{ id: string }> {
  if (EXACT_EPIC_ID_PATTERN.test(relatedEpicAddress)) {
    return { id: relatedEpicAddress };
  }
  const candidate = await resolveEpicRelationTarget(storage, focalEpicId, relatedEpicAddress, {
    excludeMcpHidden: true,
  });
  return { id: candidate.id };
}
