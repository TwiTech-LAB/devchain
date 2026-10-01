import { ConflictError, NotFoundError } from '../../../common/errors/error-types';
import type {
  CreateRemoteOperation,
  RemoteOperation,
  RemoteOperationState,
  UpdateRemoteOperation,
} from '../../storage/models/domain.models';
import { RemoteOperationRunner } from './remote-operation.runner';
import type {
  RemoteOperationDefinition,
  RemoteOperationStepDefinition,
} from './remote-operation.types';

class InMemoryOperations {
  readonly rows = new Map<string, RemoteOperation>();
  readonly writes: RemoteOperation[] = [];
  private sequence = 0;

  async createRemoteOperation(data: CreateRemoteOperation): Promise<RemoteOperation> {
    const open = [...this.rows.values()].find(
      (row) => row.projectId === data.projectId && ['running', 'failed'].includes(row.state),
    );
    if (open) {
      throw new ConflictError('open', { code: 'REMOTE_OPERATION_IN_PROGRESS' });
    }
    const row: RemoteOperation = {
      ...data,
      id: `op-${++this.sequence}`,
      state: 'running',
      createdAt: 'now',
      updatedAt: 'now',
    };
    this.rows.set(row.id, row);
    return structuredClone(row);
  }

  async getRemoteOperation(id: string): Promise<RemoteOperation> {
    const row = this.rows.get(id);
    if (!row) throw new NotFoundError('Remote operation', id);
    return structuredClone(row);
  }

  async listRemoteOperations(filter: { states?: RemoteOperationState[] } = {}) {
    return [...this.rows.values()]
      .filter((row) => !filter.states || filter.states.includes(row.state))
      .map((row) => structuredClone(row));
  }

  async updateRemoteOperation(id: string, data: UpdateRemoteOperation): Promise<RemoteOperation> {
    const { expectedState, ...patch } = structuredClone(data);
    const current = await this.getRemoteOperation(id);
    if (expectedState && current.state !== expectedState) {
      throw new ConflictError('changed', { code: 'REMOTE_OPERATION_STATE_CHANGED' });
    }
    const row = { ...current, ...patch };
    this.rows.set(id, row);
    this.writes.push(structuredClone(row));
    return structuredClone(row);
  }
}

function step(
  id: string,
  run: RemoteOperationStepDefinition['run'] = async () => undefined,
  skip?: RemoteOperationStepDefinition['skip'],
): RemoteOperationStepDefinition {
  return { id, label: id, run: jest.fn(run), ...(skip && { skip }) };
}

function definition(
  steps: RemoteOperationStepDefinition[],
  overrides: Partial<RemoteOperationDefinition> = {},
): RemoteOperationDefinition {
  return {
    kind: 'attach',
    steps,
    assertCancellable: jest.fn(),
    rollback: jest.fn(async () => undefined),
    ...overrides,
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

describe('RemoteOperationRunner', () => {
  let storage: InMemoryOperations;
  let broadcaster: { broadcastEvent: jest.Mock };

  beforeEach(() => {
    storage = new InMemoryOperations();
    broadcaster = { broadcastEvent: jest.fn() };
  });

  function runnerFor(attach: RemoteOperationDefinition): RemoteOperationRunner {
    const detach = definition([], { kind: 'detach' });
    return new RemoteOperationRunner(
      storage as never,
      broadcaster,
      attach as never,
      detach as never,
      { kind: 'claim', steps: [] } as never,
      { kind: 'update_host', steps: [] } as never,
    );
  }

  async function startAndSettle(runner: RemoteOperationRunner, details = {}) {
    const operation = await runner.start({
      kind: 'attach',
      remoteId: 'remote-1',
      projectId: 'project-1',
      details,
    });
    await runner.whenIdle(operation.id);
    return storage.getRemoteOperation(operation.id);
  }

  it('runs the steps in order, persisting and publishing before and after each one', async () => {
    const order: string[] = [];
    const attach = definition([
      step('one', async () => void order.push('one')),
      step('two', async () => void order.push('two')),
    ]);
    const runner = runnerFor(attach);

    const done = await startAndSettle(runner);

    expect(order).toEqual(['one', 'two']);
    expect(done.state).toBe('done');
    expect(done.steps.map((s) => s.state)).toEqual(['done', 'done']);
    expect(storage.writes.map((w) => w.steps.map((s) => s.state).join(','))).toEqual([
      'running,pending',
      'done,pending',
      'done,running',
      'done,done',
      'done,done',
    ]);
    expect(broadcaster.broadcastEvent).toHaveBeenCalledTimes(6);
    expect(broadcaster.broadcastEvent).toHaveBeenLastCalledWith(
      'remote-operations',
      'progress',
      expect.objectContaining({ id: done.id, state: 'done' }),
    );
  });

  describe('step progress', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('persists and publishes the latest progress at most once a second without changing steps', async () => {
      const gate = deferred();
      const runner = runnerFor(
        definition([
          step('sync', async ({ progress }) => {
            await progress({ fileSync: { completion: 10 } });
            await progress({ fileSync: { completion: 60 }, phase: 'copy' });
            await gate.promise;
          }),
        ]),
      );
      const operation = await runner.start({
        kind: 'attach',
        remoteId: 'remote-1',
        projectId: 'project-1',
        details: { input: true },
      });
      await jest.advanceTimersByTimeAsync(0);
      const publishes = broadcaster.broadcastEvent.mock.calls.length;
      const writes = storage.writes.length;

      await jest.advanceTimersByTimeAsync(999);
      expect(broadcaster.broadcastEvent).toHaveBeenCalledTimes(publishes);

      await jest.advanceTimersByTimeAsync(1);
      expect(broadcaster.broadcastEvent).toHaveBeenCalledTimes(publishes + 1);
      const published = broadcaster.broadcastEvent.mock.calls.at(-1)?.[2] as RemoteOperation;
      expect(published.details).toEqual({
        input: true,
        fileSync: { completion: 60 },
        phase: 'copy',
      });
      expect(published.steps.map((s) => s.state)).toEqual(['running']);
      expect(storage.writes.slice(writes).map((w) => w.steps[0].state)).toEqual(['running']);

      gate.resolve();
      await jest.advanceTimersByTimeAsync(0);
      await runner.whenIdle(operation.id);
      const done = await storage.getRemoteOperation(operation.id);
      expect(done.state).toBe('done');
      expect(done.details).toMatchObject({ fileSync: { completion: 60 } });
    });

    it('lands a progress patch reported right before the step ends with the step result', async () => {
      const runner = runnerFor(
        definition([step('sync', async ({ progress }) => progress({ completion: 100 }))]),
      );
      const operation = await runner.start({
        kind: 'attach',
        remoteId: 'remote-1',
        projectId: 'project-1',
        details: {},
      });
      await jest.advanceTimersByTimeAsync(0);
      await runner.whenIdle(operation.id);
      const publishes = broadcaster.broadcastEvent.mock.calls.length;

      await jest.advanceTimersByTimeAsync(2_000);

      expect(broadcaster.broadcastEvent).toHaveBeenCalledTimes(publishes);
      expect((await storage.getRemoteOperation(operation.id)).details).toEqual({ completion: 100 });
    });
  });

  it('marks a step that fails once as failed, then retry resumes from that step', async () => {
    let failures = 0;
    const first = step('first');
    const flaky = step('flaky', async () => {
      if (failures++ === 0) throw new ConflictError('not yet', { code: 'X' });
    });
    const last = step('last');
    const runner = runnerFor(definition([first, flaky, last]));

    const failed = await startAndSettle(runner);

    expect(failed.state).toBe('failed');
    expect(failed.steps.map((s) => s.state)).toEqual(['done', 'failed', 'pending']);
    expect(failed.steps[1].error).toEqual({ message: 'not yet', code: 'conflict' });
    expect(last.run).not.toHaveBeenCalled();

    await runner.retry(failed.id);
    await runner.whenIdle(failed.id);
    const done = await storage.getRemoteOperation(failed.id);

    expect(done.state).toBe('done');
    expect(done.steps.map((s) => s.state)).toEqual(['done', 'done', 'done']);
    expect(done.steps[1].error).toBeNull();
    expect(first.run).toHaveBeenCalledTimes(1);
    expect(flaky.run).toHaveBeenCalledTimes(2);
  });

  it('persists the details a step wrote, also when it throws, and hands them to later steps', async () => {
    let seen: unknown;
    let attempts = 0;
    const runner = runnerFor(
      definition([
        step('write', async ({ details }) => {
          details.attempt = ++attempts;
          if (attempts === 1) throw new Error('boom');
        }),
        step('read', async ({ operation }) => void (seen = operation.details.attempt)),
      ]),
    );

    const failed = await startAndSettle(runner, { input: true });
    expect(failed.details).toEqual({ input: true, attempt: 1 });
    expect(failed.steps[0].error).toEqual({ message: 'boom', code: null });

    await runner.retry(failed.id);
    await runner.whenIdle(failed.id);

    expect(seen).toBe(2);
  });

  it('creates skipped steps from the initial details and never runs them', async () => {
    const skipped = step('host', undefined, (details) => details.force === true);
    const runner = runnerFor(definition([step('local'), skipped]));

    const done = await startAndSettle(runner, { force: true });

    expect(done.steps.map((s) => s.state)).toEqual(['done', 'skipped']);
    expect(skipped.run).not.toHaveBeenCalled();
  });

  it('resumes a running operation at startup from its in-flight step', async () => {
    const steps = [step('one'), step('two'), step('three')];
    const runner = runnerFor(definition(steps));
    storage.rows.set('op-9', {
      id: 'op-9',
      kind: 'attach',
      remoteId: 'remote-1',
      projectId: 'project-1',
      state: 'running',
      steps: [
        { id: 'one', label: 'one', state: 'done', startedAt: 't', endedAt: 't', error: null },
        { id: 'two', label: 'two', state: 'running', startedAt: 't', endedAt: null, error: null },
        {
          id: 'three',
          label: 'three',
          state: 'pending',
          startedAt: null,
          endedAt: null,
          error: null,
        },
      ],
      details: {},
      createdAt: 'now',
      updatedAt: 'now',
    });

    await runner.onApplicationBootstrap();
    await runner.whenIdle('op-9');

    expect(steps[0].run).not.toHaveBeenCalled();
    expect(steps[1].run).toHaveBeenCalledTimes(1);
    expect(steps[2].run).toHaveBeenCalledTimes(1);
    expect((await storage.getRemoteOperation('op-9')).state).toBe('done');
  });

  it('fails a resumed claim-capable operation persisted with another PC identity', async () => {
    const claimSteps = [step('claim_claim')];
    const runner = new RemoteOperationRunner(
      storage as never,
      broadcaster,
      definition([]) as never,
      definition([], { kind: 'detach' }) as never,
      definition(claimSteps, { kind: 'claim' }) as never,
      { kind: 'update_host', steps: [] } as never,
    );
    storage.rows.set('op-9', {
      id: 'op-9',
      kind: 'claim',
      remoteId: 'remote-1',
      projectId: null,
      state: 'running',
      steps: [
        {
          id: 'claim_claim',
          label: 'claim_claim',
          state: 'pending',
          startedAt: null,
          endedAt: null,
          error: null,
        },
      ],
      details: { userName: 'someone-else', homePath: '/var/home/elsewhere' },
      createdAt: 'now',
      updatedAt: 'now',
    });

    await runner.onApplicationBootstrap();
    await runner.whenIdle('op-9');

    expect(claimSteps[0].run).not.toHaveBeenCalled();
    const after = await storage.getRemoteOperation('op-9');
    expect(after.state).toBe('failed');
    expect(after.steps[0].error).toMatchObject({ code: 'CLAIM_IDENTITY_MISMATCH' });
  });

  it.each([false, true])(
    'fails the interrupted running step on startup identity mismatch (pending steps: %s)',
    async (hasPending) => {
      const claimSteps = [
        step('check'),
        step('optional'),
        step('claim'),
        ...(hasPending ? [step('finish')] : []),
      ];
      const runner = new RemoteOperationRunner(
        storage as never,
        broadcaster,
        definition([]) as never,
        definition([], { kind: 'detach' }) as never,
        definition(claimSteps, { kind: 'claim' }) as never,
        { kind: 'update_host', steps: [] } as never,
      );
      const completed = {
        id: 'check',
        label: 'check',
        state: 'done' as const,
        startedAt: 'before',
        endedAt: 'then',
        error: null,
      };
      const skipped = {
        id: 'optional',
        label: 'optional',
        state: 'skipped' as const,
        startedAt: null,
        endedAt: null,
        error: null,
      };
      const pending = {
        id: 'finish',
        label: 'finish',
        state: 'pending' as const,
        startedAt: null,
        endedAt: null,
        error: null,
      };
      storage.rows.set('interrupted-claim', {
        id: 'interrupted-claim',
        kind: 'claim',
        remoteId: 'remote-1',
        projectId: null,
        state: 'running',
        steps: [
          completed,
          skipped,
          {
            id: 'claim',
            label: 'claim',
            state: 'running',
            startedAt: 'interrupted',
            endedAt: null,
            error: null,
          },
          ...(hasPending ? [pending] : []),
        ],
        details: { userName: 'someone-else', homePath: '/var/home/elsewhere' },
        createdAt: 'before',
        updatedAt: 'interrupted',
      });

      await runner.onApplicationBootstrap();
      await runner.whenIdle('interrupted-claim');

      for (const step of claimSteps) expect(step.run).not.toHaveBeenCalled();
      const after = await storage.getRemoteOperation('interrupted-claim');
      expect(after.state).toBe('failed');
      expect(after.steps[0]).toEqual(completed);
      expect(after.steps[1]).toEqual(skipped);
      expect(after.steps[2]).toMatchObject({
        state: 'failed',
        startedAt: 'interrupted',
        endedAt: expect.any(String),
        error: {
          code: 'CLAIM_IDENTITY_MISMATCH',
          message: expect.stringContaining('cancel this operation and start a new one'),
        },
      });
      expect(after.steps[2].error?.message).toContain('someone-else');
      expect(after.steps[2].error?.message).toContain('/var/home/elsewhere');
      expect(after.steps.some((step) => step.state === 'running')).toBe(false);
      if (hasPending) expect(after.steps[3]).toEqual(pending);
    },
  );

  it('stops persisting once the application shuts down mid-step', async () => {
    const gate = deferred();
    const runner = runnerFor(definition([step('slow', () => gate.promise), step('next')]));
    const operation = await runner.start({
      kind: 'attach',
      remoteId: 'remote-1',
      projectId: 'project-1',
      details: {},
    });
    await new Promise((resolve) => setImmediate(resolve));

    runner.onApplicationShutdown();
    gate.resolve();
    await runner.whenIdle(operation.id);

    const row = await storage.getRemoteOperation(operation.id);
    expect(row.state).toBe('running');
    expect(row.steps.map((s) => s.state)).toEqual(['running', 'pending']);
  });

  it('cancels a failed operation through its rollback and merges the rollback details', async () => {
    const attach = definition([step('fails', async () => Promise.reject(new Error('x')))], {
      rollback: jest.fn(async () => ({ hostReleaseError: 'gone' })),
    });
    const runner = runnerFor(attach);
    const failed = await startAndSettle(runner);

    const cancelled = await runner.cancel(failed.id);

    expect(attach.rollback).toHaveBeenCalledWith(expect.objectContaining({ id: failed.id }));
    expect(cancelled.state).toBe('cancelled');
    expect(cancelled.details).toEqual({ hostReleaseError: 'gone' });
  });

  it('cancels a running operation after its current step and runs no further step', async () => {
    const gate = deferred();
    const next = step('next');
    const attach = definition([step('slow', () => gate.promise), next]);
    const runner = runnerFor(attach);
    const operation = await runner.start({
      kind: 'attach',
      remoteId: 'remote-1',
      projectId: 'project-1',
      details: {},
    });
    await new Promise((resolve) => setImmediate(resolve));

    const cancelling = runner.cancel(operation.id);
    gate.resolve();
    const cancelled = await cancelling;

    expect(cancelled.state).toBe('cancelled');
    expect(next.run).not.toHaveBeenCalled();
    expect(attach.rollback).toHaveBeenCalledTimes(1);
  });

  it('keeps a failed operation open with the cancel error when the rollback throws', async () => {
    const attach = definition([step('fails', async () => Promise.reject(new Error('x')))], {
      rollback: jest.fn(async () => Promise.reject(new Error('host unreachable'))),
    });
    const runner = runnerFor(attach);
    const failed = await startAndSettle(runner);

    await expect(runner.cancel(failed.id)).rejects.toThrow('host unreachable');

    const row = await storage.getRemoteOperation(failed.id);
    expect(row.state).toBe('failed');
    expect(row.details.cancelError).toEqual({ message: 'host unreachable', code: null });
  });

  it('refuses retry of an operation that has not failed and cancel of a finished one', async () => {
    const runner = runnerFor(definition([step('one')]));
    const done = await startAndSettle(runner);

    await expect(runner.retry(done.id)).rejects.toMatchObject({
      statusCode: 409,
      details: { code: 'REMOTE_OPERATION_NOT_FAILED' },
    });
    await expect(runner.cancel(done.id)).rejects.toMatchObject({
      statusCode: 409,
      details: { code: 'REMOTE_OPERATION_FINISHED' },
    });
  });

  it('refuses a second open operation for the same project', async () => {
    const runner = runnerFor(
      definition([step('fails', async () => Promise.reject(new Error('x')))]),
    );
    await startAndSettle(runner);

    await expect(
      runner.start({ kind: 'attach', remoteId: 'remote-1', projectId: 'project-1', details: {} }),
    ).rejects.toMatchObject({ details: { code: 'REMOTE_OPERATION_IN_PROGRESS' } });
  });

  it('supersedes a failed operation as cancelled without its rollback', async () => {
    const forget = jest.fn();
    const attach = definition(
      [
        step('one', async () => {
          throw new Error('host down');
        }),
      ],
      { forget },
    );
    const runner = runnerFor(attach);
    const failed = await startAndSettle(runner);

    const cancelled = await runner.supersede(failed, { supersededAt: 't' });

    expect(cancelled).toMatchObject({ state: 'cancelled', details: { supersededAt: 't' } });
    expect(cancelled.steps).toEqual(failed.steps);
    expect(attach.rollback).not.toHaveBeenCalled();
    expect(forget).toHaveBeenCalledWith(failed.id);
    expect(broadcaster.broadcastEvent).toHaveBeenLastCalledWith(
      'remote-operations',
      'progress',
      expect.objectContaining({ id: failed.id, state: 'cancelled' }),
    );
    await expect(runner.cancel(failed.id)).rejects.toMatchObject({
      details: { code: 'REMOTE_OPERATION_FINISHED' },
    });
    await expect(runner.retry(failed.id)).rejects.toMatchObject({
      details: { code: 'REMOTE_OPERATION_NOT_FAILED' },
    });
  });

  it('lets only one of a retry and a takeover win the failed operation', async () => {
    let fail = true;
    const gate = deferred();
    const attach = definition([
      step('one', async () => {
        if (fail) throw new Error('host down');
        await gate.promise;
      }),
    ]);
    const runner = runnerFor(attach);
    const failed = await startAndSettle(runner);
    fail = false;

    await runner.retry(failed.id);

    // A step is executing, and the row is no longer failed.
    await expect(runner.supersede(failed, {})).rejects.toMatchObject({
      details: { code: 'REMOTE_OPERATION_IN_PROGRESS' },
    });
    gate.resolve();
    await runner.whenIdle(failed.id);
    await expect(runner.supersede(failed, {})).rejects.toMatchObject({
      details: { code: 'REMOTE_OPERATION_STATE_CHANGED' },
    });
    expect((await storage.getRemoteOperation(failed.id)).state).toBe('done');
  });

  it('refuses a retry once a takeover cancelled the operation after the retry read it', async () => {
    const attach = definition([
      step('one', async () => {
        throw new Error('host down');
      }),
    ]);
    const runner = runnerFor(attach);
    const failed = await startAndSettle(runner);
    const read = storage.getRemoteOperation.bind(storage);
    jest.spyOn(storage, 'getRemoteOperation').mockImplementationOnce(async (id) => {
      const row = await read(id);
      // The takeover lands between the retry's read and its write.
      await runner.supersede(row, {});
      return row;
    });

    await expect(runner.retry(failed.id)).rejects.toMatchObject({
      details: { code: 'REMOTE_OPERATION_STATE_CHANGED' },
    });
    expect((await read(failed.id)).state).toBe('cancelled');
    expect(attach.steps[0].run).toHaveBeenCalledTimes(1);
  });

  it('propagates a definition refusing the cancel', async () => {
    const attach = definition([step('fails', async () => Promise.reject(new Error('x')))], {
      assertCancellable: () => {
        throw new ConflictError('too late', { code: 'REMOTE_OPERATION_NOT_CANCELLABLE' });
      },
    });
    const runner = runnerFor(attach);
    const failed = await startAndSettle(runner);

    await expect(runner.cancel(failed.id)).rejects.toThrow('too late');
    expect(attach.rollback).not.toHaveBeenCalled();
  });
});
