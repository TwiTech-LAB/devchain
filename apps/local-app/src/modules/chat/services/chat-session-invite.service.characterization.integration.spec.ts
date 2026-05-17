/**
 * Characterization tests — ChatSessionInviteService.
 *
 * Layer: backend-integration
 * Justification: invite behavior depends on SQLite uniqueness, insert/update
 * ordering, and EventEmitter side effects. A migrated :memory: DB is the
 * cheapest reliable layer for this legacy behavior.
 */

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { count } from 'drizzle-orm';
import { join } from 'path';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { chatMessages, chatThreadSessionInvites } from '../../storage/db/schema';
import type { ActiveSessionLookup } from '../../sessions/services/active-session-lookup.service';
import type { SessionLauncherFacade } from '../../sessions/services/session-launcher-facade.service';
import type { ChatSettingsService } from './chat-settings.service';
import { ChatSessionInviteService } from './chat-session-invite.service';

const NOW = '2026-01-01T00:00:00.000Z';
const PROJECT_ID = 'project-1';
const THREAD_ID = 'thread-1';
const AGENT_ID = 'agent-1';
const OTHER_AGENT_ID = 'agent-2';
const SESSION_ID = 'tmux-session-1';

function setupDb(): { sqlite: Database.Database; db: BetterSQLite3Database } {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  const db = drizzle(sqlite);

  sqlite.pragma('foreign_keys = OFF');
  migrate(db, { migrationsFolder: join(__dirname, '../../../..', 'drizzle') });
  sqlite.pragma('foreign_keys = ON');

  sqlite.exec(`
    INSERT INTO projects (id, name, root_path, created_at, updated_at)
    VALUES ('${PROJECT_ID}', 'Project', '/tmp/project', '${NOW}', '${NOW}');

    INSERT INTO providers (id, name, created_at, updated_at)
    VALUES ('provider-1', 'claude', '${NOW}', '${NOW}');

    INSERT INTO agent_profiles (id, name, created_at, updated_at)
    VALUES ('profile-1', 'Profile', '${NOW}', '${NOW}');

    INSERT INTO profile_provider_configs (id, profile_id, provider_id, name, position, created_at, updated_at)
    VALUES ('ppc-1', 'profile-1', 'provider-1', 'default', 0, '${NOW}', '${NOW}');

    INSERT INTO agents (id, project_id, profile_id, provider_config_id, name, created_at, updated_at)
    VALUES ('${AGENT_ID}', '${PROJECT_ID}', 'profile-1', 'ppc-1', 'Alpha', '${NOW}', '${NOW}');

    INSERT INTO agents (id, project_id, profile_id, provider_config_id, name, created_at, updated_at)
    VALUES ('${OTHER_AGENT_ID}', '${PROJECT_ID}', 'profile-1', 'ppc-1', 'Beta', '${NOW}', '${NOW}');

    INSERT INTO chat_threads (id, project_id, title, is_group, created_by_type, created_at, updated_at)
    VALUES ('${THREAD_ID}', '${PROJECT_ID}', 'Planning Thread', 1, 'user', '${NOW}', '${NOW}');

    INSERT INTO chat_members (thread_id, agent_id, created_at)
    VALUES ('${THREAD_ID}', '${AGENT_ID}', '${NOW}');

    INSERT INTO chat_members (thread_id, agent_id, created_at)
    VALUES ('${THREAD_ID}', '${OTHER_AGENT_ID}', '${NOW}');
  `);

  return { sqlite, db };
}

async function tableCount(
  db: BetterSQLite3Database,
  table: typeof chatMessages | typeof chatThreadSessionInvites,
): Promise<number> {
  const [row] = await db.select({ value: count() }).from(table);
  return row.value;
}

describe('ChatSessionInviteService characterization', () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database;
  let eventEmitter: { emit: jest.Mock };
  let chatSettings: { getInviteTemplate: jest.Mock };
  let activeSessionLookup: { listActiveSessions: jest.Mock };
  let sessionLauncherFacade: { ensureActiveSession: jest.Mock };
  let service: ChatSessionInviteService;

  beforeEach(() => {
    ({ sqlite, db } = setupDb());
    eventEmitter = { emit: jest.fn().mockReturnValue(true) };
    chatSettings = {
      getInviteTemplate: jest
        .fn()
        .mockResolvedValue(
          'Invite {{ invited_agent_name }} to {{ thread_title }} with {{ participant_names }}',
        ),
    };
    activeSessionLookup = {
      listActiveSessions: jest.fn().mockResolvedValue([
        { agentId: AGENT_ID, tmuxSessionId: SESSION_ID },
        { agentId: OTHER_AGENT_ID, tmuxSessionId: 'tmux-session-2' },
      ]),
    };
    sessionLauncherFacade = {
      ensureActiveSession: jest.fn().mockResolvedValue({
        sessionId: `session-${AGENT_ID}`,
        agentId: AGENT_ID,
        projectId: PROJECT_ID,
        status: 'running',
        tmuxSessionId: SESSION_ID,
        startedAt: NOW,
        lastActivityAt: NOW,
      }),
    };

    service = new ChatSessionInviteService(
      db,
      eventEmitter as unknown as EventEmitter2,
      chatSettings as unknown as ChatSettingsService,
      activeSessionLookup as unknown as ActiveSessionLookup,
      sessionLauncherFacade as unknown as SessionLauncherFacade,
    );
  });

  afterEach(() => {
    if (sqlite.open) {
      sqlite.close();
    }
  });

  it('emits after message and invite-row insert', async () => {
    eventEmitter.emit.mockImplementation((eventName: string) => {
      expect(eventName).toBe('chat.message.created');
      expect(sqlite.prepare('SELECT COUNT(*) AS value FROM chat_messages').get()).toEqual({
        value: 1,
      });
      expect(
        sqlite.prepare('SELECT COUNT(*) AS value FROM chat_thread_session_invites').get(),
      ).toEqual({ value: 1 });
      return true;
    });

    await service.ensureSessionInvites(THREAD_ID, PROJECT_ID, [AGENT_ID]);

    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'chat.message.created',
      expect.objectContaining({
        threadId: THREAD_ID,
        projectId: PROJECT_ID,
        message: expect.objectContaining({
          authorType: 'system',
          content: 'Invite Alpha to Planning Thread with Alpha, Beta',
        }),
      }),
    );
    await expect(tableCount(db, chatMessages)).resolves.toBe(1);
    await expect(tableCount(db, chatThreadSessionInvites)).resolves.toBe(1);
  });

  it('skips empty targets and remains idempotent with existing invite rows', async () => {
    await service.ensureSessionInvites(THREAD_ID, PROJECT_ID, []);
    await expect(tableCount(db, chatMessages)).resolves.toBe(0);

    await service.ensureSessionInvites(THREAD_ID, PROJECT_ID, [AGENT_ID]);
    activeSessionLookup.listActiveSessions.mockResolvedValue([
      { agentId: AGENT_ID, tmuxSessionId: SESSION_ID },
    ]);
    await service.ensureSessionInvites(THREAD_ID, PROJECT_ID, [AGENT_ID]);

    await expect(tableCount(db, chatMessages)).resolves.toBe(1);
    await expect(tableCount(db, chatThreadSessionInvites)).resolves.toBe(1);
  });

  it('auto-launches offline targeted agents before invite persistence and event emit', async () => {
    activeSessionLookup.listActiveSessions.mockResolvedValue([]);
    sessionLauncherFacade.ensureActiveSession.mockImplementation(async () => {
      expect(sqlite.prepare('SELECT COUNT(*) AS value FROM chat_messages').get()).toEqual({
        value: 0,
      });
      expect(
        sqlite.prepare('SELECT COUNT(*) AS value FROM chat_thread_session_invites').get(),
      ).toEqual({
        value: 0,
      });
      return {
        sessionId: `session-${AGENT_ID}`,
        agentId: AGENT_ID,
        projectId: PROJECT_ID,
        status: 'running',
        tmuxSessionId: SESSION_ID,
        startedAt: NOW,
        lastActivityAt: NOW,
      };
    });

    await service.ensureSessionInvites(THREAD_ID, PROJECT_ID, [AGENT_ID]);

    expect(sessionLauncherFacade.ensureActiveSession).toHaveBeenCalledWith(AGENT_ID, PROJECT_ID);
    await expect(tableCount(db, chatMessages)).resolves.toBe(1);
    await expect(tableCount(db, chatThreadSessionInvites)).resolves.toBe(1);
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'chat.message.created',
      expect.objectContaining({
        threadId: THREAD_ID,
        projectId: PROJECT_ID,
      }),
    );
  });

  it('continues to insert the invite row when chat.message.created emit fails', async () => {
    eventEmitter.emit.mockImplementation(() => {
      throw new Error('listener failed');
    });

    await service.ensureSessionInvites(THREAD_ID, PROJECT_ID, [AGENT_ID]);

    await expect(tableCount(db, chatMessages)).resolves.toBe(1);
    await expect(tableCount(db, chatThreadSessionInvites)).resolves.toBe(1);
  });

  it('throws non-unique database failures', async () => {
    activeSessionLookup.listActiveSessions.mockImplementation(async () => {
      sqlite.close();
      return [{ agentId: AGENT_ID, tmuxSessionId: SESSION_ID }];
    });

    await expect(service.ensureSessionInvites(THREAD_ID, PROJECT_ID, [AGENT_ID])).rejects.toThrow();
  });
});
