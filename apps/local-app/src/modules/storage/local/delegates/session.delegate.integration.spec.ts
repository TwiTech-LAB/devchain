import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { join } from 'path';
import { LocalStorageService } from '../local-storage.service';
import type { Project, Provider, AgentProfile, Agent } from '../../models/domain.models';

const MIGRATIONS_FOLDER = join(__dirname, '../../../../../drizzle');

describe('SessionStorageDelegate (integration)', () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database;
  let service: LocalStorageService;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    db = drizzle(sqlite);
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    sqlite.pragma('foreign_keys = ON');
    service = new LocalStorageService(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  // --- Seed helpers ---

  async function seedProject(name = 'Test Project'): Promise<Project> {
    return service.createProject({
      name,
      rootPath: `/tmp/${name.toLowerCase().replace(/\s+/g, '-')}-${randomUUID().slice(0, 8)}`,
      description: null,
      isTemplate: false,
    });
  }

  async function seedFullAgent(
    projectId: string,
    agentName = 'Agent-1',
  ): Promise<{ agent: Agent; profile: AgentProfile; provider: Provider; configId: string }> {
    const provider = await service.createProvider({
      name: `provider-${agentName}-${randomUUID().slice(0, 6)}`,
    });
    const profile = await service.createAgentProfile({ projectId, name: `profile-${agentName}` });
    const config = await service.createProfileProviderConfig({
      profileId: profile.id,
      providerId: provider.id,
      name: `config-${agentName}`,
      options: null,
      env: null,
    });
    const agent = await service.createAgent({
      projectId,
      profileId: profile.id,
      name: agentName,
      providerConfigId: config.id,
    });
    return { agent, profile, provider, configId: config.id };
  }

  function insertSession(agentId: string, status: 'running' | 'stopped' | 'failed'): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    sqlite
      .prepare(
        `INSERT INTO sessions (id, agent_id, status, started_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, agentId, status, now, now, now);
    return id;
  }

  function insertTranscript(sessionId: string): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    sqlite
      .prepare(
        `INSERT INTO transcripts (id, session_id, content, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, sessionId, 'test transcript content', now, now);
    return id;
  }

  function insertSessionInvite(
    sessionId: string,
    agentId: string,
    threadId: string,
    messageId: string,
  ): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    sqlite
      .prepare(
        `INSERT INTO chat_thread_session_invites (id, thread_id, agent_id, session_id, invite_message_id, sent_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, threadId, agentId, sessionId, messageId, now);
    return id;
  }

  function createChatThread(projectId: string): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    sqlite
      .prepare(
        `INSERT INTO chat_threads (id, project_id, created_by_type, created_at, updated_at)
         VALUES (?, ?, 'system', ?, ?)`,
      )
      .run(id, projectId, now, now);
    return id;
  }

  function createChatMember(threadId: string, agentId: string): void {
    const now = new Date().toISOString();
    sqlite
      .prepare(
        `INSERT INTO chat_members (thread_id, agent_id, created_at)
         VALUES (?, ?, ?)`,
      )
      .run(threadId, agentId, now);
  }

  function createChatMessage(threadId: string, agentId: string): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    sqlite
      .prepare(
        `INSERT INTO chat_messages (id, thread_id, author_type, author_agent_id, content, created_at)
         VALUES (?, ?, 'agent', ?, 'test message', ?)`,
      )
      .run(id, threadId, agentId, now);
    return id;
  }

  function getSessionRow(sessionId: string): Record<string, unknown> | undefined {
    return sqlite.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as
      | Record<string, unknown>
      | undefined;
  }

  function getTranscriptRow(transcriptId: string): Record<string, unknown> | undefined {
    return sqlite.prepare('SELECT * FROM transcripts WHERE id = ?').get(transcriptId) as
      | Record<string, unknown>
      | undefined;
  }

  function getInvitesBySessionId(sessionId: string): unknown[] {
    return sqlite
      .prepare('SELECT * FROM chat_thread_session_invites WHERE session_id = ?')
      .all(sessionId);
  }

  // ==========================================
  // parkSessionsFromAgents
  // ==========================================

  describe('parkSessionsFromAgents', () => {
    it('returns empty map for empty agentIds (no-op)', async () => {
      const result = await service.parkSessionsFromAgents([]);
      expect(result).toEqual(new Map());
    });

    it('returns only completed sessions; running sessions remain attached', async () => {
      const project = await seedProject();
      const { agent } = await seedFullAgent(project.id, 'A1');

      const stoppedId = insertSession(agent.id, 'stopped');
      const failedId = insertSession(agent.id, 'failed');
      const runningId = insertSession(agent.id, 'running');

      const result = await service.parkSessionsFromAgents([agent.id]);

      const parkedIds = result.get(agent.id) ?? [];
      expect(parkedIds).toHaveLength(2);
      expect(parkedIds).toContain(stoppedId);
      expect(parkedIds).toContain(failedId);
      expect(parkedIds).not.toContain(runningId);

      const stoppedRow = getSessionRow(stoppedId);
      expect(stoppedRow?.agent_id).toBeNull();

      const failedRow = getSessionRow(failedId);
      expect(failedRow?.agent_id).toBeNull();

      const runningRow = getSessionRow(runningId);
      expect(runningRow?.agent_id).toBe(agent.id);
    });

    it('groups results by old agentId and advances updated_at', async () => {
      const project = await seedProject();
      const { agent: a1 } = await seedFullAgent(project.id, 'A1');
      const { agent: a2 } = await seedFullAgent(project.id, 'A2');

      const s1 = insertSession(a1.id, 'stopped');
      const s2 = insertSession(a1.id, 'failed');
      const s3 = insertSession(a2.id, 'stopped');

      const beforePark = getSessionRow(s1)?.updated_at as string;

      await new Promise((r) => setTimeout(r, 10));

      const result = await service.parkSessionsFromAgents([a1.id, a2.id]);

      expect(result.size).toBe(2);
      expect(result.get(a1.id)).toEqual(expect.arrayContaining([s1, s2]));
      expect(result.get(a2.id)).toEqual([s3]);

      const afterPark = getSessionRow(s1)?.updated_at as string;
      expect(afterPark > beforePark).toBe(true);
    });
  });

  // ==========================================
  // applySessionPlan
  // ==========================================

  describe('applySessionPlan', () => {
    it('no-op for both arrays empty', async () => {
      await expect(service.applySessionPlan([], [])).resolves.toBeUndefined();
    });

    it('reassigns sessions and deletes sessions with transcripts and invites', async () => {
      const project = await seedProject();
      const { agent: oldAgent } = await seedFullAgent(project.id, 'OldAgent');
      const { agent: newAgent } = await seedFullAgent(project.id, 'NewAgent');

      const keepId = insertSession(oldAgent.id, 'stopped');
      const deleteId = insertSession(oldAgent.id, 'failed');

      const transcriptId = insertTranscript(deleteId);

      const threadId = createChatThread(project.id);
      createChatMember(threadId, oldAgent.id);
      const messageId = createChatMessage(threadId, oldAgent.id);
      insertSessionInvite(deleteId, oldAgent.id, threadId, messageId);

      // Park first (set agent_id = NULL)
      await service.parkSessionsFromAgents([oldAgent.id]);

      await service.applySessionPlan([{ sessionId: keepId, newAgentId: newAgent.id }], [deleteId]);

      // Reassigned session points to new agent
      const keptRow = getSessionRow(keepId);
      expect(keptRow?.agent_id).toBe(newAgent.id);

      // Deleted session is gone
      expect(getSessionRow(deleteId)).toBeUndefined();

      // Transcript cascaded
      expect(getTranscriptRow(transcriptId)).toBeUndefined();

      // Invite cleaned up
      expect(getInvitesBySessionId(deleteId)).toHaveLength(0);
    });

    it('groups multiple sessions reassigning to same new agent', async () => {
      const project = await seedProject();
      const { agent: old } = await seedFullAgent(project.id, 'Old');
      const { agent: target } = await seedFullAgent(project.id, 'Target');

      const s1 = insertSession(old.id, 'stopped');
      const s2 = insertSession(old.id, 'stopped');

      await service.parkSessionsFromAgents([old.id]);

      await service.applySessionPlan(
        [
          { sessionId: s1, newAgentId: target.id },
          { sessionId: s2, newAgentId: target.id },
        ],
        [],
      );

      expect(getSessionRow(s1)?.agent_id).toBe(target.id);
      expect(getSessionRow(s2)?.agent_id).toBe(target.id);
    });

    it('is atomic — both deletes and reassigns happen in one transaction', async () => {
      const project = await seedProject();
      const { agent: oldAgent } = await seedFullAgent(project.id, 'OldA');
      const { agent: newAgent } = await seedFullAgent(project.id, 'NewA');

      const deleteId = insertSession(oldAgent.id, 'stopped');
      const keepId = insertSession(oldAgent.id, 'failed');

      insertTranscript(deleteId);

      const threadId = createChatThread(project.id);
      createChatMember(threadId, oldAgent.id);
      const messageId = createChatMessage(threadId, oldAgent.id);
      insertSessionInvite(deleteId, oldAgent.id, threadId, messageId);

      await service.parkSessionsFromAgents([oldAgent.id]);

      await service.applySessionPlan([{ sessionId: keepId, newAgentId: newAgent.id }], [deleteId]);

      // Delete side: session, transcript, and invite all gone
      expect(getSessionRow(deleteId)).toBeUndefined();
      expect(getInvitesBySessionId(deleteId)).toHaveLength(0);

      // Reassign side: session re-bound to new agent in same transaction
      const kept = getSessionRow(keepId);
      expect(kept?.agent_id).toBe(newAgent.id);
    });
  });
});
