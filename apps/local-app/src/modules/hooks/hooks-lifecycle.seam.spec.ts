/**
 * End-to-end SEAM test (P3-5): proves a provider lifecycle hook event flows
 * through EVERY layer in ONE test —
 *   relay-output JSON  →  HookEventSchema.parse  →  HooksService.handleHookEvent
 *   →  published `claude.hooks.session.started`  →  TranscriptPersistenceListener
 *
 * The per-surface contracts (relay→schema, DTO→service dispatch, event→listener)
 * are each already locked by their co-located specs. This file stitches them so
 * the cross-layer payload contract cannot silently drift when the hook plumbing
 * is generalized (Copilot = HookCapability adopter #2).
 *
 * The `relay-output` fixtures below are the exact JSON shape the provider relays
 * emit after normalizing the provider payload (Claude `hooks-config.service.ts`
 * and Copilot `copilot-hooks-config.service.ts` RELAY_SCRIPT_CONTENT). The
 * relay→schema contract itself is locked by `copilot-hooks-config.service.spec.ts`,
 * which runs the REAL bash relay and validates its output against `HookEventSchema`.
 */

jest.mock('../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

// getRawSqliteClient: return the raw client we inject, so the listener can be
// constructed against a fully-mocked DB without touching better-sqlite3.
jest.mock('../storage/db/sqlite-raw', () => ({
  getRawSqliteClient: (db: { session: { client: unknown } }) => db.session.client,
}));

import { HookEventSchema, type HookEventData } from './dtos/hook-event.dto';
import { HooksService } from './services/hooks.service';
import type { EventsService } from '../events/services/events.service';
import type { PendingAskUserQuestionService } from './services/pending-ask-user-question.service';
import { TranscriptPersistenceListener } from '../session-reader/services/transcript-persistence.listener';
import type { TranscriptPathValidator } from '../session-reader/services/transcript-path-validator.service';
import type { SessionReaderAdapterFactory } from '../session-reader/adapters/session-reader-adapter.factory';
import type { StorageService } from '../storage/interfaces/storage.interface';
import type { ProviderAdapterFactory } from '../providers/adapters';
import type { ClaudeHooksSessionStartedEventPayload } from '../events/catalog/claude.hooks.session.started';

const PROJECT_ID = '11111111-1111-1111-1111-111111111111';
const AGENT_ID = '22222222-2222-2222-2222-222222222222';
const SESSION_ID = '33333333-3333-3333-3333-333333333333';
const COPILOT_TRANSCRIPT = `/home/user/.copilot/session-state/${SESSION_ID}/events.jsonl`;

// ── Relay-output fixtures ────────────────────────────────────────────────
// The normalized JSON the provider relay POSTs to /api/hooks/events.

/** Copilot SessionStart relay output (camelCase; no transcriptPath on start). */
const COPILOT_RELAY_SESSION_START = {
  hookEventName: 'SessionStart',
  providerName: 'copilot',
  providerSessionId: 'cp-sess-e2e-1',
  source: 'new',
  model: 'gpt-5-codex',
  tmuxSessionName: 'devchain-e2e',
  projectId: PROJECT_ID,
  agentId: AGENT_ID,
  sessionId: SESSION_ID,
} as const;

/** Copilot Stop (agentStop) relay output (carries transcriptPath + stopReason). */
const COPILOT_RELAY_STOP = {
  hookEventName: 'Stop',
  providerName: 'copilot',
  providerSessionId: 'cp-sess-e2e-1',
  transcriptPath: COPILOT_TRANSCRIPT,
  stopReason: 'end_turn',
  tmuxSessionName: 'devchain-e2e',
  projectId: PROJECT_ID,
  agentId: AGENT_ID,
  sessionId: SESSION_ID,
} as const;

/** Claude SessionStart relay output (snake_case already normalized; no providerName ⇒ claude). */
const CLAUDE_RELAY_SESSION_START = {
  hookEventName: 'SessionStart',
  claudeSessionId: 'claude-sess-e2e-1',
  source: 'startup',
  model: 'claude-sonnet-4-5',
  permissionMode: 'default',
  transcriptPath: '/home/user/.claude/projects/-home-user-proj/claude-sess-e2e-1.jsonl',
  tmuxSessionName: 'devchain-e2e',
  projectId: PROJECT_ID,
  agentId: AGENT_ID,
  sessionId: SESSION_ID,
} as const;

// ── Mock builders ───────────────────────────────────────────────────────

function createHooksService(serviceEvents: EventsService) {
  const storage = {
    getAgent: jest.fn().mockResolvedValue({ id: AGENT_ID, name: 'E2EAgent' }),
  };
  const pending = {
    set: jest.fn(),
    clearByToolUseId: jest.fn(),
    getBySession: jest.fn().mockReturnValue([]),
    clearBySession: jest.fn().mockReturnValue(0),
  };
  return {
    service: new HooksService(
      storage as never,
      serviceEvents,
      pending as unknown as PendingAskUserQuestionService,
    ),
    storage,
    pending,
  };
}

/** Build a fresh EventsService stub whose `publish` is a spy. */
function eventsStub(): EventsService {
  return { publish: jest.fn().mockResolvedValue('evt-id') } as unknown as EventsService;
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('Copilot lifecycle seam: relay → HookEventSchema → HooksService → listener', () => {
  let service: HooksService;
  let serviceEvents: EventsService;
  let listener: TranscriptPersistenceListener;
  let listenerEvents: EventsService;
  let validator: { validateShape: jest.Mock };
  let listenerMockGet: jest.Mock;
  let listenerMockRun: jest.Mock;

  beforeEach(() => {
    serviceEvents = eventsStub();
    listenerEvents = eventsStub();
    service = createHooksService(serviceEvents).service;

    // Listener DB: the Copilot session is already bound by Phase-1
    // (deterministic `--session-id` bind), so the hook must confirm, not rebind.
    listenerMockGet = jest.fn().mockReturnValue({
      transcript_path: COPILOT_TRANSCRIPT,
      provider_session_id: 'cp-sess-e2e-1',
    });
    listenerMockRun = jest.fn().mockReturnValue({ changes: 1 });

    // Rebuild the listener with a DB routing to the per-test mocks above.
    const db = {
      session: {
        client: {
          prepare: jest.fn((sql: string) => {
            if (sql.includes('UPDATE sessions')) return { run: listenerMockRun };
            if (sql.includes('SELECT transcript_path, provider_session_id'))
              return { get: listenerMockGet };
            return { get: jest.fn(), run: jest.fn() };
          }),
        },
      },
    };
    validator = {
      validateShape: jest.fn().mockReturnValue('/normalized/transcript.jsonl'),
    };
    listener = new TranscriptPersistenceListener(
      db as never,
      validator as unknown as TranscriptPathValidator,
      listenerEvents,
      { getAdapter: jest.fn().mockReturnValue(null) } as unknown as SessionReaderAdapterFactory,
      {} as StorageService,
      {} as unknown as ProviderAdapterFactory as never,
    );
  });

  it('flows a Copilot SessionStart end-to-end and the listener confirms idempotently (no rebind)', async () => {
    // 1. relay output → DTO schema (.strict() discriminated union)
    const parsed = HookEventSchema.parse(COPILOT_RELAY_SESSION_START) as HookEventData;
    expect(parsed.hookEventName).toBe('SessionStart');

    // 2. DTO → HooksService dispatch → publishes claude.hooks.session.started
    const result = await service.handleHookEvent(parsed);
    expect(result).toEqual({ ok: true, handled: true, data: {} });

    expect(serviceEvents.publish).toHaveBeenCalledTimes(1);
    const [eventName, published] = serviceEvents.publish.mock.calls[0];
    expect(eventName).toBe('claude.hooks.session.started');
    // The publisher mirrors providerSessionId into claudeSessionId so legacy
    // Claude subscribers keep a non-empty id.
    expect(published).toMatchObject({
      claudeSessionId: 'cp-sess-e2e-1',
      providerName: 'copilot',
      providerSessionId: 'cp-sess-e2e-1',
      source: 'new',
      model: 'gpt-5-codex',
      sessionId: SESSION_ID,
    });

    // 3. published event → listener: Copilot confirmation path (idempotent, Phase-1 owns binding)
    await listener.handleHookSessionStarted(published as ClaudeHooksSessionStartedEventPayload);

    // NEVER (re)binds and never re-discovers — Phase-1 already bound it.
    expect(listenerMockRun).not.toHaveBeenCalled();
    expect(validator.validateShape).not.toHaveBeenCalled();
    expect(listenerEvents.publish).not.toHaveBeenCalled();
  });

  it('flows a Copilot SessionStart even when Phase-1 has not yet bound (unknown session → warn, no rebind)', async () => {
    listenerMockGet.mockReturnValue(undefined); // session row absent

    const parsed = HookEventSchema.parse(COPILOT_RELAY_SESSION_START) as HookEventData;
    await service.handleHookEvent(parsed);
    const [, published] = serviceEvents.publish.mock.calls[0];

    await listener.handleHookSessionStarted(published as ClaudeHooksSessionStartedEventPayload);

    // Unknown session ⇒ warn + skip; still never rebinds.
    expect(listenerMockRun).not.toHaveBeenCalled();
    expect(listenerEvents.publish).not.toHaveBeenCalled();
  });

  it('flows a Copilot Stop through the DTO + service (handleStop is a confirmed no-op — final-metrics deferred)', async () => {
    // Per EM note + backlog feb88d1c: the agentStop→final-metrics re-read is
    // intentionally unwired. This asserts the CURRENT no-op behavior (NOT a
    // metrics re-read, which does not exist yet).
    const parsed = HookEventSchema.parse(COPILOT_RELAY_STOP) as HookEventData;
    expect(parsed.hookEventName).toBe('Stop');

    const result = await service.handleHookEvent(parsed);

    expect(result).toEqual({ ok: true, handled: false, data: {} });
    expect(serviceEvents.publish).not.toHaveBeenCalled();
  });
});

describe('Claude regression seam: the same pipeline binds the transcript FROM the hook (byte-identical path)', () => {
  let service: HooksService;
  let serviceEvents: EventsService;
  let listener: TranscriptPersistenceListener;
  let listenerEvents: EventsService;
  let validator: { validateShape: jest.Mock };
  let listenerMockRun: jest.Mock;

  beforeEach(() => {
    serviceEvents = eventsStub();
    listenerEvents = eventsStub();
    service = createHooksService(serviceEvents).service;

    const mockRun = jest.fn().mockReturnValue({ changes: 1 });
    listenerMockRun = mockRun;
    const db = {
      session: {
        client: {
          prepare: jest.fn((sql: string) => {
            if (sql.includes('UPDATE sessions')) return { run: mockRun };
            return { get: jest.fn(), run: jest.fn() };
          }),
        },
      },
    };
    validator = {
      validateShape: jest
        .fn()
        .mockReturnValue('/home/user/.claude/projects/-home-user-proj/claude-sess-e2e-1.jsonl'),
    };
    listener = new TranscriptPersistenceListener(
      db as never,
      validator as unknown as TranscriptPathValidator,
      listenerEvents,
      { getAdapter: jest.fn().mockReturnValue(null) } as unknown as SessionReaderAdapterFactory,
      {} as StorageService,
      {} as unknown as ProviderAdapterFactory as never,
    );
  });

  it('flows a Claude SessionStart and persists the transcript via the hook path (UPDATE + discovered)', async () => {
    // 1. relay output → DTO schema
    const parsed = HookEventSchema.parse(CLAUDE_RELAY_SESSION_START) as HookEventData;
    expect(parsed.hookEventName).toBe('SessionStart');

    // 2. DTO → HooksService dispatch → publishes claude.hooks.session.started
    await service.handleHookEvent(parsed);
    expect(serviceEvents.publish).toHaveBeenCalledTimes(1);
    const [eventName, published] = serviceEvents.publish.mock.calls[0];
    expect(eventName).toBe('claude.hooks.session.started');
    // Claude path: claudeSessionId is the Claude id; no providerName/providerSessionId.
    expect(published).toMatchObject({
      claudeSessionId: 'claude-sess-e2e-1',
      providerName: undefined,
      providerSessionId: undefined,
      transcriptPath: CLAUDE_RELAY_SESSION_START.transcriptPath,
    });

    // 3. published event → listener: Claude path (bind transcript FROM the hook)
    await listener.handleHookSessionStarted(published as ClaudeHooksSessionStartedEventPayload);

    // Claude binds its transcript from the hook (the original, byte-identical path).
    expect(validator.validateShape).toHaveBeenCalledWith(
      CLAUDE_RELAY_SESSION_START.transcriptPath,
      'claude',
    );
    expect(listenerMockRun).toHaveBeenCalledWith(
      '/home/user/.claude/projects/-home-user-proj/claude-sess-e2e-1.jsonl',
      'claude-sess-e2e-1',
      expect.any(String), // updated_at
      SESSION_ID,
    );
    expect(listenerEvents.publish).toHaveBeenCalledWith(
      'session.transcript.discovered',
      expect.objectContaining({
        sessionId: SESSION_ID,
        transcriptPath: '/home/user/.claude/projects/-home-user-proj/claude-sess-e2e-1.jsonl',
        providerName: 'claude',
        providerSessionId: 'claude-sess-e2e-1',
      }),
    );
  });
});
