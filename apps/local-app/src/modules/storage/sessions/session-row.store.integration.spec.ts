import { Test, type TestingModule } from '@nestjs/testing';
import type Database from 'better-sqlite3';
import { createTestDatabase } from '../../../common/test/test-database.helper';
import { createMockAgent, createMockProject } from '../../../../test/factories';
import { DB_CONNECTION } from '../db/db.provider';
import { SessionRowStore } from './session-row.store';
import { SessionRowsModule } from './session-rows.module';

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-01T00:01:00.000Z';
const T2 = '2026-01-01T00:02:00.000Z';
const T3 = '2026-01-01T00:03:00.000Z';
const T4 = '2026-01-01T00:04:00.000Z';

const oldSummary = {
  id: 'old',
  epicId: null,
  agentId: 'agent-old',
  tmuxSessionId: null,
  status: 'running',
  startedAt: T1,
  endedAt: null,
  lastActivityAt: null,
  activityState: null,
  busySince: null,
  transcriptPath: null,
  name: null,
  createdAt: T0,
  updatedAt: T0,
};
const newSummary = {
  ...oldSummary,
  id: 'new',
  agentId: 'agent-new',
  tmuxSessionId: 'tmux-new',
  startedAt: T2,
  lastActivityAt: T3,
  activityState: 'busy',
  busySince: T2,
  transcriptPath: '/tmp/session-new.jsonl',
  name: 'Working',
};
const newInfo = {
  sessionId: 'new',
  agentId: 'agent-new',
  projectId: 'project-a',
  status: 'running',
  tmuxSessionId: 'tmux-new',
  startedAt: T2,
  lastActivityAt: T3,
  activityState: 'busy',
  name: 'Working',
  providerNameAtLaunch: 'codex',
};
const oldInfo = {
  sessionId: 'old',
  agentId: 'agent-old',
  projectId: 'project-a',
  status: 'running',
  tmuxSessionId: null,
  startedAt: T1,
  lastActivityAt: null,
  activityState: null,
  name: null,
  providerNameAtLaunch: null,
};

// Real SQLite is the cheapest layer that verifies projections, joins, NULLs, and SQL ordering.
describe('SessionRowStore queries', () => {
  let sqlite: Database.Database;
  let module: TestingModule;
  let store: SessionRowStore;

  beforeEach(async () => {
    const database = createTestDatabase();
    sqlite = database.sqlite;
    module = await Test.createTestingModule({ imports: [SessionRowsModule] })
      .overrideProvider(DB_CONNECTION)
      .useValue(database.db)
      .compile();
    store = module.get(SessionRowStore);

    sqlite
      .prepare(
        `INSERT INTO providers (id, name, mcp_configured, created_at, updated_at)
         VALUES ('provider', 'codex', 0, ?, ?)`,
      )
      .run(T0, T0);
    for (const id of ['project-a', 'project-b']) {
      const project = createMockProject({ id });
      sqlite
        .prepare(
          `INSERT INTO projects (id, name, root_path, is_template, created_at, updated_at)
           VALUES (?, ?, ?, 0, ?, ?)`,
        )
        .run(id, project.name, project.rootPath, T0, T0);
      sqlite
        .prepare(
          `INSERT INTO agent_profiles (id, project_id, name, created_at, updated_at)
           VALUES (?, ?, 'Profile', ?, ?)`,
        )
        .run(`profile-${id}`, id, T0, T0);
      sqlite
        .prepare(
          `INSERT INTO profile_provider_configs
             (id, profile_id, provider_id, name, position, created_at, updated_at)
           VALUES (?, ?, 'provider', 'Config', 0, ?, ?)`,
        )
        .run(`config-${id}`, `profile-${id}`, T0, T0);
    }
    for (const [id, projectId] of [
      ['agent-new', 'project-a'],
      ['agent-old', 'project-a'],
      ['agent-other', 'project-b'],
    ]) {
      const agent = createMockAgent({ id, projectId, name: id });
      sqlite
        .prepare(
          `INSERT INTO agents
             (id, project_id, profile_id, provider_config_id, name, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, projectId, `profile-${projectId}`, `config-${projectId}`, agent.name, T0, T0);
    }
    for (const [id, agentId, startedAt, status] of [
      ['new', 'agent-new', T2, 'running'],
      ['old', 'agent-old', T1, 'running'],
      ['other', 'agent-other', T3, 'running'],
      ['orphan', null, T4, 'running'],
      ['ended', 'agent-new', T4, 'stopped'],
    ]) {
      sqlite
        .prepare(
          `INSERT INTO sessions (id, agent_id, status, started_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(id, agentId, status, startedAt, T0, T0);
    }
    sqlite
      .prepare(
        `UPDATE sessions SET tmux_session_id = 'tmux-new', provider_session_id = 'native-new',
           provider_name_at_launch = 'codex', last_activity_at = ?, activity_state = 'busy',
           busy_since = ?, transcript_path = '/tmp/session-new.jsonl', name = 'Working'
         WHERE id = 'new'`,
      )
      .run(T3, T2);
  });

  afterEach(async () => {
    await module.close();
    sqlite.close();
  });

  it.each([
    {
      name: 'session detail includes provider identifiers',
      read: (s: SessionRowStore) => s.getSession('new'),
      expected: { ...newSummary, providerSessionId: 'native-new', providerNameAtLaunch: 'codex' },
    },
    {
      name: 'agent summary omits provider identifiers',
      read: (s: SessionRowStore) => s.getActiveSessionForAgent('agent-new'),
      expected: newSummary,
    },
    {
      name: 'active lookup uses its own project/provider projection',
      read: (s: SessionRowStore) => s.getActiveSessionInfo('agent-new', 'project-a'),
      expected: newInfo,
    },
    {
      name: 'ownership lookup includes stopped sessions',
      read: (s: SessionRowStore) => s.getSessionProjectScope('ended'),
      expected: { sessionId: 'ended', agentId: 'agent-new', projectId: 'project-a' },
    },
  ])('$name', ({ read, expected }) => {
    expect(read(store)).toStrictEqual(expected);
  });

  it.each([
    {
      name: 'detail',
      read: (s: SessionRowStore) => s.getSession('old'),
      expected: {
        ...oldSummary,
        providerSessionId: null,
        providerNameAtLaunch: null,
      },
    },
    {
      name: 'agent summary',
      read: (s: SessionRowStore) => s.getActiveSessionForAgent('agent-old'),
      expected: oldSummary,
    },
    {
      name: 'active lookup',
      read: (s: SessionRowStore) => s.getActiveSessionInfo('agent-old', 'project-a'),
      expected: oldInfo,
    },
  ])('preserves null versus omitted fields in $name', ({ read, expected }) => {
    expect(read(store)).toStrictEqual(expected);
  });

  it.each([
    { name: 'missing session', read: (s: SessionRowStore) => s.getSession('missing') },
    { name: 'missing agent', read: (s: SessionRowStore) => s.getActiveSessionForAgent('missing') },
    {
      name: 'missing active lookup',
      read: (s: SessionRowStore) => s.getActiveSessionInfo('missing', 'project-a'),
    },
    {
      name: 'another project',
      read: (s: SessionRowStore) => s.getActiveSessionInfo('agent-new', 'project-b'),
    },
    {
      name: 'missing ownership',
      read: (s: SessionRowStore) => s.getSessionProjectScope('missing'),
    },
    { name: 'parked ownership', read: (s: SessionRowStore) => s.getSessionProjectScope('orphan') },
  ])('returns null for $name', ({ read }) => {
    expect(read(store)).toBeNull();
  });

  it.each([
    {
      name: 'all summaries',
      read: (s: SessionRowStore) => s.listActiveSessions(),
      expected: [
        { ...oldSummary, id: 'orphan', agentId: null, startedAt: T4 },
        { ...oldSummary, id: 'other', agentId: 'agent-other', startedAt: T3 },
        newSummary,
        oldSummary,
      ],
    },
    {
      name: 'project summaries',
      read: (s: SessionRowStore) => s.getActiveSessionsForProject('project-a'),
      expected: [newSummary, oldSummary],
    },
    {
      name: 'project active lookup',
      read: (s: SessionRowStore) => s.listActiveSessionInfos('project-a'),
      expected: [newInfo, oldInfo],
    },
  ])('preserves descending start order, projection and scope for $name', ({ read, expected }) => {
    expect(read(store)).toStrictEqual(expected);
  });

  it.each([
    {
      name: 'project summaries',
      read: (s: SessionRowStore) => s.getActiveSessionsForProject('missing'),
    },
    {
      name: 'project active lookup',
      read: (s: SessionRowStore) => s.listActiveSessionInfos('missing'),
    },
  ])('returns an empty list for missing $name', ({ read }) => {
    expect(read(store)).toEqual([]);
  });

  it('lists only the running provider snapshots across projects, including null providers', () => {
    const rows = store.listRunningProviderSessions();
    expect(rows).toHaveLength(4);
    expect(rows.sort((a, b) => a.sessionId.localeCompare(b.sessionId))).toStrictEqual([
      { sessionId: 'new', providerNameAtLaunch: 'codex' },
      { sessionId: 'old', providerNameAtLaunch: null },
      { sessionId: 'orphan', providerNameAtLaunch: null },
      { sessionId: 'other', providerNameAtLaunch: null },
    ]);
  });
});
