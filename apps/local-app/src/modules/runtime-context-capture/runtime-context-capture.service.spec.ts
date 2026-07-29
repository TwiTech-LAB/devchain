jest.mock('../storage/db/sqlite-raw', () => ({
  getRawSqliteClient: (db: { session: { client: unknown } }) => db.session.client,
}));

import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import {
  RUNTIME_CONTEXT_CAPTURE_TUPLE_CHANGED_EVENT,
  RuntimeContextCaptureService,
} from './runtime-context-capture.service';
import type { RuntimeContextCaptureReport } from './runtime-context-capture.types';

const SESSION_A = '11111111-1111-1111-1111-111111111111';
const SESSION_B = '22222222-2222-2222-2222-222222222222';

describe('RuntimeContextCaptureService', () => {
  let rows: Map<string, { status: string; provider_name_at_launch: string | null }>;
  let service: RuntimeContextCaptureService;

  beforeEach(() => {
    rows = new Map([
      [SESSION_A, { status: 'running', provider_name_at_launch: 'claude' }],
      [SESSION_B, { status: 'running', provider_name_at_launch: 'claude' }],
    ]);
    service = createService(rows);
  });

  it('binds the first report for a running Claude session without provider-session state', () => {
    const result = service.capture(report({ sessionId: SESSION_A }));

    expect(result).toEqual(
      expect.objectContaining({
        accepted: true,
        change: 'bound',
        tupleChanged: true,
        modelChanged: true,
        contextWindowChanged: true,
      }),
    );
    expect(service.get(SESSION_A)).toEqual(
      expect.objectContaining({
        claudeSessionId: 'claude-runtime-1',
        modelId: 'claude-sonnet-4-6',
        contextWindowTokens: 1_000_000,
      }),
    );
  });

  it('keeps concurrent sessions isolated', () => {
    service.capture(report({ sessionId: SESSION_A, sequence: 1 }));
    service.capture(
      report({
        sessionId: SESSION_B,
        epoch: 'epoch-b',
        sequence: 8,
        claudeSessionId: 'claude-runtime-b',
        modelId: 'claude-opus-4-6',
      }),
    );

    expect(service.get(SESSION_A)?.sequence).toBe(1);
    expect(service.get(SESSION_B)).toEqual(
      expect.objectContaining({
        epoch: 'epoch-b',
        sequence: 8,
        claudeSessionId: 'claude-runtime-b',
      }),
    );
  });

  it('atomically replaces the tuple for a higher-sequence hookless clear', () => {
    service.capture(report({ sessionId: SESSION_A, sequence: 3 }));

    const result = service.capture(
      report({
        sessionId: SESSION_A,
        sequence: 4,
        claudeSessionId: 'claude-runtime-after-clear',
        modelId: 'claude-opus-4-6',
        contextWindowTokens: 200_000,
      }),
    );

    expect(result).toEqual(
      expect.objectContaining({
        accepted: true,
        change: 'tuple-changed',
        runtimeSessionChanged: true,
        modelChanged: true,
        contextWindowChanged: true,
      }),
    );
    expect(service.get(SESSION_A)).toEqual(
      expect.objectContaining({
        sequence: 4,
        claudeSessionId: 'claude-runtime-after-clear',
        modelId: 'claude-opus-4-6',
        contextWindowTokens: 200_000,
      }),
    );
  });

  it('rejects old-after-new delivery and leaves the newer tuple unchanged', () => {
    service.capture(report({ sessionId: SESSION_A, sequence: 9, modelId: 'new-model' }));

    const result = service.capture(
      report({ sessionId: SESSION_A, sequence: 7, modelId: 'old-model' }),
    );

    expect(result).toEqual({ accepted: false, reason: 'sequence-not-increasing' });
    expect(service.get(SESSION_A)).toEqual(
      expect.objectContaining({ sequence: 9, modelId: 'new-model' }),
    );
  });

  it('distinguishes a sequence-only advance from a meaningful tuple change', () => {
    service.capture(report({ sessionId: SESSION_A, sequence: 1 }));

    const result = service.capture(report({ sessionId: SESSION_A, sequence: 2 }));

    expect(result).toEqual(
      expect.objectContaining({
        accepted: true,
        change: 'sequence-advanced',
        tupleChanged: false,
        runtimeSessionChanged: false,
        modelChanged: false,
        contextWindowChanged: false,
      }),
    );
  });

  it('signals tuple and provenance changes but not sequence-only advances', () => {
    const emit = jest.fn();
    service = createService(rows, { emit } as unknown as EventEmitter2);

    service.capture(report({ sessionId: SESSION_A, sequence: 1 }));
    service.capture(report({ sessionId: SESSION_A, sequence: 2 }));
    service.capture(
      report({
        sessionId: SESSION_A,
        sequence: 3,
        contextWindowTokens: 750_000,
      }),
    );

    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenNthCalledWith(1, RUNTIME_CONTEXT_CAPTURE_TUPLE_CHANGED_EVENT, {
      sessionId: SESSION_A,
    });
    expect(emit).toHaveBeenNthCalledWith(2, RUNTIME_CONTEXT_CAPTURE_TUPLE_CHANGED_EVENT, {
      sessionId: SESSION_A,
    });
  });

  it('rejects stopped, non-Claude, and unknown sessions without creating state', () => {
    rows.set(SESSION_A, { status: 'stopped', provider_name_at_launch: 'claude' });
    rows.set(SESSION_B, { status: 'running', provider_name_at_launch: 'codex' });

    expect(service.capture(report({ sessionId: SESSION_A }))).toEqual({
      accepted: false,
      reason: 'session-ineligible',
    });
    expect(service.capture(report({ sessionId: SESSION_B }))).toEqual({
      accepted: false,
      reason: 'session-ineligible',
    });
    expect(service.capture(report({ sessionId: '33333333-3333-3333-3333-333333333333' }))).toEqual({
      accepted: false,
      reason: 'session-ineligible',
    });
    expect(service.get(SESSION_A)).toBeNull();
    expect(service.get(SESSION_B)).toBeNull();
  });

  it('rotates the expected epoch and rejects delayed reports from the prior process', () => {
    service.capture(report({ sessionId: SESSION_A, epoch: 'old-epoch', sequence: 4 }));
    const nextEpoch = service.rotateEpoch(SESSION_A);

    expect(
      service.capture(report({ sessionId: SESSION_A, epoch: 'old-epoch', sequence: 5 })),
    ).toEqual({ accepted: false, reason: 'epoch-mismatch' });
    expect(service.get(SESSION_A)).toBeNull();

    expect(
      service.capture(report({ sessionId: SESSION_A, epoch: nextEpoch, sequence: 1 })),
    ).toEqual(expect.objectContaining({ accepted: true, change: 'bound' }));
  });

  it('binds a configured window independently of Claude capture state', () => {
    service.rotateEpoch(SESSION_A, {
      modelId: 'custom/model',
      contextWindowTokens: 640_000,
    });

    expect(service.getLiveContext(SESSION_A)).toEqual({
      configuredOverride: {
        modelId: 'custom/model',
        contextWindowTokens: 640_000,
      },
      claudeCapture: null,
    });

    service.capture(
      report({
        sessionId: SESSION_A,
        epoch: service.getEpoch(SESSION_A)!,
        modelId: 'claude-sonnet-4-6',
      }),
    );

    expect(service.getLiveContext(SESSION_A)).toEqual({
      configuredOverride: {
        modelId: 'custom/model',
        contextWindowTokens: 640_000,
      },
      claudeCapture: expect.objectContaining({ modelId: 'claude-sonnet-4-6' }),
    });
  });

  it('restores the prior in-memory snapshot after a failed lifecycle transition', () => {
    service.rotateEpoch(SESSION_A, {
      modelId: 'claude-sonnet-4-6',
      contextWindowTokens: 750_000,
    });
    const epoch = service.getEpoch(SESSION_A)!;
    service.capture(report({ sessionId: SESSION_A, epoch, sequence: 4 }));
    const snapshot = service.snapshot(SESSION_A);
    service.rotateEpoch(SESSION_A);

    service.restoreSnapshot(SESSION_A, snapshot);

    expect(service.getEpoch(SESSION_A)).toBe(epoch);
    expect(service.get(SESSION_A)).toEqual(expect.objectContaining({ epoch, sequence: 4 }));
    expect(service.getLiveContext(SESSION_A)?.configuredOverride).toEqual({
      modelId: 'claude-sonnet-4-6',
      contextWindowTokens: 750_000,
    });
  });

  it('rebinds a rehydrated running session after an empty-registry server restart', () => {
    service.capture(report({ sessionId: SESSION_A, epoch: 'retired-server', sequence: 40 }));
    const restartedService = createService(rows);

    const result = restartedService.capture(
      report({ sessionId: SESSION_A, epoch: 'live-process', sequence: 41 }),
    );

    expect(result).toEqual(expect.objectContaining({ accepted: true, change: 'bound' }));
    expect(restartedService.get(SESSION_A)?.epoch).toBe('live-process');
  });

  it('clears the registry entry on end cleanup', () => {
    service.capture(report({ sessionId: SESSION_A }));

    service.clear(SESSION_A);

    expect(service.get(SESSION_A)).toBeNull();
    expect(service.getEpoch(SESSION_A)).toBeNull();
    expect(service.getLiveContext(SESSION_A)).toBeNull();
  });
});

function createService(
  rows: Map<string, { status: string; provider_name_at_launch: string | null }>,
  eventEmitter?: EventEmitter2,
): RuntimeContextCaptureService {
  const sqlite = {
    prepare: jest.fn().mockReturnValue({
      get: jest.fn((sessionId: string) => rows.get(sessionId)),
    }),
  };
  const db = { session: { client: sqlite } } as unknown as BetterSQLite3Database;
  return new RuntimeContextCaptureService(db, eventEmitter);
}

function report(overrides: Partial<RuntimeContextCaptureReport> = {}): RuntimeContextCaptureReport {
  return {
    sessionId: SESSION_A,
    epoch: 'epoch-a',
    sequence: 1,
    claudeSessionId: 'claude-runtime-1',
    modelId: 'claude-sonnet-4-6',
    contextWindowTokens: 1_000_000,
    ...overrides,
  };
}
