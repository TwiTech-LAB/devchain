import { Logger } from '@nestjs/common';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import {
  TranscriptPersistenceListener,
  type PersistOutcome,
} from './transcript-persistence.listener';
import { TranscriptPathValidator } from './transcript-path-validator.service';
import { EventsService } from '../../events/services/events.service';
import { ValidationError } from '../../../common/errors/error-types';
import type { SessionReaderAdapterFactory } from '../adapters/session-reader-adapter.factory';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import type {
  SessionReaderAdapter,
  SessionFileInfo,
  TranscriptCandidateMetadata,
} from '../adapters/session-reader-adapter.interface';
import { CodexSessionReaderAdapter } from '../adapters/codex-session-reader.adapter';
import { readFileHead } from '../adapters/utils/file-search.util';
import type { ClaudeHooksSessionStartedEventPayload } from '../../events/catalog/claude.hooks.session.started';
import type { SessionStartedEventPayload } from '../../events/catalog/session.started';

jest.mock('../adapters/utils/file-search.util', () => ({
  readFileHead: jest.fn(),
}));

jest.mock('node:fs/promises', () => ({
  realpath: jest.fn(),
}));

// Real Codex metadata parser, reused so the shared adapter mock extracts
// session_meta byte-identically to production. extractCandidateMetadata parses
// content only (no pricing / fs), so a bare instance is sufficient.
const codexMetadataParser = new CodexSessionReaderAdapter(undefined as unknown as never);

const mockReadFileHead = readFileHead as jest.MockedFunction<typeof readFileHead>;
const mockRealpath = fsPromises.realpath as jest.MockedFunction<
  (filePath: string) => Promise<string>
>;
const DISCOVERY_BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000, 16_000] as const;

async function advanceDiscoveryRetryDelay(delayIndex: number): Promise<void> {
  await jest.advanceTimersByTimeAsync(DISCOVERY_BACKOFF_MS[delayIndex]);
}

async function advanceAllDiscoveryRetries(): Promise<void> {
  for (const delayMs of DISCOVERY_BACKOFF_MS) {
    await jest.advanceTimersByTimeAsync(delayMs);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockDb() {
  const mockGetTranscriptPath = jest.fn();
  const mockGetPersistRow = jest.fn();
  const mockGetStartedAt = jest.fn();
  const mockAllAssignedTranscriptPaths = jest.fn().mockReturnValue([]);
  // DB-backed exclusivity probe (excludeAssignedDbCandidates): rows already
  // owning a (transcriptPath, providerSessionId) pair. Distinct from the
  // file-backed exclusion query above — matched by the `IS NOT NULL` clause.
  const mockAllAssignedDbCandidates = jest.fn().mockReturnValue([]);
  // DB-backed uniqueness guard (persistDiscoveredPath): a conflicting session
  // id when the same (providerSessionId, transcriptPath) is already bound.
  const mockGetDbUniquenessConflict = jest.fn().mockReturnValue(undefined);
  const mockRun = jest.fn().mockReturnValue({ changes: 1 });
  const mockBeginRun = jest.fn().mockReturnValue({ changes: 0 });
  const mockCommitRun = jest.fn().mockReturnValue({ changes: 0 });
  const mockRollbackRun = jest.fn().mockReturnValue({ changes: 0 });
  const mockPrepare = jest.fn((sql: string) => {
    if (sql === 'BEGIN') {
      return { run: mockBeginRun };
    }
    if (sql === 'COMMIT') {
      return { run: mockCommitRun };
    }
    if (sql === 'ROLLBACK') {
      return { run: mockRollbackRun };
    }
    if (sql.includes('SELECT transcript_path, provider_session_id, provider_name_at_launch')) {
      return { get: mockGetPersistRow };
    }
    if (sql.includes('SELECT id, transcript_path FROM sessions')) {
      return { all: mockAllAssignedTranscriptPaths };
    }
    // DB-backed exclusivity probe — must precede the generic two-column gate
    // query (both start with `SELECT transcript_path, provider_session_id`).
    if (sql.includes('provider_session_id IS NOT NULL')) {
      return { all: mockAllAssignedDbCandidates };
    }
    if (sql.includes('SELECT transcript_path, provider_session_id')) {
      return { get: mockGetTranscriptPath };
    }
    if (sql.includes('SELECT started_at')) {
      return { get: mockGetStartedAt };
    }
    if (sql.includes('UPDATE sessions')) {
      return { run: mockRun };
    }
    // DB-backed uniqueness guard on (providerSessionId, transcriptPath).
    if (sql.includes('SELECT id FROM sessions') && sql.includes('provider_session_id = ?')) {
      return { get: mockGetDbUniquenessConflict };
    }
    return { get: jest.fn(), run: jest.fn() };
  });

  const mockDb = {
    session: { client: { prepare: mockPrepare } },
  } as unknown as BetterSQLite3Database;

  return {
    mockDb,
    mockPrepare,
    mockRun,
    mockBeginRun,
    mockCommitRun,
    mockRollbackRun,
    mockGetTranscriptPath,
    mockGetPersistRow,
    mockGetStartedAt,
    mockAllAssignedTranscriptPaths,
    mockAllAssignedDbCandidates,
    mockGetDbUniquenessConflict,
  };
}

function createMockStorage(): jest.Mocked<
  Pick<StorageService, 'getAgent' | 'getProfileProviderConfig' | 'getProvider' | 'getProject'>
> {
  return {
    getAgent: jest.fn().mockResolvedValue({
      id: 'agent-1',
      projectId: 'project-1',
      profileId: 'profile-1',
      providerConfigId: 'config-1',
      name: 'TestAgent',
      description: null,
      createdAt: '2024-01-01',
      updatedAt: '2024-01-01',
    }),
    getProfileProviderConfig: jest.fn().mockResolvedValue({
      id: 'config-1',
      profileId: 'profile-1',
      providerId: 'provider-1',
      name: 'Claude Config',
      options: null,
      env: null,
      position: 0,
    }),
    getProvider: jest.fn().mockResolvedValue({
      id: 'provider-1',
      name: 'claude',
      binPath: null,
      mcpConfigured: false,
    }),
    getProject: jest.fn().mockResolvedValue({
      id: 'project-1',
      name: 'TestProject',
      rootPath: '/home/user/my-project',
      isTemplate: false,
    }),
  };
}

function createMockAdapterFactory(
  adapter?: SessionReaderAdapter,
): jest.Mocked<Pick<SessionReaderAdapterFactory, 'getAdapter'>> {
  return {
    getAdapter: jest.fn().mockReturnValue(adapter ?? null),
  };
}

function createMockAdapter(): jest.Mocked<
  Pick<SessionReaderAdapter, 'discoverSessionFile' | 'extractCandidateMetadata'>
> {
  return {
    discoverSessionFile: jest.fn().mockResolvedValue([]),
    // The discovery pipeline sources candidate metadata through the adapter
    // seam, so the shared mock parses session_meta exactly as the real Codex
    // adapter does. Non-session_meta content yields undefined, leaving generic
    // content/short-id/timestamp matching unchanged.
    extractCandidateMetadata: jest.fn((content: string) =>
      codexMetadataParser.extractCandidateMetadata(content),
    ),
  };
}

/**
 * A DB-backed session-reader adapter mock (`sourceKind: 'db'`). The listener
 * routes DB-backed sources through `handleDbBackedDiscovery` before any file
 * strategy, so only `discoverSessionFile` + the `sourceKind` marker are needed.
 */
function createMockDbBackedAdapter(providerName: string): jest.Mocked<
  Pick<SessionReaderAdapter, 'discoverSessionFile' | 'sourceKind' | 'providerName'>
> & {
  providerName: string;
  sourceKind: 'db';
} {
  return {
    providerName,
    sourceKind: 'db',
    incrementalMode: 'snapshot',
    discoverSessionFile: jest.fn().mockResolvedValue([]),
  } as never;
}

/** OpenCode candidate: every session shares one container `opencode.db`,
 *  distinguished by its `ses_…` providerSessionId. Mirrors the real adapter
 *  shape (`opencode-session-reader.adapter.ts:87-93`). */
function opencodeCandidate(overrides: Partial<SessionFileInfo> = {}): SessionFileInfo {
  return {
    filePath: '/home/user/.local/share/opencode/opencode.db',
    providerName: 'opencode',
    providerSessionId: 'ses_01HTEST0000000000000000001',
    sizeBytes: 0,
    lastModified: '2026-02-25T10:00:00.000Z',
    ...overrides,
  };
}

/** agy candidate: one per-conversation `conversations/<convId>.db`, carrying
 *  the conversationId as `providerSessionId`. Mirrors the real adapter shape
 *  (`antigravity-session-reader.adapter.ts:98-107`). */
function agyCandidate(overrides: Partial<SessionFileInfo> = {}): SessionFileInfo {
  return {
    filePath: '/home/user/.gemini/antigravity-cli/conversations/conv-test-0001.db',
    providerName: 'agy',
    providerSessionId: 'conv-test-0001',
    sizeBytes: 0,
    lastModified: '2026-02-25T10:00:00.000Z',
    ...overrides,
  };
}

function makeFileInfo(overrides: Partial<SessionFileInfo> = {}): SessionFileInfo {
  return {
    filePath: '/home/user/.claude/projects/-home-user-my-project/abc123.jsonl',
    providerName: 'claude',
    sizeBytes: 1024,
    lastModified: new Date().toISOString(),
    ...overrides,
  };
}

function codexSessionMetaContent(overrides: {
  providerSessionId?: string;
  timestamp?: string;
  cwd?: string;
  body?: string;
}): string {
  return `${JSON.stringify({
    timestamp: overrides.timestamp ?? '2026-02-25T10:00:00.000Z',
    type: 'session_meta',
    payload: {
      id: overrides.providerSessionId ?? 'codex-session-1',
      timestamp: overrides.timestamp ?? '2026-02-25T10:00:00.000Z',
      cwd: overrides.cwd ?? '/home/user/my-project',
    },
  })}\n${overrides.body ?? ''}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TranscriptPersistenceListener', () => {
  let listener: TranscriptPersistenceListener;
  let mockValidator: jest.Mocked<Pick<TranscriptPathValidator, 'validateShape'>>;
  let mockEvents: jest.Mocked<Pick<EventsService, 'publish'>>;
  let mockRun: jest.Mock;
  let mockGetTranscriptPath: jest.Mock;
  let mockGetPersistRow: jest.Mock;
  let mockGetStartedAt: jest.Mock;
  let mockAllAssignedTranscriptPaths: jest.Mock;
  let mockAllAssignedDbCandidates: jest.Mock;
  let mockGetDbUniquenessConflict: jest.Mock;
  let mockPrepare: jest.Mock;
  let mockStorage: ReturnType<typeof createMockStorage>;
  let mockAdapterFactory: ReturnType<typeof createMockAdapterFactory>;

  const hookPayload: ClaudeHooksSessionStartedEventPayload = {
    claudeSessionId: 'claude-sess-123',
    source: 'startup',
    model: 'claude-sonnet-4-6',
    transcriptPath: '/home/user/.claude/projects/my-proj/session.jsonl',
    tmuxSessionName: 'agent-session',
    projectId: '11111111-1111-1111-1111-111111111111',
    agentId: '22222222-2222-2222-2222-222222222222',
    sessionId: '33333333-3333-3333-3333-333333333333',
  };

  const sessionStartedPayload: SessionStartedEventPayload = {
    sessionId: '33333333-3333-3333-3333-333333333333',
    projectId: '11111111-1111-1111-1111-111111111111',
    epicId: null,
    agentId: '22222222-2222-2222-2222-222222222222',
    tmuxSessionName: 'agent-session',
  };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.resetAllMocks();
    mockReadFileHead.mockResolvedValue('');

    const db = createMockDb();
    mockPrepare = db.mockPrepare;
    mockRun = db.mockRun;
    mockGetTranscriptPath = db.mockGetTranscriptPath;
    mockGetPersistRow = db.mockGetPersistRow;
    mockGetStartedAt = db.mockGetStartedAt;
    mockAllAssignedTranscriptPaths = db.mockAllAssignedTranscriptPaths;
    mockAllAssignedDbCandidates = db.mockAllAssignedDbCandidates;
    mockGetDbUniquenessConflict = db.mockGetDbUniquenessConflict;
    mockRealpath.mockImplementation(async (filePath: string) => filePath);

    mockValidator = {
      validateShape: jest.fn().mockReturnValue('/normalized/path/session.jsonl'),
    };

    mockEvents = {
      publish: jest.fn().mockResolvedValue('event-id'),
    };

    mockGetTranscriptPath.mockReturnValue({
      transcript_path: null,
      provider_session_id: null,
    });
    mockGetPersistRow.mockReturnValue({
      transcript_path: null,
      provider_session_id: null,
      provider_name_at_launch: 'claude',
    });

    mockStorage = createMockStorage();
    mockAdapterFactory = createMockAdapterFactory();

    const mockProviderAdapterFactory = {
      getAdapter: jest.fn().mockImplementation((name: string) => {
        if (name === 'claude') {
          return {
            providerName: 'claude',
            hooksEnabled: true,
            hooksProvideTranscriptPath: true,
            transcriptDiscoveryStrategy: 'first',
            transcriptContentSearchMaxBytes: 16_384,
            providerSessionIdRequiredForRestore: false,
          };
        }
        if (name === 'copilot') {
          return {
            providerName: 'copilot',
            hooksEnabled: true,
            hooksProvideTranscriptPath: false,
          };
        }
        if (name === 'acme') {
          return {
            providerName: 'acme',
            hooksEnabled: true,
            hooksProvideTranscriptPath: true,
          };
        }
        if (name === 'codex') {
          return {
            providerName: 'codex',
            transcriptDiscoveryStrategy: 'all',
            transcriptContentSearchMaxBytes: 65_536,
            contentMatchMaxCandidates: 200,
            providerSessionIdRequiredForRestore: true,
          };
        }
        if (name === 'agy') {
          return {
            providerName: 'agy',
            transcriptDiscoveryStrategy: 'all',
            transcriptContentSearchMaxBytes: 32_768,
            providerSessionIdRequiredForRestore: true,
          };
        }
        return { providerName: name };
      }),
    };

    listener = new TranscriptPersistenceListener(
      db.mockDb,
      mockValidator as unknown as TranscriptPathValidator,
      mockEvents as unknown as EventsService,
      mockAdapterFactory as unknown as SessionReaderAdapterFactory,
      mockStorage as unknown as StorageService,
      mockProviderAdapterFactory as unknown as never,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Hook-based discovery (existing tests, updated method name)
  // -------------------------------------------------------------------------

  describe('handleHookSessionStarted', () => {
    it('should persist transcript path and publish discovery event', async () => {
      await listener.handleHookSessionStarted(hookPayload);

      expect(mockValidator.validateShape).toHaveBeenCalledWith(
        hookPayload.transcriptPath,
        'claude',
      );
      expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('UPDATE sessions'));
      expect(mockRun).toHaveBeenCalledWith(
        '/normalized/path/session.jsonl',
        'claude-sess-123',
        expect.any(String), // updated_at
        '33333333-3333-3333-3333-333333333333',
      );
      expect(mockEvents.publish).toHaveBeenCalledWith('session.transcript.discovered', {
        sessionId: '33333333-3333-3333-3333-333333333333',
        agentId: '22222222-2222-2222-2222-222222222222',
        projectId: '11111111-1111-1111-1111-111111111111',
        transcriptPath: '/normalized/path/session.jsonl',
        providerName: 'claude',
        providerSessionId: 'claude-sess-123',
      });
    });

    it('should skip when transcriptPath is missing', async () => {
      const payload = { ...hookPayload, transcriptPath: undefined };

      await listener.handleHookSessionStarted(payload);

      expect(mockValidator.validateShape).not.toHaveBeenCalled();
      expect(mockPrepare).not.toHaveBeenCalled();
      expect(mockEvents.publish).not.toHaveBeenCalled();
    });

    it('should skip when sessionId is null', async () => {
      const payload = { ...hookPayload, sessionId: null };

      await listener.handleHookSessionStarted(payload);

      expect(mockValidator.validateShape).not.toHaveBeenCalled();
      expect(mockPrepare).not.toHaveBeenCalled();
      expect(mockEvents.publish).not.toHaveBeenCalled();
    });

    it('should skip persistence when path validation fails', async () => {
      mockValidator.validateShape.mockImplementation(() => {
        throw new ValidationError('path outside allowed root');
      });

      await listener.handleHookSessionStarted(hookPayload);

      expect(mockValidator.validateShape).toHaveBeenCalled();
      expect(mockPrepare).not.toHaveBeenCalled();
      expect(mockEvents.publish).not.toHaveBeenCalled();
    });

    it('should handle session not found gracefully (0 changes)', async () => {
      mockRun.mockReturnValue({ changes: 0 });

      await listener.handleHookSessionStarted(hookPayload);

      expect(mockPrepare).toHaveBeenCalled();
      expect(mockRun).toHaveBeenCalled();
      expect(mockEvents.publish).not.toHaveBeenCalled();
    });

    it('should skip discovery event when agentId is null', async () => {
      const payload = { ...hookPayload, agentId: null };

      await listener.handleHookSessionStarted(payload);

      expect(mockPrepare).toHaveBeenCalled();
      expect(mockRun).toHaveBeenCalled();
      expect(mockEvents.publish).not.toHaveBeenCalled();
    });

    it('should not propagate errors from DB update', async () => {
      mockRun.mockImplementation(() => {
        throw new Error('SQLITE_BUSY');
      });

      await expect(listener.handleHookSessionStarted(hookPayload)).resolves.not.toThrow();
    });

    it('should not propagate errors from event publishing', async () => {
      mockEvents.publish.mockRejectedValue(new Error('Event bus down'));

      await expect(listener.handleHookSessionStarted(hookPayload)).resolves.not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Copilot hook lifecycle CONFIRMATION (HookCapability adopter #2)
  // Phase-1 owns binding; the hook never (re)binds — it confirms + warns.
  // -------------------------------------------------------------------------

  describe('handleHookSessionStarted — Copilot confirmation path', () => {
    const SID = '33333333-3333-3333-3333-333333333333';
    const COPILOT_TRANSCRIPT = '/home/user/.copilot/session-state/33333333/events.jsonl';

    const copilotSessionStart: ClaudeHooksSessionStartedEventPayload = {
      // Publisher mirrors providerSessionId into claudeSessionId (P3-2 bridge).
      claudeSessionId: 'copilot-sess-1',
      providerName: 'copilot',
      providerSessionId: 'copilot-sess-1',
      source: 'new',
      tmuxSessionName: 'agent-session',
      projectId: '11111111-1111-1111-1111-111111111111',
      agentId: '22222222-2222-2222-2222-222222222222',
      sessionId: SID,
      // NOTE: Copilot SessionStart carries NO transcriptPath.
    };

    it('confirms (idempotent no-op) when the bound provider_session_id matches — no overwrite, no publish', async () => {
      mockGetTranscriptPath.mockReturnValue({
        transcript_path: COPILOT_TRANSCRIPT,
        provider_session_id: 'copilot-sess-1',
      });

      await listener.handleHookSessionStarted(copilotSessionStart);

      // Never (re)binds and never re-discovers — Phase-1 already bound it.
      expect(mockRun).not.toHaveBeenCalled();
      expect(mockValidator.validateShape).not.toHaveBeenCalled();
      expect(mockEvents.publish).not.toHaveBeenCalled();
    });

    it('WARNS on provider_session_id mismatch and does NOT overwrite the bound session', async () => {
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      mockGetTranscriptPath.mockReturnValue({
        transcript_path: COPILOT_TRANSCRIPT,
        provider_session_id: 'a-different-bound-id',
      });

      try {
        await listener.handleHookSessionStarted(copilotSessionStart);

        expect(warnSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionId: SID,
            providerName: 'copilot',
            bound: 'a-different-bound-id',
            incoming: 'copilot-sess-1',
          }),
          expect.stringContaining('provider_session_id mismatch'),
        );
        expect(mockRun).not.toHaveBeenCalled();
        expect(mockEvents.publish).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('WARNS on transcript_path mismatch when a Stop hook carries a divergent path', async () => {
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      mockGetTranscriptPath.mockReturnValue({
        transcript_path: COPILOT_TRANSCRIPT,
        provider_session_id: 'copilot-sess-1',
      });
      const stopHook: ClaudeHooksSessionStartedEventPayload = {
        ...copilotSessionStart,
        transcriptPath: '/home/user/.copilot/session-state/OTHER/events.jsonl',
      };

      try {
        await listener.handleHookSessionStarted(stopHook);

        expect(warnSpy).toHaveBeenCalledWith(
          expect.objectContaining({ sessionId: SID, providerName: 'copilot' }),
          expect.stringContaining('transcript_path mismatch'),
        );
        expect(mockRun).not.toHaveBeenCalled();
        expect(mockEvents.publish).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('WARNS and skips when the session is unknown (no rebind)', async () => {
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      mockGetTranscriptPath.mockReturnValue(undefined);

      try {
        await listener.handleHookSessionStarted(copilotSessionStart);

        expect(warnSpy).toHaveBeenCalledWith(
          expect.objectContaining({ sessionId: SID, providerName: 'copilot' }),
          expect.stringContaining('unknown session'),
        );
        expect(mockRun).not.toHaveBeenCalled();
        expect(mockEvents.publish).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('never runs the Claude hook-binding UPDATE for Copilot, even with a transcriptPath present', async () => {
      // Regression guard: the provider branch must short-circuit BEFORE the
      // Claude path's validateShape + UPDATE, so a Copilot hook can never
      // overwrite a deterministically-bound session.
      mockGetTranscriptPath.mockReturnValue({
        transcript_path: COPILOT_TRANSCRIPT,
        provider_session_id: 'copilot-sess-1',
      });
      const stopHookMatching: ClaudeHooksSessionStartedEventPayload = {
        ...copilotSessionStart,
        transcriptPath: COPILOT_TRANSCRIPT,
      };

      await listener.handleHookSessionStarted(stopHookMatching);

      expect(mockValidator.validateShape).not.toHaveBeenCalled();
      expect(mockRun).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Legacy-default characterization: absent providerName → 'claude' → bind.
  // Locks the fail-safe contract so the generic capability lookup can never
  // accidentally change the legacy Claude path.
  // -------------------------------------------------------------------------

  describe('handleHookSessionStarted — legacy-default characterization', () => {
    it('absent providerName binds with identical validation root, DB writes, and event payload as pre-generic', async () => {
      const legacyPayload: ClaudeHooksSessionStartedEventPayload = {
        claudeSessionId: 'claude-sess-123',
        source: 'startup',
        transcriptPath: '/home/user/.claude/projects/my-proj/session.jsonl',
        tmuxSessionName: 'agent-session',
        projectId: '11111111-1111-1111-1111-111111111111',
        agentId: '22222222-2222-2222-2222-222222222222',
        sessionId: '33333333-3333-3333-3333-333333333333',
        // providerName deliberately absent → defaults to 'claude'
      };

      await listener.handleHookSessionStarted(legacyPayload);

      // Validation uses the resolved provider name ('claude'), not a hardcode.
      expect(mockValidator.validateShape).toHaveBeenCalledWith(
        legacyPayload.transcriptPath,
        'claude',
      );
      // DB write uses claudeSessionId (providerSessionId absent → fallback).
      expect(mockRun).toHaveBeenCalledWith(
        '/normalized/path/session.jsonl',
        'claude-sess-123',
        expect.any(String),
        '33333333-3333-3333-3333-333333333333',
      );
      // Event carries the resolved provider name, not a hardcode.
      expect(mockEvents.publish).toHaveBeenCalledWith(
        'session.transcript.discovered',
        expect.objectContaining({
          providerName: 'claude',
          providerSessionId: 'claude-sess-123',
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Fake-adapter proof: a hypothetical hook-capable provider with
  // hooksProvideTranscriptPath=true binds through the generic path with
  // ZERO listener edits — the capability lookup does all the work.
  // -------------------------------------------------------------------------

  describe('handleHookSessionStarted — generic bind proof (fake hook-capable provider)', () => {
    it('a provider with hooksProvideTranscriptPath=true binds via the generic capability path', async () => {
      const acmePayload: ClaudeHooksSessionStartedEventPayload = {
        claudeSessionId: 'acme-sess-1',
        providerName: 'acme',
        providerSessionId: 'acme-sess-1',
        source: 'startup',
        transcriptPath: '/home/user/.acme/sessions/session.jsonl',
        tmuxSessionName: 'agent-session',
        projectId: '11111111-1111-1111-1111-111111111111',
        agentId: '22222222-2222-2222-2222-222222222222',
        sessionId: '33333333-3333-3333-3333-333333333333',
      };

      await listener.handleHookSessionStarted(acmePayload);

      expect(mockValidator.validateShape).toHaveBeenCalledWith(acmePayload.transcriptPath, 'acme');
      expect(mockRun).toHaveBeenCalledWith(
        '/normalized/path/session.jsonl',
        'acme-sess-1',
        expect.any(String),
        '33333333-3333-3333-3333-333333333333',
      );
      expect(mockEvents.publish).toHaveBeenCalledWith(
        'session.transcript.discovered',
        expect.objectContaining({
          providerName: 'acme',
          providerSessionId: 'acme-sess-1',
        }),
      );
    });
  });

  describe('persistDiscoveredPath outcomes', () => {
    async function persistDiscoveredPath(
      fileOverrides: Partial<SessionFileInfo>,
      providerName = 'codex',
    ): Promise<PersistOutcome> {
      return (
        listener as unknown as {
          persistDiscoveredPath: (
            sessionId: string,
            agentId: string,
            projectId: string,
            file: SessionFileInfo,
            providerName: string,
          ) => Promise<PersistOutcome>;
        }
      ).persistDiscoveredPath(
        sessionStartedPayload.sessionId,
        sessionStartedPayload.agentId,
        'project-1',
        makeFileInfo({ providerName, ...fileOverrides }),
        providerName,
      );
    }

    it('returns persisted when Case A writes transcript path and provider id', async () => {
      mockGetPersistRow.mockReturnValue({
        transcript_path: null,
        provider_session_id: null,
        provider_name_at_launch: 'codex',
      });

      const outcome = await persistDiscoveredPath({ providerSessionId: 'codex-session-1' });

      expect(outcome).toEqual({ kind: 'persisted', sessionId: sessionStartedPayload.sessionId });
      expect(mockRun).toHaveBeenCalledWith(
        '/normalized/path/session.jsonl',
        'codex-session-1',
        expect.any(String),
        sessionStartedPayload.sessionId,
      );
      expect(mockEvents.publish).toHaveBeenCalledWith('session.transcript.discovered', {
        sessionId: sessionStartedPayload.sessionId,
        agentId: sessionStartedPayload.agentId,
        projectId: 'project-1',
        transcriptPath: '/normalized/path/session.jsonl',
        providerName: 'codex',
        // Regression: the discovered event MUST carry providerSessionId on the
        // persisted-both success path, or DB-backed watchers skip startup
        // (transcript-watcher.service.ts: DB sources require providerSessionId).
        providerSessionId: 'codex-session-1',
      });
    });

    it('returns persistedPathOnly when Case A writes a Codex path before the id is available', async () => {
      mockGetPersistRow.mockReturnValue({
        transcript_path: null,
        provider_session_id: null,
        provider_name_at_launch: 'codex',
      });

      const outcome = await persistDiscoveredPath({});

      expect(outcome).toEqual({
        kind: 'persistedPathOnly',
        sessionId: sessionStartedPayload.sessionId,
      });
      expect(mockRun).toHaveBeenCalledWith(
        '/normalized/path/session.jsonl',
        null,
        expect.any(String),
        sessionStartedPayload.sessionId,
      );
      expect(mockEvents.publish).toHaveBeenCalledWith('session.transcript.discovered', {
        sessionId: sessionStartedPayload.sessionId,
        agentId: sessionStartedPayload.agentId,
        projectId: 'project-1',
        transcriptPath: '/normalized/path/session.jsonl',
        providerName: 'codex',
      });
      expect(mockEvents.publish).not.toHaveBeenCalledWith(
        'session.providerSessionId.discovered',
        expect.anything(),
      );
    });

    it('returns backfilledId and emits providerSessionId.discovered for Case B id repair', async () => {
      mockGetPersistRow.mockReturnValue({
        transcript_path: '/normalized/path/session.jsonl',
        provider_session_id: null,
        provider_name_at_launch: 'codex',
      });

      const outcome = await persistDiscoveredPath({ providerSessionId: 'codex-session-1' });

      expect(outcome).toEqual({
        kind: 'backfilledId',
        sessionId: sessionStartedPayload.sessionId,
      });
      expect(mockRun).toHaveBeenCalledWith(
        'codex-session-1',
        expect.any(String),
        sessionStartedPayload.sessionId,
      );
      expect(mockEvents.publish).toHaveBeenCalledWith('session.providerSessionId.discovered', {
        sessionId: sessionStartedPayload.sessionId,
        providerSessionId: 'codex-session-1',
        providerName: 'codex',
      });
    });

    it('supports silent Case B id repair without emitting providerSessionId.discovered', async () => {
      mockGetPersistRow.mockReturnValue({
        transcript_path: '/normalized/path/session.jsonl',
        provider_session_id: null,
        provider_name_at_launch: 'codex',
      });

      const outcome = await listener.backfillProviderSessionIdForTranscriptPath({
        sessionId: sessionStartedPayload.sessionId,
        providerName: 'codex',
        transcriptPath: '/normalized/path/session.jsonl',
        providerSessionId: 'codex-session-1',
        emitEvent: false,
      });

      expect(outcome).toEqual({
        kind: 'backfilledId',
        sessionId: sessionStartedPayload.sessionId,
      });
      expect(mockRun).toHaveBeenCalledWith(
        'codex-session-1',
        expect.any(String),
        sessionStartedPayload.sessionId,
      );
      expect(mockEvents.publish).not.toHaveBeenCalled();
    });

    it('returns alreadyComplete when the matching row already has both fields', async () => {
      mockGetPersistRow.mockReturnValue({
        transcript_path: '/normalized/path/session.jsonl',
        provider_session_id: 'codex-session-1',
        provider_name_at_launch: 'codex',
      });

      const outcome = await persistDiscoveredPath({ providerSessionId: 'codex-session-1' });

      expect(outcome).toEqual({
        kind: 'alreadyComplete',
        sessionId: sessionStartedPayload.sessionId,
      });
      expect(mockRun).not.toHaveBeenCalled();
      expect(mockEvents.publish).not.toHaveBeenCalled();
    });

    it('returns pathMismatch when the existing path differs after normalization', async () => {
      mockGetPersistRow.mockReturnValue({
        transcript_path: '/different/path/session.jsonl',
        provider_session_id: null,
        provider_name_at_launch: 'codex',
      });

      const outcome = await persistDiscoveredPath({ providerSessionId: 'codex-session-1' });

      expect(outcome).toEqual({
        kind: 'pathMismatch',
        sessionId: sessionStartedPayload.sessionId,
        existing: '/different/path/session.jsonl',
        incoming: '/normalized/path/session.jsonl',
      });
      expect(mockRun).not.toHaveBeenCalled();
      expect(mockEvents.publish).not.toHaveBeenCalled();
    });

    it('returns skipped providerMismatch instead of cross-provider id backfill', async () => {
      mockGetPersistRow.mockReturnValue({
        transcript_path: '/normalized/path/session.jsonl',
        provider_session_id: null,
        provider_name_at_launch: 'claude',
      });

      const outcome = await persistDiscoveredPath({ providerSessionId: 'codex-session-1' });

      expect(outcome).toEqual({
        kind: 'skipped',
        sessionId: sessionStartedPayload.sessionId,
        reason: 'providerMismatch',
      });
      expect(mockRun).not.toHaveBeenCalled();
      expect(mockEvents.publish).not.toHaveBeenCalled();
    });

    it('documents Claude Case B as skipped because Claude ids come from hook payloads', async () => {
      mockGetPersistRow.mockReturnValue({
        transcript_path: '/normalized/path/session.jsonl',
        provider_session_id: null,
        provider_name_at_launch: 'claude',
      });

      const outcome = await persistDiscoveredPath({}, 'claude');

      expect(outcome).toEqual({
        kind: 'skipped',
        sessionId: sessionStartedPayload.sessionId,
        reason: 'noIdAvailable',
      });
      expect(mockRun).not.toHaveBeenCalled();
      expect(mockEvents.publish).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Auto-discovery on session launch
  // -------------------------------------------------------------------------

  describe('handleSessionStarted (auto-discovery)', () => {
    let mockAdapter: ReturnType<typeof createMockAdapter>;

    beforeEach(() => {
      mockAdapter = createMockAdapter();
      mockAdapterFactory.getAdapter.mockReturnValue(mockAdapter as unknown as SessionReaderAdapter);
      // By default: session has no transcript_path yet
      mockGetTranscriptPath.mockReturnValue({
        transcript_path: null,
        provider_session_id: null,
      });
      mockGetStartedAt.mockReturnValue({ started_at: null });
    });

    it('should discover transcript and persist on first attempt', async () => {
      mockAdapter.discoverSessionFile.mockResolvedValue([makeFileInfo()]);

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      await promise;

      expect(mockStorage.getAgent).toHaveBeenCalledWith(sessionStartedPayload.agentId);
      expect(mockStorage.getProfileProviderConfig).toHaveBeenCalledWith('config-1');
      expect(mockStorage.getProvider).toHaveBeenCalledWith('provider-1');
      expect(mockStorage.getProject).toHaveBeenCalledWith('project-1');

      // File adapters now also receive `sessionId` in the discovery context
      // (backward-compatible widening for deterministic-binding adapters like
      // Copilot). Claude/Codex ignore it — behavior is unchanged.
      expect(mockAdapter.discoverSessionFile).toHaveBeenCalledWith({
        projectRoot: '/home/user/my-project',
        sessionId: sessionStartedPayload.sessionId,
      });
      expect(mockAdapter.discoverSessionFile).toHaveBeenCalledTimes(1);

      expect(mockValidator.validateShape).toHaveBeenCalledWith(
        '/home/user/.claude/projects/-home-user-my-project/abc123.jsonl',
        'claude',
      );

      expect(mockPrepare).toHaveBeenCalledWith('BEGIN');
      expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('provider_name_at_launch'));
      expect(mockRun).toHaveBeenCalledWith(
        '/normalized/path/session.jsonl',
        null,
        expect.any(String),
        sessionStartedPayload.sessionId,
      );

      // Should emit discovery event
      expect(mockEvents.publish).toHaveBeenCalledWith('session.transcript.discovered', {
        sessionId: sessionStartedPayload.sessionId,
        agentId: sessionStartedPayload.agentId,
        projectId: 'project-1',
        transcriptPath: '/normalized/path/session.jsonl',
        providerName: 'claude',
      });
      expect(mockReadFileHead).not.toHaveBeenCalled();
    });

    it('should match non-Claude transcript by full session UUID content', async () => {
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'codex',
        binPath: null,
        mcpConfigured: false,
      });

      const codexFile = makeFileInfo({
        filePath: '/home/user/.codex/sessions/2026/02/25/rollout-a.jsonl',
        providerName: 'codex',
        providerSessionId: 'codex-session-1',
      });
      mockAdapter.discoverSessionFile.mockResolvedValue([codexFile]);
      mockReadFileHead.mockResolvedValue(
        `{"type":"session_meta","payload":{"id":"abc"},"session":"${sessionStartedPayload.sessionId}"}`,
      );

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      await promise;

      expect(mockReadFileHead).toHaveBeenCalledWith(codexFile.filePath, 65_536);
      expect(mockValidator.validateShape).toHaveBeenCalledWith(codexFile.filePath, 'codex');
      expect(mockEvents.publish).toHaveBeenCalledWith(
        'session.transcript.discovered',
        expect.objectContaining({
          providerName: 'codex',
        }),
      );
    });

    it('should capture Codex rollout that appears after a 12s cold start', async () => {
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'codex',
        binPath: null,
        mcpConfigured: false,
      });
      const startedAtMs = Date.now();
      const codexFile = makeFileInfo({
        filePath: '/home/user/.codex/sessions/2026/02/25/rollout-cold-start.jsonl',
        providerName: 'codex',
        providerSessionId: 'codex-session-1',
      });
      mockAdapter.discoverSessionFile.mockImplementation(async () =>
        Date.now() - startedAtMs >= 12_000 ? [codexFile] : [],
      );
      mockReadFileHead.mockResolvedValue(`session=${sessionStartedPayload.sessionId}`);

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      await advanceAllDiscoveryRetries();
      await promise;

      expect(mockAdapter.discoverSessionFile).toHaveBeenCalledTimes(6);
      expect(mockValidator.validateShape).toHaveBeenCalledWith(codexFile.filePath, 'codex');
    });

    it('should content-match Codex session IDs beyond 16KB but within the 64KB head', async () => {
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'codex',
        binPath: null,
        mcpConfigured: false,
      });
      const codexFile = makeFileInfo({
        filePath: '/home/user/.codex/sessions/2026/02/25/rollout-large-head.jsonl',
        providerName: 'codex',
        providerSessionId: 'codex-session-1',
      });
      mockAdapter.discoverSessionFile.mockResolvedValue([codexFile]);
      mockReadFileHead.mockResolvedValue(`${'x'.repeat(40_000)}${sessionStartedPayload.sessionId}`);

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      await promise;

      expect(mockReadFileHead).toHaveBeenCalledWith(codexFile.filePath, 65_536);
      expect(mockValidator.validateShape).toHaveBeenCalledWith(codexFile.filePath, 'codex');
    });

    it('should scan up to the Codex 200-candidate cap', async () => {
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'codex',
        binPath: null,
        mcpConfigured: false,
      });
      const files = Array.from({ length: 150 }, (_, index) =>
        makeFileInfo({
          filePath: `/tmp/codex-${index}.jsonl`,
          providerName: 'codex',
          providerSessionId: `codex-session-${index}`,
        }),
      );
      mockAdapter.discoverSessionFile.mockResolvedValue(files);
      mockReadFileHead.mockImplementation(async (filePath: string) =>
        filePath === '/tmp/codex-149.jsonl'
          ? `session=${sessionStartedPayload.sessionId}`
          : 'different session',
      );

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      await promise;

      expect(mockReadFileHead).toHaveBeenCalledTimes(150);
      expect(mockValidator.validateShape).toHaveBeenCalledWith('/tmp/codex-149.jsonl', 'codex');
    });

    it('should use the 200-candidate fallback when a provider has no candidate cap override', async () => {
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'custom',
        binPath: null,
        mcpConfigured: false,
      });
      const files = Array.from({ length: 201 }, (_, index) =>
        makeFileInfo({
          filePath: `/tmp/custom-${index}.jsonl`,
          providerName: 'custom',
        }),
      );
      mockAdapter.discoverSessionFile.mockResolvedValue(files);
      mockReadFileHead.mockImplementation(async (filePath: string) =>
        filePath === '/tmp/custom-199.jsonl'
          ? `session=${sessionStartedPayload.sessionId}`
          : 'different session',
      );

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      await promise;

      expect(mockReadFileHead).toHaveBeenCalledTimes(200);
      expect(mockReadFileHead).not.toHaveBeenCalledWith('/tmp/custom-200.jsonl', expect.anything());
      expect(mockValidator.validateShape).toHaveBeenCalledWith('/tmp/custom-199.jsonl', 'custom');
    });

    it('should log full UUID content matches with matchType content', async () => {
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'codex',
        binPath: null,
        mcpConfigured: false,
      });
      const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
      const codexFile = makeFileInfo({
        filePath: '/home/user/.codex/sessions/2026/02/25/rollout-match.jsonl',
        providerName: 'codex',
        providerSessionId: 'codex-session-1',
      });
      mockAdapter.discoverSessionFile.mockResolvedValue([codexFile]);
      mockReadFileHead.mockResolvedValue(`session=${sessionStartedPayload.sessionId}`);

      try {
        const promise = listener.handleSessionStarted(sessionStartedPayload);
        await jest.advanceTimersByTimeAsync(0);
        await promise;

        expect(logSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionId: sessionStartedPayload.sessionId,
            providerName: 'codex',
            filePath: codexFile.filePath,
            matchType: 'content',
          }),
          'Auto-discovered transcript via content match',
        );
      } finally {
        logSpy.mockRestore();
      }
    });

    it('should discover Codex transcript by session_meta metadata without session UUID content', async () => {
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'codex',
        binPath: null,
        mcpConfigured: false,
      });
      mockGetPersistRow.mockReturnValue({
        transcript_path: null,
        provider_session_id: null,
        provider_name_at_launch: 'codex',
      });
      mockGetStartedAt.mockReturnValue({ started_at: '2026-02-25T10:00:05.000Z' });
      const codexFile = makeFileInfo({
        filePath: '/home/user/.codex/sessions/2026/02/25/rollout-metadata.jsonl',
        providerName: 'codex',
      });
      mockAdapter.discoverSessionFile.mockResolvedValue([codexFile]);
      mockReadFileHead.mockResolvedValue(
        codexSessionMetaContent({
          providerSessionId: 'codex-session-from-meta',
          timestamp: '2026-02-25T10:00:00.000Z',
        }),
      );

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      await promise;

      expect(mockValidator.validateShape).toHaveBeenCalledWith(codexFile.filePath, 'codex');
      expect(mockRun).toHaveBeenCalledWith(
        '/normalized/path/session.jsonl',
        'codex-session-from-meta',
        expect.any(String),
        sessionStartedPayload.sessionId,
      );
      expect(mockReadFileHead).toHaveBeenCalledTimes(1);
    });

    it('should use content to break ambiguous Codex metadata matches', async () => {
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'codex',
        binPath: null,
        mcpConfigured: false,
      });
      const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
      mockGetStartedAt.mockReturnValue({ started_at: '2026-02-25T10:00:00.000Z' });
      const files = [
        makeFileInfo({
          filePath: '/tmp/codex-a.jsonl',
          providerName: 'codex',
        }),
        makeFileInfo({
          filePath: '/tmp/codex-b.jsonl',
          providerName: 'codex',
        }),
      ];
      mockAdapter.discoverSessionFile.mockResolvedValue(files);
      mockReadFileHead.mockImplementation(async (filePath: string) =>
        filePath === '/tmp/codex-a.jsonl'
          ? codexSessionMetaContent({
              providerSessionId: 'codex-a',
              timestamp: '2026-02-25T10:00:01.000Z',
            })
          : codexSessionMetaContent({
              providerSessionId: 'codex-b',
              timestamp: '2026-02-25T10:00:02.000Z',
              body: `session=${sessionStartedPayload.sessionId}`,
            }),
      );

      try {
        const promise = listener.handleSessionStarted(sessionStartedPayload);
        await jest.advanceTimersByTimeAsync(0);
        await promise;

        expect(mockValidator.validateShape).toHaveBeenCalledWith('/tmp/codex-b.jsonl', 'codex');
        expect(logSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            filePath: '/tmp/codex-b.jsonl',
            matchType: 'metadata+content',
          }),
          'Auto-discovered transcript via Codex metadata match',
        );
      } finally {
        logSpy.mockRestore();
      }
    });

    it('should fall through to content match when Codex metadata cwd misses project root', async () => {
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'codex',
        binPath: null,
        mcpConfigured: false,
      });
      const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
      mockGetStartedAt.mockReturnValue({ started_at: '2026-02-25T10:00:00.000Z' });
      const codexFile = makeFileInfo({
        filePath: '/tmp/codex-content.jsonl',
        providerName: 'codex',
      });
      mockAdapter.discoverSessionFile.mockResolvedValue([codexFile]);
      mockReadFileHead.mockResolvedValue(
        codexSessionMetaContent({
          providerSessionId: 'codex-content',
          timestamp: '2026-02-25T10:00:01.000Z',
          cwd: '/home/user/other-project',
          body: `session=${sessionStartedPayload.sessionId}`,
        }),
      );

      try {
        const promise = listener.handleSessionStarted(sessionStartedPayload);
        await jest.advanceTimersByTimeAsync(0);
        await promise;

        expect(mockValidator.validateShape).toHaveBeenCalledWith(codexFile.filePath, 'codex');
        expect(logSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            filePath: codexFile.filePath,
            matchType: 'content',
          }),
          'Auto-discovered transcript via content match',
        );
      } finally {
        logSpy.mockRestore();
      }
    });

    it('should disambiguate Codex agents in different project roots by realpath cwd', async () => {
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'codex',
        binPath: null,
        mcpConfigured: false,
      });
      mockGetStartedAt.mockReturnValue({ started_at: '2026-02-25T10:00:00.000Z' });
      const files = [
        makeFileInfo({
          filePath: '/tmp/wrong-project.jsonl',
          providerName: 'codex',
        }),
        makeFileInfo({
          filePath: '/tmp/right-project.jsonl',
          providerName: 'codex',
        }),
      ];
      mockAdapter.discoverSessionFile.mockResolvedValue(files);
      mockReadFileHead.mockImplementation(async (filePath: string) =>
        filePath === '/tmp/wrong-project.jsonl'
          ? codexSessionMetaContent({
              providerSessionId: 'codex-wrong',
              timestamp: '2026-02-25T10:00:01.000Z',
              cwd: '/home/user/other-project',
            })
          : codexSessionMetaContent({
              providerSessionId: 'codex-right',
              timestamp: '2026-02-25T10:00:02.000Z',
              cwd: '/home/user/my-project',
            }),
      );

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      await promise;

      expect(mockValidator.validateShape).toHaveBeenCalledWith('/tmp/right-project.jsonl', 'codex');
      expect(mockValidator.validateShape).not.toHaveBeenCalledWith(
        '/tmp/wrong-project.jsonl',
        'codex',
      );
    });

    it('should not metadata-match partially flushed Codex candidates without providerSessionId', async () => {
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'codex',
        binPath: null,
        mcpConfigured: false,
      });
      mockGetStartedAt.mockReturnValue({ started_at: '2026-02-25T10:00:00.000Z' });
      mockAdapter.discoverSessionFile.mockResolvedValue([
        makeFileInfo({ filePath: '/tmp/partial.jsonl', providerName: 'codex' }),
      ]);
      mockReadFileHead.mockResolvedValue('{"type":"session_meta","payload":{"cwd":');

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      await advanceAllDiscoveryRetries();
      await promise;

      expect(mockEvents.publish).not.toHaveBeenCalled();
      expect(mockValidator.validateShape).not.toHaveBeenCalled();
    });

    it('should exclude Codex candidates already assigned to another session', async () => {
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'codex',
        binPath: null,
        mcpConfigured: false,
      });
      mockGetStartedAt.mockReturnValue({ started_at: '2026-02-25T10:00:00.000Z' });
      mockAllAssignedTranscriptPaths.mockReturnValue([
        { id: 'other-session', transcript_path: '/tmp/already-assigned.jsonl' },
      ]);
      mockAdapter.discoverSessionFile.mockResolvedValue([
        makeFileInfo({
          filePath: '/tmp/already-assigned.jsonl',
          providerName: 'codex',
        }),
      ]);
      mockReadFileHead.mockResolvedValue(
        codexSessionMetaContent({
          providerSessionId: 'codex-already-assigned',
          timestamp: '2026-02-25T10:00:00.000Z',
          body: `session=${sessionStartedPayload.sessionId}`,
        }),
      );

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      await advanceAllDiscoveryRetries();
      await promise;

      expect(mockEvents.publish).not.toHaveBeenCalled();
      expect(mockValidator.validateShape).not.toHaveBeenCalled();
    });

    it('should use cwd-filtered timestamp fallback to pick the closest Codex rollout', async () => {
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'codex',
        binPath: null,
        mcpConfigured: false,
      });
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      mockGetStartedAt.mockReturnValue({ started_at: '2026-02-25T10:00:00.000Z' });
      const files = [
        makeFileInfo({ filePath: '/tmp/far.jsonl', providerName: 'codex' }),
        makeFileInfo({ filePath: '/tmp/close.jsonl', providerName: 'codex' }),
      ];
      mockAdapter.discoverSessionFile.mockResolvedValue(files);
      mockReadFileHead.mockImplementation(async (filePath: string) =>
        filePath === '/tmp/far.jsonl'
          ? codexSessionMetaContent({
              providerSessionId: 'codex-far',
              timestamp: '2026-02-25T10:00:20.000Z',
            })
          : codexSessionMetaContent({
              providerSessionId: 'codex-close',
              timestamp: '2026-02-25T10:00:05.000Z',
            }),
      );

      try {
        const promise = listener.handleSessionStarted(sessionStartedPayload);
        await jest.advanceTimersByTimeAsync(0);
        await advanceAllDiscoveryRetries();
        await promise;

        expect(mockValidator.validateShape).toHaveBeenCalledWith('/tmp/close.jsonl', 'codex');
        expect(
          mockRealpath.mock.calls.filter((call) => call[0] === '/home/user/my-project'),
        ).toHaveLength(1);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            filePath: '/tmp/close.jsonl',
            matchType: 'timestamp-fallback',
          }),
          'Auto-discovered transcript via timestamp heuristic fallback',
        );
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('safeRealpath should fall back to a normalized absolute path without throwing', async () => {
      mockRealpath.mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }));

      await expect(
        (
          listener as unknown as {
            safeRealpath: (filePath: string) => Promise<string>;
          }
        ).safeRealpath('relative/missing.jsonl'),
      ).resolves.toBe(path.normalize(path.resolve('relative/missing.jsonl')));
    });

    it('should match non-Claude transcript by bare short prefix content', async () => {
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'codex',
        binPath: null,
        mcpConfigured: false,
      });

      const codexFile = makeFileInfo({
        filePath: '/home/user/.codex/sessions/2026/02/25/rollout-short.jsonl',
        providerName: 'codex',
        providerSessionId: 'codex-session-1',
      });
      mockAdapter.discoverSessionFile.mockResolvedValue([codexFile]);
      mockReadFileHead.mockResolvedValue(`id=${sessionStartedPayload.sessionId.slice(0, 8)}`);

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      await promise;

      expect(mockValidator.validateShape).toHaveBeenCalledWith(codexFile.filePath, 'codex');
      expect(mockEvents.publish).toHaveBeenCalledWith(
        'session.transcript.discovered',
        expect.objectContaining({
          providerName: 'codex',
        }),
      );
    });

    it('should call readFileHead once per scanned file', async () => {
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'codex',
        binPath: null,
        mcpConfigured: false,
      });
      const files = [
        makeFileInfo({ filePath: '/tmp/a.jsonl', providerName: 'codex' }),
        makeFileInfo({ filePath: '/tmp/b.jsonl', providerName: 'codex' }),
        makeFileInfo({
          filePath: '/tmp/c.jsonl',
          providerName: 'codex',
          providerSessionId: 'codex-session-1',
        }),
      ];
      mockAdapter.discoverSessionFile.mockResolvedValue(files);
      mockReadFileHead
        .mockResolvedValueOnce('nothing')
        .mockResolvedValueOnce('still nothing')
        .mockResolvedValueOnce(`Session ${sessionStartedPayload.sessionId.slice(0, 8)}`);

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      await promise;

      expect(mockReadFileHead).toHaveBeenCalledTimes(3);
      const calledPaths = mockReadFileHead.mock.calls.map((call) => call[0]);
      expect(new Set(calledPaths).size).toBe(3);
      expect(calledPaths).toEqual(['/tmp/a.jsonl', '/tmp/b.jsonl', '/tmp/c.jsonl']);
    });

    it('should stop scanning remaining files when first candidate contains full UUID', async () => {
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'codex',
        binPath: null,
        mcpConfigured: false,
      });
      const files = [
        makeFileInfo({
          filePath: '/tmp/first.jsonl',
          providerName: 'codex',
          providerSessionId: 'codex-session-1',
        }),
        makeFileInfo({ filePath: '/tmp/second.jsonl', providerName: 'codex' }),
        makeFileInfo({ filePath: '/tmp/third.jsonl', providerName: 'codex' }),
      ];
      mockAdapter.discoverSessionFile.mockResolvedValue(files);
      mockReadFileHead.mockResolvedValue(`session=${sessionStartedPayload.sessionId}`);

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      await promise;

      expect(mockReadFileHead).toHaveBeenCalledTimes(1);
      expect(mockReadFileHead).toHaveBeenCalledWith('/tmp/first.jsonl', 65_536);
    });

    it('should refuse ambiguous short-id matches for non-Claude providers', async () => {
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'codex',
        binPath: null,
        mcpConfigured: false,
      });

      const shortId = sessionStartedPayload.sessionId.slice(0, 8);
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      mockAdapter.discoverSessionFile.mockResolvedValue([
        makeFileInfo({ filePath: '/home/user/.codex/sessions/2026/02/25/rollout-a.jsonl' }),
        makeFileInfo({ filePath: '/home/user/.codex/sessions/2026/02/25/rollout-b.jsonl' }),
      ]);
      mockReadFileHead.mockResolvedValue(`{"prompt":"Session ${shortId}"}`);

      try {
        const promise = listener.handleSessionStarted(sessionStartedPayload);
        await jest.advanceTimersByTimeAsync(0);
        await advanceAllDiscoveryRetries();
        await promise;
        expect(mockEvents.publish).not.toHaveBeenCalled();
        expect(mockValidator.validateShape).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalledWith(
          expect.objectContaining({ shortMatchCount: 2 }),
          expect.stringContaining('Short session prefix matched multiple transcript candidates'),
        );
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('should apply timestamp heuristic only on final retry for non-Claude providers', async () => {
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'codex',
        binPath: null,
        mcpConfigured: false,
      });

      const codexFile = makeFileInfo({
        filePath: '/home/user/.codex/sessions/2026/02/25/rollout-a.jsonl',
        providerName: 'codex',
        providerSessionId: 'codex-session-1',
      });
      mockAdapter.discoverSessionFile.mockResolvedValue([codexFile]);
      mockReadFileHead.mockResolvedValue(`{"timestamp":"2026-02-25T10:00:30.000Z"}`);
      mockGetTranscriptPath
        .mockReturnValueOnce({ transcript_path: null, provider_session_id: null })
        .mockReturnValueOnce({ transcript_path: null, provider_session_id: null })
        .mockReturnValueOnce({ transcript_path: null, provider_session_id: null });
      mockGetStartedAt.mockReturnValue({ started_at: '2026-02-25T10:00:00.000Z' });

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      await advanceAllDiscoveryRetries();
      await promise;

      expect(mockAdapter.discoverSessionFile).toHaveBeenCalledTimes(7);
      expect(mockReadFileHead).toHaveBeenCalledTimes(7);
      expect(mockValidator.validateShape).toHaveBeenCalledWith(codexFile.filePath, 'codex');
      expect(mockEvents.publish).toHaveBeenCalledWith(
        'session.transcript.discovered',
        expect.objectContaining({
          providerName: 'codex',
        }),
      );
    });

    // NOTE: this exercises a GENERIC file-backed fake (the default mockAdapter
    // has no `sourceKind`, so the listener treats it as a file source). It does
    // NOT represent production `agy`, which is DB-backed (`sourceKind: 'db'`)
    // and routes through handleDbBackedDiscovery — covered by the parameterized
    // DB-backed suite below. The `name: 'agy'` here only selects a non-claude /
    // non-codex provider so the 'all' file strategy runs.
    it('should not run timestamp heuristic on non-final retries (generic file-backed fake, not production agy)', async () => {
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'agy',
        binPath: null,
        mcpConfigured: false,
      });
      // A provider WITHOUT extractCandidateMetadata: the metadata pipeline (and
      // its getSessionStartedAt read) must not run, so this fake proves the
      // generic path is untouched by the presence-based gate.
      mockAdapter.extractCandidateMetadata = undefined;
      mockAdapter.discoverSessionFile
        .mockResolvedValue([])
        .mockResolvedValueOnce([makeFileInfo({ providerName: 'agy' })])
        .mockResolvedValueOnce([makeFileInfo({ providerName: 'agy' })]);
      mockReadFileHead.mockResolvedValue('no id no timestamp');

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      await advanceDiscoveryRetryDelay(0);
      await advanceDiscoveryRetryDelay(1);

      expect(mockGetStartedAt).toHaveBeenCalledTimes(0);

      await advanceAllDiscoveryRetries();
      await promise;

      expect(mockGetStartedAt).toHaveBeenCalledTimes(0);
      expect(mockEvents.publish).not.toHaveBeenCalled();
    });

    it('should refuse timestamp heuristic when multiple candidates are tied for closest', async () => {
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'codex',
        binPath: null,
        mcpConfigured: false,
      });
      mockAdapter.discoverSessionFile.mockResolvedValue([
        makeFileInfo({ filePath: '/tmp/a.jsonl', providerName: 'codex' }),
        makeFileInfo({ filePath: '/tmp/b.jsonl', providerName: 'codex' }),
      ]);
      mockReadFileHead.mockImplementation(async (filePath: string) =>
        filePath === '/tmp/a.jsonl'
          ? `{"timestamp":"2026-02-25T09:59:30.000Z"}`
          : `{"timestamp":"2026-02-25T10:00:30.000Z"}`,
      );
      mockGetTranscriptPath
        .mockReturnValueOnce({ transcript_path: null })
        .mockReturnValueOnce({ transcript_path: null })
        .mockReturnValueOnce({ transcript_path: null });
      mockGetStartedAt.mockReturnValue({ started_at: '2026-02-25T10:00:00.000Z' });

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      await advanceAllDiscoveryRetries();
      await promise;

      expect(mockEvents.publish).not.toHaveBeenCalled();
      expect(mockValidator.validateShape).not.toHaveBeenCalledWith('/tmp/a.jsonl', 'codex');
      expect(mockValidator.validateShape).not.toHaveBeenCalledWith('/tmp/b.jsonl', 'codex');
    });

    it('should exclude candidates without content timestamps from timestamp heuristic', async () => {
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'codex',
        binPath: null,
        mcpConfigured: false,
      });
      mockAdapter.discoverSessionFile.mockResolvedValue([
        makeFileInfo({ filePath: '/tmp/no-ts.jsonl', providerName: 'codex' }),
      ]);
      mockReadFileHead.mockResolvedValue(`{"type":"assistant","text":"no timestamp field"}`);
      mockGetTranscriptPath
        .mockReturnValueOnce({ transcript_path: null })
        .mockReturnValueOnce({ transcript_path: null })
        .mockReturnValueOnce({ transcript_path: null });
      mockGetStartedAt.mockReturnValue({ started_at: '2026-02-25T10:00:00.000Z' });

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      await advanceAllDiscoveryRetries();
      await promise;

      expect(mockEvents.publish).not.toHaveBeenCalled();
    });

    it('should skip unreadable files (readFileHead=null) and continue discovery safely', async () => {
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'codex',
        binPath: null,
        mcpConfigured: false,
      });
      const files = [
        makeFileInfo({ filePath: '/tmp/unreadable.jsonl', providerName: 'codex' }),
        makeFileInfo({
          filePath: '/tmp/readable.jsonl',
          providerName: 'codex',
          providerSessionId: 'codex-session-1',
        }),
      ];
      mockAdapter.discoverSessionFile.mockResolvedValue(files);
      mockReadFileHead
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(`session=${sessionStartedPayload.sessionId}`);

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      await promise;

      expect(mockReadFileHead).toHaveBeenCalledTimes(2);
      expect(mockValidator.validateShape).toHaveBeenCalledWith('/tmp/readable.jsonl', 'codex');
      expect(mockEvents.publish).toHaveBeenCalled();
    });

    it('should not persist unrelated transcripts with different content', async () => {
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'codex',
        binPath: null,
        mcpConfigured: false,
      });
      mockAdapter.discoverSessionFile.mockResolvedValue([
        makeFileInfo({
          filePath: '/tmp/unrelated-recent.jsonl',
          providerName: 'codex',
          lastModified: '2026-02-25T10:00:59.000Z',
        }),
      ]);
      mockReadFileHead.mockResolvedValue(
        '{"timestamp":"2026-02-24T08:00:00.000Z","content":"different session"}',
      );
      mockGetTranscriptPath
        .mockReturnValueOnce({ transcript_path: null })
        .mockReturnValueOnce({ transcript_path: null })
        .mockReturnValueOnce({ transcript_path: null });
      mockGetStartedAt.mockReturnValue({ started_at: '2026-02-25T10:00:00.000Z' });

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      await advanceAllDiscoveryRetries();
      await promise;

      expect(mockEvents.publish).not.toHaveBeenCalled();
      expect(mockValidator.validateShape).not.toHaveBeenCalled();
    });

    it('should treat empty read content as non-match and continue retries', async () => {
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'codex',
        binPath: null,
        mcpConfigured: false,
      });
      mockAdapter.discoverSessionFile.mockResolvedValue([
        makeFileInfo({ filePath: '/tmp/empty.jsonl', providerName: 'codex' }),
      ]);
      mockReadFileHead.mockResolvedValue('');
      mockGetStartedAt.mockReturnValue({ started_at: '2026-02-25T10:00:00.000Z' });

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      await advanceAllDiscoveryRetries();
      await promise;

      expect(mockEvents.publish).not.toHaveBeenCalled();
    });

    it('should warn when discovered transcript exceeds 10MB', async () => {
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const largeFile = makeFileInfo({ sizeBytes: 10 * 1024 * 1024 + 1 });
      mockAdapter.discoverSessionFile.mockResolvedValue([largeFile]);

      try {
        const promise = listener.handleSessionStarted(sessionStartedPayload);
        await jest.advanceTimersByTimeAsync(0);
        await promise;
        expect(warnSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            filePath: largeFile.filePath,
            sizeBytes: largeFile.sizeBytes,
          }),
          'Discovered transcript exceeds 10MB',
        );
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('should use debug logs for non-final misses and warn on final miss', async () => {
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'codex',
        binPath: null,
        mcpConfigured: false,
      });
      const debugSpy = jest.spyOn(Logger.prototype, 'debug').mockImplementation();
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      mockAdapter.discoverSessionFile.mockResolvedValue([]);

      try {
        const promise = listener.handleSessionStarted(sessionStartedPayload);
        await jest.advanceTimersByTimeAsync(0);
        await advanceAllDiscoveryRetries();
        await promise;

        const retryDebugCalls = debugSpy.mock.calls.filter(
          (call) => call[1] === 'Transcript file not found — will retry',
        );
        const finalWarnCalls = warnSpy.mock.calls.filter(
          (call) => call[1] === 'Transcript not found after all discovery retries',
        );

        expect(retryDebugCalls).toHaveLength(6);
        expect(finalWarnCalls).toHaveLength(1);
        expect(mockEvents.publish).not.toHaveBeenCalled();
      } finally {
        debugSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });

    it('should retry with exponential backoff and persist on third attempt', async () => {
      // File not found on first two attempts, found on third
      mockAdapter.discoverSessionFile
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([makeFileInfo()]);

      const promise = listener.handleSessionStarted(sessionStartedPayload);

      // First attempt: no file
      await jest.advanceTimersByTimeAsync(0);
      expect(mockAdapter.discoverSessionFile).toHaveBeenCalledTimes(1);

      // Wait for first retry delay (500ms)
      await advanceDiscoveryRetryDelay(0);
      expect(mockAdapter.discoverSessionFile).toHaveBeenCalledTimes(2);

      // Wait for second retry delay (1000ms)
      await advanceDiscoveryRetryDelay(1);
      expect(mockAdapter.discoverSessionFile).toHaveBeenCalledTimes(3);

      await promise;

      // Should have found file on third attempt and persisted
      expect(mockEvents.publish).toHaveBeenCalledWith(
        'session.transcript.discovered',
        expect.objectContaining({
          sessionId: sessionStartedPayload.sessionId,
        }),
      );
    });

    it('should retry after a Codex path-only write and backfill id when it becomes available', async () => {
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'codex',
        binPath: null,
        mcpConfigured: false,
      });
      const firstFile = makeFileInfo({
        filePath: '/tmp/match.jsonl',
        providerName: 'codex',
      });
      const secondFile = makeFileInfo({
        filePath: '/tmp/match.jsonl',
        providerName: 'codex',
        providerSessionId: 'codex-session-1',
      });
      mockAdapter.discoverSessionFile
        .mockResolvedValueOnce([firstFile])
        .mockResolvedValueOnce([secondFile]);
      mockReadFileHead.mockResolvedValue(`session=${sessionStartedPayload.sessionId}`);
      mockGetTranscriptPath
        .mockReturnValueOnce({ transcript_path: null, provider_session_id: null })
        .mockReturnValueOnce({
          transcript_path: '/normalized/path/session.jsonl',
          provider_session_id: null,
        });
      mockGetPersistRow
        .mockReturnValueOnce({
          transcript_path: null,
          provider_session_id: null,
          provider_name_at_launch: 'codex',
        })
        .mockReturnValueOnce({
          transcript_path: '/normalized/path/session.jsonl',
          provider_session_id: null,
          provider_name_at_launch: 'codex',
        })
        .mockReturnValueOnce({
          transcript_path: '/normalized/path/session.jsonl',
          provider_session_id: null,
          provider_name_at_launch: 'codex',
        });

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      expect(mockAdapter.discoverSessionFile).toHaveBeenCalledTimes(1);
      await advanceDiscoveryRetryDelay(0);
      await promise;

      expect(mockAdapter.discoverSessionFile).toHaveBeenCalledTimes(2);
      expect(mockEvents.publish).toHaveBeenCalledTimes(2);
      expect(mockEvents.publish).toHaveBeenNthCalledWith(1, 'session.transcript.discovered', {
        sessionId: sessionStartedPayload.sessionId,
        agentId: sessionStartedPayload.agentId,
        projectId: 'project-1',
        transcriptPath: '/normalized/path/session.jsonl',
        providerName: 'codex',
      });
      expect(mockEvents.publish).toHaveBeenNthCalledWith(
        2,
        'session.providerSessionId.discovered',
        {
          sessionId: sessionStartedPayload.sessionId,
          providerSessionId: 'codex-session-1',
          providerName: 'codex',
        },
      );
    });

    it('should warn on final retry when Codex provider id never flushes after path-only writes', async () => {
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'codex',
        binPath: null,
        mcpConfigured: false,
      });
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const file = makeFileInfo({
        filePath: '/tmp/match.jsonl',
        providerName: 'codex',
      });
      mockAdapter.discoverSessionFile.mockResolvedValue([file]);
      mockReadFileHead.mockResolvedValue(`session=${sessionStartedPayload.sessionId}`);
      mockGetTranscriptPath
        .mockReturnValueOnce({ transcript_path: null, provider_session_id: null })
        .mockReturnValueOnce({
          transcript_path: '/normalized/path/session.jsonl',
          provider_session_id: null,
        })
        .mockReturnValueOnce({
          transcript_path: '/normalized/path/session.jsonl',
          provider_session_id: null,
        });
      mockGetPersistRow
        .mockReturnValue({
          transcript_path: '/normalized/path/session.jsonl',
          provider_session_id: null,
          provider_name_at_launch: 'codex',
        })
        .mockReturnValueOnce({
          transcript_path: null,
          provider_session_id: null,
          provider_name_at_launch: 'codex',
        });

      try {
        const promise = listener.handleSessionStarted(sessionStartedPayload);
        await jest.advanceTimersByTimeAsync(0);
        await advanceAllDiscoveryRetries();
        await promise;

        expect(mockAdapter.discoverSessionFile).toHaveBeenCalledTimes(7);
        expect(mockEvents.publish).toHaveBeenCalledTimes(1);
        expect(mockEvents.publish).toHaveBeenCalledWith('session.transcript.discovered', {
          sessionId: sessionStartedPayload.sessionId,
          agentId: sessionStartedPayload.agentId,
          projectId: 'project-1',
          transcriptPath: '/normalized/path/session.jsonl',
          providerName: 'codex',
        });
        expect(mockEvents.publish).not.toHaveBeenCalledWith(
          'session.providerSessionId.discovered',
          expect.anything(),
        );
        expect(warnSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionId: sessionStartedPayload.sessionId,
            reason: 'providerSessionIdNotFlushed',
            attempt: 7,
            maxRetries: 6,
          }),
          'Provider session id not available after final discovery attempt',
        );
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('should persist on attempt 2 when attempt 1 has no files', async () => {
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'codex',
        binPath: null,
        mcpConfigured: false,
      });
      mockAdapter.discoverSessionFile.mockResolvedValueOnce([]).mockResolvedValueOnce([
        makeFileInfo({
          filePath: '/tmp/match-2.jsonl',
          providerName: 'codex',
          providerSessionId: 'codex-session-1',
        }),
      ]);
      mockReadFileHead.mockResolvedValue(`session=${sessionStartedPayload.sessionId}`);

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      expect(mockAdapter.discoverSessionFile).toHaveBeenCalledTimes(1);
      await advanceDiscoveryRetryDelay(0);
      await promise;

      expect(mockAdapter.discoverSessionFile).toHaveBeenCalledTimes(2);
      expect(mockValidator.validateShape).toHaveBeenCalledWith('/tmp/match-2.jsonl', 'codex');
      expect(mockEvents.publish).toHaveBeenCalledWith(
        'session.transcript.discovered',
        expect.objectContaining({
          providerName: 'codex',
          sessionId: sessionStartedPayload.sessionId,
        }),
      );
    });

    it('should not persist if file never found after all retries', async () => {
      mockAdapter.discoverSessionFile.mockResolvedValue([]);

      const promise = listener.handleSessionStarted(sessionStartedPayload);

      // Advance through all retries
      await jest.advanceTimersByTimeAsync(0);
      await advanceAllDiscoveryRetries();
      await promise;

      expect(mockAdapter.discoverSessionFile).toHaveBeenCalledTimes(7);
      expect(mockEvents.publish).not.toHaveBeenCalled();
    });

    it('should skip if transcript already discovered via hooks (deduplication)', async () => {
      // Hooks already set complete transcript metadata.
      mockGetTranscriptPath.mockReturnValue({
        transcript_path: '/already/set.jsonl',
        provider_session_id: 'claude-session-1',
      });

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      await promise;

      expect(mockAdapter.discoverSessionFile).not.toHaveBeenCalled();
      expect(mockEvents.publish).not.toHaveBeenCalled();
    });

    it('should stop retrying if hooks complete metadata between retries', async () => {
      mockAdapter.discoverSessionFile.mockResolvedValue([]);

      // First attempt: no transcript_path, no file found
      // Before second attempt: hooks have set complete metadata
      mockGetTranscriptPath
        .mockReturnValueOnce({ transcript_path: null, provider_session_id: null })
        .mockReturnValueOnce({
          transcript_path: '/hook/set.jsonl',
          provider_session_id: 'claude-session-1',
        });

      const promise = listener.handleSessionStarted(sessionStartedPayload);

      await jest.advanceTimersByTimeAsync(0);
      expect(mockAdapter.discoverSessionFile).toHaveBeenCalledTimes(1);

      await advanceDiscoveryRetryDelay(0);
      await promise;

      // Should have stopped after detecting hook-set path
      expect(mockAdapter.discoverSessionFile).toHaveBeenCalledTimes(1);
      expect(mockEvents.publish).not.toHaveBeenCalled();
    });

    it('should skip if no adapter found for provider', async () => {
      mockAdapterFactory.getAdapter.mockReturnValue(undefined);

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      await promise;

      expect(mockAdapter.discoverSessionFile).not.toHaveBeenCalled();
      expect(mockEvents.publish).not.toHaveBeenCalled();
    });

    it('should skip if provider chain resolution fails', async () => {
      mockStorage.getAgent.mockRejectedValue(new Error('Agent not found'));

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      await promise;

      expect(mockAdapter.discoverSessionFile).not.toHaveBeenCalled();
      expect(mockEvents.publish).not.toHaveBeenCalled();
    });

    it('should skip persist if validation fails on discovered path', async () => {
      mockAdapter.discoverSessionFile.mockResolvedValue([makeFileInfo()]);
      mockValidator.validateShape.mockImplementation(() => {
        throw new ValidationError('path outside allowed root');
      });

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      await promise;

      expect(mockEvents.publish).not.toHaveBeenCalled();
    });

    it('should not overwrite an existing different transcript path', async () => {
      mockAdapter.discoverSessionFile.mockResolvedValue([makeFileInfo()]);
      mockGetPersistRow.mockReturnValue({
        transcript_path: '/hook/set.jsonl',
        provider_session_id: null,
        provider_name_at_launch: 'claude',
      });

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      await promise;

      expect(mockRun).not.toHaveBeenCalled();
      expect(mockEvents.publish).not.toHaveBeenCalled();
    });

    it('should not propagate errors from auto-discovery', async () => {
      mockAdapter.discoverSessionFile.mockRejectedValue(new Error('fs error'));

      await expect(
        (async () => {
          const promise = listener.handleSessionStarted(sessionStartedPayload);
          await jest.advanceTimersByTimeAsync(0);
          await promise;
        })(),
      ).resolves.not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // DB-backed auto-discovery (OpenCode + agy): parameterized safety net.
  //
  // sourceKind='db' routes through handleDbBackedDiscovery BEFORE any file
  // strategy (transcriptDiscoveryStrategy is never consulted), so these cases
  // never touch content/short-id/timestamp logic. Each provider's candidates
  // mirror its real adapter shape (shared-container ses_ ids for opencode;
  // per-conversation conv ids for agy).
  // -------------------------------------------------------------------------

  describe('handleSessionStarted (DB-backed auto-discovery)', () => {
    describe.each([
      {
        providerName: 'opencode' as const,
        candA: opencodeCandidate({ providerSessionId: 'ses_01HWZTEST00000000000000A' }),
        candB: opencodeCandidate({ providerSessionId: 'ses_01HWZTEST00000000000000B' }),
      },
      {
        providerName: 'agy' as const,
        candA: agyCandidate({
          providerSessionId: 'conv-aaaa-0001',
          filePath: '/home/user/.gemini/antigravity-cli/conversations/conv-aaaa-0001.db',
        }),
        candB: agyCandidate({
          providerSessionId: 'conv-aaaa-0002',
          filePath: '/home/user/.gemini/antigravity-cli/conversations/conv-aaaa-0002.db',
        }),
      },
    ])('$providerName', ({ providerName, candA, candB }) => {
      let dbAdapter: ReturnType<typeof createMockDbBackedAdapter>;

      beforeEach(() => {
        dbAdapter = createMockDbBackedAdapter(providerName);
        mockAdapterFactory.getAdapter.mockReturnValue(dbAdapter as unknown as SessionReaderAdapter);
        mockStorage.getProvider.mockResolvedValue({
          id: 'provider-1',
          name: providerName,
          binPath: null,
          mcpConfigured: false,
        });
        // Fresh session row (no transcript bound yet) + a launch timestamp.
        mockGetTranscriptPath.mockReturnValue({
          transcript_path: null,
          provider_session_id: null,
        });
        mockGetPersistRow.mockReturnValue({
          transcript_path: null,
          provider_session_id: null,
          provider_name_at_launch: providerName,
        });
        mockGetStartedAt.mockReturnValue({ started_at: '2026-02-25T10:00:00.000Z' });
      });

      it('persists when exactly one unassigned candidate is discovered', async () => {
        dbAdapter.discoverSessionFile.mockResolvedValue([candA]);

        const promise = listener.handleSessionStarted(sessionStartedPayload);
        await jest.advanceTimersByTimeAsync(0);
        await promise;

        // DB discovery context carries the launch timestamp + sessionId.
        expect(dbAdapter.discoverSessionFile).toHaveBeenCalledWith({
          projectRoot: '/home/user/my-project',
          sessionStartedAt: expect.any(Date),
          sessionId: sessionStartedPayload.sessionId,
        });
        expect(dbAdapter.discoverSessionFile).toHaveBeenCalledTimes(1);

        expect(mockValidator.validateShape).toHaveBeenCalledWith(candA.filePath, providerName);
        expect(mockRun).toHaveBeenCalledWith(
          '/normalized/path/session.jsonl',
          candA.providerSessionId,
          expect.any(String),
          sessionStartedPayload.sessionId,
        );
        expect(mockEvents.publish).toHaveBeenCalledWith(
          'session.transcript.discovered',
          expect.objectContaining({
            sessionId: sessionStartedPayload.sessionId,
            providerName,
            providerSessionId: candA.providerSessionId,
          }),
        );
        // File-path logic is never reached for DB-backed sources.
        expect(mockReadFileHead).not.toHaveBeenCalled();
      });

      it('warns and retries while more than one candidate stays ambiguous', async () => {
        dbAdapter.discoverSessionFile.mockResolvedValue([candA, candB]);
        const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

        try {
          const promise = listener.handleSessionStarted(sessionStartedPayload);
          await jest.advanceTimersByTimeAsync(0);
          await advanceAllDiscoveryRetries();
          await promise;

          expect(dbAdapter.discoverSessionFile).toHaveBeenCalledTimes(7);
          expect(mockRun).not.toHaveBeenCalled();
          expect(mockEvents.publish).not.toHaveBeenCalled();

          const ambiguousCalls = warnSpy.mock.calls.filter(
            (call) =>
              call[1] ===
              'Ambiguous DB-backed session match (multiple unassigned candidates) — retrying instead of guessing',
          );
          const finalCalls = warnSpy.mock.calls.filter(
            (call) =>
              call[1] ===
              'DB-backed discovery still ambiguous after final attempt — left unassigned',
          );
          expect(ambiguousCalls.length).toBeGreaterThanOrEqual(1);
          expect(finalCalls).toHaveLength(1);
        } finally {
          warnSpy.mockRestore();
        }
      });

      it('retries with no candidates and warns on the final attempt', async () => {
        dbAdapter.discoverSessionFile.mockResolvedValue([]);
        const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

        try {
          const promise = listener.handleSessionStarted(sessionStartedPayload);
          await jest.advanceTimersByTimeAsync(0);
          await advanceAllDiscoveryRetries();
          await promise;

          expect(dbAdapter.discoverSessionFile).toHaveBeenCalledTimes(7);
          expect(mockRun).not.toHaveBeenCalled();
          expect(mockEvents.publish).not.toHaveBeenCalled();

          const finalCalls = warnSpy.mock.calls.filter(
            (call) =>
              call[1] === 'No DB-backed session candidate found after final discovery attempt',
          );
          expect(finalCalls).toHaveLength(1);
        } finally {
          warnSpy.mockRestore();
        }
      });

      it('excludes candidates already assigned to another session', async () => {
        // candA is already owned by a different session row.
        mockAllAssignedDbCandidates.mockReturnValue([
          { transcript_path: candA.filePath, provider_session_id: candA.providerSessionId },
        ]);
        dbAdapter.discoverSessionFile.mockResolvedValue([candA, candB]);

        const promise = listener.handleSessionStarted(sessionStartedPayload);
        await jest.advanceTimersByTimeAsync(0);
        await promise;

        // Only the unassigned candB is persisted.
        expect(mockRun).toHaveBeenCalledWith(
          '/normalized/path/session.jsonl',
          candB.providerSessionId,
          expect.any(String),
          sessionStartedPayload.sessionId,
        );
        expect(mockEvents.publish).toHaveBeenCalledWith(
          'session.transcript.discovered',
          expect.objectContaining({ providerSessionId: candB.providerSessionId }),
        );
        expect(dbAdapter.discoverSessionFile).toHaveBeenCalledTimes(1);
      });

      it('skips persist when the (providerSessionId, path) uniqueness guard fires', async () => {
        dbAdapter.discoverSessionFile.mockResolvedValue([candA]);
        mockGetDbUniquenessConflict.mockReturnValue({ id: 'other-session-id' });
        const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

        try {
          const promise = listener.handleSessionStarted(sessionStartedPayload);
          await jest.advanceTimersByTimeAsync(0);
          await promise;

          // The path-writing UPDATE never runs; discovery stops on the skipped outcome.
          expect(mockRun).not.toHaveBeenCalled();
          expect(mockEvents.publish).not.toHaveBeenCalled();

          const conflictCalls = warnSpy.mock.calls.filter(
            (call) => call[1] === 'Provider session id already bound to another session — skipping',
          );
          expect(conflictCalls).toHaveLength(1);
          expect(dbAdapter.discoverSessionFile).toHaveBeenCalledTimes(1);
        } finally {
          warnSpy.mockRestore();
        }
      });

      it('exits early via the discovery gate when transcript metadata is already complete', async () => {
        dbAdapter.discoverSessionFile.mockResolvedValue([candA]);
        mockGetTranscriptPath.mockReturnValue({
          transcript_path: '/already/bound.db',
          provider_session_id: 'ses_already_bound',
        });

        const promise = listener.handleSessionStarted(sessionStartedPayload);
        await jest.advanceTimersByTimeAsync(0);
        await promise;

        expect(dbAdapter.discoverSessionFile).not.toHaveBeenCalled();
        expect(mockRun).not.toHaveBeenCalled();
        expect(mockEvents.publish).not.toHaveBeenCalled();
      });
    });
  });

  // -------------------------------------------------------------------------
  // Provider-agnostic seam proof.
  //
  // These two fakes are NOT known to the listener; the provider-adapter factory
  // returns a bare `{ providerName }` (no discovery strategy → the 'all' file
  // path). They prove the presence-based opt-in with ZERO listener edits:
  //   - a fake that IMPLEMENTS extractCandidateMetadata drives the full metadata
  //     pipeline (30s window, cwd filter, content disambiguation) using its own
  //     non-Codex content format.
  //   - a fake that implements NEITHER optional method keeps generic content /
  //     short-id / timestamp matching (via the listener's default extractor).
  // -------------------------------------------------------------------------

  describe('handleSessionStarted (provider-agnostic seam proof)', () => {
    /** Non-Codex metadata line: `#fakemeta sid=… ts=… cwd=…` on the first line. */
    function fakeMetaContent(fields: {
      sid?: string;
      ts?: string;
      cwd?: string;
      body?: string;
    }): string {
      return `#fakemeta sid=${fields.sid ?? ''} ts=${fields.ts ?? ''} cwd=${fields.cwd ?? ''}\n${fields.body ?? ''}`;
    }

    function createFakeMetadataAdapter(): jest.Mocked<
      Pick<SessionReaderAdapter, 'discoverSessionFile' | 'extractCandidateMetadata'>
    > & { providerName: string } {
      return {
        providerName: 'fakeprov',
        discoverSessionFile: jest.fn().mockResolvedValue([]),
        extractCandidateMetadata: jest.fn(
          (content: string): TranscriptCandidateMetadata | undefined => {
            const firstLine = content.split('\n', 1)[0] ?? '';
            const sid = firstLine.match(/sid=(\S+)/)?.[1];
            const ts = firstLine.match(/ts=(\S+)/)?.[1];
            const cwd = firstLine.match(/cwd=(\S+)/)?.[1];
            if (!sid && !ts && !cwd) {
              return undefined;
            }
            return { providerSessionId: sid, timestamp: ts, workspacePath: cwd };
          },
        ),
      };
    }

    /** A fake implementing NEITHER optional metadata method. */
    function createNoMethodAdapter(): jest.Mocked<
      Pick<SessionReaderAdapter, 'discoverSessionFile'>
    > & {
      providerName: string;
    } {
      return {
        providerName: 'nometh',
        discoverSessionFile: jest.fn().mockResolvedValue([]),
      };
    }

    beforeEach(() => {
      mockGetTranscriptPath.mockReturnValue({ transcript_path: null, provider_session_id: null });
      mockGetStartedAt.mockReturnValue({ started_at: '2026-02-25T10:00:00.000Z' });
    });

    it('drives the metadata pipeline for a fake adapter — cwd filter narrows to the project root', async () => {
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'fakeprov',
        binPath: null,
        mcpConfigured: false,
      });
      mockGetPersistRow.mockReturnValue({
        transcript_path: null,
        provider_session_id: null,
        provider_name_at_launch: 'fakeprov',
      });
      const fake = createFakeMetadataAdapter();
      mockAdapterFactory.getAdapter.mockReturnValue(fake as unknown as SessionReaderAdapter);
      fake.discoverSessionFile.mockResolvedValue([
        makeFileInfo({ filePath: '/tmp/fake-wrong.jsonl', providerName: 'fakeprov' }),
        makeFileInfo({ filePath: '/tmp/fake-right.jsonl', providerName: 'fakeprov' }),
      ]);
      mockReadFileHead.mockImplementation(async (filePath: string) =>
        filePath === '/tmp/fake-wrong.jsonl'
          ? fakeMetaContent({
              sid: 'fake-wrong',
              ts: '2026-02-25T10:00:01.000Z',
              cwd: '/home/user/other-project',
            })
          : fakeMetaContent({
              sid: 'fake-right',
              ts: '2026-02-25T10:00:02.000Z',
              cwd: '/home/user/my-project',
            }),
      );

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      await promise;

      expect(fake.extractCandidateMetadata).toHaveBeenCalled();
      expect(mockValidator.validateShape).toHaveBeenCalledWith('/tmp/fake-right.jsonl', 'fakeprov');
      expect(mockValidator.validateShape).not.toHaveBeenCalledWith(
        '/tmp/fake-wrong.jsonl',
        'fakeprov',
      );
      expect(mockEvents.publish).toHaveBeenCalledWith(
        'session.transcript.discovered',
        expect.objectContaining({ providerName: 'fakeprov', providerSessionId: 'fake-right' }),
      );
    });

    it('disambiguates tied fake-metadata matches by session-id content (metadata+content)', async () => {
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'fakeprov',
        binPath: null,
        mcpConfigured: false,
      });
      mockGetPersistRow.mockReturnValue({
        transcript_path: null,
        provider_session_id: null,
        provider_name_at_launch: 'fakeprov',
      });
      const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
      const fake = createFakeMetadataAdapter();
      mockAdapterFactory.getAdapter.mockReturnValue(fake as unknown as SessionReaderAdapter);
      fake.discoverSessionFile.mockResolvedValue([
        makeFileInfo({ filePath: '/tmp/fake-a.jsonl', providerName: 'fakeprov' }),
        makeFileInfo({ filePath: '/tmp/fake-b.jsonl', providerName: 'fakeprov' }),
      ]);
      mockReadFileHead.mockImplementation(async (filePath: string) =>
        filePath === '/tmp/fake-a.jsonl'
          ? fakeMetaContent({
              sid: 'fake-a',
              ts: '2026-02-25T10:00:01.000Z',
              cwd: '/home/user/my-project',
            })
          : fakeMetaContent({
              sid: 'fake-b',
              ts: '2026-02-25T10:00:02.000Z',
              cwd: '/home/user/my-project',
              body: `session=${sessionStartedPayload.sessionId}`,
            }),
      );

      try {
        const promise = listener.handleSessionStarted(sessionStartedPayload);
        await jest.advanceTimersByTimeAsync(0);
        await promise;

        expect(mockValidator.validateShape).toHaveBeenCalledWith('/tmp/fake-b.jsonl', 'fakeprov');
        expect(logSpy).toHaveBeenCalledWith(
          expect.objectContaining({ filePath: '/tmp/fake-b.jsonl', matchType: 'metadata+content' }),
          'Auto-discovered transcript via Codex metadata match',
        );
      } finally {
        logSpy.mockRestore();
      }
    });

    it('keeps generic content matching for a fake WITHOUT the optional methods', async () => {
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'nometh',
        binPath: null,
        mcpConfigured: false,
      });
      mockGetPersistRow.mockReturnValue({
        transcript_path: null,
        provider_session_id: null,
        provider_name_at_launch: 'nometh',
      });
      const fake = createNoMethodAdapter();
      mockAdapterFactory.getAdapter.mockReturnValue(fake as unknown as SessionReaderAdapter);
      fake.discoverSessionFile.mockResolvedValue([
        makeFileInfo({
          filePath: '/tmp/nometh.jsonl',
          providerName: 'nometh',
          providerSessionId: 'nometh-1',
        }),
      ]);
      mockReadFileHead.mockResolvedValue(`session=${sessionStartedPayload.sessionId}`);

      const promise = listener.handleSessionStarted(sessionStartedPayload);
      await jest.advanceTimersByTimeAsync(0);
      await promise;

      expect(mockValidator.validateShape).toHaveBeenCalledWith('/tmp/nometh.jsonl', 'nometh');
      expect(mockEvents.publish).toHaveBeenCalledWith(
        'session.transcript.discovered',
        expect.objectContaining({ providerName: 'nometh' }),
      );
    });

    it('keeps the default timestamp extractor for a no-method fake — ranks all in-window matches (no cwd filter)', async () => {
      mockStorage.getProvider.mockResolvedValue({
        id: 'provider-1',
        name: 'nometh',
        binPath: null,
        mcpConfigured: false,
      });
      mockGetPersistRow.mockReturnValue({
        transcript_path: null,
        provider_session_id: null,
        provider_name_at_launch: 'nometh',
      });
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const fake = createNoMethodAdapter();
      mockAdapterFactory.getAdapter.mockReturnValue(fake as unknown as SessionReaderAdapter);
      fake.discoverSessionFile.mockResolvedValue([
        makeFileInfo({ filePath: '/tmp/far.jsonl', providerName: 'nometh' }),
        makeFileInfo({ filePath: '/tmp/close.jsonl', providerName: 'nometh' }),
      ]);
      mockReadFileHead.mockImplementation(async (filePath: string) =>
        filePath === '/tmp/far.jsonl'
          ? `{"timestamp":"2026-02-25T10:00:20.000Z"}`
          : `{"timestamp":"2026-02-25T10:00:05.000Z"}`,
      );

      try {
        const promise = listener.handleSessionStarted(sessionStartedPayload);
        await jest.advanceTimersByTimeAsync(0);
        await advanceAllDiscoveryRetries();
        await promise;

        expect(mockValidator.validateShape).toHaveBeenCalledWith('/tmp/close.jsonl', 'nometh');
        expect(warnSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            filePath: '/tmp/close.jsonl',
            matchType: 'timestamp-fallback',
          }),
          'Auto-discovered transcript via timestamp heuristic fallback',
        );
        // No workspacePath metadata ⇒ the pipeline must NOT resolve the project
        // root for cwd narrowing.
        expect(
          mockRealpath.mock.calls.filter((call) => call[0] === '/home/user/my-project'),
        ).toHaveLength(0);
      } finally {
        warnSpy.mockRestore();
      }
    });
  });
});
