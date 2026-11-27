import { Test, type TestingModule } from '@nestjs/testing';
import type Database from 'better-sqlite3';
import { createTestDatabase } from '../../../common/test/test-database.helper';
import { createMockAgent, createMockProject } from '../../../../test/factories';
import { DB_CONNECTION } from '../db/db.provider';
import { beforeRollbackRecordId, SessionRowStore } from './session-row.store';
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

  it('stores a stopped save point with a copy binding and no runtime activity', async () => {
    store.markIdle('new', T3);
    await expect(
      store.insertSavePoint({
        sessionId: 'saved',
        sourceSessionId: 'new',
        sourceBusySince: T2,
        providerSessionId: 'native-saved',
        transcriptPath: '/tmp/session-saved.jsonl',
        sizeBytes: null,
        now: T4,
        admit: jest.fn(),
      }),
    ).resolves.toBe('inserted');

    expect(store.getSessionTreeRow('saved')).toEqual({
      id: 'saved',
      agentId: 'agent-new',
      agentName: 'agent-new',
      parentSessionId: 'new',
      kind: 'save_point',
      status: 'stopped',
      startedAt: T4,
      endedAt: T4,
      lastActivityAt: null,
      providerSessionId: 'native-saved',
      providerNameAtLaunch: 'codex',
      transcriptPath: '/tmp/session-saved.jsonl',
      sizeBytes: null,
      name: null,
    });
    expect(store.getSession('saved')).toMatchObject({
      tmuxSessionId: null,
      epicId: null,
      activityState: null,
      busySince: null,
    });
    expect(
      sqlite.prepare('SELECT inherited_session_ids FROM sessions WHERE id = ?').get('saved'),
    ).toEqual({ inherited_session_ids: JSON.stringify(['new']) });
  });

  const lineageOfOld = {
    outcome: 'lineageRunning',
    running: { sessionId: 'old', agentId: 'agent-old', agentName: 'agent-old' },
  };
  it.each([
    { status: 'stopped', ownerId: 'agent-new', outcome: { outcome: 'committed' } },
    { status: 'failed', ownerId: 'agent-new', outcome: { outcome: 'committed' } },
    { status: 'running', ownerId: 'agent-new', outcome: { outcome: 'invalidState' } },
    { status: 'stopped', ownerId: 'agent-other', outcome: { outcome: 'invalidState' } },
    { status: 'stopped', ownerId: 'agent-new', inherited: ['old'], outcome: lineageOfOld },
    {
      status: 'stopped',
      ownerId: 'agent-new',
      inherited: ['old'],
      oldLineage: '{"not":"an array"}',
      outcome: lineageOfOld,
    },
  ])(
    'commits a rollback of a $status session owned by $ownerId: $outcome.outcome',
    async ({ status, ownerId, inherited, oldLineage, outcome }) => {
      const committed = outcome.outcome === 'committed';
      sqlite
        .prepare('UPDATE sessions SET inherited_session_ids = ? WHERE id = ?')
        .run(oldLineage ?? null, 'old');
      sqlite
        .prepare(
          `UPDATE sessions SET status = ?, activity_state = 'busy', busy_since = ?,
             inherited_session_ids = ? WHERE id = ?`,
        )
        .run(status, T2, inherited ? JSON.stringify(inherited) : null, 'new');
      const before = sqlite.prepare('SELECT * FROM sessions WHERE id = ?').get('new');
      const recordId = beforeRollbackRecordId('new');

      const bound = await store.commitRollback({
        sessionId: 'new',
        ownerId,
        providerSessionId: 'native-copy',
        transcriptPath: '/tmp/copy.jsonl',
        tmuxSessionName: 'tmux-rolled-back',
        now: T4,
        record: {
          providerSessionId: 'native-kept',
          transcriptPath: '/tmp/kept.jsonl',
          sizeBytes: 9,
        },
        admit: jest.fn(),
      });

      expect(bound).toEqual(outcome);
      if (!committed) {
        expect(sqlite.prepare('SELECT * FROM sessions WHERE id = ?').get('new')).toEqual(before);
        expect(store.getSessionTreeRow(recordId)).toBeNull();
        return;
      }
      expect(store.getSession('new')).toMatchObject({
        status: 'running',
        tmuxSessionId: 'tmux-rolled-back',
        transcriptPath: '/tmp/copy.jsonl',
        activityState: null,
        busySince: null,
        endedAt: null,
      });
      expect(store.getSessionTreeRow(recordId)).toMatchObject({
        parentSessionId: 'new',
        kind: 'save_point',
        status: 'stopped',
        providerSessionId: 'native-kept',
        sizeBytes: 9,
      });
    },
  );

  // RFC 4122 version 5: the version nibble is 5 and the variant bits are 10.
  it.each([
    {
      name: 'stopped under the expected owner',
      status: 'stopped',
      agentId: 'agent-old',
      claim: { outcome: 'claimed', movedSavePointIds: ['restored-save'], agentRevert: null },
    },
    {
      name: 'moved to another owner',
      status: 'stopped',
      agentId: 'agent-other',
      claim: { outcome: 'invalidState' },
    },
    {
      name: 'running on another agent',
      status: 'running',
      agentId: 'agent-other',
      claim: { outcome: 'runningOnOtherAgent', agentId: 'agent-other' },
    },
    {
      name: 'related to a running session',
      status: 'stopped',
      agentId: 'agent-old',
      inherited: ['old'],
      claim: {
        outcome: 'lineageRunning',
        running: { sessionId: 'old', agentId: 'agent-old', agentName: 'agent-old' },
      },
    },
  ])(
    'claims a restore of a session $name only when it wins',
    async ({ status, agentId, inherited, claim }) => {
      // One running row per agent: free the target and the agent that holds the running row.
      sqlite.prepare("UPDATE sessions SET status = 'stopped' WHERE id IN ('new', 'other')").run();
      const insert = sqlite.prepare(
        `INSERT INTO sessions (id, kind, parent_session_id, agent_id, status, inherited_session_ids,
                             started_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insert.run(
        'restored',
        'session',
        null,
        agentId,
        status,
        JSON.stringify(inherited ?? []),
        T1,
        T0,
        T0,
      );
      insert.run(
        'restored-save',
        'save_point',
        'restored',
        agentId,
        'stopped',
        '["restored"]',
        T1,
        T0,
        T0,
      );
      const lifecycle = sqlite.prepare(
        `SELECT id, agent_id, status, ended_at, tmux_session_id FROM sessions ORDER BY id`,
      );
      const before = lifecycle.all();
      const prior = sqlite
        .prepare('SELECT * FROM sessions WHERE id = ?')
        .get('restored') as Parameters<SessionRowStore['rollbackRestore']>[0];

      const result = await store.claimRestore({
        sessionId: 'restored',
        ownerId: 'agent-old',
        targetId: 'agent-new',
        tmuxSessionName: 'tmux-restored',
        now: T4,
        admit: jest.fn(),
      });

      expect(result).toEqual(claim);
      if (result.outcome !== 'claimed') {
        expect(lifecycle.all()).toEqual(before);
        return;
      }
      expect(store.getSession('restored')).toMatchObject({
        agentId: 'agent-new',
        status: 'running',
        tmuxSessionId: 'tmux-restored',
        endedAt: null,
      });
      expect(store.getSessionTreeRow('restored-save')?.agentId).toBe('agent-new');
      await store.rollbackRestore(prior, T4, result.movedSavePointIds);
      expect(lifecycle.all()).toEqual(before);
    },
  );

  it('derives a stable version 5 record ID for each session', () => {
    const id = beforeRollbackRecordId('new');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(beforeRollbackRecordId('new')).toBe(id);
    expect(beforeRollbackRecordId('old')).not.toBe(id);
  });

  it('copies inherited ids to the fork, appends its id on save, and keeps its history after deletion', async () => {
    const inheritedIds = sqlite.prepare('SELECT inherited_session_ids FROM sessions WHERE id = ?');
    store.markIdle('new', T3);
    await store.insertSavePoint({
      sessionId: 'saved',
      sourceSessionId: 'new',
      sourceBusySince: T2,
      providerSessionId: 'native-saved',
      transcriptPath: '/tmp/session-saved.jsonl',
      sizeBytes: null,
      now: T3,
      admit: jest.fn(),
    });
    store.stopSession('new', T3, null);
    await store.insertForkedSession({
      sessionId: 'fork',
      parentSessionId: 'saved',
      agentId: 'agent-new',
      epicId: null,
      tmuxSessionName: 'tmux-fork',
      providerName: 'codex',
      now: T4,
      admit: jest.fn(),
    });
    expect(inheritedIds.get('fork')).toEqual({ inherited_session_ids: JSON.stringify(['new']) });
    expect(store.getSessionTreeRow('fork')).toMatchObject({
      providerSessionId: null,
      transcriptPath: null,
    });
    await store.bindForkTranscript({
      sessionId: 'fork',
      providerSessionId: 'native-fork',
      transcriptPath: '/tmp/session-fork.jsonl',
      updatedAt: T4,
      admit: jest.fn(),
    });

    expect(store.listSessionTreeRows('agent-new')).toEqual([
      expect.objectContaining({
        id: 'fork',
        kind: 'session',
        status: 'running',
        parentSessionId: 'saved',
        providerSessionId: 'native-fork',
        transcriptPath: '/tmp/session-fork.jsonl',
      }),
      expect.objectContaining({ id: 'ended', kind: 'session', parentSessionId: null }),
      expect.objectContaining({ id: 'saved', kind: 'save_point', parentSessionId: 'new' }),
      expect.objectContaining({ id: 'new', kind: 'session', parentSessionId: null }),
    ]);

    await expect(
      store.insertSavePoint({
        sessionId: 'saved-fork',
        sourceSessionId: 'fork',
        sourceBusySince: null,
        providerSessionId: 'native-saved-fork',
        transcriptPath: '/tmp/session-saved-fork.jsonl',
        sizeBytes: null,
        now: T4,
        admit: jest.fn(),
      }),
    ).resolves.toBe('inserted');
    expect(inheritedIds.get('saved-fork')).toEqual({
      inherited_session_ids: JSON.stringify(['new', 'fork']),
    });

    expect(store.deleteRecord('new')).toBe(true);
    expect(store.deleteRecord('saved')).toBe(true);
    expect(store.getSessionTreeRow('fork')).toMatchObject({ parentSessionId: null });
    expect(inheritedIds.get('fork')).toEqual({ inherited_session_ids: JSON.stringify(['new']) });
  });

  // SQLite exercises JSON append order and preserves SQL NULL for legacy save points.
  it.each([
    { kind: 'session', inherited: null, expected: ['ended'] },
    { kind: 'session', inherited: ['older', 'old'], expected: ['older', 'old', 'ended'] },
    { kind: 'session', inherited: { not: 'an array' }, expected: ['ended'] },
    { kind: 'save_point', inherited: null, expected: [] },
    { kind: 'save_point', inherited: ['older', 'old'], expected: ['older', 'old'] },
  ])('stores inherited ids from a $kind with $inherited', async ({ kind, inherited, expected }) => {
    store.stopSession('new', T3, null);
    store.stopSession('old', T3, null);
    sqlite
      .prepare('UPDATE sessions SET kind = ?, inherited_session_ids = ? WHERE id = ?')
      .run(kind, inherited === null ? null : JSON.stringify(inherited), 'ended');

    await store.insertForkedSession({
      sessionId: 'fork',
      parentSessionId: 'ended',
      agentId: 'agent-new',
      epicId: null,
      tmuxSessionName: 'tmux-fork',
      providerName: 'codex',
      now: T4,
      admit: jest.fn(),
    });

    expect(
      sqlite.prepare('SELECT inherited_session_ids FROM sessions WHERE id = ?').get('fork'),
    ).toEqual({ inherited_session_ids: JSON.stringify(expected) });
  });

  // The running row's own id must count even when its stored lineage is not a JSON array.
  it.each([
    { kind: 'session', lineage: null },
    { kind: 'save_point', lineage: null },
    { kind: 'session', lineage: '{"not":"an array"}' },
    { kind: 'save_point', lineage: '7' },
  ])(
    'refuses a fork of a $kind that inherits the id of a running session with lineage $lineage',
    async ({ kind, lineage }) => {
      store.stopSession('new', T3, null);
      sqlite
        .prepare('UPDATE sessions SET inherited_session_ids = ? WHERE id = ?')
        .run(lineage, 'old');
      sqlite
        .prepare('UPDATE sessions SET kind = ?, inherited_session_ids = ? WHERE id = ?')
        .run(kind, JSON.stringify(['old']), 'ended');

      await expect(
        store.insertForkedSession({
          sessionId: 'fork',
          parentSessionId: 'ended',
          agentId: 'agent-new',
          epicId: null,
          tmuxSessionName: 'tmux-fork',
          providerName: 'codex',
          now: T4,
          admit: jest.fn(),
        }),
      ).resolves.toEqual({
        outcome: 'lineageRunning',
        running: { sessionId: 'old', agentId: 'agent-old', agentName: 'agent-old' },
      });
      expect(store.getSession('fork')).toBeNull();
    },
  );

  it('fails the fork insert on the foreign key when the save point was deleted', async () => {
    await expect(
      store.insertSavePoint({
        sessionId: 'saved',
        sourceSessionId: 'old',
        sourceBusySince: null,
        providerSessionId: 'native-saved',
        transcriptPath: '/tmp/session-saved.jsonl',
        sizeBytes: null,
        now: T3,
        admit: jest.fn(),
      }),
    ).resolves.toBe('inserted');
    store.stopSession('old', T3, null);
    expect(store.deleteRecord('saved')).toBe(true);

    await expect(
      store.insertForkedSession({
        sessionId: 'fork',
        parentSessionId: 'saved',
        agentId: 'agent-old',
        epicId: null,
        tmuxSessionName: 'tmux-fork',
        providerName: 'codex',
        now: T4,
        admit: jest.fn(),
      }),
    ).rejects.toMatchObject({ code: 'SQLITE_CONSTRAINT_FOREIGNKEY' });
  });

  it('lists only running identities and reads inherited IDs in stored order', () => {
    const inheritedIds = [
      'aaaaaaaa-1111-4111-8111-111111111111',
      'bbbbbbbb-2222-4222-8222-222222222222',
    ];
    const setInheritedIds = sqlite.prepare(
      'UPDATE sessions SET inherited_session_ids = ? WHERE id = ?',
    );
    setInheritedIds.run(JSON.stringify(inheritedIds), 'new');
    setInheritedIds.run(JSON.stringify(['cccccccc-3333-4333-8333-333333333333']), 'ended');
    setInheritedIds.run('malformed', 'other');

    expect(store.listRunningSessionIdentities()).toEqual([
      { id: 'orphan', agentId: null, status: 'running', startedAt: T4, inheritedSessionIds: [] },
      {
        id: 'other',
        agentId: 'agent-other',
        status: 'running',
        startedAt: T3,
        inheritedSessionIds: [],
      },
      {
        id: 'new',
        agentId: 'agent-new',
        status: 'running',
        startedAt: T2,
        inheritedSessionIds: inheritedIds,
      },
      {
        id: 'old',
        agentId: 'agent-old',
        status: 'running',
        startedAt: T1,
        inheritedSessionIds: [],
      },
    ]);
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

  describe('bindProviderSessionIdIfAbsent', () => {
    function insertUnbound(id: string, providerAtLaunch: string | null): void {
      sqlite
        .prepare(
          `INSERT INTO sessions (id, agent_id, status, started_at, created_at, updated_at)
           VALUES (?, NULL, 'running', ?, ?, ?)`,
        )
        .run(id, T2, T0, T0);
      if (providerAtLaunch !== null) {
        sqlite
          .prepare(`UPDATE sessions SET provider_name_at_launch = ? WHERE id = ?`)
          .run(providerAtLaunch, id);
      }
    }

    const row = (id: string) =>
      sqlite
        .prepare(
          `SELECT provider_session_id, transcript_path, updated_at FROM sessions WHERE id = ?`,
        )
        .get(id) as {
        provider_session_id: string | null;
        transcript_path: string | null;
        updated_at: string;
      };

    it('binds a NULL provider_session_id for a case-insensitive provider match once', () => {
      insertUnbound('bindable', 'DEVIN');

      const changes = store.bindProviderSessionIdIfAbsent({
        sessionId: 'bindable',
        providerSessionId: 'first-echidna',
        providerName: 'devin',
        updatedAt: T4,
      });

      expect(changes).toBe(1);
      const after = row('bindable');
      expect(after.provider_session_id).toBe('first-echidna');
      expect(after.transcript_path).toBeNull();
      expect(after.updated_at).toBe(T4);
    });

    it('keeps the first binding when a different id arrives later', () => {
      insertUnbound('bindable', 'devin');
      store.bindProviderSessionIdIfAbsent({
        sessionId: 'bindable',
        providerSessionId: 'first-echidna',
        providerName: 'devin',
        updatedAt: T3,
      });

      const changes = store.bindProviderSessionIdIfAbsent({
        sessionId: 'bindable',
        providerSessionId: 'second-id',
        providerName: 'devin',
        updatedAt: T4,
      });

      expect(changes).toBe(0);
      const after = row('bindable');
      expect(after.provider_session_id).toBe('first-echidna');
      expect(after.updated_at).toBe(T3);
    });

    it('writes nothing for a different provider', () => {
      insertUnbound('bindable', 'claude');

      const changes = store.bindProviderSessionIdIfAbsent({
        sessionId: 'bindable',
        providerSessionId: 'first-echidna',
        providerName: 'devin',
        updatedAt: T4,
      });

      expect(changes).toBe(0);
      const after = row('bindable');
      expect(after.provider_session_id).toBeNull();
      expect(after.updated_at).toBe(T0);
    });

    it('writes nothing for an unknown session', () => {
      const changes = store.bindProviderSessionIdIfAbsent({
        sessionId: 'no-such-session',
        providerSessionId: 'first-echidna',
        providerName: 'devin',
        updatedAt: T4,
      });
      expect(changes).toBe(0);
    });

    it('allows binding for legacy rows with NULL provider_name_at_launch', () => {
      insertUnbound('legacy', null);

      const changes = store.bindProviderSessionIdIfAbsent({
        sessionId: 'legacy',
        providerSessionId: 'first-echidna',
        providerName: 'devin',
        updatedAt: T4,
      });

      expect(changes).toBe(1);
      expect(row('legacy').provider_session_id).toBe('first-echidna');
    });
  });

  describe('family session lists', () => {
    const insertProfile = sqlite3Insert(
      `INSERT INTO agent_profiles (id, project_id, name, family_slug, created_at, updated_at)
       VALUES (@id, @projectId, @id, @slug, '${T0}', '${T0}')`,
    );
    const insertAgent = sqlite3Insert(
      `INSERT INTO agents
         (id, project_id, profile_id, provider_config_id, name, disabled, created_at, updated_at)
       VALUES (@id, @projectId, @profileId, 'config-' || @projectId, @id, @disabled, '${T0}', '${T0}')`,
    );
    const insertSession = sqlite3Insert(
      `INSERT INTO sessions
         (id, agent_id, parent_session_id, status, started_at, last_activity_at, created_at, updated_at)
       VALUES (@id, @agentId, @parentId, 'stopped', '${T0}', @lastActivityAt, '${T0}', '${T0}')`,
    );
    const pageIds = (page: ReturnType<SessionRowStore['getSessionTreePage']>) =>
      page.rows.map(({ id, parentSessionId }) => [id, parentSessionId]);

    function sqlite3Insert(sql: string) {
      return (params: Record<string, unknown>) => sqlite.prepare(sql).run(params);
    }

    beforeEach(() => {
      // The unique slug index compares raw text, and template import stores slugs unnormalized.
      for (const [id, projectId, slug] of [
        ['profile-upper', 'project-a', ' Coder '],
        ['profile-lower', 'project-a', 'coder'],
        ['profile-loner', 'project-a', null],
        ['profile-remote', 'project-b', 'coder'],
        ['profile-tab-accent', 'project-a', '\tÉQUIPE\t'],
        ['profile-accent', 'project-a', 'équipe'],
        ['profile-blank-space', 'project-a', '  '],
        ['profile-blank-tab', 'project-a', '\t'],
      ]) {
        insertProfile({ id, projectId, slug });
      }
      for (const [id, projectId, profileId, disabled] of [
        ['coder-1', 'project-a', 'profile-upper', 0],
        ['coder-2', 'project-a', 'profile-lower', 1],
        ['loner', 'project-a', 'profile-loner', 0],
        ['remote-coder', 'project-b', 'profile-remote', 0],
        ['equipe-1', 'project-a', 'profile-tab-accent', 0],
        ['equipe-2', 'project-a', 'profile-accent', 0],
        ['blank-1', 'project-a', 'profile-blank-space', 0],
        ['blank-2', 'project-a', 'profile-blank-tab', 0],
      ] as const) {
        insertAgent({ id, projectId, profileId, disabled });
      }
      for (const [id, agentId, parentId, lastActivityAt] of [
        ['c1-root', 'coder-1', null, T3],
        ['c2-root', 'coder-2', null, T3],
        ['c2-child', 'coder-2', 'c1-root', T2],
        ['c1-fork', 'coder-1', 'c1-root', T1],
        ['loner-root', 'loner', null, T4],
        ['c1-orphan', 'coder-1', 'loner-root', T1],
        ['remote-root', 'remote-coder', null, T4],
        ['eq1-root', 'equipe-1', null, T1],
        ['eq2-root', 'equipe-2', null, T2],
      ]) {
        insertSession({ id, agentId, parentId, lastActivityAt });
      }
    });

    it.each([
      { agentId: 'coder-1', family: ['coder-1', 'coder-2'] },
      { agentId: 'coder-2', family: ['coder-1', 'coder-2'] },
      { agentId: 'agent-new', family: ['agent-new', 'agent-old'] },
      { agentId: 'loner', family: ['loner'] },
      { agentId: 'equipe-1', family: ['equipe-1', 'equipe-2'] },
      { agentId: 'blank-1', family: ['blank-1'] },
      { agentId: 'missing', family: [] },
    ])('resolves the family of $agentId', ({ agentId, family }) => {
      expect(store.listFamilyAgentIds(agentId).sort()).toEqual(family);
    });

    it('pages family roots by recency and id across owners, with owners and outside parents as roots', () => {
      const first = store.getSessionTreePage('coder-1', null, 2, 'family');
      expect(first.total).toBe(3);
      expect(pageIds(first)).toEqual([
        ['c2-root', null],
        ['c1-root', null],
        ['c2-child', 'c1-root'],
        ['c1-fork', 'c1-root'],
      ]);
      expect(first.rows[0]).toMatchObject({ agentId: 'coder-2', agentName: 'coder-2' });
      expect(first.rows[1]).toMatchObject({ agentId: 'coder-1', agentName: 'coder-1' });

      const second = store.getSessionTreePage('coder-1', first.next, 2, 'family');
      expect(second).toMatchObject({ total: 3, next: null });
      expect(pageIds(second)).toEqual([['c1-orphan', 'loner-root']]);
    });

    it('lists the sessions of profiles whose slugs differ only in tabs and non-ASCII case', () => {
      expect(pageIds(store.getSessionTreePage('equipe-1', null, 10, 'family'))).toEqual([
        ['eq2-root', null],
        ['eq1-root', null],
      ]);
    });

    it('lists only own rows by default and keeps forks as roots after their parent moved', () => {
      expect(pageIds(store.getSessionTreePage('coder-1', null, 10))).toEqual([
        ['c1-root', null],
        ['c1-fork', 'c1-root'],
        ['c1-orphan', 'loner-root'],
      ]);

      sqlite.prepare(`UPDATE sessions SET agent_id = 'loner' WHERE id = 'c1-root'`).run();

      const own = store.getSessionTreePage('coder-1', null, 10, 'agent');
      expect(own.total).toBe(2);
      expect(pageIds(own)).toEqual([
        ['c1-orphan', 'loner-root'],
        ['c1-fork', 'c1-root'],
      ]);
    });
  });
});
