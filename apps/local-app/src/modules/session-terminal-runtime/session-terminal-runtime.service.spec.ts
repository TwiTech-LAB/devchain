const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

jest.mock('../../common/logging/logger', () => ({
  createLogger: jest.fn(() => mockLogger),
}));

import { MODULE_METADATA } from '@nestjs/common/constants';
import { Test, type TestingModule } from '@nestjs/testing';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { ProviderAdapterFactory } from '../providers/adapters/provider-adapter.factory';
import { ProviderAdaptersModule } from '../providers/adapters/provider-adapters.module';
import { ClaudeLaunchSettingsMaterializerService } from '../runtime-context-capture/claude-launch-settings-materializer.service';
import { CodexPluginProfileMaterializerService } from '../runtime-context-capture/codex-plugin-profile-materializer.service';
import { RuntimeContextCaptureModule } from '../runtime-context-capture/runtime-context-capture.module';
import { RuntimeContextCaptureService } from '../runtime-context-capture/runtime-context-capture.service';
import { DB_CONNECTION } from '../storage/db/db.provider';
import { DbModule } from '../storage/db/db.module';
import { SessionTerminalRuntimeModule } from './session-terminal-runtime.module';
import { SessionTerminalRuntimeService } from './session-terminal-runtime.service';

interface SessionInput {
  id: string;
  tmuxSessionName?: string | null;
  providerName?: string | null;
  status?: 'running' | 'stopped' | 'failed';
}

describe('SessionTerminalRuntimeService', () => {
  let sqlite: Database.Database;
  let moduleRef: TestingModule;
  let service: SessionTerminalRuntimeService;
  let providerAdapterFactory: { getAdapter: jest.Mock };
  let runtimeContextCapture: { clear: jest.Mock };
  let claudeLaunchSettings: { cleanupSessionSync: jest.Mock; reconcileStartup: jest.Mock };
  let codexPluginProfiles: { cleanupSession: jest.Mock; reconcileStartup: jest.Mock };

  beforeEach(async () => {
    jest.clearAllMocks();
    sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        tmux_session_id TEXT,
        provider_name_at_launch TEXT,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    providerAdapterFactory = { getAdapter: jest.fn() };
    runtimeContextCapture = { clear: jest.fn() };
    claudeLaunchSettings = { cleanupSessionSync: jest.fn(), reconcileStartup: jest.fn() };
    codexPluginProfiles = {
      cleanupSession: jest.fn().mockResolvedValue(undefined),
      reconcileStartup: jest.fn().mockResolvedValue(undefined),
    };

    const db = drizzle(sqlite) as BetterSQLite3Database;
    moduleRef = await Test.createTestingModule({
      providers: [
        SessionTerminalRuntimeService,
        { provide: DB_CONNECTION, useValue: db },
        { provide: ProviderAdapterFactory, useValue: providerAdapterFactory },
        { provide: RuntimeContextCaptureService, useValue: runtimeContextCapture },
        { provide: ClaudeLaunchSettingsMaterializerService, useValue: claudeLaunchSettings },
        { provide: CodexPluginProfileMaterializerService, useValue: codexPluginProfiles },
      ],
    }).compile();
    service = moduleRef.get(SessionTerminalRuntimeService);
  });

  afterEach(async () => {
    jest.useRealTimers();
    await moduleRef.close();
    if (sqlite.open) sqlite.close();
  });

  it('declares only the three locked module imports and exports the concrete service', () => {
    expect(Reflect.getMetadata(MODULE_METADATA.IMPORTS, SessionTerminalRuntimeModule)).toEqual([
      DbModule,
      ProviderAdaptersModule,
      RuntimeContextCaptureModule,
    ]);
    expect(Reflect.getMetadata(MODULE_METADATA.PROVIDERS, SessionTerminalRuntimeModule)).toEqual([
      SessionTerminalRuntimeService,
    ]);
    expect(Reflect.getMetadata(MODULE_METADATA.EXPORTS, SessionTerminalRuntimeModule)).toEqual([
      SessionTerminalRuntimeService,
    ]);
  });

  describe('getDescriptor', () => {
    it('returns an immutable descriptor with provider policy for an eligible running row', () => {
      insertSession({ id: 'running', tmuxSessionName: 'tmux-running', providerName: 'opencode' });
      providerAdapterFactory.getAdapter.mockReturnValue({
        terminalOutputBehavior: { rawLineEndings: true, usesAlternateScreen: true },
      });

      const descriptor = service.getDescriptor('running');

      expect(descriptor).toEqual({
        sessionId: 'running',
        tmuxSessionName: 'tmux-running',
        normalizeLf: false,
        usesAlternateScreen: true,
      });
      expect(Object.isFrozen(descriptor)).toBe(true);
      expect(providerAdapterFactory.getAdapter).toHaveBeenCalledWith('opencode');
    });

    it.each([
      ['missing row', undefined],
      [
        'non-running row',
        {
          id: 'target',
          status: 'stopped' as const,
          tmuxSessionName: 'stored',
          providerName: 'claude',
        },
      ],
      ['missing provider', { id: 'target', tmuxSessionName: 'stored', providerName: null }],
      ['missing tmux target', { id: 'target', tmuxSessionName: null, providerName: 'claude' }],
    ])('uses safe values without adapter resolution for a %s', (_label, input) => {
      if (input) insertSession(input);

      expect(service.getDescriptor('target')).toEqual({
        sessionId: 'target',
        tmuxSessionName: input?.tmuxSessionName ?? null,
        normalizeLf: true,
        usesAlternateScreen: false,
      });
      expect(providerAdapterFactory.getAdapter).not.toHaveBeenCalled();
    });

    it('retains the stored tmux target when provider resolution fails', () => {
      insertSession({ id: 'unknown', tmuxSessionName: 'tmux-stored', providerName: 'unknown' });
      providerAdapterFactory.getAdapter.mockImplementation(() => {
        throw new Error('unsupported provider');
      });

      expect(service.getDescriptor('unknown')).toEqual({
        sessionId: 'unknown',
        tmuxSessionName: 'tmux-stored',
        normalizeLf: true,
        usesAlternateScreen: false,
      });
    });

    it('returns safe values instead of throwing when the durable lookup fails', () => {
      sqlite.close();

      expect(service.getDescriptor('unavailable')).toEqual({
        sessionId: 'unavailable',
        tmuxSessionName: null,
        normalizeLf: true,
        usesAlternateScreen: false,
      });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'unavailable' }),
        'Failed to resolve durable session terminal context',
      );
    });
  });

  describe('getProviderNameAtLaunch', () => {
    it('returns the provider only for a running session', () => {
      insertSession({ id: 'running-provider', providerName: 'codex' });
      insertSession({ id: 'stopped-provider', providerName: 'claude', status: 'stopped' });

      expect(service.getProviderNameAtLaunch('running-provider')).toBe('codex');
      expect(service.getProviderNameAtLaunch('stopped-provider')).toBeNull();
      expect(service.getProviderNameAtLaunch('missing-provider')).toBeNull();
    });
  });

  it('lists only running startup rows with both required fields', () => {
    insertSession({ id: 'valid', tmuxSessionName: 'tmux-valid', providerName: 'claude' });
    insertSession({
      id: 'stopped',
      status: 'stopped',
      tmuxSessionName: 'tmux-stop',
      providerName: 'codex',
    });
    insertSession({ id: 'no-tmux', tmuxSessionName: null, providerName: 'claude' });
    insertSession({ id: 'no-provider', tmuxSessionName: 'tmux-no-provider', providerName: null });
    insertSession({ id: 'empty-tmux', tmuxSessionName: '', providerName: 'claude' });
    insertSession({
      id: 'empty-provider',
      tmuxSessionName: 'tmux-empty-provider',
      providerName: '',
    });

    const catalog = service.listStartupSessions();

    expect(catalog).toEqual([{ sessionId: 'valid', tmuxSessionName: 'tmux-valid' }]);
    expect(Object.isFrozen(catalog[0])).toBe(true);
  });

  describe('releaseProviderArtifacts', () => {
    // Unit coverage observes owner callbacks at the artifact boundary without tmux or filesystem IO.
    it('clears capture and runs synchronous cleanup before starting asynchronous cleanup, then awaits it', async () => {
      const order: string[] = [];
      let finishCodexCleanup!: () => void;
      runtimeContextCapture.clear.mockImplementation(() => order.push('capture'));
      claudeLaunchSettings.cleanupSessionSync.mockImplementation(() => order.push('claude-sync'));
      codexPluginProfiles.cleanupSession.mockImplementation(() => {
        order.push('codex-async');
        return new Promise<void>((resolve) => {
          finishCodexCleanup = () => {
            order.push('codex-settled');
            resolve();
          };
        });
      });

      const released = service.releaseProviderArtifacts('release');
      expect(order).toEqual(['capture', 'claude-sync', 'codex-async']);

      finishCodexCleanup();
      await released;

      expect(order).toEqual(['capture', 'claude-sync', 'codex-async', 'codex-settled']);
    });

    // Unit coverage injects owner failures and checks the surviving owner plus the public warning.
    it.each([
      [
        'synchronous',
        'CLAUDE_SETTINGS_CLEANUP_FAILED',
        'Failed to clean Claude launch settings after session termination',
      ],
      [
        'asynchronous',
        'CODEX_PROFILE_CLEANUP_FAILED',
        'Failed to clean Codex profile lifecycle after session termination',
      ],
    ] as const)(
      'continues cleanup after a %s owner failure without exposing error details',
      async (phase, errorCode, message) => {
        const cleanupError = new Error('/private/provider/artifact');
        if (phase === 'synchronous') {
          claudeLaunchSettings.cleanupSessionSync.mockImplementation(() => {
            throw cleanupError;
          });
        } else {
          codexPluginProfiles.cleanupSession.mockRejectedValue(cleanupError);
        }

        await service.releaseProviderArtifacts('owner-failure');

        expect(claudeLaunchSettings.cleanupSessionSync).toHaveBeenCalledWith('owner-failure');
        expect(codexPluginProfiles.cleanupSession).toHaveBeenCalledWith('owner-failure');
        expect(mockLogger.warn).toHaveBeenCalledWith(
          { sessionId: 'owner-failure', errorCode },
          message,
        );
        expect(JSON.stringify(mockLogger.warn.mock.calls)).not.toContain(cleanupError.message);
      },
    );
  });

  // Unit coverage is sufficient for the startup contract: each owner receives the same proven-dead set.
  it('reconciles all artifact owners at startup in list order', async () => {
    const nonLiveSessionIds = new Set(['dead']);

    await service.reconcileProviderStartup(nonLiveSessionIds);

    expect(claudeLaunchSettings.reconcileStartup).toHaveBeenCalledWith(nonLiveSessionIds);
    expect(codexPluginProfiles.reconcileStartup).toHaveBeenCalledWith(nonLiveSessionIds);
    expect(claudeLaunchSettings.reconcileStartup.mock.invocationCallOrder[0]).toBeLessThan(
      codexPluginProfiles.reconcileStartup.mock.invocationCallOrder[0],
    );
  });

  describe('retireConfirmedLoss', () => {
    it('cleans in order before a guarded failed update using one timestamp', () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-08-11T10:30:00.123Z'));
      insertSession({ id: 'lost', tmuxSessionName: 'tmux-lost', providerName: 'claude' });
      const order: string[] = [];
      sqlite.function('record_retirement_update', () => order.push('update'));
      sqlite.exec(`
        CREATE TRIGGER record_retirement_update
        BEFORE UPDATE OF status ON sessions
        BEGIN
          SELECT record_retirement_update();
        END;
      `);
      runtimeContextCapture.clear.mockImplementation(() => order.push('capture'));
      claudeLaunchSettings.cleanupSessionSync.mockImplementation(() => order.push('claude'));
      codexPluginProfiles.cleanupSession.mockImplementation(() => {
        order.push('codex');
        return Promise.resolve();
      });

      expect(service.retireConfirmedLoss('lost', 'confirmed absent')).toBeUndefined();

      expect(order).toEqual(['capture', 'claude', 'codex', 'update']);
      expect(readLifecycle('lost')).toEqual({
        status: 'failed',
        ended_at: '2026-08-11T10:30:00.123Z',
        updated_at: '2026-08-11T10:30:00.123Z',
      });
    });

    it('runs cleanup even when the guarded update changes zero rows', () => {
      insertSession({ id: 'already-stopped', status: 'stopped' });

      service.retireConfirmedLoss('already-stopped', 'confirmed absent');

      expect(runtimeContextCapture.clear).toHaveBeenCalledWith('already-stopped');
      expect(claudeLaunchSettings.cleanupSessionSync).toHaveBeenCalledWith('already-stopped');
      expect(codexPluginProfiles.cleanupSession).toHaveBeenCalledWith('already-stopped');
      expect(readLifecycle('already-stopped')).toEqual({
        status: 'stopped',
        ended_at: null,
        updated_at: '2026-01-01T00:00:00.000Z',
      });
    });

    it('returns before Codex cleanup settles and logs a later rejection', async () => {
      insertSession({ id: 'async-cleanup' });
      let rejectCleanup!: (error: Error) => void;
      const pendingCleanup = new Promise<void>((_resolve, reject) => {
        rejectCleanup = reject;
      });
      codexPluginProfiles.cleanupSession.mockReturnValue(pendingCleanup);

      expect(service.retireConfirmedLoss('async-cleanup', 'confirmed absent')).toBeUndefined();
      expect(readLifecycle('async-cleanup').status).toBe('failed');

      const cleanupError = new Error('cleanup failed later');
      rejectCleanup(cleanupError);
      await pendingCleanup.catch(() => undefined);
      await Promise.resolve();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        { sessionId: 'async-cleanup', errorCode: 'CODEX_PROFILE_CLEANUP_FAILED' },
        'Failed to clean Codex profile lifecycle after session termination',
      );
    });
  });

  function insertSession(input: SessionInput): void {
    sqlite
      .prepare(
        `INSERT INTO sessions
          (id, tmux_session_id, provider_name_at_launch, status, started_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.tmuxSessionName ?? null,
        input.providerName ?? null,
        input.status ?? 'running',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
      );
  }

  function readLifecycle(id: string): {
    status: string;
    ended_at: string | null;
    updated_at: string;
  } {
    return sqlite
      .prepare('SELECT status, ended_at, updated_at FROM sessions WHERE id = ?')
      .get(id) as { status: string; ended_at: string | null; updated_at: string };
  }
});
