import { SessionRowStore } from '../../../../storage/sessions/session-row.store';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
/**
 * Test harness for SessionLaunchPipeline and SessionRestorePipeline.
 *
 * Creates full jest.fn() mocks for every constructor dependency so that
 * the actual pipeline classes can be instantiated without NestJS DI.
 */

// ── Mock data factories ────────────────────────────────────────────────

export function fakeAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'agent-1',
    projectId: 'project-1',
    profileId: 'profile-1',
    providerConfigId: 'ppc-1',
    modelOverride: null,
    effortOverride: null,
    name: 'test-agent',
    description: null,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

export function fakeProject(overrides: Record<string, unknown> = {}) {
  return {
    id: 'project-1',
    name: 'TestProject',
    description: null,
    rootPath: '/tmp/project',
    isTemplate: false,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

export function fakeEpic(overrides: Record<string, unknown> = {}) {
  return {
    id: 'epic-1',
    projectId: 'project-1',
    title: 'Test Epic',
    description: null,
    statusId: 'status-1',
    parentId: null,
    agentId: null,
    version: 1,
    data: null,
    skillsRequired: null,
    tags: [],
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

export function fakeProfile(overrides: Record<string, unknown> = {}) {
  return {
    id: 'profile-1',
    projectId: null,
    name: 'default',
    familySlug: null,
    systemPrompt: null,
    instructions: null,
    temperature: null,
    maxTokens: null,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

export function fakeProvider(overrides: Record<string, unknown> = {}) {
  return {
    id: 'provider-1',
    name: 'test-provider',
    binPath: '/usr/bin/test-provider',
    mcpConfigured: true,
    mcpEndpoint: null,
    mcpRegisteredAt: null,
    autoCompactThreshold: null,
    claudeLaunchSettingsJson: null,
    env: null,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

export function fakeProfileProviderConfig(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ppc-1',
    profileId: 'profile-1',
    providerId: 'provider-1',
    providerName: 'test-provider',
    name: 'default',
    description: null,
    options: null,
    env: null,
    model: null,
    effort: null,
    position: 0,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

// ── In-memory SQLite mock ──────────────────────────────────────────────

export interface SqliteStatementMock {
  run: jest.Mock;
  get: jest.Mock;
  all: jest.Mock;
}

/**
 * Creates a `prepare` mock that returns statement objects with run/get/all.
 * The behaviour can be customised per-SQL via `sqlHandlers`.
 */
export function createSqliteMock() {
  const defaultStmt: SqliteStatementMock = {
    run: jest.fn().mockReturnValue({ changes: 1 }),
    get: jest.fn().mockReturnValue(undefined),
    all: jest.fn().mockReturnValue([]),
  };

  const prepare = jest.fn().mockReturnValue(defaultStmt);

  // `exec` runs the BEGIN and COMMIT of queued store transactions.
  const db = {
    session: { client: { prepare, exec: jest.fn() } },
  };

  return { db, prepare, defaultStmt };
}

// ── Provider adapter mock ──────────────────────────────────────────────

export function createMockAdapter(providerName = 'test-provider') {
  return {
    providerName,
    launchInitialPromptBehavior: undefined,
    initialPromptSeedMode: undefined as 'argv' | 'stdin' | undefined,
    buildLaunchArgs: jest.fn().mockReturnValue({
      argv: [providerName, '--session', 'new'],
    }),
    evaluateAutoCompactConfig: jest.fn().mockResolvedValue({ enabled: true }),
  };
}

// ── Full harness for SessionLaunchPipeline ─────────────────────────────

/** A Vault launch seam for an agent with no Vault access and no grants. */
export function createVaultLaunchMock() {
  return {
    hasAccess: jest.fn().mockResolvedValue(false),
    grantedEntryCount: jest.fn().mockResolvedValue(0),
  };
}

export function createLaunchPipelineHarness() {
  const sqliteMock = createSqliteMock();
  const adapter = createMockAdapter();

  const storage = {
    getAgent: jest.fn().mockResolvedValue(fakeAgent()),
    getProject: jest.fn().mockResolvedValue(fakeProject()),
    getEpic: jest.fn().mockResolvedValue(fakeEpic()),
    getAgentProfile: jest.fn().mockResolvedValue(fakeProfile()),
    getProvider: jest.fn().mockResolvedValue(fakeProvider()),
    getProviderEnvForProject: jest.fn().mockReturnValue(null),
    getInitialSessionPrompt: jest.fn().mockResolvedValue(null),
    listProfileProviderConfigsByProfile: jest.fn().mockResolvedValue([fakeProfileProviderConfig()]),
  };

  const sessionCoordinator = {
    withAgentLock: jest.fn().mockImplementation((_id: string, fn: () => Promise<unknown>) => fn()),
  };

  const providerAdapterFactory = {
    getAdapter: jest.fn().mockReturnValue(adapter),
    isSupported: jest.fn().mockReturnValue(true),
  };

  const terminalIO = {
    createEmptySession: jest.fn().mockResolvedValue(undefined),
    destroySession: jest.fn().mockResolvedValue(undefined),
    destroyExpectedSession: jest.fn().mockResolvedValue({ outcome: 'destroyed' }),
    setAlternateScreen: jest.fn().mockResolvedValue(undefined),
    typeCommand: jest.fn().mockResolvedValue(undefined),
    waitForOutput: jest.fn().mockResolvedValue(undefined),
    deliver: jest.fn().mockResolvedValue(undefined),
    deliverImmediate: jest.fn().mockResolvedValue(undefined),
    sessionExists: jest.fn().mockResolvedValue(false),
    startHealthCheck: jest.fn(),
  };

  const ptyService = {
    startStreaming: jest.fn().mockResolvedValue(undefined),
    stopStreaming: jest.fn(),
  };

  const terminalSessionRegistry = {
    create: jest.fn(),
    dispose: jest.fn(),
    bind: jest.fn(),
    get: jest.fn(),
  };

  const hooksConfigService = {
    ensureHooksConfig: jest.fn().mockResolvedValue(undefined),
  };

  const copilotHooksConfigService = {
    providerName: 'copilot',
    ensureHooksConfig: jest.fn().mockResolvedValue(undefined),
  };

  const devinHooksConfigService = {
    providerName: 'devin',
    ensureHooksConfig: jest.fn().mockResolvedValue(undefined),
  };

  const preflightService = {
    runChecks: jest.fn().mockResolvedValue({
      overall: 'pass',
      checks: [],
      providers: [{ id: 'provider-1', mcpStatus: 'pass' }],
    }),
  };

  const mcpEnsureService = {
    ensureMcp: jest.fn().mockResolvedValue(undefined),
    ensureProjectProvisioning: jest.fn().mockResolvedValue({ success: true, warnings: [] }),
  };

  const eventsService = {
    publish: jest.fn().mockResolvedValue(undefined),
  };

  const teamsService = {
    listTeamsByAgent: jest.fn().mockResolvedValue([]),
  };

  const runtimeContextCapture = {
    clear: jest.fn(),
  };
  const claudeLaunchSettings = {
    cleanupSessionSync: jest.fn(),
  };
  const codexPluginProfiles = {
    cleanupSession: jest.fn().mockResolvedValue(undefined),
  };
  const providerRuntimePlan = Object.freeze({ mode: 'new' });
  const preparedProviderRuntime = {
    config: {
      argv: ['test-provider', '--session', 'new'],
      commandArgs: ['test-provider', '--session', 'new'],
      env: null,
      contextWindowOverride: null,
      promptHandshake: undefined,
    },
    typedArgs: ['/bin/sh', '/private/launch/session.sh'],
    afterCommand: jest.fn().mockResolvedValue(undefined),
    rollback: jest.fn().mockResolvedValue(undefined),
  };
  const providerRuntimePreparation = {
    createPlan: jest.fn().mockResolvedValue(providerRuntimePlan),
    materialize: jest.fn().mockResolvedValue(preparedProviderRuntime),
  };
  const vaultLaunch = createVaultLaunchMock();
  const savePoints = {
    getForkSupport: jest.fn(),
    isTeamMember: jest.fn().mockResolvedValue(false),
    readableTranscript: jest.fn(async (transcriptPath: string) => transcriptPath),
  };
  const sessionRows = new SessionRowStore(sqliteMock.db as unknown as BetterSQLite3Database);

  // Build the pipeline via direct instantiation (bypass DI decorators)
  // Constructor order matches the @Injectable constructor parameter order.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { SessionLaunchPipeline } = require('../session-launch-pipeline.service');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const runtimeServices = require('../../../../session-terminal-runtime/session-terminal-runtime.service');
  const sessionTerminalRuntime = new runtimeServices.SessionTerminalRuntimeService(
    sqliteMock.db,
    providerAdapterFactory,
    runtimeContextCapture,
    claudeLaunchSettings,
    codexPluginProfiles,
    sessionRows,
  );
  const pipeline = new SessionLaunchPipeline(
    sqliteMock.db, // @Inject(DB_CONNECTION)
    storage, // @Inject(STORAGE_SERVICE)
    sessionCoordinator, // SessionCoordinatorService
    providerAdapterFactory, // ProviderAdapterFactory
    terminalIO, // TerminalIOService
    ptyService, // PtyService
    terminalSessionRegistry, // TerminalSessionRegistry
    hooksConfigService, // HooksConfigService
    copilotHooksConfigService, // CopilotHooksConfigService
    devinHooksConfigService, // DevinHooksConfigService
    preflightService, // PreflightService
    mcpEnsureService, // ProviderMcpEnsureService
    eventsService, // EventsService
    teamsService, // TeamsService
    sessionTerminalRuntime, // SessionTerminalRuntimeService
    providerRuntimePreparation, // ProviderRuntimePreparationService
    sessionRows,
    vaultLaunch, // VaultLaunchService
    savePoints, // SessionSavePointsService
  );

  return {
    pipeline,
    mocks: {
      vaultLaunch,
      sqliteMock,
      adapter,
      storage,
      sessionCoordinator,
      providerAdapterFactory,
      terminalIO,
      ptyService,
      terminalSessionRegistry,
      hooksConfigService,
      copilotHooksConfigService,
      devinHooksConfigService,
      preflightService,
      mcpEnsureService,
      eventsService,
      teamsService,
      runtimeContextCapture,
      claudeLaunchSettings,
      codexPluginProfiles,
      sessionTerminalRuntime,
      providerRuntimePlan,
      preparedProviderRuntime,
      providerRuntimePreparation,
      savePoints,
      sessionRows,
    },
  };
}

// ── Full harness for SessionRestorePipeline ─────────────────────────────

function createDefaultStreamServiceMock() {
  return {
    scheduleClear: jest.fn(),
    cancelScheduledClear: jest.fn().mockReturnValue(null),
    setClearExpiryHandler: jest.fn(),
    clearBuffer: jest.fn(),
    retireReplay: jest.fn(),
    getSequenceEpoch: jest.fn(),
    getBufferStats: jest.fn(),
    initializeBuffer: jest.fn(),
  };
}

interface StoppedSessionRow {
  id: string;
  kind: 'session' | 'save_point';
  parent_session_id: string | null;
  epic_id: string;
  agent_id: string;
  tmux_session_id: string | null;
  status: string;
  started_at: string;
  ended_at: string | null;
  transcript_path: string | null;
  provider_session_id: string | null;
  provider_name_at_launch: string;
  created_at: string;
  updated_at: string;
}

/** `TStream` is the injected stream service's type; the default is a bag of jest mocks. */
export function createRestorePipelineHarness<
  TStream = ReturnType<typeof createDefaultStreamServiceMock>,
>(opts?: { streamService?: TStream }) {
  const sqliteMock = createSqliteMock();
  const adapter = createMockAdapter();

  const storage = {
    getAgent: jest.fn().mockResolvedValue(fakeAgent()),
    getProject: jest.fn().mockResolvedValue(fakeProject()),
    getEpic: jest.fn().mockResolvedValue(fakeEpic()),
    getAgentProfile: jest.fn().mockResolvedValue(fakeProfile()),
    getProvider: jest.fn().mockResolvedValue(fakeProvider()),
    getProviderEnvForProject: jest.fn().mockReturnValue(null),
    getInitialSessionPrompt: jest.fn().mockResolvedValue(null),
    listProfileProviderConfigsByProfile: jest.fn().mockResolvedValue([fakeProfileProviderConfig()]),
  };

  const sessionCoordinator = {
    withAgentLock: jest.fn().mockImplementation((_id: string, fn: () => Promise<unknown>) => fn()),
    withAgentLocks: jest
      .fn()
      .mockImplementation((_ids: string[], fn: () => Promise<unknown>) => fn()),
  };

  const providerAdapterFactory = {
    getAdapter: jest.fn().mockReturnValue(adapter),
  };

  const terminalIO = {
    createEmptySession: jest.fn().mockResolvedValue(undefined),
    destroySession: jest.fn().mockResolvedValue(undefined),
    destroyExpectedSession: jest.fn().mockResolvedValue({ outcome: 'destroyed' }),
    setAlternateScreen: jest.fn().mockResolvedValue(undefined),
    typeCommand: jest.fn().mockResolvedValue(undefined),
    sessionExists: jest.fn().mockResolvedValue(false),
    startHealthCheck: jest.fn(),
  };

  const ptyService = {
    startStreaming: jest.fn().mockResolvedValue(undefined),
    stopStreaming: jest.fn(),
  };

  const terminalSessionRegistry = {
    create: jest.fn(),
    dispose: jest.fn(),
    bind: jest.fn(),
    get: jest.fn(),
  };

  const eventsService = {
    publish: jest.fn().mockResolvedValue(undefined),
  };

  const preflightService = {
    runChecks: jest.fn().mockResolvedValue({
      overall: 'pass',
      checks: [],
      providers: [{ id: 'provider-1', mcpStatus: 'pass' }],
    }),
  };

  const mcpEnsureService = {
    ensureMcp: jest.fn().mockResolvedValue(undefined),
    ensureProjectProvisioning: jest.fn().mockResolvedValue({ success: true, warnings: [] }),
  };

  // Replay-lifecycle owner. Default is a jest.fn() mock (cancelScheduledClear returns null → no
  // rollback re-arm pushed); a test can inject a real TerminalStreamService to exercise the timer.
  const streamService = (opts?.streamService ?? createDefaultStreamServiceMock()) as TStream;

  const providerRuntimePlan = Object.freeze({ mode: 'restore' });
  const preparedProviderRuntime = {
    config: {
      argv: ['test-provider', '--resume', 'provider-session-1'],
      commandArgs: ['test-provider', '--resume', 'provider-session-1'],
      env: null,
      contextWindowOverride: null,
      promptHandshake: undefined,
    },
    typedArgs: ['/bin/sh', '/private/launch/session.sh'],
    afterCommand: jest.fn().mockResolvedValue(undefined),
    rollback: jest.fn().mockResolvedValue(undefined),
  };
  const providerRuntimePreparation = {
    createPlan: jest.fn().mockResolvedValue(providerRuntimePlan),
    materialize: jest.fn().mockResolvedValue(preparedProviderRuntime),
  };

  // Default: prepare returns a stopped session row when called with SELECT,
  // and a normal statement for INSERT/UPDATE.
  const stoppedSessionRow: StoppedSessionRow = {
    id: 'session-1',
    kind: 'session',
    parent_session_id: null,
    epic_id: 'epic-1',
    agent_id: 'agent-1',
    tmux_session_id: null,
    status: 'stopped',
    started_at: '2025-01-01T00:00:00Z',
    ended_at: '2025-01-01T01:00:00Z',
    transcript_path: null,
    provider_session_id: 'provider-session-1',
    provider_name_at_launch: 'test-provider',
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T01:00:00Z',
  };

  // A save point of the stopped session, for rollback.
  const savePointRow: StoppedSessionRow = {
    ...stoppedSessionRow,
    id: 'save-point-1',
    kind: 'save_point',
    parent_session_id: stoppedSessionRow.id,
    transcript_path: '/test/save-point.jsonl',
    provider_session_id: 'save-point-native',
  };

  const selectStmt = {
    run: jest.fn().mockReturnValue({ changes: 1 }),
    get: jest.fn((id: string) => (id === savePointRow.id ? savePointRow : stoppedSessionRow)),
    all: jest.fn().mockReturnValue([]),
  };

  // checkNoRunningSession uses: SELECT id FROM sessions WHERE agent_id = ? AND status = 'running'
  const noRunningStmt = {
    run: jest.fn().mockReturnValue({ changes: 0 }),
    get: jest.fn().mockReturnValue(undefined), // no running session found
    all: jest.fn().mockReturnValue([]),
  };

  const updateStmt = {
    run: jest.fn().mockReturnValue({ changes: 1 }),
    get: jest.fn().mockReturnValue(undefined),
    all: jest.fn().mockReturnValue([]),
  };

  // Route by SQL pattern
  sqliteMock.prepare.mockImplementation((sql: string) => {
    const upper = sql.trim().toUpperCase();
    if (upper.startsWith('SELECT') && upper.includes("STATUS = 'RUNNING'")) {
      return noRunningStmt;
    }
    if (upper.startsWith('SELECT')) return selectStmt;
    return updateStmt;
  });

  const forkAdapter = {
    ...adapter,
    forkReadsSavePointTranscript: true,
    createSavePoint: jest.fn().mockResolvedValue({
      providerSessionId: 'record-native',
      transcriptPath: '/test/record.jsonl',
    }),
    prepareForkLaunch: jest.fn(),
  };
  const launchPipeline = {
    requireForkSupport: jest.fn().mockResolvedValue({
      adapter: forkAdapter,
      providerBinPath: '/usr/bin/test-provider',
      helperEnv: {},
    }),
    readableForkSource: jest.fn(async (source: unknown) => source),
    setupHooksConfig: jest.fn().mockResolvedValue(undefined),
    verifyProvider: jest.fn().mockResolvedValue(undefined),
  };
  const savePoints = {
    isTeamMember: jest.fn().mockResolvedValue(false),
    readableTranscript: jest.fn(async (path: string) => path),
  };
  const sessionRows = new SessionRowStore(sqliteMock.db as unknown as BetterSQLite3Database);
  const hooks = { fenceRuntime: jest.fn() };

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { SessionRestorePipeline } = require('../session-restore-pipeline.service');
  const pipeline = new SessionRestorePipeline(
    sqliteMock.db, // @Inject(DB_CONNECTION)
    storage, // @Inject(STORAGE_SERVICE)
    sessionCoordinator, // SessionCoordinatorService
    providerAdapterFactory, // ProviderAdapterFactory
    terminalIO, // TerminalIOService
    ptyService, // PtyService
    terminalSessionRegistry, // TerminalSessionRegistry
    eventsService, // EventsService
    streamService, // TerminalStreamService
    providerRuntimePreparation, // ProviderRuntimePreparationService
    preflightService, // PreflightService
    mcpEnsureService, // ProviderMcpEnsureService
    sessionRows,
    launchPipeline, // SessionLaunchPipeline
    savePoints, // SessionSavePointsService
    hooks, // HooksService
  );

  /**
   * Helper: create a custom prepare mock that correctly routes SELECT queries
   * for the restore pipeline (readSessionRow vs checkNoRunningSession) while
   * allowing the caller to track UPDATE/INSERT calls via a runCalls array.
   */
  function createTrackedPrepare(runCalls?: { sql: string; args: unknown[] }[]) {
    return (sql: string) => {
      const upper = sql.trim().toUpperCase();
      // checkNoRunningSession: SELECT ... status = 'running'
      if (upper.startsWith('SELECT') && upper.includes("STATUS = 'RUNNING'")) {
        return noRunningStmt;
      }
      // readSessionRow: other SELECTs
      if (upper.startsWith('SELECT')) {
        return selectStmt;
      }
      // UPDATE / INSERT — optionally tracked
      if (runCalls) {
        return {
          run: jest.fn((...args: unknown[]) => {
            runCalls.push({ sql, args });
            return { changes: 1 };
          }),
          get: jest.fn(),
          all: jest.fn(),
        };
      }
      return updateStmt;
    };
  }

  return {
    pipeline,
    stoppedSessionRow,
    savePointRow,
    createTrackedPrepare,
    mocks: {
      sqliteMock,
      selectStmt,
      noRunningStmt,
      updateStmt,
      adapter,
      storage,
      sessionCoordinator,
      providerAdapterFactory,
      terminalIO,
      ptyService,
      terminalSessionRegistry,
      eventsService,
      streamService,
      preflightService,
      mcpEnsureService,
      providerRuntimePlan,
      preparedProviderRuntime,
      providerRuntimePreparation,
      forkAdapter,
      launchPipeline,
      savePoints,
      sessionRows,
      hooks,
    },
  };
}
