import {
  Inject,
  Injectable,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  Optional,
} from '@nestjs/common';
import { AppError, ConflictError } from '../../../common/errors/error-types';
import { createLogger } from '../../../common/logging/logger';
import {
  REALTIME_BROADCASTER,
  type RealtimeBroadcaster,
} from '../../realtime/ports/realtime-broadcaster.port';
import { STORAGE_SERVICE, type RemoteStorage } from '../../storage/interfaces/storage.interface';
import type {
  RemoteOperation,
  RemoteOperationKind,
  RemoteOperationStep,
  RemoteOperationStepError,
  UpdateRemoteOperation,
} from '../../storage/models/domain.models';
import { claimIdentityMismatch } from '../home-identity';
import { AttachOperation } from './attach.operation';
import { ClaimOperation } from './claim.operation';
import { DetachOperation } from './detach.operation';
import { UpdateHostOperation } from './update-host.operation';
import { CreateVmOperation } from './create-vm.operation';
import { ResetVmOperation } from './reset-vm.operation';
import { DestroyVmOperation } from './destroy-vm.operation';
import { VM_LIFECYCLE_KINDS, type RemoteOperationDefinition } from './remote-operation.types';
import { UpdateLoginsOperation } from './update-logins.operation';
import { InstallHostOperation } from './install-host.operation';

const logger = createLogger('RemoteOperationRunner');

export const REMOTE_OPERATIONS_TOPIC = 'remote-operations';

/** Minimum time between two publishes of one operation caused by step progress. */
export const PROGRESS_PUBLISH_INTERVAL_MS = 1_000;

/**
 * Executes saved step lists one step at a time. The row is written before and
 * after every step, so a restart resumes a `running` operation at the step
 * that was in flight, and a `failed` one waits for `retry` or `cancel`.
 */
@Injectable()
export class RemoteOperationRunner implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly definitions: ReadonlyMap<RemoteOperationKind, RemoteOperationDefinition>;
  private readonly active = new Map<string, Promise<void>>();
  private readonly cancelRequested = new Set<string>();
  private readonly lastPublishedAt = new Map<string, number>();
  private stopped = false;

  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: RemoteStorage,
    @Inject(REALTIME_BROADCASTER) private readonly broadcaster: RealtimeBroadcaster,
    attach: AttachOperation,
    detach: DetachOperation,
    claim: ClaimOperation,
    updateHost: UpdateHostOperation,
    @Optional() createVm?: CreateVmOperation,
    @Optional() resetVm?: ResetVmOperation,
    @Optional() destroyVm?: DestroyVmOperation,
    @Optional() installHost?: InstallHostOperation,
    @Optional() updateLogins?: UpdateLoginsOperation,
  ) {
    this.definitions = new Map<RemoteOperationKind, RemoteOperationDefinition>([
      [attach.kind, attach],
      ...(updateLogins ? [[updateLogins.kind, updateLogins] as const] : []),
      [detach.kind, detach],
      [claim.kind, claim],
      [updateHost.kind, updateHost],
      ...(installHost ? [[installHost.kind, installHost] as const] : []),
      ...(createVm ? [[createVm.kind, createVm] as const] : []),
      ...(resetVm ? [[resetVm.kind, resetVm] as const] : []),
      ...(destroyVm ? [[destroyVm.kind, destroyVm] as const] : []),
    ]);
  }

  async onApplicationBootstrap(): Promise<void> {
    const unfinished = await this.storage.listRemoteOperations({ states: ['running'] });
    for (const operation of unfinished) {
      logger.info({ operationId: operation.id, kind: operation.kind }, 'Resuming remote operation');
      this.launch(operation.id);
    }
  }

  onApplicationShutdown(): void {
    this.stopped = true;
  }

  /** Persists the operation, then runs it in the background. */
  async start(input: {
    id?: string;
    kind: RemoteOperationKind;
    remoteId: string;
    projectId: string | null;
    details: Record<string, unknown>;
  }): Promise<RemoteOperation> {
    const definition = this.definition(input.kind);
    const steps = definition.stepsFor?.(input.details) ?? definition.steps;
    const operation = await this.storage.createRemoteOperation({
      ...input,
      steps: steps.map((step) => ({
        id: step.id,
        label: step.label,
        state: step.skip?.(input.details) ? 'skipped' : 'pending',
        startedAt: null,
        endedAt: null,
        error: null,
      })),
    });
    logger.info(
      { operationId: operation.id, kind: operation.kind, projectId: operation.projectId },
      'Started remote operation',
    );
    this.publish(operation);
    this.launch(operation.id);
    return operation;
  }

  /** Re-runs a failed operation from its failed step. */
  async retry(id: string): Promise<RemoteOperation> {
    const current = await this.storage.getRemoteOperation(id);
    if (current.state !== 'failed' || this.active.has(id)) {
      throw new ConflictError('Only a failed operation can be retried.', {
        code: 'REMOTE_OPERATION_NOT_FAILED',
        operationId: id,
        state: current.state,
      });
    }
    const from = this.definition(current.kind).retryFrom?.(current) ?? null;
    const fromIndex = from === null ? -1 : current.steps.findIndex((step) => step.id === from);
    const operation = await this.persist(current, {
      state: 'running',
      // A takeover may have cancelled it since the read.
      expectedState: 'failed',
      steps: current.steps.map((step, index) =>
        step.state === 'failed' ||
        (fromIndex >= 0 && index >= fromIndex && step.state !== 'skipped')
          ? { ...step, state: 'pending', error: null }
          : step,
      ),
    });
    this.launch(id);
    return operation;
  }

  /**
   * Rolls the operation back and marks it `cancelled`. A running operation is
   * stopped after its current step, and this call waits for the rollback.
   */
  async cancel(id: string): Promise<RemoteOperation> {
    const current = await this.storage.getRemoteOperation(id);
    if (current.state !== 'running' && current.state !== 'failed') {
      throw new ConflictError(`Operation is already ${current.state}.`, {
        code: 'REMOTE_OPERATION_FINISHED',
        operationId: id,
        state: current.state,
      });
    }
    const definition = this.definition(current.kind);
    definition.assertCancellable(current);

    const running = this.active.get(id);
    if (running) {
      this.cancelRequested.add(id);
      await definition.interrupt?.(id);
      await running;
      const after = await this.storage.getRemoteOperation(id);
      if (after.state === 'failed' && after.details.cancelError) {
        throw new ConflictError('Cancelling the operation failed; it can be cancelled again.', {
          code: 'REMOTE_OPERATION_CANCEL_FAILED',
          operationId: id,
          error: after.details.cancelError,
        });
      }
      return after;
    }
    return this.rollback(current, definition);
  }

  /**
   * Ends a failed operation as `cancelled` without its rollback, because
   * another operation takes over from its current state. The write applies
   * only if the operation is still failed, so a concurrent retry and a
   * takeover cannot both proceed.
   */
  async supersede(
    operation: RemoteOperation,
    details: Record<string, unknown>,
  ): Promise<RemoteOperation> {
    if (this.active.has(operation.id)) {
      throw new ConflictError('The operation is running.', {
        code: 'REMOTE_OPERATION_IN_PROGRESS',
        operationId: operation.id,
      });
    }
    const cancelled = await this.persist(operation, {
      state: 'cancelled',
      expectedState: 'failed',
      details: { ...operation.details, ...details },
    });
    this.definition(operation.kind).forget?.(operation.id);
    return cancelled;
  }

  /** Takes over only a failed VM create/reset; a running or failed destroy remains exclusive. */
  async supersedeFailedVmOperation(remoteId: string): Promise<RemoteOperation | null> {
    const [open] = await this.storage.listRemoteOperations({
      remoteId,
      states: ['running', 'failed'],
      kinds: VM_LIFECYCLE_KINDS,
      limit: 1,
    });
    if (!open) return null;
    if (open.state === 'running' || open.kind === 'destroy_vm') {
      throw new ConflictError('A VM lifecycle operation is open for this remote.', {
        code: 'REMOTE_OPERATION_IN_PROGRESS',
        operationId: open.id,
      });
    }
    await this.whenIdle(open.id);
    const current = await this.storage.getRemoteOperation(open.id);
    if (current.state === 'running') {
      throw new ConflictError('A VM lifecycle operation is open for this remote.', {
        code: 'REMOTE_OPERATION_IN_PROGRESS',
        operationId: current.id,
      });
    }
    if (current.state !== 'failed') return null;
    return this.supersede(current, { supersededAt: new Date().toISOString() });
  }

  /** Resolves once the operation has no step executing in this process. */
  async whenIdle(id: string): Promise<void> {
    await this.active.get(id);
  }

  private definition(kind: RemoteOperationKind): RemoteOperationDefinition {
    const definition = this.definitions.get(kind);
    if (!definition) {
      throw new ConflictError(`Remote operation kind "${kind}" is not available.`, {
        code: 'REMOTE_OPERATION_KIND_UNAVAILABLE',
        kind,
      });
    }
    return definition;
  }

  private launch(id: string): void {
    const run = this.execute(id)
      .catch((error: unknown) => {
        if (!this.stopped) {
          logger.error({ error, operationId: id }, 'Remote operation runner crashed');
        }
      })
      .finally(() => {
        this.active.delete(id);
        this.cancelRequested.delete(id);
        this.lastPublishedAt.delete(id);
      });
    this.active.set(id, run);
  }

  private async execute(id: string): Promise<void> {
    let operation = await this.storage.getRemoteOperation(id);
    const definition = this.definition(operation.kind);

    // A claim-capable operation persisted under another PC identity must not
    // continue on this one; fail it instead of re-targeting a partly applied claim.
    const message = claimIdentityMismatch(operation.kind, operation.details);
    if (message) {
      logger.warn({ operationId: id, kind: operation.kind }, message);
      const runningIndex = operation.steps.findIndex((step) => step.state === 'running');
      const index =
        runningIndex >= 0
          ? runningIndex
          : operation.steps.findIndex((step) => step.state !== 'done' && step.state !== 'skipped');
      operation = await this.persist(operation, {
        state: 'failed',
        ...(index >= 0 && {
          steps: withStep(operation.steps, index, {
            state: 'failed',
            endedAt: new Date().toISOString(),
            error: { message, code: 'CLAIM_IDENTITY_MISMATCH' },
          }),
        }),
      });
      return;
    }

    for (const stepDefinition of definition.stepsFor?.(operation.details) ?? definition.steps) {
      if (this.stopped) return;
      if (this.cancelRequested.has(id)) {
        await this.rollback(operation, definition);
        return;
      }
      const index = operation.steps.findIndex((step) => step.id === stepDefinition.id);
      const step = operation.steps[index];
      if (!step || step.state === 'done' || step.state === 'skipped') continue;

      operation = await this.persist(operation, {
        steps: withStep(operation.steps, index, {
          state: 'running',
          startedAt: new Date().toISOString(),
          endedAt: null,
          error: null,
        }),
      });
      // A cancel accepted during that write found no step to interrupt, so the
      // step must not start: it would run with a signal nobody aborts.
      if (this.cancelRequested.has(id)) {
        operation = await this.persist(operation, {
          steps: withStep(operation.steps, index, step),
        });
        await this.rollback(operation, definition);
        return;
      }

      const details = { ...operation.details };
      const progress = this.progressReporter(id, details);
      try {
        await stepDefinition.run({ operation, details, progress: progress.report });
      } catch (error) {
        await progress.close();
        if (this.stopped) return;
        const stepError = toStepError(error);
        logger.warn(
          { operationId: id, stepId: step.id, code: stepError.code, message: stepError.message },
          'Remote operation step failed',
        );
        operation = await this.persist(operation, {
          state: 'failed',
          details,
          steps: withStep(operation.steps, index, {
            state: 'failed',
            endedAt: new Date().toISOString(),
            error: stepError,
          }),
        });
        if (this.cancelRequested.has(id)) {
          await this.rollback(operation, definition);
        }
        return;
      }
      await progress.close();
      if (this.stopped) return;
      operation = await this.persist(operation, {
        details,
        steps: withStep(operation.steps, index, {
          state: 'done',
          endedAt: new Date().toISOString(),
        }),
      });
    }

    operation = await this.persist(operation, { state: 'done' });
    logger.info({ operationId: id, kind: operation.kind }, 'Remote operation completed');
    try {
      await definition.completed?.(operation);
    } catch (error) {
      logger.error(
        { err: error, operationId: id, kind: operation.kind },
        'Remote operation completion hook failed',
      );
    }
  }

  private async rollback(
    operation: RemoteOperation,
    definition: RemoteOperationDefinition,
  ): Promise<RemoteOperation> {
    let rollbackDetails: Record<string, unknown> | void;
    try {
      rollbackDetails = await definition.rollback(operation);
    } catch (error) {
      const cancelError = toStepError(error);
      logger.warn({ operationId: operation.id, ...cancelError }, 'Remote operation cancel failed');
      await this.persist(operation, {
        state: 'failed',
        details: { ...operation.details, cancelError },
      });
      throw error;
    }
    const { cancelError: _discarded, ...details } = operation.details;
    const cancelled = await this.persist(operation, {
      state: 'cancelled',
      details: { ...details, ...rollbackDetails },
    });
    logger.info({ operationId: operation.id }, 'Remote operation cancelled');
    return cancelled;
  }

  private async persist(
    operation: RemoteOperation,
    data: UpdateRemoteOperation,
  ): Promise<RemoteOperation> {
    const updated = await this.storage.updateRemoteOperation(operation.id, data);
    this.publish(updated);
    return updated;
  }

  private publish(operation: RemoteOperation): void {
    this.lastPublishedAt.set(operation.id, Date.now());
    this.broadcaster.broadcastEvent(REMOTE_OPERATIONS_TOPIC, 'progress', operation);
  }

  /**
   * Progress writes for one step run. A patch is written once the interval
   * since the operation's last publish has passed; patches arriving before
   * then merge into that one write. `close` drops a pending write, since the
   * step's outcome persists the same details, and waits for one in flight.
   */
  private progressReporter(
    id: string,
    details: Record<string, unknown>,
  ): { report: (patch: Record<string, unknown>) => Promise<void>; close: () => Promise<void> } {
    let timer: NodeJS.Timeout | null = null;
    let writing: Promise<void> = Promise.resolve();
    let closed = false;
    const write = () => {
      timer = null;
      writing = writing.then(async () => {
        if (closed || this.stopped) return;
        try {
          const updated = await this.storage.updateRemoteOperation(id, { details: { ...details } });
          this.publish(updated);
        } catch (error) {
          logger.warn({ error, operationId: id }, 'Remote operation progress was not saved');
        }
      });
    };
    return {
      report: async (patch) => {
        if (closed) return;
        Object.assign(details, patch);
        if (timer) return;
        const since = Date.now() - (this.lastPublishedAt.get(id) ?? 0);
        timer = setTimeout(write, Math.max(0, PROGRESS_PUBLISH_INTERVAL_MS - since));
        timer.unref?.();
      },
      close: async () => {
        closed = true;
        if (timer) clearTimeout(timer);
        timer = null;
        await writing;
      },
    };
  }
}

function withStep(
  steps: RemoteOperationStep[],
  index: number,
  patch: Partial<RemoteOperationStep>,
): RemoteOperationStep[] {
  return steps.map((step, i) => (i === index ? { ...step, ...patch } : step));
}

const MAX_ERROR_MESSAGE_LENGTH = 2_000;

function toStepError(error: unknown): RemoteOperationStepError {
  const message = error instanceof Error ? error.message : String(error);
  return {
    message: message.slice(0, MAX_ERROR_MESSAGE_LENGTH),
    code: error instanceof AppError ? error.code : null,
  };
}
