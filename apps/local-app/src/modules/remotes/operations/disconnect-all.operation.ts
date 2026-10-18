import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError, ConflictError } from '../../../common/errors/error-types';
import { STORAGE_SERVICE, type RemoteStorage } from '../../storage/interfaces/storage.interface';
import type { RemoteOperation } from '../../storage/models/domain.models';
import type { DockerCopyBackRequest } from '../docker/docker-copy-back.dto';
import { RemoteOperationStepRefusedError } from './remote-operation.errors';
import type {
  RemoteOperationDefinition,
  RemoteOperationStepDefinition,
  RemoteOperationStepRun,
} from './remote-operation.types';

export interface DisconnectAllDetails {
  force: boolean;
  projects: Array<{
    projectId: string;
    operationId: string;
    dockerCopyBack?: DockerCopyBackRequest;
  }>;
  failedChildId?: string;
  cancelRequested?: boolean;
}

interface ChildRunner {
  start(input: {
    id: string;
    kind: 'detach';
    remoteId: string;
    projectId: string;
    details: Record<string, unknown>;
  }): Promise<RemoteOperation>;
  retry(id: string): Promise<RemoteOperation>;
  cancel(id: string): Promise<RemoteOperation>;
  whenIdle(id: string): Promise<void>;
  resumeChild(id: string): Promise<void>;
}

/** A batch child operation, or null before the batch started it. */
export async function findBatchChild(
  storage: RemoteStorage,
  id: string,
): Promise<RemoteOperation | null> {
  try {
    return await storage.getRemoteOperation(id);
  } catch (error) {
    if (error instanceof NotFoundError) return null;
    throw error;
  }
}

/** Each project has a real detach row, including its own copy-back ledger and rollback. */
@Injectable()
export class DisconnectAllOperation implements RemoteOperationDefinition {
  readonly kind = 'disconnect_all' as const;
  readonly steps: readonly RemoteOperationStepDefinition[];
  private runner!: ChildRunner;
  private readonly running = new Map<string, RemoteOperationStepRun>();
  private readonly cancelling = new Set<string>();

  constructor(@Inject(STORAGE_SERVICE) private readonly storage: RemoteStorage) {
    this.steps = [
      { id: 'preflight', label: 'Check the connected projects', run: (c) => this.preflight(c) },
    ];
  }

  // The runner supplies its child lifecycle port when registering definitions,
  // so the operation and runner do not depend on each other through Nest DI.
  useRunner(runner: ChildRunner): void {
    this.runner = runner;
  }

  stepsFor(details: Record<string, unknown>): readonly RemoteOperationStepDefinition[] {
    const batch = details as unknown as DisconnectAllDetails;
    const steps: readonly RemoteOperationStepDefinition[] = [
      ...this.steps,
      ...batch.projects.map((project, index) => ({
        id: `disconnect:${index}`,
        label: `Disconnect ${project.projectId}`,
        run: (run: RemoteOperationStepRun) => this.disconnect(run, index),
      })),
    ];
    return steps.map((step) => ({
      ...step,
      run: async (run) => {
        this.running.set(run.operation.id, run);
        try {
          if (this.cancelling.has(run.operation.id))
            await run.progress({ cancelRequested: true }, { durable: true });
          if (!run.details.cancelRequested) await step.run(run);
        } finally {
          this.running.delete(run.operation.id);
        }
      },
    }));
  }

  assertCancellable(): void {}

  cancellationRequested(operation: RemoteOperation): boolean {
    return operation.details.cancelRequested === true;
  }

  async interrupt(id: string): Promise<void> {
    this.cancelling.add(id);
    const run = this.running.get(id);
    if (run) await run.progress({ cancelRequested: true }, { durable: true });
    else {
      const operation = await this.storage.getRemoteOperation(id);
      await this.storage.updateRemoteOperation(id, {
        details: { ...operation.details, cancelRequested: true },
      });
    }
    await this.cancelChildren(await this.storage.getRemoteOperation(id));
  }

  async rollback(operation: RemoteOperation): Promise<void> {
    try {
      operation.details.cancelRequested = true;
      await this.storage.updateRemoteOperation(operation.id, { details: operation.details });
      await this.cancelChildren(operation);
    } finally {
      this.cancelling.delete(operation.id);
    }
  }

  async completed(operation: RemoteOperation): Promise<void> {
    this.cancelling.delete(operation.id);
  }

  private async preflight({ operation, details }: RemoteOperationStepRun): Promise<void> {
    const batch = details as unknown as DisconnectAllDetails;
    const current = (await this.storage.listRemoteProjectBindings()).filter(
      (binding) => binding.remoteId === operation.remoteId,
    );
    const ids = new Set(batch.projects.map((project) => project.projectId));
    if (
      ids.size !== batch.projects.length ||
      current.length !== ids.size ||
      current.some((binding) => binding.state !== 'remote' || !ids.has(binding.projectId))
    ) {
      throw new RemoteOperationStepRefusedError(
        'DISCONNECT_ALL_BINDINGS_CHANGED',
        'The connected projects changed; cancel and start Disconnect all again.',
      );
    }
    let [open] = await this.storage.listRemoteOperations({
      remoteId: operation.remoteId,
      kinds: ['attach', 'detach', 'force_sync'],
      states: ['running', 'failed'],
      limit: 1,
    });
    for (const { projectId } of batch.projects) {
      if (open) break;
      [open] = await this.storage.listRemoteOperations({
        projectId,
        states: ['running', 'failed'],
        limit: 1,
      });
    }
    if (open) {
      throw new RemoteOperationStepRefusedError(
        'DISCONNECT_ALL_PROJECT_OPERATION_OPEN',
        'A project operation is still open; finish it before Disconnect all.',
      );
    }
  }

  private async disconnect(run: RemoteOperationStepRun, index: number): Promise<void> {
    const { operation, details } = run;
    const batch = details as unknown as DisconnectAllDetails;
    const project = batch.projects[index];
    let child = await findBatchChild(this.storage, project.operationId);
    if (!child) {
      if (batch.cancelRequested || this.cancelling.has(operation.id)) return;
      child = await this.runner.start({
        id: project.operationId,
        kind: 'detach',
        remoteId: operation.remoteId,
        projectId: project.projectId,
        details: {
          parentOperationId: operation.id,
          force: batch.force,
          ...(!batch.force && project.dockerCopyBack && { dockerCopyBack: project.dockerCopyBack }),
        },
      });
    } else if (child.state === 'failed' && batch.failedChildId === child.id) {
      if (child.steps.some((step) => step.error?.code === 'DOCKER_COPY_BACK_CHOICE_REQUIRED'))
        this.childFailed(child, batch);
      await this.runner.whenIdle(child.id);
      if (batch.cancelRequested || this.cancelling.has(operation.id)) return;
      child = await this.runner.retry(child.id);
      delete batch.failedChildId;
      await run.progress({ failedChildId: undefined }, { durable: true });
    }
    if (batch.cancelRequested || this.cancelling.has(operation.id)) await this.cancelChild(child);
    else if (child.state === 'running') await this.runner.resumeChild(child.id);
    await this.runner.whenIdle(child.id);
    child = await this.storage.getRemoteOperation(child.id);
    if (child.state === 'failed') this.childFailed(child, batch);
  }

  private childFailed(child: RemoteOperation, batch: DisconnectAllDetails): never {
    batch.failedChildId = child.id;
    const error = child.steps.find((step) => step.state === 'failed')?.error;
    throw new RemoteOperationStepRefusedError(
      error?.code ?? 'DISCONNECT_ALL_CHILD_FAILED',
      error?.message ?? 'A Disconnect stopped; retry or cancel Disconnect all.',
    );
  }

  private async cancelChildren(operation: RemoteOperation): Promise<void> {
    const batch = operation.details as unknown as DisconnectAllDetails;
    for (const project of batch.projects) {
      const child = await findBatchChild(this.storage, project.operationId);
      if (child && (child.state === 'running' || child.state === 'failed'))
        await this.cancelChild(child);
    }
  }

  private async cancelChild(child: RemoteOperation): Promise<void> {
    try {
      await this.runner.cancel(child.id);
    } catch (error) {
      if (error instanceof ConflictError && error.details?.code === 'REMOTE_OPERATION_FINISHED') {
        const finished = await this.storage.getRemoteOperation(child.id);
        if (finished.state === 'done' || finished.state === 'cancelled') return;
      }
      if (
        !(error instanceof ConflictError) ||
        error.details?.code !== 'REMOTE_OPERATION_NOT_CANCELLABLE'
      )
        throw error;
      await this.runner.whenIdle(child.id);
      const current = await this.storage.getRemoteOperation(child.id);
      if (current.state === 'failed') {
        await this.runner.retry(child.id);
        await this.runner.whenIdle(child.id);
      } else if (current.state === 'running') {
        await this.runner.resumeChild(child.id);
        await this.runner.whenIdle(child.id);
      }
      const after = await this.storage.getRemoteOperation(child.id);
      if (after.state !== 'done' && after.state !== 'cancelled') {
        throw new ConflictError(
          'The active Disconnect must finish before the batch can be cancelled.',
          {
            code: 'DISCONNECT_ALL_CHILD_UNFINISHED',
            operationId: child.id,
          },
        );
      }
    }
  }
}
