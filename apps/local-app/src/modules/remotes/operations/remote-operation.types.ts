import type { RemoteOperation, RemoteOperationKind } from '../../storage/models/domain.models';

export interface RemoteOperationStepRun {
  /** Snapshot of the operation as persisted before this step started. */
  readonly operation: RemoteOperation;
  /**
   * Writable copy of `operation.details`, persisted with the step's outcome
   * (also when it throws). Later steps and a resumed run read it back.
   */
  readonly details: Record<string, unknown>;
  /**
   * Merges `patch` into `details`, persists it and publishes the operation
   * without changing any step state. Calls are throttled to one publish per
   * second per operation; the latest patch always lands, at the latest with
   * the step's outcome. With durable, bypasses throttling and rejects if the
   * details cannot be saved before an effect.
   */
  progress(patch: Record<string, unknown>, options?: { durable?: boolean }): Promise<void>;
}

export interface RemoteOperationStepDefinition {
  id: string;
  label: string;
  /**
   * Must be idempotent: after a crash or a retry the step runs again from the
   * start, possibly after some of its effects already happened.
   */
  run(context: RemoteOperationStepRun): Promise<void>;
  /** Evaluated once, on the initial details, when the operation is created. */
  skip?(details: Record<string, unknown>): boolean;
}

export interface RemoteOperationDefinition {
  readonly kind: RemoteOperationKind;
  readonly steps: readonly RemoteOperationStepDefinition[];
  /** Rebuilds a persisted operation's step definitions from its initial details. */
  stepsFor?(details: Record<string, unknown>): readonly RemoteOperationStepDefinition[];
  /** Throws `ConflictError` when the operation can no longer be cancelled. */
  assertCancellable(operation: RemoteOperation): void;
  /**
   * Undoes the completed steps. Runs only while no step is executing. The
   * returned values are merged into the cancelled operation's details.
   */
  rollback(operation: RemoteOperation): Promise<Record<string, unknown> | void>;
  /** Runs after `done` is durable; hook failures are logged without changing that state. */
  completed?(operation: RemoteOperation): Promise<void>;
  /** Drops what the definition keeps in memory for an operation that ended without a rollback. */
  forget?(operationId: string): void;
  /**
   * Called when a cancel arrives while a step runs, so a step that waits on
   * something slow can stop early; the cancel waits for the step either way.
   */
  interrupt?(operationId: string): Promise<void>;
  /**
   * The step a retry restarts from, when it is earlier than the failed step;
   * that step and every later one run again. Null or absent: the failed step.
   */
  retryFrom?(operation: RemoteOperation): string | null;
  /**
   * The step a startup resume of a `running` operation restarts from; that step
   * and every later one run again. Null or absent: the next unfinished step.
   */
  resumeFrom?(operation: RemoteOperation): string | null;
}

export function requireProjectId(operation: RemoteOperation): string {
  if (!operation.projectId) {
    throw new Error(`Remote operation ${operation.id} has no project.`);
  }
  return operation.projectId;
}

/**
 * The step ran, or began running, at least once. A retry sets a step back to
 * `pending` but keeps its `startedAt`, so an earlier attempt still counts.
 */
export function stepStarted(operation: RemoteOperation, stepId: string): boolean {
  const step = operation.steps.find((candidate) => candidate.id === stepId);
  if (!step) return false;
  return step.startedAt !== null || (step.state !== 'pending' && step.state !== 'skipped');
}

/** Operations that own a remote's VM or host install; one may be open per remote. */
export const VM_LIFECYCLE_KINDS = ['create_vm', 'reset_vm', 'destroy_vm'] as const;
export const HOST_LIFECYCLE_KINDS = [
  'claim',
  'install_host',
  'update_host',
  'update_logins',
  ...VM_LIFECYCLE_KINDS,
] as const;

/**
 * The operation as a composed definition sees it: only the steps under
 * `prefix`, with the prefix removed from their ids.
 */
export function withStepPrefix(operation: RemoteOperation, prefix: string): RemoteOperation {
  return {
    ...operation,
    steps: operation.steps
      .filter((step) => step.id.startsWith(prefix))
      .map((step) => ({ ...step, id: step.id.slice(prefix.length) })),
  };
}

/**
 * Another definition's steps inside a composed operation: ids get `prefix`,
 * `skip` is kept, and each run sees its operation through `withStepPrefix`.
 */
export function prefixSteps(
  steps: readonly RemoteOperationStepDefinition[],
  prefix: string,
): RemoteOperationStepDefinition[] {
  return steps.map((step) => ({
    id: `${prefix}${step.id}`,
    label: step.label,
    skip: step.skip,
    run: (run) => step.run({ ...run, operation: withStepPrefix(run.operation, prefix) }),
  }));
}
