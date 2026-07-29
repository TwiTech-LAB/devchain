import { spawn } from 'child_process';
import { createServer, type Server } from 'http';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DEFAULT_CLAUDE_LAUNCH_SETTINGS_JSON } from '@devchain/shared';
import { HooksController } from '../../../hooks/controllers/hooks.controller';
import { HooksService } from '../../../hooks/services/hooks.service';
import { ClaudeAdapter } from '../../../providers/adapters/claude.adapter';
import {
  CANONICAL_DEVCHAIN_STATUS_LINE_COMMAND,
  ClaudeLaunchSettingsMaterializerService,
} from '../../../runtime-context-capture/claude-launch-settings-materializer.service';
import {
  RUNTIME_CONTEXT_CAPTURE_TUPLE_CHANGED_EVENT,
  RuntimeContextCaptureService,
} from '../../../runtime-context-capture/runtime-context-capture.service';
import { writeRuntimeContextEndpointDiscovery } from '../../../runtime-context-capture/runtime-context-capture-files';
import type { RuntimeContextCaptureReport } from '../../../runtime-context-capture/runtime-context-capture.types';
import type { SessionReaderAdapterFactory } from '../../../session-reader/adapters/session-reader-adapter.factory';
import type { UnifiedMetrics } from '../../../session-reader/dtos/unified-session.types';
import type { PricingServiceInterface } from '../../../session-reader/services/pricing.interface';
import type { SessionCacheService } from '../../../session-reader/services/session-cache.service';
import { SessionReaderService } from '../../../session-reader/services/session-reader.service';
import type { TranscriptPathValidator } from '../../../session-reader/services/transcript-path-validator.service';
import type { TranscriptWatcherService } from '../../../session-reader/services/transcript-watcher.service';
import type { SessionsService } from '../sessions.service';
import { resolve } from '../provider-launch-config';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const MODEL_ID = 'claude-sonnet-4-6';
const FIRST_CLAUDE_SESSION_ID = 'claude-runtime-before-clear';
const CLEARED_CLAUDE_SESSION_ID = 'claude-runtime-after-clear';

interface RelayServer {
  server: Server;
  apiUrl: string;
  bodies: RuntimeContextCaptureReport[];
}

describe('context-window resolution lifecycle', () => {
  let tempRoot: string;
  let runtimeRoot: string;
  let projectRoot: string;
  let changedWorkingDirectory: string;
  let transcriptPath: string;
  let sqlite: Database.Database;
  const servers: Server[] = [];

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'devchain-context-lifecycle-'));
    runtimeRoot = join(tempRoot, 'runtime state');
    projectRoot = join(tempRoot, 'project root');
    changedWorkingDirectory = join(projectRoot, 'nested', 'working-directory');
    transcriptPath = join(tempRoot, 'transcript.jsonl');
    await mkdir(changedWorkingDirectory, { recursive: true });
    await writeFile(transcriptPath, '');

    sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        provider_name_at_launch TEXT,
        provider_session_id TEXT
      );
    `);
    sqlite
      .prepare(
        `INSERT INTO sessions (id, status, provider_name_at_launch, provider_session_id)
         VALUES (?, 'running', 'claude', ?)`,
      )
      .run(SESSION_ID, FIRST_CLAUDE_SESSION_ID);
  });

  afterEach(async () => {
    sqlite.close();
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolveClose) => {
            server.close(() => resolveClose());
          }),
      ),
    );
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('joins launch settings, /cd-safe relay, live enrichment, /clear, and port restart', async () => {
    const firstRuntime = createRuntimeHarness(sqlite, transcriptPath);
    const materializer = new ClaudeLaunchSettingsMaterializerService(runtimeRoot);
    const adapter = new ClaudeAdapter();
    const profileOptionArgs = ['--model', MODEL_ID, '--verbose'];
    const configEnv = {
      DEVCHAIN_CONTEXT_WINDOW_TOKENS: '750000',
      PRESERVED_CONFIG_ENV: 'yes',
    };

    const freshBase = resolve({
      mode: 'new',
      sessionId: SESSION_ID,
      adapter,
      profileOptions: `--model ${MODEL_ID} --verbose`,
      modelOverride: null,
      providerBinPath: '/usr/bin/claude',
      providerEnv: null,
      configEnv,
      provider: {},
    });
    const freshEpoch = firstRuntime.capture.rotateEpoch(
      SESSION_ID,
      freshBase.contextWindowOverride,
    );
    const freshSettings = await materializer.prepare({
      providerName: 'claude',
      settingsJson: DEFAULT_CLAUDE_LAUNCH_SETTINGS_JSON,
      profileOptionArgs,
      providerEnv: null,
      configEnv,
      sessionId: SESSION_ID,
      epoch: freshEpoch,
      projectRootPath: projectRoot,
    });
    const freshLaunch = resolve({
      mode: 'new',
      sessionId: SESSION_ID,
      adapter,
      profileOptions: `--model ${MODEL_ID} --verbose`,
      modelOverride: null,
      providerBinPath: '/usr/bin/claude',
      providerEnv: null,
      configEnv,
      provider: {},
      providerOptionArgs: freshSettings.optionArgs,
      runtimeEnv: freshSettings.runtimeEnv,
    });

    expect(freshSettings.captureEnabled).toBe(true);
    expect(freshLaunch.argv).toEqual([
      '--settings',
      freshSettings.optionArgs[1],
      ...profileOptionArgs,
    ]);
    expect(freshLaunch.env).toEqual({
      PRESERVED_CONFIG_ENV: 'yes',
      DEVCHAIN_STATUSLINE_LOCATOR: freshSettings.runtimeEnv.DEVCHAIN_STATUSLINE_LOCATOR,
    });
    expect(freshLaunch.commandArgs).toEqual(
      expect.arrayContaining(['-u', 'DEVCHAIN_CONTEXT_WINDOW_TOKENS']),
    );
    expect((await stat(freshSettings.optionArgs[1])).mode & 0o777).toBe(0o600);
    expect(await readFile(freshSettings.optionArgs[1], 'utf8')).toBe(
      DEFAULT_CLAUDE_LAUNCH_SETTINGS_JSON,
    );

    const firstEndpoint = await createRelayServer(firstRuntime.controller);
    await writeRuntimeContextEndpointDiscovery(firstEndpoint.apiUrl, runtimeRoot);
    await runCanonicalStatusLineCommand(
      projectRoot,
      changedWorkingDirectory,
      freshSettings.runtimeEnv.DEVCHAIN_STATUSLINE_LOCATOR,
      statusLineInput(FIRST_CLAUDE_SESSION_ID, 1_000_000),
    );
    await firstRuntime.reader.onModuleDestroy();

    expect(firstEndpoint.bodies).toHaveLength(1);
    expect(firstRuntime.capture.get(SESSION_ID)).toEqual(
      expect.objectContaining({
        epoch: freshEpoch,
        sequence: 1,
        claudeSessionId: FIRST_CLAUDE_SESSION_ID,
        modelId: MODEL_ID,
        contextWindowTokens: 1_000_000,
      }),
    );
    expect(
      (await firstRuntime.reader.getTranscriptSummary(SESSION_ID)).metrics.contextWindowTokens,
    ).toBe(750_000);
    expect(firstRuntime.cache.invalidateDto).toHaveBeenCalledWith(SESSION_ID);
    expect(firstRuntime.watcher.invalidateLastKnownSummaryMetrics).toHaveBeenCalledWith(SESSION_ID);
    expect(firstRuntime.events.publish).toHaveBeenCalledWith('session.runtime-context.updated', {
      sessionId: SESSION_ID,
    });

    const preRestoreSnapshot = firstRuntime.capture.snapshot(SESSION_ID);
    const restoreEpoch = firstRuntime.capture.rotateEpoch(SESSION_ID, null);
    const restoreSettings = await materializer.prepare({
      providerName: 'claude',
      settingsJson: DEFAULT_CLAUDE_LAUNCH_SETTINGS_JSON,
      profileOptionArgs,
      providerEnv: null,
      configEnv: null,
      sessionId: SESSION_ID,
      epoch: restoreEpoch,
      projectRootPath: projectRoot,
    });
    const restoreLaunch = resolve({
      mode: 'restore',
      providerSessionId: FIRST_CLAUDE_SESSION_ID,
      adapter,
      profileOptions: `--model ${MODEL_ID} --verbose`,
      modelOverride: null,
      providerBinPath: '/usr/bin/claude',
      providerEnv: null,
      configEnv: null,
      provider: {},
      providerOptionArgs: restoreSettings.optionArgs,
      runtimeEnv: restoreSettings.runtimeEnv,
    });

    expect(restoreLaunch.argv).toEqual([
      '--resume',
      FIRST_CLAUDE_SESSION_ID,
      '--settings',
      restoreSettings.optionArgs[1],
      ...profileOptionArgs,
    ]);
    firstRuntime.capture.restoreSnapshot(SESSION_ID, preRestoreSnapshot);
    expect(firstRuntime.capture.snapshot(SESSION_ID)).toEqual(preRestoreSnapshot);
    firstRuntime.capture.rotateEpoch(SESSION_ID, null);
    const liveRestoreEpoch = firstRuntime.capture.getEpoch(SESSION_ID)!;
    const liveRestoreSettings = await materializer.prepare({
      providerName: 'claude',
      settingsJson: DEFAULT_CLAUDE_LAUNCH_SETTINGS_JSON,
      profileOptionArgs,
      providerEnv: null,
      configEnv: null,
      sessionId: SESSION_ID,
      epoch: liveRestoreEpoch,
      projectRootPath: projectRoot,
    });

    await runCanonicalStatusLineCommand(
      projectRoot,
      changedWorkingDirectory,
      liveRestoreSettings.runtimeEnv.DEVCHAIN_STATUSLINE_LOCATOR,
      statusLineInput(FIRST_CLAUDE_SESSION_ID, 1_000_000),
    );
    expect(
      (await firstRuntime.reader.getTranscriptSummary(SESSION_ID)).metrics.contextWindowTokens,
    ).toBe(1_000_000);

    const restartedRuntime = createRuntimeHarness(sqlite, transcriptPath);
    const restartedEndpoint = await createRelayServer(restartedRuntime.controller);
    await writeRuntimeContextEndpointDiscovery(restartedEndpoint.apiUrl, runtimeRoot);
    await runCanonicalStatusLineCommand(
      projectRoot,
      changedWorkingDirectory,
      liveRestoreSettings.runtimeEnv.DEVCHAIN_STATUSLINE_LOCATOR,
      statusLineInput(FIRST_CLAUDE_SESSION_ID, 1_000_000),
    );

    expect(restartedEndpoint.bodies).toHaveLength(1);
    expect(restartedRuntime.capture.get(SESSION_ID)).toEqual(
      expect.objectContaining({
        epoch: liveRestoreEpoch,
        sequence: 3,
        claudeSessionId: FIRST_CLAUDE_SESSION_ID,
      }),
    );

    sqlite
      .prepare('UPDATE sessions SET provider_session_id = ? WHERE id = ?')
      .run(CLEARED_CLAUDE_SESSION_ID, SESSION_ID);
    await runCanonicalStatusLineCommand(
      projectRoot,
      changedWorkingDirectory,
      liveRestoreSettings.runtimeEnv.DEVCHAIN_STATUSLINE_LOCATOR,
      statusLineInput(CLEARED_CLAUDE_SESSION_ID, 900_000),
    );
    await restartedRuntime.reader.onModuleDestroy();

    expect(restartedRuntime.capture.get(SESSION_ID)).toEqual(
      expect.objectContaining({
        sequence: 4,
        claudeSessionId: CLEARED_CLAUDE_SESSION_ID,
        contextWindowTokens: 900_000,
      }),
    );
    expect(
      restartedRuntime.capture.capture({
        sessionId: SESSION_ID,
        epoch: liveRestoreEpoch,
        sequence: 3,
        claudeSessionId: FIRST_CLAUDE_SESSION_ID,
        modelId: MODEL_ID,
        contextWindowTokens: 1_000_000,
      }),
    ).toEqual({ accepted: false, reason: 'sequence-not-increasing' });
    expect(
      (await restartedRuntime.reader.getTranscriptSummary(SESSION_ID)).metrics.contextWindowTokens,
    ).toBe(900_000);
  });

  async function createRelayServer(controller: HooksController): Promise<RelayServer> {
    const bodies: RuntimeContextCaptureReport[] = [];
    const server = createServer((request, response) => {
      let raw = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => {
        raw += chunk;
      });
      request.on('end', () => {
        void (async () => {
          const body = JSON.parse(raw) as RuntimeContextCaptureReport;
          bodies.push(body);
          const result = await controller.receiveHookEvent(body);
          response.statusCode = 200;
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify(result));
        })();
      });
    });
    servers.push(server);
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Relay server did not bind');
    return { server, apiUrl: `http://127.0.0.1:${address.port}`, bodies };
  }
});

function createRuntimeHarness(sqlite: Database.Database, transcriptPath: string) {
  const emitter = new EventEmitter2();
  const capture = new RuntimeContextCaptureService(sqlite as never, emitter);
  const cache = {
    getEntry: jest.fn().mockReturnValue(undefined),
    invalidateDto: jest.fn(),
  };
  const watcher = {
    getLastKnownSummaryMetrics: jest.fn().mockReturnValue(null),
    invalidateLastKnownSummaryMetrics: jest.fn(),
  };
  const events = {
    publish: jest.fn().mockResolvedValue('event-id'),
  };
  const sessions = {
    getSession: jest.fn().mockImplementation(() => {
      const row = sqlite
        .prepare(
          `SELECT status, provider_name_at_launch, provider_session_id
           FROM sessions
           WHERE id = ?`,
        )
        .get(SESSION_ID) as {
        status: string;
        provider_name_at_launch: string;
        provider_session_id: string;
      };
      return {
        id: SESSION_ID,
        agentId: 'agent-id',
        providerNameAtLaunch: row.provider_name_at_launch,
        providerSessionId: row.provider_session_id,
        transcriptPath,
        status: row.status,
      };
    }),
  };
  const adapter = {
    providerName: 'claude',
    sourceKind: 'file',
    getSummary: jest.fn().mockResolvedValue({
      metrics: metrics(),
      exactFields: [],
    }),
  };
  const adapterFactory = {
    getAdapter: jest.fn().mockReturnValue(adapter),
  };
  const pathValidator = {
    validateForRead: jest.fn().mockResolvedValue(transcriptPath),
  };
  const pricing = {
    calculateMessageCost: jest.fn().mockReturnValue(0),
    getCatalogContextWindowSize: jest.fn((modelId: string) =>
      modelId === MODEL_ID ? 1_000_000 : null,
    ),
    getContextWindowSize: jest.fn().mockReturnValue(1_000_000),
  } satisfies PricingServiceInterface;
  const reader = new SessionReaderService(
    adapterFactory as unknown as SessionReaderAdapterFactory,
    pathValidator as unknown as TranscriptPathValidator,
    cache as unknown as SessionCacheService,
    sessions as unknown as SessionsService,
    watcher as unknown as TranscriptWatcherService,
    pricing,
    capture,
    events as never,
  );
  emitter.on(RUNTIME_CONTEXT_CAPTURE_TUPLE_CHANGED_EVENT, (payload) => {
    reader.handleRuntimeContextTupleChanged(payload);
  });

  const hooks = new HooksService(
    { getAgent: jest.fn() } as never,
    { publish: jest.fn() } as never,
    {} as never,
    capture,
  );
  return {
    capture,
    reader,
    cache,
    watcher,
    events,
    controller: new HooksController(hooks),
  };
}

function metrics(): UnifiedMetrics {
  return {
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 120,
    totalContextConsumption: 120,
    compactionCount: 0,
    phaseBreakdowns: [],
    visibleContextTokens: 100,
    totalContextTokens: 120,
    contextWindowTokens: 200_000,
    costUsd: 0,
    primaryModel: MODEL_ID,
    durationMs: 1_000,
    messageCount: 2,
    isOngoing: true,
  };
}

function statusLineInput(claudeSessionId: string, contextWindowTokens: number): string {
  return JSON.stringify({
    session_id: claudeSessionId,
    model: { id: MODEL_ID },
    context_window: { context_window_size: contextWindowTokens },
  });
}

async function runCanonicalStatusLineCommand(
  projectRoot: string,
  cwd: string,
  locatorPath: string,
  input: string,
): Promise<void> {
  await new Promise<void>((resolveRun, reject) => {
    const child = spawn('/bin/sh', ['-c', CANONICAL_DEVCHAIN_STATUS_LINE_COMMAND], {
      cwd,
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: projectRoot,
        DEVCHAIN_STATUSLINE_LOCATOR: locatorPath,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      reject(new Error(`Status-line command exited ${String(code)}: ${stderr}`));
    });
    child.stdin.end(input);
  });
}
