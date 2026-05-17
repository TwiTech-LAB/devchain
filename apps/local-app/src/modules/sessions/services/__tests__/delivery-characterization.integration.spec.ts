/**
 * Characterization tests — message-delivery cluster (golden master)
 *
 * Layer: backend-integration
 * Justification: ensureSessionInvites idempotency and chat ACK round-trip
 * depend on real SQLite UNIQUE constraints and SELECT-before-INSERT patterns
 * that mocks cannot exercise. Using :memory: SQLite is the cheapest layer that
 * proves these behaviours.
 *
 * Covers behaviors 9–10 from the epic:
 *   9.  Chat ACK round-trip — chat_ack updates acknowledgedAt
 *   10. ensureSessionInvites idempotency — same (thread, agent, session) doesn't double-insert
 */

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { join } from 'path';
import { ChatService } from '../../../chat/services/chat.service';
import { ChatSessionInviteService } from '../../../chat/services/chat-session-invite.service';
import { chatMessages, chatThreadSessionInvites } from '../../../storage/db/schema';
import type { ActiveSessionLookup } from '../active-session-lookup.service';
import type { SessionLauncherFacade } from '../session-launcher-facade.service';
import type { ChatSettingsService } from '../../../chat/services/chat-settings.service';

jest.mock('../../../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const NOW = '2026-01-01T00:00:00.000Z';
const PROJECT_ID = 'proj-1';
const AGENT_ID = 'agent-1';
const AGENT_ID_2 = 'agent-2';
const THREAD_ID = 'thread-1';
const SESSION_ID = 'tmux-session-1';

function setupInMemoryDb(): { sqlite: Database.Database; db: BetterSQLite3Database } {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  const db = drizzle(sqlite);

  sqlite.pragma('foreign_keys = OFF');
  migrate(db, { migrationsFolder: join(__dirname, '../../../../..', 'drizzle') });
  sqlite.pragma('foreign_keys = ON');

  return { sqlite, db };
}

function seedCoreData(sqlite: Database.Database): void {
  const profileId = 'profile-1';
  const providerId = 'provider-1';
  const ppcId = 'ppc-1';

  sqlite.exec(`
    INSERT INTO projects (id, name, root_path, created_at, updated_at)
    VALUES ('${PROJECT_ID}', 'Test Project', '/tmp/test', '${NOW}', '${NOW}');

    INSERT INTO providers (id, name, created_at, updated_at)
    VALUES ('${providerId}', 'claude', '${NOW}', '${NOW}');

    INSERT INTO agent_profiles (id, name, created_at, updated_at)
    VALUES ('${profileId}', 'Test Profile', '${NOW}', '${NOW}');

    INSERT INTO profile_provider_configs (id, profile_id, provider_id, name, position, created_at, updated_at)
    VALUES ('${ppcId}', '${profileId}', '${providerId}', 'default', 0, '${NOW}', '${NOW}');

    INSERT INTO agents (id, project_id, profile_id, provider_config_id, name, created_at, updated_at)
    VALUES ('${AGENT_ID}', '${PROJECT_ID}', '${profileId}', '${ppcId}', 'Alpha', '${NOW}', '${NOW}');

    INSERT INTO agents (id, project_id, profile_id, provider_config_id, name, created_at, updated_at)
    VALUES ('${AGENT_ID_2}', '${PROJECT_ID}', '${profileId}', '${ppcId}', 'Beta', '${NOW}', '${NOW}');
  `);
}

function seedThread(sqlite: Database.Database, agentIds: string[]): void {
  sqlite.exec(`
    INSERT INTO chat_threads (id, project_id, is_group, created_by_type, created_at, updated_at)
    VALUES ('${THREAD_ID}', '${PROJECT_ID}', 0, 'user', '${NOW}', '${NOW}');
  `);

  for (const agentId of agentIds) {
    sqlite.exec(`
      INSERT INTO chat_members (thread_id, agent_id, created_at)
      VALUES ('${THREAD_ID}', '${agentId}', '${NOW}');
    `);
  }
}

function buildInviteEnsurer(
  db: BetterSQLite3Database,
  options?: { activeSessionAgents?: Map<string, string> },
) {
  const eventEmitter = new EventEmitter2();

  const mockChatSettings = {
    getInviteTemplate: jest
      .fn()
      .mockResolvedValue(
        'Welcome {{ invited_agent_name }} to thread {{ thread_id }}. Message ID: {{ message_id }}',
      ),
  } as unknown as ChatSettingsService;

  const sessionsByAgent = options?.activeSessionAgents ?? new Map([[AGENT_ID, SESSION_ID]]);

  const activeSessionLookup = {
    listActiveSessions: jest.fn().mockResolvedValue(
      Array.from(sessionsByAgent.entries()).map(([agentId, tmuxId]) => ({
        id: `session-${agentId}`,
        agentId,
        tmuxSessionId: tmuxId,
        status: 'running',
      })),
    ),
  } as unknown as ActiveSessionLookup;
  const sessionLauncherFacade = {
    ensureActiveSession: jest
      .fn()
      .mockImplementation(async (agentId: string, projectId: string) => ({
        sessionId: `launched-session-${agentId}`,
        agentId,
        projectId,
        status: 'running',
        tmuxSessionId: sessionsByAgent.get(agentId) ?? SESSION_ID,
        startedAt: NOW,
        lastActivityAt: NOW,
      })),
  } as unknown as SessionLauncherFacade;

  const ensurer = new ChatSessionInviteService(
    db,
    eventEmitter,
    mockChatSettings,
    activeSessionLookup,
    sessionLauncherFacade,
  );

  return { ensurer, eventEmitter, sessionLauncherFacade };
}

function buildChatServiceWithEnsurer(db: BetterSQLite3Database, ensurer: ChatSessionInviteService) {
  const eventEmitter = new EventEmitter2();

  const mockChatSettings = {
    getInviteTemplate: jest.fn(),
  } as unknown as ChatSettingsService;

  const service = new ChatService(db, eventEmitter, mockChatSettings, ensurer);

  return { service, eventEmitter };
}

// ═════════════════════════════════════════════════════════════════════════════
// 10. ensureSessionInvites idempotency
// ═════════════════════════════════════════════════════════════════════════════

describe('[Characterization] 10 — ensureSessionInvites idempotency', () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database;

  beforeEach(() => {
    ({ sqlite, db } = setupInMemoryDb());
    seedCoreData(sqlite);
    seedThread(sqlite, [AGENT_ID, AGENT_ID_2]);
  });

  afterEach(() => {
    sqlite.close();
  });

  it('creates invite on first call for (thread, agent, session)', async () => {
    const { ensurer } = buildInviteEnsurer(db);

    await ensurer.ensureSessionInvites(THREAD_ID, PROJECT_ID, [AGENT_ID]);

    const invites = db.select().from(chatThreadSessionInvites).all();

    expect(invites.length).toBe(1);
    expect(invites[0].threadId).toBe(THREAD_ID);
    expect(invites[0].agentId).toBe(AGENT_ID);
    expect(invites[0].sessionId).toBe(SESSION_ID);
    expect(invites[0].acknowledgedAt).toBeNull();
  });

  it('does not double-insert on second call with same (thread, agent, session)', async () => {
    const { ensurer } = buildInviteEnsurer(db);

    await ensurer.ensureSessionInvites(THREAD_ID, PROJECT_ID, [AGENT_ID]);
    await ensurer.ensureSessionInvites(THREAD_ID, PROJECT_ID, [AGENT_ID]);

    const invites = db.select().from(chatThreadSessionInvites).all();
    expect(invites.length).toBe(1);
  });

  it('creates new invite when session changes for same (thread, agent)', async () => {
    const session1 = new Map([[AGENT_ID, 'tmux-session-1']]);
    const { ensurer: ens1 } = buildInviteEnsurer(db, { activeSessionAgents: session1 });
    await ens1.ensureSessionInvites(THREAD_ID, PROJECT_ID, [AGENT_ID]);

    const session2 = new Map([[AGENT_ID, 'tmux-session-2']]);
    const { ensurer: ens2 } = buildInviteEnsurer(db, { activeSessionAgents: session2 });
    await ens2.ensureSessionInvites(THREAD_ID, PROJECT_ID, [AGENT_ID]);

    const invites = db.select().from(chatThreadSessionInvites).all();
    expect(invites.length).toBe(2);
    expect(invites.map((i) => i.sessionId).sort()).toEqual(['tmux-session-1', 'tmux-session-2']);
  });

  it('auto-launches agents without active sessions (invite inserted, no error)', async () => {
    const noSessions = new Map<string, string>();
    const { ensurer, sessionLauncherFacade } = buildInviteEnsurer(db, {
      activeSessionAgents: noSessions,
    });

    await ensurer.ensureSessionInvites(THREAD_ID, PROJECT_ID, [AGENT_ID]);

    const invites = db.select().from(chatThreadSessionInvites).all();
    expect(invites.length).toBe(1);
    expect(sessionLauncherFacade.ensureActiveSession).toHaveBeenCalledWith(AGENT_ID, PROJECT_ID);
  });

  it('UNIQUE constraint catch prevents double-insert on race', async () => {
    const { ensurer } = buildInviteEnsurer(db);

    await ensurer.ensureSessionInvites(THREAD_ID, PROJECT_ID, [AGENT_ID]);

    const invitesBefore = db.select().from(chatThreadSessionInvites).all();
    expect(invitesBefore.length).toBe(1);

    const duplicateMsgId = 'dup-msg-id';
    sqlite.exec(`
      INSERT INTO chat_messages (id, thread_id, author_type, content, created_at)
      VALUES ('${duplicateMsgId}', '${THREAD_ID}', 'system', 'dup', '${NOW}');
    `);
    try {
      sqlite.exec(`
        INSERT INTO chat_thread_session_invites (id, thread_id, agent_id, session_id, invite_message_id, sent_at)
        VALUES ('dup-id', '${THREAD_ID}', '${AGENT_ID}', '${SESSION_ID}', '${duplicateMsgId}', '${NOW}');
      `);
    } catch {
      // UNIQUE constraint violation — expected
    }

    await expect(
      ensurer.ensureSessionInvites(THREAD_ID, PROJECT_ID, [AGENT_ID]),
    ).resolves.toBeUndefined();

    const invitesAfter = db.select().from(chatThreadSessionInvites).all();
    expect(invitesAfter.length).toBe(1);
  });

  it('sends invite message before the authored message (ordering invariant)', async () => {
    const { ensurer } = buildInviteEnsurer(db);
    const { service } = buildChatServiceWithEnsurer(db, ensurer);

    await service.createMessage(THREAD_ID, {
      authorType: 'user',
      content: 'User message',
      projectId: PROJECT_ID,
    });

    const messages = db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.threadId, THREAD_ID))
      .all();

    expect(messages.length).toBeGreaterThanOrEqual(2);

    const inviteMessages = messages.filter((m) => m.authorType === 'system');
    const userMsg = messages.find((m) => m.authorType === 'user');

    expect(inviteMessages.length).toBeGreaterThan(0);
    expect(userMsg).toBeDefined();
    expect(inviteMessages.every((inviteMsg) => inviteMsg.createdAt <= userMsg!.createdAt)).toBe(
      true,
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 9. Chat ACK round-trip
// ═════════════════════════════════════════════════════════════════════════════

describe('[Characterization] 9 — Chat ACK round-trip', () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database;

  beforeEach(() => {
    ({ sqlite, db } = setupInMemoryDb());
    seedCoreData(sqlite);
    seedThread(sqlite, [AGENT_ID]);
  });

  afterEach(() => {
    sqlite.close();
  });

  it('acknowledgeInvite sets acknowledgedAt when invite exists', async () => {
    const { ensurer } = buildInviteEnsurer(db);
    const { service } = buildChatServiceWithEnsurer(db, ensurer);

    await service.createMessage(THREAD_ID, {
      authorType: 'user',
      content: 'Hello',
      projectId: PROJECT_ID,
    });

    const invites = db.select().from(chatThreadSessionInvites).all();
    expect(invites.length).toBe(1);
    expect(invites[0].acknowledgedAt).toBeNull();

    const inviteMessageId = invites[0].inviteMessageId;

    await service.acknowledgeInvite(THREAD_ID, inviteMessageId, AGENT_ID, SESSION_ID);

    const updated = db.select().from(chatThreadSessionInvites).all();
    expect(updated[0].acknowledgedAt).not.toBeNull();
  });

  it('acknowledgeInvite is idempotent (double-ACK does not error)', async () => {
    const { ensurer } = buildInviteEnsurer(db);
    const { service } = buildChatServiceWithEnsurer(db, ensurer);

    await service.createMessage(THREAD_ID, {
      authorType: 'user',
      content: 'Hello',
      projectId: PROJECT_ID,
    });

    const invites = db.select().from(chatThreadSessionInvites).all();
    const inviteMessageId = invites[0].inviteMessageId;

    await service.acknowledgeInvite(THREAD_ID, inviteMessageId, AGENT_ID, SESSION_ID);
    const firstAck = db.select().from(chatThreadSessionInvites).all()[0].acknowledgedAt;

    await service.acknowledgeInvite(THREAD_ID, inviteMessageId, AGENT_ID, SESSION_ID);
    const secondAck = db.select().from(chatThreadSessionInvites).all()[0].acknowledgedAt;

    expect(secondAck).toBe(firstAck);
  });

  it('acknowledgeInvite does nothing for non-invite messages', async () => {
    const { ensurer } = buildInviteEnsurer(db);
    const { service } = buildChatServiceWithEnsurer(db, ensurer);

    await expect(
      service.acknowledgeInvite(THREAD_ID, 'nonexistent-msg-id', AGENT_ID, SESSION_ID),
    ).resolves.toBeUndefined();
  });

  it('acknowledgeInvite does nothing for wrong session', async () => {
    const { ensurer } = buildInviteEnsurer(db);
    const { service } = buildChatServiceWithEnsurer(db, ensurer);

    await service.createMessage(THREAD_ID, {
      authorType: 'user',
      content: 'Hello',
      projectId: PROJECT_ID,
    });

    const invites = db.select().from(chatThreadSessionInvites).all();
    const inviteMessageId = invites[0].inviteMessageId;

    await service.acknowledgeInvite(THREAD_ID, inviteMessageId, AGENT_ID, 'wrong-session');

    const unchanged = db.select().from(chatThreadSessionInvites).all();
    expect(unchanged[0].acknowledgedAt).toBeNull();
  });
});
