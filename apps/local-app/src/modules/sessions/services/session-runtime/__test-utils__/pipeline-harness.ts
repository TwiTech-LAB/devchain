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
    autoCompactThreshold1m: null,
    oneMillionContextEnabled: false,
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

  const db = {
    session: { client: { prepare } },
  };

  return { db, prepare, defaultStmt };
}

// ── Provider adapter mock ──────────────────────────────────────────────

export function createMockAdapter(providerName = 'test-provider') {
  return {
    providerName,
    launchInitialPromptBehavior: undefined,
    buildLaunchArgs: jest.fn().mockReturnValue({
      argv: [providerName, '--session', 'new'],
    }),
    evaluateAutoCompactConfig: jest.fn().mockResolvedValue({ enabled: true }),
  };
}

// ── Full harness for SessionLaunchPipeline ─────────────────────────────

export function createLaunchPipelineHarness() {
  const sqliteMock = createSqliteMock();
  const adapter = createMockAdapter();

  const storage = {
    getAgent: jest.fn().mockResolvedValue(fakeAgent()),
    getProject: jest.fn().mockResolvedValue(fakeProject()),
    getEpic: jest.fn().mockResolvedValue(fakeEpic()),
    getAgentProfile: jest.fn().mockResolvedValue(fakeProfile()),
    getProvider: jest.fn().mockResolvedValue(fakeProvider()),
    getInitialSessionPrompt: jest.fn().mockResolvedValue(null),
    listProfileProviderConfigsByProfile: jest.fn().mockResolvedValue([fakeProfileProviderConfig()]),
  };

  const sessionCoordinator = {
    withAgentLock: jest.fn().mockImplementation((_id: string, fn: () => Promise<unknown>) => fn()),
  };

  const providerAdapterFactory = {
    getAdapter: jest.fn().mockReturnValue(adapter),
  };

  const terminalIO = {
    createEmptySession: jest.fn().mockResolvedValue(undefined),
    destroySession: jest.fn().mockResolvedValue(undefined),
    disableAlternateScreen: jest.fn().mockResolvedValue(undefined),
    typeCommand: jest.fn().mockResolvedValue(undefined),
    waitForOutput: jest.fn().mockResolvedValue(undefined),
    deliver: jest.fn().mockResolvedValue(undefined),
    sessionExists: jest.fn().mockResolvedValue(false),
    startHealthCheck: jest.fn(),
  };

  const ptyService = {
    startStreaming: jest.fn().mockResolvedValue(undefined),
  };

  const terminalSessionRegistry = {
    create: jest.fn(),
    dispose: jest.fn(),
    bind: jest.fn(),
  };

  const hooksConfigService = {
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
  };

  const eventsService = {
    publish: jest.fn().mockResolvedValue(undefined),
  };

  const teamsService = {
    listTeamsByAgent: jest.fn().mockResolvedValue([]),
  };

  // Build the pipeline via direct instantiation (bypass DI decorators)
  // Constructor order matches the @Injectable constructor parameter order.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { SessionLaunchPipeline } = require('../session-launch-pipeline.service');
  const pipeline = new SessionLaunchPipeline(
    sqliteMock.db, // @Inject(DB_CONNECTION)
    storage, // @Inject(STORAGE_SERVICE)
    sessionCoordinator, // SessionCoordinatorService
    providerAdapterFactory, // ProviderAdapterFactory
    terminalIO, // TerminalIOService
    ptyService, // PtyService
    terminalSessionRegistry, // TerminalSessionRegistry
    hooksConfigService, // HooksConfigService
    preflightService, // PreflightService
    mcpEnsureService, // ProviderMcpEnsureService
    eventsService, // EventsService
    teamsService, // TeamsService
  );

  return {
    pipeline,
    mocks: {
      sqliteMock,
      adapter,
      storage,
      sessionCoordinator,
      providerAdapterFactory,
      terminalIO,
      ptyService,
      terminalSessionRegistry,
      hooksConfigService,
      preflightService,
      mcpEnsureService,
      eventsService,
      teamsService,
    },
  };
}

// ── Full harness for SessionRestorePipeline ─────────────────────────────

export function createRestorePipelineHarness() {
  const sqliteMock = createSqliteMock();
  const adapter = createMockAdapter();

  // For restore, the adapter.buildLaunchArgs must include the providerSessionId
  adapter.buildLaunchArgs.mockImplementation((input: { providerSessionId?: string }) => ({
    argv: ['test-provider', '--resume', input.providerSessionId ?? 'sess-id'],
  }));

  const storage = {
    getAgent: jest.fn().mockResolvedValue(fakeAgent()),
    getProject: jest.fn().mockResolvedValue(fakeProject()),
    getEpic: jest.fn().mockResolvedValue(fakeEpic()),
    getAgentProfile: jest.fn().mockResolvedValue(fakeProfile()),
    getProvider: jest.fn().mockResolvedValue(fakeProvider()),
    getInitialSessionPrompt: jest.fn().mockResolvedValue(null),
    listProfileProviderConfigsByProfile: jest.fn().mockResolvedValue([fakeProfileProviderConfig()]),
  };

  const sessionCoordinator = {
    withAgentLock: jest.fn().mockImplementation((_id: string, fn: () => Promise<unknown>) => fn()),
  };

  const providerAdapterFactory = {
    getAdapter: jest.fn().mockReturnValue(adapter),
  };

  const terminalIO = {
    createEmptySession: jest.fn().mockResolvedValue(undefined),
    destroySession: jest.fn().mockResolvedValue(undefined),
    disableAlternateScreen: jest.fn().mockResolvedValue(undefined),
    typeCommand: jest.fn().mockResolvedValue(undefined),
    sessionExists: jest.fn().mockResolvedValue(false),
    startHealthCheck: jest.fn(),
  };

  const ptyService = {
    startStreaming: jest.fn().mockResolvedValue(undefined),
  };

  const terminalSessionRegistry = {
    create: jest.fn(),
    dispose: jest.fn(),
    bind: jest.fn(),
  };

  const eventsService = {
    publish: jest.fn().mockResolvedValue(undefined),
  };

  const terminalGateway = {
    broadcastEvent: jest.fn(),
  };

  // Default: prepare returns a stopped session row when called with SELECT,
  // and a normal statement for INSERT/UPDATE.
  const stoppedSessionRow = {
    id: 'session-1',
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

  const selectStmt = {
    run: jest.fn().mockReturnValue({ changes: 1 }),
    get: jest.fn().mockReturnValue(stoppedSessionRow),
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

  // eslint-disable-next-line @typescript-eslint/no-var-requires
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
    terminalGateway, // TerminalGateway
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
      terminalGateway,
    },
  };
}
