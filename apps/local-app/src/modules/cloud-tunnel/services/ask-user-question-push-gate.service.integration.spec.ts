// Backend integration: real SQLite is the cheapest reliable proof of this persisted contract.
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'path';
import {
  AskUserQuestionPushGateService,
  AUQ_NATIVE_PUSH_GRACE_MS,
} from './ask-user-question-push-gate.service';
import { CloudSessionManagerService } from '../../cloud/services/cloud-session-manager.service';
import { EgressQueueService } from '../../cloud/services/egress-queue.service';
import { EventMapperService } from '../../cloud/services/event-mapper.service';
import { ProjectEgressConfigService } from '../../cloud/services/project-egress-config.service';
import { TunnelClientService } from './tunnel-client.service';
import type { ClaudeHooksAskUserQuestionPendingEventPayload } from '../../events/catalog/claude.hooks.ask_user_question.pending';
import { GUEST_SANDBOX_ROOT_PATH } from '../../guests/constants';

const MIGRATIONS_FOLDER = join(__dirname, '../../../../drizzle');
const ENABLED_PROJECTS_KEY = 'cloud.egress.enabledProjects';
const DEFAULT_ENABLED_KEY = 'cloud.egress.newProjectsDefaultEnabled';
const DEFAULT_PROJECT_ID = '11111111-1111-1111-1111-111111111111';
const TS = '2026-07-31T00:00:00.000Z';

function makePayload(
  overrides: Partial<ClaudeHooksAskUserQuestionPendingEventPayload> = {},
): ClaudeHooksAskUserQuestionPendingEventPayload {
  return {
    projectId: DEFAULT_PROJECT_ID,
    agentId: '22222222-2222-2222-2222-222222222222',
    sessionId: '33333333-3333-3333-3333-333333333333',
    claudeSessionId: 'claude-sess-1',
    toolUseId: 'tool-use-1',
    questions: [
      {
        question: 'Pick one',
        header: 'Choice',
        multiSelect: false,
        options: [{ label: 'A', description: '' }],
      },
    ],
    createdAt: 1,
    expiresAt: 2,
    ...overrides,
  };
}

describe('AskUserQuestionPushGateService', () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database;
  let gate: AskUserQuestionPushGateService;
  let cloudSession: { getStatus: jest.Mock };
  let egressQueue: { enqueue: jest.Mock };
  let projectConfig: ProjectEgressConfigService;
  let tunnelClient: { querySseLiveness: jest.Mock; getInstanceId: jest.Mock };
  const eventMapper = new EventMapperService();

  beforeEach(() => {
    jest.useFakeTimers();
    sqlite = new Database(':memory:');
    db = drizzle(sqlite);
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    upsertSetting(DEFAULT_ENABLED_KEY, true);
    insertProject(DEFAULT_PROJECT_ID, '/tmp/default-project');

    cloudSession = {
      getStatus: jest.fn().mockReturnValue({ connected: true, userId: 'user-1' }),
    };
    egressQueue = { enqueue: jest.fn() };
    projectConfig = new ProjectEgressConfigService(db);
    tunnelClient = {
      querySseLiveness: jest.fn().mockResolvedValue({ live: false, lastSeenAt: null }),
      getInstanceId: jest.fn().mockReturnValue('inst-1'),
    };

    gate = new AskUserQuestionPushGateService(
      cloudSession as unknown as CloudSessionManagerService,
      egressQueue as unknown as EgressQueueService,
      eventMapper,
      projectConfig,
      tunnelClient as unknown as TunnelClientService,
    );
  });

  afterEach(() => {
    gate.onModuleDestroy();
    jest.useRealTimers();
    sqlite.close();
  });

  function insertProject(id: string, rootPath: string): void {
    sqlite
      .prepare(
        `INSERT INTO projects
         (id, name, root_path, is_template, created_at, updated_at)
         VALUES (?, ?, ?, 0, ?, ?)`,
      )
      .run(id, id, rootPath, TS, TS);
  }

  function upsertSetting(key: string, value: unknown): void {
    sqlite
      .prepare(
        `INSERT INTO settings (id, key, value, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(randomUUID(), key, JSON.stringify(value), TS, TS);
  }

  async function fireAndSettle(payload = makePayload()) {
    await gate.onPending(payload);
    jest.advanceTimersByTime(AUQ_NATIVE_PUSH_GRACE_MS);
    // Flush the async decide() chain (querySseLiveness + branch).
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }

  it('SUPPRESSES the native push when SSE is live (foreground)', async () => {
    tunnelClient.querySseLiveness.mockResolvedValue({ live: true, lastSeenAt: Date.now() });

    await fireAndSettle();

    expect(tunnelClient.querySseLiveness).toHaveBeenCalledTimes(1);
    expect(egressQueue.enqueue).not.toHaveBeenCalled();
  });

  it('ALLOWS a new implicitly enabled project through the unchanged liveness flow', async () => {
    tunnelClient.querySseLiveness.mockResolvedValue({ live: false, lastSeenAt: null });

    await fireAndSettle();

    expect(egressQueue.enqueue).toHaveBeenCalledTimes(1);
    const payload = egressQueue.enqueue.mock.calls[0][0];
    expect(payload.sourceEventType).toBe('claude.hooks.ask_user_question.pending');
    // Stable, question-scoped idempotency key.
    expect(payload.sourceEventId).toBe('auq.pending:tool-use-1');
    // Identifiers only — NEVER the question content.
    expect(payload.payload).toMatchObject({
      sessionId: '33333333-3333-3333-3333-333333333333',
      toolUseId: 'tool-use-1',
      instanceId: 'inst-1',
    });
    expect(payload.payload.questions).toBeUndefined();
  });

  it('does not query or enqueue before the grace window elapses', async () => {
    await gate.onPending(makePayload());
    jest.advanceTimersByTime(AUQ_NATIVE_PUSH_GRACE_MS - 1);
    await Promise.resolve();

    expect(tunnelClient.querySseLiveness).not.toHaveBeenCalled();
    expect(egressQueue.enqueue).not.toHaveBeenCalled();
  });

  it('skips entirely when the cloud session is disconnected', async () => {
    cloudSession.getStatus.mockReturnValue({ connected: false });
    await fireAndSettle();
    expect(tunnelClient.querySseLiveness).not.toHaveBeenCalled();
    expect(egressQueue.enqueue).not.toHaveBeenCalled();
  });

  it('skips an existing baselined-disabled project before the liveness flow', async () => {
    upsertSetting(ENABLED_PROJECTS_KEY, { [DEFAULT_PROJECT_ID]: false });
    await fireAndSettle();
    expect(tunnelClient.querySseLiveness).not.toHaveBeenCalled();
    expect(egressQueue.enqueue).not.toHaveBeenCalled();
  });

  it('keeps an implicit Guest Sandbox outside the liveness flow', async () => {
    const sandboxProjectId = '44444444-4444-4444-4444-444444444444';
    insertProject(sandboxProjectId, GUEST_SANDBOX_ROOT_PATH);

    await fireAndSettle(makePayload({ projectId: sandboxProjectId }));

    expect(tunnelClient.querySseLiveness).not.toHaveBeenCalled();
    expect(egressQueue.enqueue).not.toHaveBeenCalled();
  });

  it('skips a current project with an explicit disabled override', async () => {
    projectConfig.setEnabled(DEFAULT_PROJECT_ID, false);

    await gate.onPending(makePayload());

    expect(tunnelClient.querySseLiveness).not.toHaveBeenCalled();
    expect(egressQueue.enqueue).not.toHaveBeenCalled();
  });

  it('delivers native push (fail-open) when the liveness query throws', async () => {
    tunnelClient.querySseLiveness.mockRejectedValue(new Error('tunnel gone'));
    await fireAndSettle();
    expect(egressQueue.enqueue).toHaveBeenCalledTimes(1);
  });

  it('clears pending timers on destroy without firing', async () => {
    await gate.onPending(makePayload());
    gate.onModuleDestroy();
    jest.advanceTimersByTime(AUQ_NATIVE_PUSH_GRACE_MS * 2);
    await Promise.resolve();
    expect(tunnelClient.querySseLiveness).not.toHaveBeenCalled();
    expect(egressQueue.enqueue).not.toHaveBeenCalled();
  });
});
