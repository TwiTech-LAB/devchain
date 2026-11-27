// Backend integration: real in-memory SQLite and the real coordinator are the cheapest layer that
// shows which rows each restore, rollback and stop writes when they interleave across agents.
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { createTestDatabase } from '../../../common/test/test-database.helper';
import { beforeRollbackRecordId, SessionRowStore } from '../../storage/sessions/session-row.store';
import { SessionCoordinatorService } from './session-coordinator.service';
import { SessionsService } from './sessions.service';
import { SessionTerminalRuntimeService } from '../../session-terminal-runtime/session-terminal-runtime.service';
import { SessionRestorePipeline } from './session-runtime/session-restore-pipeline.service';
import { SessionLaunchPipeline } from './session-runtime/session-launch-pipeline.service';
import { SessionRuntime } from './session-runtime';
import { EpicTimeStore } from '../../epic-time/services/epic-time.store';
import { createProjectWriteGateStub } from '../../storage/write-gate/testing/project-write-gate.stub';
import { LocalStorageService } from '../../storage/local/local-storage.service';
import { AgentsController } from '../../agents/controllers/agents.controller';
import { TeamsService } from '../../teams/services/teams.service';
import { SessionLifecycleFacade } from './session-lifecycle-facade.service';
import { restartAgentAction } from '../../subscribers/actions/restart-agent.action';
import { deleteAgentAction } from '../../subscribers/actions/delete-agent.action';
import { terminateSessionAction } from '../../subscribers/actions/terminate-session.action';
import { NotFoundError } from '../../../common/errors/error-types';
import { chmod, mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostResolver } from '@devchain/shared';
import { PreflightService } from '../../core/services/preflight.service';
import { FakeProcessExecutor } from '../../terminal/services/process-executor/fake-process-executor';
import { getEnvConfig } from '../../../common/config/env.config';

jest.mock('../../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const PROJECT = '00000000-0000-4000-8000-000000000001';
// Ids sort in this order, which is the order the coordinator takes their locks.
const A = 'aaaaaaaa-0000-4000-8000-000000000000';
const B = 'bbbbbbbb-0000-4000-8000-000000000000';
const C = 'cccccccc-0000-4000-8000-000000000000';
const STRANGER = 'dddddddd-0000-4000-8000-000000000000';
const OTHER_PROVIDER = 'eeeeeeee-0000-4000-8000-000000000000';
/** The config of OTHER_PROVIDER's profile on the provider that S launched with. */
const SWITCH = 'config-switch';
const NOW = '2026-11-01T10:00:00.000Z';
const STOP = { source: 'web-api' as const, reason: 'user-requested' as const };

const sid = (n: number) => `5e551011-0000-4000-8000-${String(n).padStart(12, '0')}`;
const S = sid(1);
const SAVE_POINT = sid(2);
const BEFORE_ROLLBACK = beforeRollbackRecordId(S);
const FORK = sid(3);

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('Timed out waiting for a lifecycle checkpoint');
}

describe('restore of a family session into another agent', () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database;
  let coordinator: SessionCoordinatorService;
  let sessions: SessionsService;
  let runtime: SessionRuntime;
  let liveTmux: Set<string>;
  let terminalIO: Record<string, jest.Mock>;
  let streamService: {
    cancelScheduledClear: jest.Mock;
    scheduleClear: jest.Mock;
    retireReplay: jest.Mock;
  };
  let eventsService: { publish: jest.Mock };
  let providerRuntimePreparation: { createPlan: jest.Mock; materialize: jest.Mock };
  let preflightService: { runChecks: jest.Mock };
  let mcpEnsureService: { ensureMcp: jest.Mock };
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = '/tmp/family';
    ({ sqlite } = createTestDatabase());
    db = drizzle(sqlite);
    coordinator = new SessionCoordinatorService();
    liveTmux = new Set();
    seedAgents();

    terminalIO = {
      createEmptySession: jest.fn(async (name: string) => {
        liveTmux.add(name);
        return { name };
      }),
      destroyExpectedSession: jest.fn(async ({ name }: { name: string }) =>
        liveTmux.delete(name) ? { outcome: 'destroyed' } : { outcome: 'known-absent' },
      ),
      setAlternateScreen: jest.fn().mockResolvedValue(undefined),
      typeCommand: jest.fn().mockResolvedValue(undefined),
      startHealthCheck: jest.fn(),
    };
    const ptyService = { startStreaming: jest.fn(), stopStreaming: jest.fn() };
    const registry = { create: jest.fn(), bind: jest.fn(), dispose: jest.fn(), get: jest.fn() };
    eventsService = { publish: jest.fn().mockResolvedValue(undefined) };
    streamService = {
      cancelScheduledClear: jest.fn().mockReturnValue(null),
      scheduleClear: jest.fn(),
      retireReplay: jest.fn(),
    };
    const adapter = { providerName: 'test-provider' };
    const providerAdapterFactory = { getAdapter: jest.fn().mockReturnValue(adapter) };
    mcpEnsureService = { ensureMcp: jest.fn().mockResolvedValue(undefined) };
    preflightService = {
      runChecks: jest.fn(async (_path: string, opts?: { providerIds?: string[] }) => ({
        overall: 'pass',
        checks: [],
        providers: (opts?.providerIds ?? []).map((id) => ({ id, mcpStatus: 'pass' })),
      })),
    };
    providerRuntimePreparation = {
      createPlan: jest.fn(async (input: { mode: string }) =>
        input.mode === 'fork'
          ? {
              ...input,
              fork: { providerSessionId: 'rolled-native', transcriptPath: '/tmp/rolled.jsonl' },
            }
          : input,
      ),
      materialize: jest.fn(async () => ({
        typedArgs: ['/bin/sh', '/private/launch/session.sh'],
        afterCommand: jest.fn().mockResolvedValue(undefined),
        rollback: jest.fn().mockResolvedValue(undefined),
      })),
    };
    const forkCollaborators = {
      requireForkSupport: jest.fn().mockResolvedValue({
        adapter,
        providerBinPath: '/usr/bin/test-provider',
        helperEnv: {},
      }),
      readableForkSource: jest.fn(async (source: unknown) => source),
      setupHooksConfig: jest.fn().mockResolvedValue(undefined),
      verifyProvider: jest.fn().mockResolvedValue(undefined),
      verifyAgentProvider: jest.fn().mockResolvedValue(undefined),
      validateFork: jest.fn().mockResolvedValue({
        provider: { name: 'test-provider' },
        project: { rootPath: '/tmp/family' },
        configEnv: null,
      }),
      assertCurrentForkProvider: jest.fn().mockResolvedValue({}),
      launchUnderLock: jest.fn().mockResolvedValue({ status: 'running' }),
    };
    const savePoints = {
      isTeamMember: jest.fn().mockResolvedValue(false),
      readableTranscript: jest.fn(async (path: string) => path),
    };
    const runtimeProviders = {
      prepare: jest.fn(),
      cleanupSessionSync: jest.fn(),
      cleanupSession: jest.fn().mockResolvedValue(undefined),
    };

    const sessionTerminalRuntime = new SessionTerminalRuntimeService(
      db,
      providerAdapterFactory as never,
      { clear: jest.fn(), snapshot: jest.fn(), restoreSnapshot: jest.fn() } as never,
      runtimeProviders as never,
      runtimeProviders as never,
      runtimeProviders as never,
      new SessionRowStore(db),
    );
    const restorePipeline = new SessionRestorePipeline(
      db,
      storage() as never,
      coordinator,
      providerAdapterFactory as never,
      terminalIO as never,
      ptyService as never,
      registry as never,
      eventsService as never,
      streamService as never,
      providerRuntimePreparation as never,
      preflightService as never,
      mcpEnsureService as never,
      new SessionRowStore(db),
      forkCollaborators as never,
      savePoints as never,
      { fenceRuntime: jest.fn() } as never,
    );
    sessions = new SessionsService(
      db,
      storage() as never,
      terminalIO as never,
      ptyService as never,
      preflightService as never,
      {} as never,
      coordinator,
      {} as never,
      providerAdapterFactory as never,
      eventsService as never,
      registry as never,
      sessionTerminalRuntime,
      new EpicTimeStore(db),
      { listRemoteOwnedProjectIds: () => [] } as never,
      new SessionRowStore(db),
    );
    runtime = new SessionRuntime(
      forkCollaborators as never,
      restorePipeline,
      createProjectWriteGateStub() as never,
      sessions,
      coordinator,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
    sqlite.close();
  });

  /** Storage reads backed by the seeded rows, so a disabled flag or a moved row is seen live. */
  function storage() {
    const agent = (id: string) => {
      const row = sqlite
        .prepare(
          `SELECT id, project_id AS projectId, profile_id AS profileId,
                  provider_config_id AS providerConfigId, model_override AS modelOverride,
                  effort_override AS effortOverride, name, disabled
           FROM agents WHERE id = ?`,
        )
        .get(id) as { disabled: number } | undefined;
      if (!row) throw new Error(`no agent ${id}`);
      return { ...row, disabled: row.disabled === 1 };
    };
    return {
      getAgent: jest.fn(async (id: string) => agent(id)),
      getProject: jest.fn(async () => ({ id: PROJECT, name: 'Family', rootPath: projectRoot })),
      getEpic: jest.fn().mockRejectedValue(new Error('no epic')),
      getAgentProfile: jest.fn(async (id: string) => ({ id })),
      listProfileProviderConfigsByProfile: jest.fn(async (profileId: string) =>
        sqlite
          .prepare(
            `SELECT id, provider_id AS providerId FROM profile_provider_configs
             WHERE profile_id = ?`,
          )
          .all(profileId)
          .map((config) => ({ ...(config as object), options: null, env: null })),
      ),
      getProfileProviderConfig: jest.fn(async (id: string) => {
        const config = sqlite
          .prepare(
            `SELECT id, profile_id AS profileId, provider_id AS providerId
             FROM profile_provider_configs WHERE id = ?`,
          )
          .get(id);
        if (!config) throw new NotFoundError('Provider config', id);
        return { ...(config as object), options: null, env: null };
      }),
      getProvider: jest.fn(async (id: string) =>
        sqlite.prepare('SELECT id, name, bin_path AS binPath FROM providers WHERE id = ?').get(id),
      ),
      getProviderEnvForProject: jest.fn().mockReturnValue(null),
      listAgents: jest.fn(async () => ({
        items: (sqlite.prepare('SELECT id FROM agents').all() as Array<{ id: string }>).map(
          ({ id }) => agent(id),
        ),
      })),
    };
  }

  function seedAgents(): void {
    const insert = (sql: string, ...args: unknown[]) => sqlite.prepare(sql).run(...args);
    insert(
      `INSERT INTO projects (id, name, root_path, is_template, is_private, created_at, updated_at)
       VALUES (?, 'Family', '/tmp/family', 0, 0, ?, ?)`,
      PROJECT,
      NOW,
      NOW,
    );
    for (const [id, name] of [
      ['provider-test', 'test-provider'],
      ['provider-other', 'other-provider'],
    ]) {
      insert(
        `INSERT INTO providers (id, name, bin_path, mcp_configured, created_at, updated_at)
         VALUES (?, ?, '/usr/bin/test-provider', 0, ?, ?)`,
        id,
        name,
        NOW,
        NOW,
      );
    }
    for (const [id, slug, provider] of [
      ['profile-crew', 'crew', 'provider-test'],
      ['profile-crew-other', ' CREW ', 'provider-other'],
      ['profile-stranger', null, 'provider-test'],
    ]) {
      insert(
        `INSERT INTO agent_profiles (id, project_id, name, family_slug, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        id,
        PROJECT,
        id,
        slug,
        NOW,
        NOW,
      );
      insert(
        `INSERT INTO profile_provider_configs
           (id, profile_id, provider_id, name, position, created_at, updated_at)
         VALUES (?, ?, ?, 'default', 0, ?, ?)`,
        `config-${id}`,
        id,
        provider,
        NOW,
        NOW,
      );
    }
    insert(
      `INSERT INTO profile_provider_configs
         (id, profile_id, provider_id, name, position, created_at, updated_at)
       VALUES (?, 'profile-crew-other', 'provider-test', 'test', 1, ?, ?)`,
      SWITCH,
      NOW,
      NOW,
    );
    for (const [id, name, profile] of [
      [A, 'Coder A', 'profile-crew'],
      [B, 'Coder B', 'profile-crew'],
      [C, 'Coder C', 'profile-crew'],
      [STRANGER, 'Stranger', 'profile-stranger'],
      [OTHER_PROVIDER, 'Coder E', 'profile-crew-other'],
    ]) {
      insert(
        `INSERT INTO agents (id, project_id, profile_id, provider_config_id, name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        id,
        PROJECT,
        profile,
        `config-${profile}`,
        name,
        NOW,
        NOW,
      );
    }
  }

  function seedSession(row: {
    id: string;
    agentId: string;
    status?: 'running' | 'stopped' | 'failed';
    kind?: 'session' | 'save_point';
    parent?: string;
    inherited?: string[];
  }): void {
    const status = row.status ?? 'stopped';
    const tmux = status === 'running' ? `tmux-${row.id}` : null;
    if (tmux) liveTmux.add(tmux);
    sqlite
      .prepare(
        `INSERT INTO sessions
           (id, kind, parent_session_id, agent_id, tmux_session_id, status, provider_session_id,
            provider_name_at_launch, transcript_path, inherited_session_ids,
            started_at, ended_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'test-provider', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.kind ?? 'session',
        row.parent ?? null,
        row.agentId,
        tmux,
        status,
        `native-${row.id}`,
        `/tmp/${row.id}.jsonl`,
        row.inherited ? JSON.stringify(row.inherited) : null,
        NOW,
        status === 'running' ? null : NOW,
        NOW,
        NOW,
      );
  }

  /** A stopped session of A with one save point, its `Before rollback` record and one fork. */
  function seedFamilySession(): void {
    seedSession({ id: S, agentId: A });
    seedSession({ id: SAVE_POINT, agentId: A, kind: 'save_point', parent: S, inherited: [S] });
    seedSession({ id: BEFORE_ROLLBACK, agentId: A, kind: 'save_point', parent: S, inherited: [S] });
    seedSession({ id: FORK, agentId: A, parent: S, inherited: [S] });
  }

  function owners(): Record<string, string> {
    const rows = sqlite.prepare('SELECT id, agent_id FROM sessions').all() as Array<{
      id: string;
      agent_id: string;
    }>;
    return Object.fromEntries(rows.map((row) => [row.id, row.agent_id]));
  }

  function row(id: string) {
    return sqlite
      .prepare(
        'SELECT agent_id AS agentId, status, tmux_session_id AS tmux FROM sessions WHERE id = ?',
      )
      .get(id) as { agentId: string; status: string; tmux: string | null };
  }

  it('runs the session under B with the same id, moves its save points, and lets B roll back', async () => {
    seedFamilySession();

    const restored = await runtime.restore(S, PROJECT, { targetAgentId: B });

    expect(restored).toMatchObject({ id: S, agentId: B, status: 'running' });
    expect(restored.tmuxSessionId).toContain(B.slice(0, 8));
    expect(owners()).toEqual({ [S]: B, [SAVE_POINT]: B, [BEFORE_ROLLBACK]: B, [FORK]: A });
    expect(eventsService.publish).toHaveBeenCalledWith(
      'session.restored',
      expect.objectContaining({ sessionId: S, agentId: B }),
    );

    await sessions.terminateSession(S, STOP);
    await expect(
      runtime.rollback(S, { projectId: PROJECT, savePointId: SAVE_POINT, keepCurrent: false }),
    ).resolves.toMatchObject({ id: S, agentId: B, status: 'running' });
    expect(row(S)).toMatchObject({ agentId: B, status: 'running' });
  });

  it('puts back the owner of the row and of the moved save points when the start fails', async () => {
    seedFamilySession();
    const lifecycle = sqlite.prepare(
      'SELECT id, agent_id, status, ended_at, tmux_session_id FROM sessions ORDER BY id',
    );
    const before = lifecycle.all();
    terminalIO.typeCommand.mockRejectedValueOnce(new Error('CLI spawn failed'));

    await expect(runtime.restore(S, PROJECT, { targetAgentId: B })).rejects.toThrow(
      'CLI spawn failed',
    );

    expect(lifecycle.all()).toEqual(before);
    expect(liveTmux.size).toBe(0);
  });

  it.each([
    { target: STRANGER, statusCode: 403, code: 'SESSION_FAMILY_MISMATCH' },
    { target: OTHER_PROVIDER, statusCode: 409, code: 'PROVIDER_MISMATCH' },
    { target: C, statusCode: 409, code: 'AGENT_DISABLED', disable: true },
  ])('refuses target $target with $code', async ({ target, statusCode, code, disable }) => {
    seedFamilySession();
    if (disable) sqlite.prepare('UPDATE agents SET disabled = 1 WHERE id = ?').run(target);
    const before = owners();

    await expect(runtime.restore(S, PROJECT, { targetAgentId: target })).rejects.toMatchObject({
      statusCode,
      ...(code === 'AGENT_DISABLED' ? {} : { details: { code } }),
    });

    expect(owners()).toEqual(before);
    expect(row(S).status).toBe('stopped');
    expect(terminalIO.createEmptySession).not.toHaveBeenCalled();
  });

  it("stops the target's running session as the replacement, never the owner's", async () => {
    seedFamilySession();
    seedSession({ id: sid(10), agentId: A, status: 'running' });
    seedSession({ id: sid(11), agentId: B, status: 'running' });

    await runtime.restore(S, PROJECT, { targetAgentId: B, replaceRunningSessionId: sid(11) });

    expect(row(sid(11)).status).toBe('stopped');
    expect(row(sid(10)).status).toBe('running');
    expect(liveTmux.has(`tmux-${sid(10)}`)).toBe(true);
    expect(row(S)).toMatchObject({ agentId: B, status: 'running' });
  });

  /** Preflight answers with this check for every provider the restore names. */
  function preflightReports(check: Record<string, unknown>): void {
    preflightService.runChecks.mockImplementation(
      async (_path: string, opts?: { providerIds?: string[] }) => ({
        overall: 'fail',
        checks: [],
        providers: (opts?.providerIds ?? []).map((id) => ({ id, ...check })),
      }),
    );
  }

  // The real preflight is the binary-check boundary: it runs `access` on the configured path.
  // Only the MCP registration list, the adapter registry and tmux are faked.
  describe('destination binary checked by the real preflight', () => {
    let root: string;
    let binary: string;
    let registered: boolean;

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), 'family-restore-'));
      projectRoot = root;
      await mkdir(join(root, 'bin'));
      binary = join(root, 'bin', 'test-provider');
      await writeFile(binary, '#!/bin/sh\n');
      await chmod(binary, 0o755);
      registered = true;
      const env = getEnvConfig();
      const endpoint = `${HostResolver.buildInternalBaseUrl({ host: env.HOST, port: env.PORT })}/mcp`;
      const executor = new FakeProcessExecutor();
      executor.setDefaultResponse({ type: 'success', stdout: 'tmux 3.3a' });
      const byIds = (table: string, columns: string) => async (ids: string[]) =>
        sqlite
          .prepare(`SELECT ${columns} FROM ${table} WHERE id IN (SELECT value FROM json_each(?))`)
          .all(JSON.stringify(ids));
      const preflight = new PreflightService(
        {
          findProjectByPath: async () => ({ id: PROJECT }),
          listAgents: storage().listAgents,
          listProfileProviderConfigsByIds: byIds(
            'profile_provider_configs',
            'id, profile_id AS profileId, provider_id AS providerId, NULL AS env, NULL AS options',
          ),
          listProvidersByIds: byIds('providers', 'id, name, bin_path AS binPath, NULL AS env'),
        } as never,
        {
          resolveBinary: jest.fn(),
          listRegistrations: jest.fn(async () => ({
            success: true,
            message: 'OK',
            entries: registered ? [{ alias: 'devchain', endpoint }] : [],
          })),
        } as never,
        {
          isSupported: () => true,
          getSupportedProviders: () => ['test-provider'],
          getAdapter: () => ({ providerName: 'test-provider' }),
        } as never,
        executor,
      );
      preflightService.runChecks.mockImplementation((path: string, opts?: object) =>
        preflight.runChecks(path, opts),
      );
      seedFamilySession();
      seedSession({ id: sid(11), agentId: B, status: 'running' });
    });

    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    const useBinary = (path: string) =>
      sqlite.prepare("UPDATE providers SET bin_path = ? WHERE id = 'provider-test'").run(path);
    const restoreReplacing = () =>
      runtime.restore(S, PROJECT, { targetAgentId: B, replaceRunningSessionId: sid(11) });
    const REFUSAL =
      'Provider test-provider failed the binary check: test-provider binary not accessible';
    const expectStillRunning = () => {
      expect(row(sid(11)).status).toBe('running');
      expect(terminalIO.destroyExpectedSession).not.toHaveBeenCalled();
    };

    it('refuses a configured absolute binary that does not exist, with MCP passing', async () => {
      useBinary(join(root, 'missing', 'test-provider'));

      await expect(restoreReplacing()).rejects.toThrow(REFUSAL);

      expect(mcpEnsureService.ensureMcp).not.toHaveBeenCalled();
      expectStillRunning();
      expect(row(S)).toMatchObject({ agentId: A, status: 'stopped' });
    });

    it('refuses a binary lost during the MCP repair, as the recheck reports it', async () => {
      useBinary(binary);
      registered = false;
      mcpEnsureService.ensureMcp.mockImplementationOnce(async () => {
        registered = true;
        await unlink(binary);
      });

      await expect(restoreReplacing()).rejects.toThrow(REFUSAL);

      expect(mcpEnsureService.ensureMcp).toHaveBeenCalledTimes(1);
      expectStillRunning();
      expect(row(S)).toMatchObject({ agentId: A, status: 'stopped' });
    });

    // A restart stops the running session first, so the provider check must come before it. The
    // real launch pipeline runs the check. The web route has its own test in
    // sessions-history.integration.spec.ts, through HTTP.
    describe('facade restart of an agent whose provider binary is inaccessible', () => {
      let realRuntime: SessionRuntime;

      beforeEach(() => {
        const launchPipeline = new SessionLaunchPipeline(
          db,
          storage() as never,
          coordinator,
          { getAdapter: () => ({ providerName: 'test-provider' }) } as never,
          terminalIO as never,
          {} as never,
          {} as never,
          {} as never,
          {} as never,
          {} as never,
          preflightService as never,
          mcpEnsureService as never,
          eventsService as never,
          {} as never,
          {} as never,
          providerRuntimePreparation as never,
          new SessionRowStore(db),
          { hasAccess: jest.fn().mockResolvedValue(false) } as never,
          {} as never,
        );
        realRuntime = new SessionRuntime(
          launchPipeline,
          {} as never,
          createProjectWriteGateStub() as never,
          sessions,
          coordinator,
        );
        useBinary(join(root, 'missing', 'test-provider'));
        sqlite.prepare("UPDATE sessions SET tmux_session_id = 'tmux-b' WHERE id = ?").run(sid(11));
        liveTmux.add('tmux-b');
      });

      it('facade restart (mobile and team lead) refuses and leaves the session running', async () => {
        const facade = new SessionLifecycleFacade(
          realRuntime,
          sessions,
          createProjectWriteGateStub() as never,
          coordinator,
          {} as never,
        );

        await expect(facade.restart(B, PROJECT)).rejects.toThrow(REFUSAL);

        expectStillRunning();
      });
    });

    it('restores with an accessible binary and a registration the repair fixes', async () => {
      useBinary(binary);
      registered = false;
      mcpEnsureService.ensureMcp.mockImplementationOnce(async () => {
        registered = true;
      });

      await expect(restoreReplacing()).resolves.toMatchObject({ id: S, agentId: B });

      expect(row(sid(11)).status).toBe('stopped');
    });
  });

  it('refuses a target with a running session before any MCP repair', async () => {
    seedFamilySession();
    seedSession({ id: sid(11), agentId: B, status: 'running' });
    preflightReports({ binaryStatus: 'pass', mcpStatus: 'warn' });

    await expect(runtime.restore(S, PROJECT, { targetAgentId: B })).rejects.toMatchObject({
      statusCode: 409,
      details: { code: 'INVALID_SESSION_STATE' },
    });

    expect(mcpEnsureService.ensureMcp).not.toHaveBeenCalled();
    expect(preflightService.runChecks).not.toHaveBeenCalled();
    expect(row(S)).toMatchObject({ agentId: A, status: 'stopped' });
  });

  it('refuses a target whose session started during the destination checks, before the claim', async () => {
    seedFamilySession();
    providerRuntimePreparation.createPlan.mockImplementationOnce(async (input: object) => {
      seedSession({ id: sid(11), agentId: B, status: 'running' });
      return input;
    });

    await expect(runtime.restore(S, PROJECT, { targetAgentId: B })).rejects.toMatchObject({
      statusCode: 409,
      details: { code: 'INVALID_SESSION_STATE' },
    });

    expect(row(S)).toMatchObject({ agentId: A, status: 'stopped' });
    expect(row(sid(11)).status).toBe('running');
    expect(terminalIO.createEmptySession).not.toHaveBeenCalled();
  });

  it('starts one of two competing restores; the loser keeps its session and the winner its replay', async () => {
    seedFamilySession();
    seedSession({ id: sid(11), agentId: B, status: 'running' });
    seedSession({ id: sid(12), agentId: C, status: 'running' });
    streamService.cancelScheduledClear.mockReturnValueOnce(60_000).mockReturnValue(null);

    const results = await Promise.allSettled([
      runtime.restore(S, PROJECT, { targetAgentId: B, replaceRunningSessionId: sid(11) }),
      runtime.restore(S, PROJECT, { targetAgentId: C, replaceRunningSessionId: sid(12) }),
    ]);

    const won = results.findIndex((result) => result.status === 'fulfilled');
    const [winner, loser] = won === 0 ? [B, C] : [C, B];
    const loserSession = won === 0 ? sid(12) : sid(11);
    expect(results[1 - won]).toMatchObject({
      status: 'rejected',
      reason: { statusCode: 409, details: { code: 'SESSION_RUNNING_ON_OTHER_AGENT' } },
    });
    expect(terminalIO.createEmptySession).toHaveBeenCalledTimes(1);
    expect(row(S)).toMatchObject({ agentId: winner, status: 'running' });
    expect(row(loserSession)).toMatchObject({ agentId: loser, status: 'running' });
    expect(liveTmux.has(`tmux-${loserSession}`)).toBe(true);
    expect(streamService.cancelScheduledClear).toHaveBeenCalledTimes(1);
    expect(streamService.scheduleClear).not.toHaveBeenCalled();

    // A retry by the loser meets the same lease.
    await expect(
      runtime.restore(S, PROJECT, { targetAgentId: loser, replaceRunningSessionId: loserSession }),
    ).rejects.toMatchObject({ details: { code: 'SESSION_RUNNING_ON_OTHER_AGENT' } });
    expect(row(loserSession).status).toBe('running');
  });

  it("lets one of A's rollback and B's restore win; the other changes nothing", async () => {
    seedFamilySession();

    const results = await Promise.allSettled([
      runtime.rollback(S, { projectId: PROJECT, savePointId: SAVE_POINT, keepCurrent: false }),
      runtime.restore(S, PROJECT, { targetAgentId: B }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { statusCode: 409 },
    });
    expect(terminalIO.createEmptySession).toHaveBeenCalledTimes(1);
    const rolledBack = results[0].status === 'fulfilled';
    const owner = rolledBack ? A : B;
    expect(row(S)).toMatchObject({ agentId: owner, status: 'running' });
    expect(owners()).toEqual({
      [S]: owner,
      [SAVE_POINT]: owner,
      [BEFORE_ROLLBACK]: owner,
      [FORK]: A,
    });
    const native = sqlite.prepare('SELECT provider_session_id AS id FROM sessions WHERE id = ?');
    expect(native.get(S)).toEqual({ id: rolledBack ? 'rolled-native' : `native-${S}` });
  });

  it('fails with 409 and stops no replacement when the owner changed before the locks', async () => {
    seedFamilySession();
    seedSession({ id: sid(11), agentId: B, status: 'running' });
    const held = deferred();
    const lockA = jest.spyOn(coordinator, 'withAgentLock');
    const hold = coordinator.withAgentLock(A, () => held.promise);

    const restore = runtime.restore(S, PROJECT, {
      targetAgentId: B,
      replaceRunningSessionId: sid(11),
    });
    await waitFor(() => lockA.mock.calls.filter(([key]) => key === A).length === 2);
    sqlite.prepare('UPDATE sessions SET agent_id = ? WHERE id = ?').run(C, S);
    held.resolve();
    await hold;

    await expect(restore).rejects.toMatchObject({
      statusCode: 409,
      details: { code: 'SESSION_OWNER_CHANGED' },
    });
    expect(row(sid(11)).status).toBe('running');
    expect(terminalIO.destroyExpectedSession).not.toHaveBeenCalled();
    expect(row(S)).toMatchObject({ agentId: C, status: 'stopped' });
  });

  it.each([
    {
      name: 'a running fork of the session',
      seed: () =>
        seedSession({ id: FORK, agentId: A, status: 'running', parent: S, inherited: [S] }),
      restored: S,
    },
    {
      name: 'a running sibling that shares an inherited id',
      seed: () => {
        seedSession({
          id: sid(20),
          agentId: A,
          status: 'running',
          parent: SAVE_POINT,
          inherited: [S, SAVE_POINT],
        });
        seedSession({ id: sid(21), agentId: A, parent: SAVE_POINT, inherited: [S, SAVE_POINT] });
      },
      restored: sid(21),
    },
  ])('refuses the restore before any stop when $name runs on A', async ({ seed, restored }) => {
    seedSession({ id: S, agentId: A });
    seedSession({ id: SAVE_POINT, agentId: A, kind: 'save_point', parent: S, inherited: [S] });
    seed();
    seedSession({ id: sid(11), agentId: B, status: 'running' });

    const restore = runtime.restore(restored, PROJECT, {
      targetAgentId: B,
      replaceRunningSessionId: sid(11),
    });

    await expect(restore).rejects.toMatchObject({
      statusCode: 409,
      message: 'A related session is running on agent "Coder A"',
      details: { code: 'SESSION_LINEAGE_RUNNING', agentId: A },
    });
    expect(row(sid(11)).status).toBe('running');
    expect(terminalIO.destroyExpectedSession).not.toHaveBeenCalled();
    expect(row(restored)).toMatchObject({ agentId: A, status: 'stopped' });
  });

  it("does not stop the moved row for A's agent-scoped stop; a stop by session id follows it", async () => {
    seedFamilySession();
    seedSession({ id: sid(30), agentId: A });
    const lockCalls = jest.spyOn(coordinator, 'withAgentLock');
    const queuedOnA = (count: number) =>
      waitFor(() => lockCalls.mock.calls.filter(([key]) => key === A).length === count);

    // Both stops read A as the owner and queue on A's lock behind the restore that moves the row.
    let held = deferred();
    let hold = coordinator.withAgentLock(A, () => held.promise);
    const restoreS = runtime.restore(S, PROJECT, { targetAgentId: B });
    await queuedOnA(2);
    const scopedStop = sessions.terminateSession(S, STOP, { expectedAgentId: A });
    held.resolve();
    await Promise.all([hold, restoreS, scopedStop]);
    expect(row(S)).toMatchObject({ agentId: B, status: 'running' });
    expect(liveTmux.has(row(S).tmux!)).toBe(true);

    held = deferred();
    hold = coordinator.withAgentLock(A, () => held.promise);
    const restoreOther = runtime.restore(sid(30), PROJECT, { targetAgentId: C });
    await queuedOnA(5);
    const stopById = sessions.terminateSession(sid(30), STOP);
    await queuedOnA(6);
    held.resolve();
    await Promise.all([hold, restoreOther, stopById]);
    expect(row(sid(30))).toMatchObject({ agentId: C, status: 'stopped' });
    expect(liveTmux.size).toBe(1);
  });

  it.each(['fork', 'rollback'] as const)(
    "stops nothing for A's %s when B moved the session while it waited for the lock",
    async (operation) => {
      seedFamilySession();
      seedSession({ id: sid(10), agentId: A, status: 'running' });
      const lockCalls = jest.spyOn(coordinator, 'withAgentLock');
      const queuedOnA = (count: number) =>
        waitFor(() => lockCalls.mock.calls.filter(([key]) => key === A).length === count);
      const held = deferred();
      const hold = coordinator.withAgentLock(A, () => held.promise);

      const restore = runtime.restore(S, PROJECT, { targetAgentId: B });
      await queuedOnA(2);
      const replace = { projectId: PROJECT, replaceRunningSessionId: sid(10) };
      const late =
        operation === 'fork'
          ? runtime.startFromSavePoint(SAVE_POINT, replace)
          : runtime.rollback(S, { ...replace, savePointId: SAVE_POINT, keepCurrent: false });
      await queuedOnA(3);
      held.resolve();
      const [, restored, lateResult] = await Promise.allSettled([hold, restore, late]);

      expect(restored.status).toBe('fulfilled');
      expect(lateResult).toMatchObject({
        status: 'rejected',
        reason: { statusCode: 409, details: { code: 'SESSION_OWNER_CHANGED' } },
      });
      expect(row(sid(10))).toMatchObject({ agentId: A, status: 'running' });
      expect(liveTmux.has(`tmux-${sid(10)}`)).toBe(true);
      expect(row(S)).toMatchObject({ agentId: B, status: 'running' });
    },
  );

  it('keeps a valid owner when the source agent is deleted between the claim and a failed start', async () => {
    seedFamilySession();
    sqlite.pragma('foreign_keys = ON');
    const claimed = deferred();
    const release = deferred();
    terminalIO.createEmptySession.mockImplementationOnce(async () => {
      claimed.resolve();
      await release.promise;
      throw new Error('tmux server unavailable');
    });

    const outcome = runtime.restore(S, PROJECT, { targetAgentId: B }).then(
      () => null,
      (error: Error) => error,
    );
    await claimed.promise;
    await new LocalStorageService(db).deleteAgent(A);
    release.resolve();

    expect(await outcome).toMatchObject({ message: 'tmux server unavailable' });
    expect(sqlite.prepare('SELECT 1 FROM agents WHERE id = ?').get(A)).toBeUndefined();
    expect(row(S)).toMatchObject({ agentId: B, status: 'stopped', tmux: null });
    expect(owners()).toMatchObject({ [SAVE_POINT]: B, [BEFORE_ROLLBACK]: B });
    expect(
      sqlite
        .prepare(
          `SELECT COUNT(*) AS running FROM sessions
           WHERE status = 'running' OR agent_id NOT IN (SELECT id FROM agents)`,
        )
        .get(),
    ).toEqual({ running: 0 });
    expect(liveTmux.size).toBe(0);
  });

  it('changes nothing for a fork or a rollback that expects another owner', async () => {
    seedFamilySession();
    const before = sqlite.prepare('SELECT * FROM sessions ORDER BY id').all();

    await expect(
      runtime.startFromSavePoint(SAVE_POINT, { projectId: PROJECT, expectedAgentId: B }),
    ).rejects.toMatchObject({ statusCode: 409, details: { code: 'SESSION_OWNER_CHANGED' } });
    await expect(
      runtime.rollback(S, {
        projectId: PROJECT,
        savePointId: SAVE_POINT,
        keepCurrent: false,
        expectedAgentId: B,
      }),
    ).rejects.toMatchObject({ statusCode: 409, details: { code: 'SESSION_OWNER_CHANGED' } });

    expect(sqlite.prepare('SELECT * FROM sessions ORDER BY id').all()).toEqual(before);
    expect(terminalIO.createEmptySession).not.toHaveBeenCalled();
  });

  describe('restore on the switch config of the launch provider', () => {
    const agentConfig = (id: string) =>
      sqlite
        .prepare(
          `SELECT provider_config_id AS configId, model_override AS model,
                  effort_override AS effort
           FROM agents WHERE id = ?`,
        )
        .get(id);
    const before = { configId: 'config-profile-crew-other', model: 'other-model', effort: 'high' };
    const switchRestore = (options: { replaceRunningSessionId?: string } = {}) =>
      runtime.restore(S, PROJECT, {
        targetAgentId: OTHER_PROVIDER,
        switchToProviderConfigId: SWITCH,
        ...options,
      });

    beforeEach(() => {
      seedFamilySession();
      sqlite
        .prepare(
          "UPDATE agents SET model_override = 'other-model', effort_override = 'high' WHERE id = ?",
        )
        .run(OTHER_PROVIDER);
    });

    it('runs the session on the switch config, clears the overrides and announces the agent once', async () => {
      const restored = await switchRestore();

      expect(restored).toMatchObject({ id: S, agentId: OTHER_PROVIDER, status: 'running' });
      expect(agentConfig(OTHER_PROVIDER)).toEqual({ configId: SWITCH, model: null, effort: null });
      expect(providerRuntimePreparation.createPlan).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: expect.objectContaining({ id: 'provider-test' }),
          agentModelOverride: null,
          agentEffortOverride: null,
        }),
      );
      const events = eventsService.publish.mock.calls.map(([name]) => name);
      expect(events.filter((name) => name === 'agent.updated')).toHaveLength(1);
      expect(events.indexOf('agent.updated')).toBeLessThan(events.indexOf('session.restored'));
    });

    it.each([
      {
        name: 'a missing config',
        config: '00000000-0000-4000-8000-00000000c0de',
        statusCode: 400,
        code: 'CONFIG_NOT_FOUND',
      },
      {
        name: 'a config of another profile',
        config: 'config-profile-crew',
        statusCode: 400,
        code: 'CONFIG_PROFILE_MISMATCH',
      },
      {
        name: 'a config on another provider than the launch provider',
        config: 'config-profile-crew-other',
        statusCode: 409,
        code: 'SWITCH_CONFIG_PROVIDER_MISMATCH',
      },
      {
        name: 'a session with no launch provider',
        config: SWITCH,
        statusCode: 409,
        code: 'SWITCH_CONFIG_PROVIDER_MISMATCH',
        seed: () =>
          sqlite.prepare('UPDATE sessions SET provider_name_at_launch = NULL WHERE id = ?').run(S),
      },
      ...[
        {
          change: 'deleted',
          code: 'CONFIG_NOT_FOUND',
          statusCode: 400,
          sql: 'DELETE FROM profile_provider_configs WHERE id = ?',
        },
        {
          change: 'moved to another profile',
          code: 'CONFIG_PROFILE_MISMATCH',
          statusCode: 400,
          sql: "UPDATE profile_provider_configs SET profile_id = 'profile-crew' WHERE id = ?",
        },
        {
          change: 'moved to another provider',
          code: 'SWITCH_CONFIG_PROVIDER_MISMATCH',
          statusCode: 409,
          sql: "UPDATE profile_provider_configs SET provider_id = 'provider-other' WHERE id = ?",
        },
      ].map(({ change, code, statusCode, sql }) => ({
        name: `a config ${change} after the checks, before the claim`,
        config: SWITCH,
        statusCode,
        code,
        seed: () =>
          providerRuntimePreparation.createPlan.mockImplementationOnce(async (input: object) => {
            sqlite.prepare(sql).run(SWITCH);
            return input;
          }),
      })),
    ])(
      'refuses $name with $code and leaves the agent',
      async ({ config, statusCode, code, seed }) => {
        seed?.();

        await expect(
          runtime.restore(S, PROJECT, {
            targetAgentId: OTHER_PROVIDER,
            switchToProviderConfigId: config,
          }),
        ).rejects.toMatchObject({ statusCode, details: { code } });

        expect(agentConfig(OTHER_PROVIDER)).toEqual(before);
        expect(row(S)).toMatchObject({ agentId: A, status: 'stopped' });
        expect(terminalIO.createEmptySession).not.toHaveBeenCalled();
      },
    );

    it.each([
      {
        name: 'a destination provider with no binary path',
        refuse: () =>
          sqlite.prepare("UPDATE providers SET bin_path = NULL WHERE id = 'provider-test'").run(),
        message: 'Provider test-provider is missing a binary path',
      },
      {
        name: 'a destination with no preflight result',
        refuse: () =>
          preflightService.runChecks.mockResolvedValueOnce({
            overall: 'pass',
            checks: [],
            providers: [],
          }),
        message: 'Preflight returned no check for the provider',
      },
    ])('refuses $name before it stops the replacement', async ({ refuse, message }) => {
      seedSession({ id: sid(11), agentId: OTHER_PROVIDER, status: 'running' });
      refuse();

      await expect(switchRestore({ replaceRunningSessionId: sid(11) })).rejects.toThrow(message);

      expect(row(sid(11)).status).toBe('running');
      expect(terminalIO.destroyExpectedSession).not.toHaveBeenCalled();
      expect(agentConfig(OTHER_PROVIDER)).toEqual(before);
    });

    it.each([
      {
        name: 'the runtime start fails',
        fail: () => terminalIO.typeCommand.mockRejectedValueOnce(new Error('CLI spawn failed')),
        message: 'CLI spawn failed',
      },
      {
        name: 'the session.restored publish fails',
        fail: () =>
          eventsService.publish.mockImplementation(async (name: string) => {
            if (name === 'session.restored') throw new Error('invalid payload');
          }),
        message: 'invalid payload',
      },
    ])('puts the agent and the session back when $name', async ({ fail, message }) => {
      fail();

      await expect(switchRestore()).rejects.toThrow(message);

      expect(agentConfig(OTHER_PROVIDER)).toEqual(before);
      expect(row(S)).toMatchObject({ agentId: A, status: 'stopped', tmux: null });
      expect(liveTmux.size).toBe(0);
    });

    it('keeps an agent edit made after the claim when the start fails', async () => {
      terminalIO.typeCommand.mockImplementationOnce(async () => {
        sqlite
          .prepare("UPDATE agents SET model_override = 'edited' WHERE id = ?")
          .run(OTHER_PROVIDER);
        throw new Error('CLI spawn failed');
      });

      await expect(switchRestore()).rejects.toThrow('CLI spawn failed');

      expect(agentConfig(OTHER_PROVIDER)).toEqual({
        configId: SWITCH,
        model: 'edited',
        effort: null,
      });
      expect(row(S)).toMatchObject({ agentId: A, status: 'stopped' });
    });
  });

  /**
   * Each caller reads A's running session S, then S stops and is restored into B before the caller
   * stops it. A stop chosen through A must leave S running on B.
   */
  describe('stops chosen through an agent, after the session moved to another agent', () => {
    const quietLogger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const launched = { id: sid(50), agentId: A, status: 'running' } as never;

    beforeEach(() => {
      seedSession({ id: S, agentId: A, status: 'running' });
      jest.spyOn(runtime, 'launch').mockResolvedValue(launched);
    });

    async function moveSToB(): Promise<void> {
      await sessions.terminateSession(S, STOP);
      await runtime.restore(S, PROJECT, { targetAgentId: B });
    }

    /** The first `listActiveSessions` call returns its snapshot only after S moved to B. */
    function staleActiveSessions(): void {
      const read = sessions.listActiveSessions.bind(sessions);
      jest.spyOn(sessions, 'listActiveSessions').mockImplementationOnce(async (...args) => {
        const snapshot = await read(...args);
        await moveSToB();
        return snapshot;
      });
    }

    function expectBStillRunsS(): void {
      expect(row(S)).toMatchObject({ agentId: B, status: 'running' });
      expect(liveTmux.has(row(S).tmux!)).toBe(true);
    }

    function actionStorage() {
      const agents = () =>
        (
          sqlite
            .prepare(
              `SELECT id, project_id AS projectId, profile_id AS profileId, name FROM agents
               WHERE disabled = 0`,
            )
            .all() as Array<{ id: string; name: string }>
        ).map((agent) => ({ ...agent, disabled: false, isProjectOwner: false }));
      return {
        ...storage(),
        getAgentByName: jest.fn(async (_projectId: string, name: string) => {
          const agent = agents().find((candidate) => candidate.name === name);
          if (!agent) throw new Error(`no agent ${name}`);
          return agent;
        }),
        listAgents: jest.fn(async () => ({ items: agents() })),
        listAgentProfiles: jest.fn(async () => ({
          items: sqlite.prepare('SELECT id, family_slug AS familySlug FROM agent_profiles').all(),
        })),
        deleteAgent: jest.fn().mockResolvedValue(undefined),
      };
    }

    function actionContext(over: Record<string, unknown> = {}) {
      return {
        sessionsService: sessions,
        sessionRuntime: runtime,
        sessionCoordinator: coordinator,
        storage: actionStorage(),
        projectId: PROJECT,
        agentId: A,
        sessionId: sid(99),
        logger: quietLogger,
        teamsService: {
          listTeamsLedByAgent: jest.fn().mockResolvedValue([]),
          deleteAgentForAutomation: jest.fn().mockResolvedValue({}),
        },
        ...over,
      } as never;
    }

    function teamsService(getActiveSession: () => Promise<unknown>): TeamsService {
      const gate = createProjectWriteGateStub() as never;
      const team = { id: 'team-crew', projectId: PROJECT, name: 'Crew', teamLeadAgentId: C };
      return new TeamsService(
        {
          getTeamLeadTeams: jest.fn().mockResolvedValue([team]),
          getTeam: jest
            .fn()
            .mockResolvedValue({ ...team, members: [{ agentId: A }, { agentId: C }] }),
          listTeamsByAgent: jest.fn().mockResolvedValue([team]),
        } as never,
        actionStorage() as never,
        { get: () => sessions } as never,
        { removeAgentFromProjectPresets: jest.fn().mockResolvedValue(undefined) } as never,
        gate,
        new SessionLifecycleFacade(runtime, sessions, gate, coordinator, {} as never),
        { getActiveSession: jest.fn(getActiveSession) } as never,
        {} as never,
        {} as never,
        {} as never,
      );
    }

    const teamInput = { leadAgentId: C, projectId: PROJECT, name: 'Coder A' };

    it('web restart', async () => {
      staleActiveSessions();
      const controller = new AgentsController(
        storage() as never,
        sessions,
        coordinator,
        runtime,
        {} as never,
        createProjectWriteGateStub() as never,
        {} as never,
      );

      await controller.restartAgent(A, { projectId: PROJECT });

      expectBStillRunsS();
    });

    it('team stop', async () => {
      const service = teamsService(async () => {
        await moveSToB();
        return { sessionId: S };
      });

      await expect(
        service.controlTeamMemberSession({ ...teamInput, action: 'stop' }),
      ).resolves.toMatchObject({ result: { action: 'stop', previousSessionId: S } });

      expectBStillRunsS();
    });

    it('team delete', async () => {
      staleActiveSessions();

      await service().deleteTeamAgent(teamInput);

      expectBStillRunsS();

      function service() {
        return teamsService(async () => null);
      }
    });

    it('subscriber restart', async () => {
      staleActiveSessions();

      await expect(restartAgentAction.execute(actionContext(), {})).resolves.toMatchObject({
        success: true,
      });

      expectBStillRunsS();
    });

    it('subscriber delete', async () => {
      staleActiveSessions();

      await expect(
        deleteAgentAction.execute(actionContext(), { agentName: 'Coder A' }),
      ).resolves.toMatchObject({ success: true });

      expectBStillRunsS();
    });

    it('subscriber terminate by family', async () => {
      staleActiveSessions();

      await expect(
        terminateSessionAction.execute(actionContext(), { familySlug: 'crew' }),
      ).resolves.toMatchObject({ success: true });

      expectBStillRunsS();
    });

    // This path reads its snapshot synchronously, so the row moves to B in the same step.
    it('subscriber terminate by agent name', async () => {
      const read = sessions.getActiveSessionForAgent.bind(sessions);
      jest.spyOn(sessions, 'getActiveSessionForAgent').mockImplementationOnce((agentId) => {
        const snapshot = read(agentId);
        sqlite.prepare('UPDATE sessions SET agent_id = ? WHERE id = ?').run(B, S);
        return snapshot;
      });

      await expect(
        terminateSessionAction.execute(actionContext(), { agentName: 'Coder A' }),
      ).resolves.toMatchObject({ success: true });

      expect(row(S)).toMatchObject({ agentId: B, status: 'running', tmux: `tmux-${S}` });
      expect(liveTmux.has(`tmux-${S}`)).toBe(true);
    });

    it("subscriber terminate of the event's session still follows its owner", async () => {
      staleActiveSessions();
      await moveSToB();

      await expect(
        terminateSessionAction.execute(actionContext({ sessionId: S }), {}),
      ).resolves.toMatchObject({ success: true });

      expect(row(S)).toMatchObject({ agentId: B, status: 'stopped' });
    });

    it("stops A's own session and keeps B's when a restore into B and A's stop run at once", async () => {
      const own = sid(51);
      await sessions.terminateSession(S, STOP);
      seedSession({ id: own, agentId: A, status: 'running' });

      const restore = runtime.restore(S, PROJECT, { targetAgentId: B });
      const stop = sessions.terminateSession(own, STOP, { expectedAgentId: A });
      await Promise.all([restore, stop]);

      expectBStillRunsS();
      expect(row(own)).toMatchObject({ agentId: A, status: 'stopped' });
      const before = owners();
      const tmuxBefore = [...liveTmux];

      await sessions.terminateSession(S, STOP, { expectedAgentId: A });
      await sessions.terminateSession(own, STOP, { expectedAgentId: A });

      expect(owners()).toEqual(before);
      expect([...liveTmux]).toEqual(tmuxBefore);
      expectBStillRunsS();
    });
  });
});
