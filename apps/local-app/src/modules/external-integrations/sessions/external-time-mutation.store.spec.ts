import {
  ExternalTimeMutationStore,
  timeEntryNoteFingerprint,
} from './external-time-mutation.store';
import type { ExternalTimeMutationTuple } from '../models/external-time-mutation.models';

function tuple(overrides: Partial<ExternalTimeMutationTuple> = {}): ExternalTimeMutationTuple {
  return {
    provider: 'clickup',
    connectionId: 'connection-1',
    connectionGeneration: 4,
    remoteTaskId: 'task-1',
    remoteEntryId: null,
    effectiveStartedAt: '2026-08-19T10:00:00.000Z',
    durationMs: 3_600_000,
    noteFingerprint: timeEntryNoteFingerprint('Implementation'),
    ...overrides,
  };
}

describe('ExternalTimeMutationStore', () => {
  it('admits, dispatches, and terminalizes a receipt', () => {
    const store = new ExternalTimeMutationStore();
    const admitted = store.admit({
      operationId: 'op-1',
      kind: 'create',
      tuple: tuple(),
      baseline: { matchingIds: ['9001'], complete: true },
    });
    expect(admitted.ok).toBe(true);

    store.markDispatched('op-1');
    expect(store.get('op-1')!.phase).toBe('dispatched');

    const terminal = store.markTerminal('op-1', 'succeeded', '9100');
    expect(terminal!.phase).toBe('succeeded');
    expect(terminal!.remoteEntryId).toBe('9100');
  });

  it('rejects a reused operation id bound to a different tuple', () => {
    const store = new ExternalTimeMutationStore();
    store.admit({ operationId: 'op-1', kind: 'create', tuple: tuple(), baseline: null });

    const conflict = store.admit({
      operationId: 'op-1',
      kind: 'create',
      tuple: tuple({ durationMs: 60_000 }),
      baseline: null,
    });

    expect(conflict.ok).toBe(false);
    expect(conflict.reason).toBe('operation_id_conflict');
  });

  it('reports a live duplicate and a terminal duplicate separately', () => {
    const store = new ExternalTimeMutationStore();
    store.admit({ operationId: 'op-1', kind: 'create', tuple: tuple(), baseline: null });
    store.markUnknown('op-1');

    const live = store.admit({
      operationId: 'op-1',
      kind: 'create',
      tuple: tuple(),
      baseline: null,
    });
    expect(live.reason).toBe('duplicate_live');
    expect(live.receipt!.phase).toBe('outcome_unknown');

    store.markTerminal('op-1', 'abandoned_unknown');
    const terminal = store.admit({
      operationId: 'op-1',
      kind: 'create',
      tuple: tuple(),
      baseline: null,
    });
    expect(terminal.reason).toBe('duplicate_terminal');
  });

  it('never evicts live receipts: capacity exhaustion fails busy', () => {
    const store = new ExternalTimeMutationStore(2, 4, 60_000);
    for (let index = 0; index < 2; index += 1) {
      const admitted = store.admit({
        operationId: `op-${index}`,
        kind: 'create',
        tuple: tuple({ durationMs: index + 1 }),
        baseline: null,
      });
      expect(admitted.ok).toBe(true);
    }

    const exhausted = store.admit({
      operationId: 'op-new',
      kind: 'create',
      tuple: tuple({ durationMs: 99 }),
      baseline: null,
    });
    expect(exhausted.ok).toBe(false);
    expect(exhausted.reason).toBe('receipt_capacity');
    // The live receipts are all still present.
    expect(store.get('op-0')).not.toBeNull();
    expect(store.get('op-1')).not.toBeNull();
  });

  it('recycles oldest terminal receipts at the total cap', () => {
    const store = new ExternalTimeMutationStore(32, 2, 60_000);
    store.admit({ operationId: 'op-0', kind: 'create', tuple: tuple(), baseline: null });
    store.markTerminal('op-0', 'failed');
    store.admit({
      operationId: 'op-1',
      kind: 'create',
      tuple: tuple({ durationMs: 2 }),
      baseline: null,
    });
    store.markTerminal('op-1', 'failed');

    const admitted = store.admit({
      operationId: 'op-2',
      kind: 'create',
      tuple: tuple({ durationMs: 3 }),
      baseline: null,
    });
    expect(admitted.ok).toBe(true);
    expect(store.get('op-0')).toBeNull();
    expect(store.get('op-1')).not.toBeNull();
    expect(store.get('op-2')).not.toBeNull();
  });

  it('expires every receipt after the TTL ends the guarantee', () => {
    let now = 1_000_000;
    const store = new ExternalTimeMutationStore(32, 256, 1_000, () => now);
    store.admit({ operationId: 'op-1', kind: 'create', tuple: tuple(), baseline: null });
    store.markUnknown('op-1');

    now += 1_001;
    expect(store.get('op-1')).toBeNull();
    expect(store.size()).toBe(0);
  });

  it('transitions only a live unknown receipt to abandoned_unknown', () => {
    const store = new ExternalTimeMutationStore();
    store.admit({ operationId: 'op-1', kind: 'delete', tuple: tuple(), baseline: null });

    expect(store.acknowledgeUnknown('op-1').ok).toBe(false);

    store.markUnknown('op-1');
    const acked = store.acknowledgeUnknown('op-1');
    expect(acked.ok).toBe(true);
    expect(acked.receipt!.phase).toBe('abandoned_unknown');

    const again = store.acknowledgeUnknown('op-1');
    expect(again.ok).toBe(false);
    expect(again.reason).toBe('not_unknown');

    expect(store.acknowledgeUnknown('missing').reason).toBe('not_found');
  });

  it('exposes a wire view without the tuple fingerprint internals', () => {
    const store = new ExternalTimeMutationStore();
    store.admit({ operationId: 'op-1', kind: 'create', tuple: tuple(), baseline: null });
    store.markTerminal('op-1', 'succeeded', '9100');

    const view = store.view(store.get('op-1')!);
    expect(view).toEqual({
      operationId: 'op-1',
      kind: 'create',
      provider: 'clickup',
      remoteTaskId: 'task-1',
      remoteEntryId: '9100',
      phase: 'succeeded',
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
      expiresAt: expect.any(String),
    });
    expect(JSON.stringify(view)).not.toMatch(/Fingerprint|connectionId/);
  });
});
