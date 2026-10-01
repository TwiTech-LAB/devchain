export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, identifier?: string) {
    super(
      `${resource}${identifier ? ` with identifier ${identifier}` : ''} not found`,
      'not_found',
      404,
    );
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'validation_error', 400, details);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'conflict', 409, details);
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'forbidden', 403, details);
  }
}

export class OptimisticLockError extends AppError {
  constructor(resource: string, identifier: string, details?: Record<string, unknown>) {
    super(
      `${resource} with identifier ${identifier} was modified by another operation. Please refresh and try again.`,
      'optimistic_lock_error',
      409,
      details,
    );
  }
}

export class StorageError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'storage_error', 500, details);
  }
}

export class IOError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'io_error', 500, details);
  }
}

export class BusyError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'busy', 409, details);
  }
}

export class TimeoutError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'timeout', 408, details);
  }
}

export class PasteNotConfirmedError extends AppError {
  constructor(
    public readonly sessionName: string,
    details?: Record<string, unknown>,
  ) {
    super(`Paste delivery not confirmed for session ${sessionName}`, 'paste_not_confirmed', 500, {
      sessionName,
      ...details,
    });
  }
}

export class TeamMemberCapReachedError extends AppError {
  constructor(maxMembers: number, currentNonLeadCount: number) {
    super('Team is at member cap', 'team_member_cap_reached', 409, {
      maxMembers,
      currentNonLeadCount,
    });
  }
}

export class UnsupportedProviderError extends AppError {
  constructor(
    public readonly providerName: string,
    supportedProviders: string[],
  ) {
    super(
      `Unsupported provider: ${providerName}. Supported providers: ${supportedProviders.join(', ')}`,
      'unsupported_provider',
      400,
      { providerName, supportedProviders },
    );
  }
}

export class DescriptionEditNotFoundError extends AppError {
  constructor(index: number, find: string, matchCount: number) {
    super(
      `Description edit ${index} did not match: the "find" text does not occur in the current description.`,
      'description_edit_not_found',
      409,
      { index, find, matchCount },
    );
  }
}

export class DescriptionEditAmbiguousError extends AppError {
  constructor(index: number, find: string, matchCount: number) {
    super(
      `Description edit ${index} is ambiguous: the "find" text occurs ${matchCount} times. Add surrounding context to make it unique.`,
      'description_edit_ambiguous',
      409,
      { index, find, matchCount },
    );
  }
}

export interface RelationRouteEffectFacts {
  sourceEpicId: string;
  targetEpicId: string;
}

export class RelationConfirmationRequiredError extends AppError {
  constructor(currentEffect: RelationRouteEffectFacts) {
    super(
      'This change displaces an active relation time route. Confirm the current route effect and retry with the accepted facts, or delete the displaced Related pair explicitly and retry.',
      'relation_confirmation_required',
      409,
      { currentEffect },
    );
  }
}

/**
 * A replica apply step failed. The whole apply transaction has rolled back.
 * `message` never includes row content: payloads carry secrets.
 */
export class ReplicaApplyError extends AppError {
  constructor(
    public readonly table: string,
    public readonly rowId: string,
    reason: string,
  ) {
    super(`Replica apply failed at ${table} row ${rowId}: ${reason}`, 'replica_apply_error', 422, {
      table,
      rowId,
    });
  }
}

/** Built-in DevChain skills are always on; a targeted disable is refused. */
export class SkillSourceAlwaysEnabledError extends AppError {
  constructor(sourceName: string, details?: Record<string, unknown>) {
    super(
      `Skill source ${sourceName} is always enabled and cannot be disabled.`,
      'SKILL_SOURCE_ALWAYS_ENABLED',
      409,
      { sourceName, ...details },
    );
  }
}

/** A remote handoff has frozen the project; writes resume after thaw or release. */
export class ProjectFrozenError extends AppError {
  constructor(public readonly projectId: string) {
    super('Project is frozen for a remote handoff.', 'PROJECT_FROZEN', 423, { projectId });
  }
}

/** The project is bound to a remote, which is its only writer until it is taken back. */
export class ProjectRemoteError extends AppError {
  constructor(
    public readonly projectId: string,
    public readonly remoteId: string,
    public readonly remoteName: string | null,
  ) {
    super(
      remoteName
        ? `Project is connected to remote "${remoteName}"; change it there.`
        : 'Project is connected to a remote; change it there.',
      'PROJECT_REMOTE',
      423,
      { projectId, remoteId, remoteName },
    );
  }
}

/** A replica could not be built; `details.errors` lists the preflight failures. */
export class ReplicaPreflightError extends AppError {
  constructor(errors: readonly Record<string, unknown>[]) {
    super('Project replica preflight failed.', 'REPLICA_PREFLIGHT_FAILED', 422, { errors });
  }
}

/**
 * Wraps a relation error from composite Epic creation so the failing input
 * index travels with it. The wrapped error keeps its own code, status, and
 * details; surfaces should project the cause and merge in `relationIndex`.
 */
export class IndexedRelationError extends AppError {
  constructor(
    public readonly relationIndex: number,
    public readonly cause: AppError,
  ) {
    super(cause.message, cause.code, cause.statusCode, cause.details);
  }
}

/**
 * Two relations in one Epic-creation list would both create an eligible
 * Related time route from the new Epic; one source may hold only one. The
 * whole create rolls back, so the remedy is to fix the list, not to delete
 * any stored pair.
 */
export class RelationRouteConflictError extends AppError {
  constructor(
    relationIndex: number,
    conflictingRelationIndex: number | null,
    currentEffect: RelationRouteEffectFacts,
  ) {
    super(
      conflictingRelationIndex !== null
        ? `Relations ${conflictingRelationIndex} and ${relationIndex} both create an eligible Related time route from the new epic. Remove or change one of them and retry.`
        : `Relation ${relationIndex} conflicts with an existing eligible Related time route from the new epic. Remove or change it and retry.`,
      'relation_route_conflict',
      409,
      { relationIndex, conflictingRelationIndex, currentEffect },
    );
  }
}
