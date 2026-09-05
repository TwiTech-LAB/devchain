import type { InfiniteData } from '@tanstack/react-query';

/**
 * Cache scope for Board batch reads. Worktree tabs and unresolved runtimes
 * key under 'isolated' so a disabled runtime never shares a main-scope
 * entry; the batch-family prefix still invalidates every variant together.
 */
export type EpicRelationQueryScope = 'main' | 'isolated';

export const epicRelationQueryKeys = {
  detailRoot: (): string[] => ['epic-relations', 'detail'],
  candidateRoot: (): string[] => ['epic-relations', 'candidates'],
  batchRoot: (): string[] => ['epic-relations', 'batch'],
  detail: (epicId: string): string[] => ['epic-relations', 'detail', epicId],
  candidates: (epicId: string, q: string, limit: number, offset: number): string[] => [
    'epic-relations',
    'candidates',
    epicId,
    q,
    String(limit),
    String(offset),
  ],
  batch: (epicIds: readonly string[], scope: EpicRelationQueryScope = 'main'): string[] => [
    'epic-relations',
    'batch',
    scope,
    ...epicIds,
  ],
};

export type EpicRelationType = 'related' | 'blocks' | 'blocked_by';

export interface EpicRelationTarget {
  id: string;
  shortId: string;
  title: string;
  status: { id: string; label: string; color: string };
  project: { id: string; name: string };
}

export interface EpicRelation {
  relationId: string;
  type: EpicRelationType;
  /**
   * Semantic source and target of the linkage derived from the stored
   * direction. Null marks a legacy neutral row that carries no direction.
   */
  sourceEpicId: string | null;
  targetEpicId: string | null;
  relatedEpic: EpicRelationTarget;
  createdAt: string;
  updatedAt: string;
}

export interface EpicRelationCandidate extends EpicRelationTarget {
  parentId: string | null;
}

export interface EpicRelationPage {
  items: EpicRelation[];
  total: number;
  limit: number;
  offset: number;
}

export interface EpicRelationCandidatePage {
  items: EpicRelationCandidate[];
  total: number;
  limit: number;
  offset: number;
}

export const EPIC_RELATION_TYPE_OPTIONS: ReadonlyArray<{
  value: EpicRelationType;
  label: string;
}> = [
  { value: 'related', label: 'Related' },
  { value: 'blocks', label: 'Blocks' },
  { value: 'blocked_by', label: 'Blocked by' },
];

export function epicRelationTypeLabel(type: EpicRelationType): string {
  return EPIC_RELATION_TYPE_OPTIONS.find((option) => option.value === type)?.label ?? type;
}

export interface EpicRelationRouteEffect {
  sourceEpicId: string;
  targetEpicId: string;
}

/**
 * Typed shape of the server's `relation_confirmation_required` 409: the
 * currently stored route effect a destructive change would displace. The
 * retry echoes these exact facts back to the write transaction.
 */
export class EpicRelationConfirmationError extends Error {
  readonly code = 'relation_confirmation_required' as const;
  readonly currentEffect: EpicRelationRouteEffect;

  constructor(message: string, currentEffect: EpicRelationRouteEffect) {
    super(message);
    this.name = 'EpicRelationConfirmationError';
    this.currentEffect = currentEffect;
  }
}

export function isEpicRelationConfirmationError(
  error: unknown,
): error is EpicRelationConfirmationError {
  return error instanceof EpicRelationConfirmationError;
}

/** Every destructive route or boundary warning carries this sentence. */
export const RELATION_ROUTE_HISTORY_WARNING = 'Time already logged to a provider does not move.';

export type EpicRelationRouteChangeKind = 'replace' | 'flip' | 'blocks' | 'delete';

/** Draft direction a dialog is about to save: which linkage type, which source. */
export interface EpicRelationDirectionDraft {
  type: 'related' | 'blocks';
  /** True when the initiated Epic (the dialog's focal side) is the source. */
  sourceIsFocal: boolean;
}

export type RelatedRouteIneligibilityCause = 'child' | 'cross-project';

export function getRelatedRouteEligibility(input: {
  sameProject: boolean;
  focalIsRoot: boolean;
  targetIsRoot: boolean | null;
}): { eligible: boolean; ineligibilityCause?: RelatedRouteIneligibilityCause } {
  if (!input.sameProject) {
    return { eligible: false, ineligibilityCause: 'cross-project' };
  }
  if (!input.focalIsRoot || input.targetIsRoot === false) {
    return { eligible: false, ineligibilityCause: 'child' };
  }
  return { eligible: input.targetIsRoot === true };
}

/**
 * Resolves which destructive-change sentence a typed 409 deserves. Server
 * facts decide whether the displaced route is this pair's own (flip) or the
 * source's route on another pair (replacement, which removes that old pair).
 */
export function relationRouteChangeKind(
  draft: Pick<EpicRelationDirectionDraft, 'type'>,
  effect: EpicRelationRouteEffect,
  pairIds: readonly [string, string],
): EpicRelationRouteChangeKind {
  if (draft.type !== 'related') return 'blocks';
  const isOwnPair =
    (effect.sourceEpicId === pairIds[0] && effect.targetEpicId === pairIds[1]) ||
    (effect.sourceEpicId === pairIds[1] && effect.targetEpicId === pairIds[0]);
  return isOwnPair ? 'flip' : 'replace';
}

const ROUTE_CHANGE_INTENT: Record<EpicRelationRouteChangeKind, string> = {
  replace: 'Saving removes the old Related pair — its target stops including that source’s time.',
  flip: 'Saving swaps this pair’s source and target.',
  blocks: 'Saving converts the relation to Blocks and removes the Related pair’s time route.',
  delete: 'Removing this relation deletes the pair and its time route.',
};

export interface EpicRelationRouteEndpoint {
  id: string;
  title: string;
}

/**
 * Warning lines for a destructive route change. The route effect always comes
 * from the server's 409 facts; the target is the logging anchor — it includes
 * and logs the source's time — so every line names the target first.
 * Endpoint titles are used when a fact Epic is one of the dialog endpoints,
 * otherwise the short ID keeps the line honest.
 */
export function relationRouteChangeWarning(
  kind: EpicRelationRouteChangeKind,
  effect: EpicRelationRouteEffect,
  endpoints: readonly EpicRelationRouteEndpoint[],
): string[] {
  const describe = (epicId: string): string => {
    const endpoint = endpoints.find((candidate) => candidate.id === epicId);
    return endpoint ? `“${endpoint.title}”` : `Epic ${epicId.slice(0, 8)}`;
  };
  return [
    `Current route: ${describe(effect.targetEpicId)} logs time with ${describe(effect.sourceEpicId)}.`,
    ROUTE_CHANGE_INTENT[kind],
    RELATION_ROUTE_HISTORY_WARNING,
  ];
}

/**
 * Boundary warning for drafts that route time across an endpoint with an
 * external link: linked Epics are excluded from related rollups, so the
 * visible and exported totals change scope. No linked endpoints means no
 * boundary warning at all.
 */
export function relationRouteBoundaryWarning(
  linkedEndpoints: readonly EpicRelationRouteEndpoint[],
): string[] {
  if (linkedEndpoints.length === 0) {
    return [];
  }
  const names = linkedEndpoints.map((endpoint) => `“${endpoint.title}”`).join(' and ');
  return [
    `${names} is linked to an external task and stays outside related time rollups.`,
    RELATION_ROUTE_HISTORY_WARNING,
  ];
}

/**
 * Focal-relative offsets: the relation endpoints paginate by `offset`, so the
 * next page cursor is the count of rows already served, clamped by `total`.
 */
export function nextEpicRelationOffset(
  page: Pick<EpicRelationPage | EpicRelationCandidatePage, 'items' | 'total' | 'offset'>,
): number | undefined {
  const nextOffset = page.offset + page.items.length;
  return nextOffset < page.total ? nextOffset : undefined;
}

export function flattenEpicRelationPages(
  data: InfiniteData<EpicRelationPage> | undefined,
): EpicRelation[] {
  return data?.pages.flatMap((page) => page.items) ?? [];
}

/**
 * Role of the related Epic in a directed Related pair, relative to whichever
 * Epic the rows were read from: the counterpart is the stored source, the
 * stored target, or the row is a legacy neutral pair with no direction.
 */
export type RelatedEpicRole = 'Source' | 'Target';

export function relatedEpicRole(
  relation: Pick<EpicRelation, 'sourceEpicId' | 'relatedEpic'>,
): RelatedEpicRole | null {
  if (relation.sourceEpicId === null) return null;
  return relation.sourceEpicId === relation.relatedEpic.id ? 'Source' : 'Target';
}

export function flattenEpicRelationCandidatePages(
  data: InfiniteData<EpicRelationCandidatePage> | undefined,
): EpicRelationCandidate[] {
  return data?.pages.flatMap((page) => page.items) ?? [];
}
