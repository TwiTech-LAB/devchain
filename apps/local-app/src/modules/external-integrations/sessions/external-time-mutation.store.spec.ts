import {
  ExternalTimeMutationStore,
  timeEntryNoteFingerprint,
} from './external-time-mutation.store';
import {
  TIME_OPERATION_RECEIPT_TTL_MS,
  type ExternalTimeMutationTuple,
} from '../models/external-time-mutation.models';

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

  it.each(['pending', 'dispatched', 'outcome_unknown'] as const)(
    'finds an exact task receipt while it is %s',
    (phase) => {
      const store = new ExternalTimeMutationStore();
      store.admit({ operationId: 'manual-op', kind: 'create', tuple: tuple(), baseline: null });
      if (phase === 'dispatched') {
        store.markDispatched('manual-op');
      } else if (phase === 'outcome_unknown') {
        store.markUnknown('manual-op');
      }

      expect(
        store.findLiveTaskReceipt({
          provider: 'clickup',
          connectionId: 'connection-1',
          connectionGeneration: 4,
          remoteTaskId: 'task-1',
        }),
      ).toMatchObject({ operationId: 'manual-op', phase });
    },
  );

  it('isolates task receipts by provider, connection epoch, task, and excluded operation', () => {
    const store = new ExternalTimeMutationStore();
    store.admit({ operationId: 'manual-op', kind: 'create', tuple: tuple(), baseline: null });

    const exact = {
      provider: 'clickup' as const,
      connectionId: 'connection-1',
      connectionGeneration: 4,
      remoteTaskId: 'task-1',
    };
    expect(store.findLiveTaskReceipt({ ...exact, excludeOperationId: 'manual-op' })).toBeNull();
    expect(store.findLiveTaskReceipt({ ...exact, remoteTaskId: 'task-2' })).toBeNull();
    expect(store.findLiveTaskReceipt({ ...exact, connectionId: 'connection-2' })).toBeNull();
    expect(store.findLiveTaskReceipt({ ...exact, connectionGeneration: 5 })).toBeNull();
    expect(store.findLiveTaskReceipt({ ...exact, provider: 'jira' })).toBeNull();
  });

  it.each(['succeeded', 'failed', 'abandoned_unknown'] as const)(
    'does not return a task receipt after it becomes %s',
    (phase) => {
      const store = new ExternalTimeMutationStore();
      store.admit({ operationId: 'manual-op', kind: 'create', tuple: tuple(), baseline: null });
      if (phase === 'abandoned_unknown') {
        store.markUnknown('manual-op');
        store.acknowledgeUnknown('manual-op');
      } else {
        store.markTerminal('manual-op', phase);
      }

      expect(
        store.findLiveTaskReceipt({
          provider: 'clickup',
          connectionId: 'connection-1',
          connectionGeneration: 4,
          remoteTaskId: 'task-1',
        }),
      ).toBeNull();
    },
  );

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

  it('drops a receipt at the real production TTL deadline its view advertised', () => {
    let now = Date.parse('2026-09-01T10:00:00.000Z');
    const store = new ExternalTimeMutationStore(32, 256, TIME_OPERATION_RECEIPT_TTL_MS, () => now);
    store.admit({ operationId: 'op-1', kind: 'create', tuple: tuple(), baseline: null });
    store.markUnknown('op-1');

    const view = store.view(store.get('op-1')!);
    expect(view.expiresAt).toBe(new Date(now + TIME_OPERATION_RECEIPT_TTL_MS).toISOString());

    // One millisecond before the advertised deadline the receipt still exists.
    now = Date.parse(view.expiresAt) - 1;
    expect(store.get('op-1')).not.toBeNull();
    expect(store.acknowledgeUnknown('op-1').ok).toBe(true);

    // After the deadline the server receipt is gone, so its acknowledgement
    // endpoint must answer not_found.
    store.admit({ operationId: 'op-2', kind: 'create', tuple: tuple(), baseline: null });
    store.markUnknown('op-2');
    const second = store.view(store.get('op-2')!);
    now = Date.parse(second.expiresAt) + 1;
    expect(store.get('op-2')).toBeNull();
    expect(store.acknowledgeUnknown('op-2').reason).toBe('not_found');
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
      canVerify: false,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
      expiresAt: expect.any(String),
    });
    expect(JSON.stringify(view)).not.toMatch(/Fingerprint|connectionId/);
  });

  it.each([
    {
      label: 'unknown create with a complete baseline',
      kind: 'create' as const,
      baseline: { matchingIds: ['9001'], complete: true },
      settle: 'unknown',
      expected: true,
    },
    {
      label: 'unknown create with an incomplete baseline',
      kind: 'create' as const,
      baseline: { matchingIds: [], complete: false },
      settle: 'unknown',
      expected: false,
    },
    {
      label: 'unknown create without a baseline',
      kind: 'create' as const,
      baseline: null,
      settle: 'unknown',
      expected: false,
    },
    {
      label: 'unknown delete',
      kind: 'delete' as const,
      baseline: null,
      settle: 'unknown',
      expected: true,
    },
    {
      label: 'unknown update with an exact baseline',
      kind: 'update' as const,
      baseline: null,
      settle: 'unknown',
      expected: true,
    },
    {
      label: 'dispatched create with a complete baseline',
      kind: 'create' as const,
      baseline: { matchingIds: [], complete: true },
      settle: 'dispatched',
      expected: false,
    },
    {
      label: 'acknowledged create with a complete baseline',
      kind: 'create' as const,
      baseline: { matchingIds: [], complete: true },
      settle: 'acknowledged',
      expected: false,
    },
  ])(
    'derives canVerify $expected from the live receipt of a $label',
    ({ kind, baseline, settle, expected }) => {
      const store = new ExternalTimeMutationStore();
      store.admit({
        operationId: 'op-1',
        kind,
        tuple: tuple(),
        baseline,
        updateBaseline:
          kind === 'update'
            ? { startedAt: new Date(0).toISOString(), durationMs: 60_000, noteFingerprint: 'fp' }
            : null,
      });
      if (settle === 'dispatched') {
        store.markDispatched('op-1');
      } else if (settle === 'unknown') {
        store.markUnknown('op-1');
      } else {
        store.markUnknown('op-1');
        store.acknowledgeUnknown('op-1');
      }

      const receipt = store.get('op-1')!;
      expect(store.view(receipt).canVerify).toBe(expected);
      // Nothing was stored: the flag is recomputed from the receipt on every read.
      expect(Object.keys(receipt)).not.toContain('canVerify');
    },
  );
});
