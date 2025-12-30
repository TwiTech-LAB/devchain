import { Test, TestingModule } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import Database from 'better-sqlite3';
import { AppModule } from '../src/app.module';
import {
  setupTestDb,
  teardownTestDb,
  resetTestDb,
  seedTestData,
  getTestDbPath,
} from './helpers/test-db';

process.env.SKIP_PREFLIGHT = '1';

describe('Chat API (E2E)', () => {
  let app: NestFastifyApplication;
  let projectId: string;
  let agentId: string;
  const agent1Id = '55555555-5555-4555-8555-555555555555';
  const agent2Id = '66666666-6666-4666-8666-666666666666';
  const agent3Id = '77777777-7777-4777-8777-777777777777';

  const seedAgents = (projectId: string, agentProfileId: string) => {
    const dbPath = getTestDbPath();
    if (!dbPath) {
      throw new Error('Test database not initialized');
    }

    const sqlite = new Database(dbPath);
    const now = new Date().toISOString();

    sqlite
      .prepare(
        `INSERT INTO agents (id, project_id, profile_id, name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(agent1Id, projectId, agentProfileId, 'Chat Bot', now, now);

    sqlite
      .prepare(
        `INSERT INTO agents (id, project_id, profile_id, name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(agent2Id, projectId, agentProfileId, 'Helper Bot', now, now);

    sqlite
      .prepare(
        `INSERT INTO agents (id, project_id, profile_id, name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(agent3Id, projectId, agentProfileId, 'Test Bot', now, now);

    sqlite.close();
  };

  beforeAll(async () => {
    setupTestDb();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(new FastifyAdapter());

    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
    teardownTestDb();
  });

  beforeEach(() => {
    resetTestDb();
    const fixtures = seedTestData();
    projectId = fixtures.projectId;
    seedAgents(projectId, fixtures.agentProfileId);
    agentId = agent1Id;
  });

  describe('Direct threads', () => {
    it('creates a direct thread for user and agent', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/chat/threads/direct',
        payload: {
          projectId,
          agentId,
        },
      });

      expect(response.statusCode).toBe(201);
      const thread = JSON.parse(response.payload);
      expect(thread.isGroup).toBe(false);
      expect(thread.members).toContain(agentId);
      expect(thread.projectId).toBe(projectId);
    });

    it('returns existing direct thread if one already exists', async () => {
      // Create first thread
      const firstResponse = await app.inject({
        method: 'POST',
        url: '/api/chat/threads/direct',
        payload: {
          projectId,
          agentId,
        },
      });

      const firstThread = JSON.parse(firstResponse.payload);

      // Try to create again
      const secondResponse = await app.inject({
        method: 'POST',
        url: '/api/chat/threads/direct',
        payload: {
          projectId,
          agentId,
        },
      });

      const secondThread = JSON.parse(secondResponse.payload);

      expect(firstThread.id).toBe(secondThread.id);
    });
  });

  describe('Group threads', () => {
    it('creates a group thread with multiple agents', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/chat/threads/group',
        payload: {
          projectId,
          agentIds: [agent1Id, agent2Id, agent3Id],
          title: 'Test Group',
          createdByType: 'user',
        },
      });

      expect(response.statusCode).toBe(201);
      const thread = JSON.parse(response.payload);
      expect(thread.isGroup).toBe(true);
      expect(thread.title).toBe('Test Group');
      expect(thread.members).toHaveLength(3);
      expect(thread.members).toContain(agent1Id);
      expect(thread.members).toContain(agent2Id);
      expect(thread.members).toContain(agent3Id);
    });

    it('rejects group thread with less than 2 agents', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/chat/threads/group',
        payload: {
          projectId,
          agentIds: [agent1Id],
          createdByType: 'user',
        },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('Messages', () => {
    let threadId: string;

    beforeEach(async () => {
      // Create a direct thread first
      const threadResponse = await app.inject({
        method: 'POST',
        url: '/api/chat/threads/direct',
        payload: {
          projectId,
          agentId,
        },
      });

      threadId = JSON.parse(threadResponse.payload).id;
    });

    it('creates a message in a thread', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/chat/threads/${threadId}/messages`,
        payload: {
          content: 'Hello world!',
          authorType: 'user',
        },
      });

      expect(response.statusCode).toBe(201);
      const message = JSON.parse(response.payload);
      expect(message.content).toBe('Hello world!');
      expect(message.authorType).toBe('user');
      expect(message.threadId).toBe(threadId);
    });

    it('lists messages in a thread', async () => {
      // Create a message
      await app.inject({
        method: 'POST',
        url: `/api/chat/threads/${threadId}/messages`,
        payload: {
          content: 'Test message',
          authorType: 'user',
        },
      });

      // List messages
      const response = await app.inject({
        method: 'GET',
        url: `/api/chat/threads/${threadId}/messages?projectId=${projectId}`,
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      const userMessages = (data.items ?? []).filter((m: any) => m.authorType === 'user');
      expect(userMessages).toHaveLength(1);
      expect(userMessages[0].content).toBe('Test message');
    });

    it('supports targeted messages for user-authored messages', async () => {
      // Create group thread
      const groupResponse = await app.inject({
        method: 'POST',
        url: '/api/chat/threads/group',
        payload: {
          projectId,
          agentIds: [agent1Id, agent2Id],
          createdByType: 'user',
        },
      });

      const groupThread = JSON.parse(groupResponse.payload);

      // Send targeted message
      const messageResponse = await app.inject({
        method: 'POST',
        url: `/api/chat/threads/${groupThread.id}/messages`,
        payload: {
          content: '@Agent1 hello!',
          authorType: 'user',
          targets: [agent1Id],
        },
      });

      expect(messageResponse.statusCode).toBe(201);
      const message = JSON.parse(messageResponse.payload);
      expect(message.targets).toEqual([agent1Id]);
    });
  });

  describe('Thread listing', () => {
    it('lists user-created threads', async () => {
      // Create a direct thread
      await app.inject({
        method: 'POST',
        url: '/api/chat/threads/direct',
        payload: {
          projectId,
          agentId,
        },
      });

      // List threads
      const response = await app.inject({
        method: 'GET',
        url: `/api/chat/threads?projectId=${projectId}&createdByType=user`,
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      expect(data.items.length).toBeGreaterThan(0);
      expect(data.items[0].createdByType).toBe('user');
    });

    it('lists agent-initiated threads separately', async () => {
      // Create agent-initiated thread
      await app.inject({
        method: 'POST',
        url: '/api/chat/threads/group',
        payload: {
          projectId,
          agentIds: [agent1Id, agent2Id],
          createdByType: 'agent',
          createdByAgentId: agent1Id,
        },
      });

      // List agent threads
      const response = await app.inject({
        method: 'GET',
        url: `/api/chat/threads?projectId=${projectId}&createdByType=agent`,
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      expect(data.items.length).toBeGreaterThan(0);
      expect(data.items[0].createdByType).toBe('agent');
    });
  });
});
