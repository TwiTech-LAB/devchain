import { Test, TestingModule } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import Database from 'better-sqlite3';
import { AppModule } from '../src/app.module';
import { TmuxService } from '../src/modules/terminal/services/tmux.service';
import { SessionsService } from '../src/modules/sessions/services/sessions.service';
import { SessionsMessagePoolService } from '../src/modules/sessions/services/sessions-message-pool.service';
import {
  setupTestDb,
  teardownTestDb,
  resetTestDb,
  seedTestData,
  getTestDbPath,
} from './helpers/test-db';

process.env.SKIP_PREFLIGHT = '1';

describe('Events & Epic Assignment flow', () => {
  let app: NestFastifyApplication;
  let projectId: string;
  let statusId: string;
  let agentId: string;

  const pasteTextMock = jest.fn();
  const sendKeysMock = jest.fn();
  const listActiveSessionsMock = jest.fn();
  const launchSessionMock = jest.fn();
  const messagePoolEnqueueMock = jest.fn();

  const seedAgent = (project: string, profile: string) => {
    const dbPath = getTestDbPath();
    if (!dbPath) {
      throw new Error('Test database not initialized');
    }

    const sqlite = new Database(dbPath);
    const now = new Date().toISOString();
    sqlite
      .prepare(
        `INSERT INTO agents (id, project_id, profile_id, name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run('agent-assignment', project, profile, 'Assignment Bot', now, now);
    sqlite.close();
  };

  beforeAll(async () => {
    setupTestDb();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(TmuxService)
      .useValue({
        pasteText: pasteTextMock.mockResolvedValue(undefined),
        sendKeys: sendKeysMock.mockResolvedValue(undefined),
        createSessionName: jest.fn(),
        startHealthCheck: jest.fn(),
        stopHealthCheck: jest.fn(),
      })
      .overrideProvider(SessionsService)
      .useValue({
        listActiveSessions: listActiveSessionsMock,
        launchSession: launchSessionMock,
      })
      .overrideProvider(SessionsMessagePoolService)
      .useValue({
        enqueue: messagePoolEnqueueMock.mockResolvedValue({ status: 'queued', poolSize: 1 }),
      })
      .compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
    teardownTestDb();
  });

  beforeEach(() => {
    pasteTextMock.mockClear();
    sendKeysMock.mockClear();
    listActiveSessionsMock.mockClear();
    launchSessionMock.mockClear();
    messagePoolEnqueueMock.mockClear();

    launchSessionMock.mockResolvedValue({
      id: 'session-123',
      tmuxSessionId: 'devchain_project_session',
    });

    resetTestDb();
    const fixtures = seedTestData();
    projectId = fixtures.projectId;
    statusId = fixtures.statusId;
    agentId = 'agent-assignment';
    seedAgent(projectId, fixtures.agentProfileId);
  });

  async function waitForEventHandled(eventName: string, timeoutMs = 2000) {
    const start = Date.now();
    // Poll the events endpoint until handler info is recorded (subscriber is async).
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const eventsResponse = await app.inject({
        method: 'GET',
        url: `/api/events?name=${encodeURIComponent(eventName)}`,
      });
      if (eventsResponse.statusCode === 200) {
        const eventsPayload = JSON.parse(eventsResponse.payload);
        const first = eventsPayload.items?.[0];
        if (first?.handlers?.some((h: any) => h.handler === 'EpicAssignmentNotifier')) {
          return eventsPayload;
        }
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Timed out waiting for event ${eventName} to be handled`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  it('publishes epic.assigned event and invokes notifier', async () => {
    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/epics',
      payload: {
        projectId,
        statusId,
        title: 'Assignment Target',
      },
    });

    expect(createResponse.statusCode).toBe(201);
    const epic = JSON.parse(createResponse.payload);

    listActiveSessionsMock.mockResolvedValue([
      {
        id: 'session-123',
        agentId,
        epicId: epic.id,
        tmuxSessionId: 'devchain_project_session',
        status: 'running',
        startedAt: new Date().toISOString(),
        endedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);

    const updateResponse = await app.inject({
      method: 'PUT',
      url: `/api/epics/${epic.id}`,
      payload: {
        agentId,
        version: epic.version,
      },
    });

    expect(updateResponse.statusCode).toBe(200);
    const eventsPayload = await waitForEventHandled('epic.assigned');
    expect(eventsPayload.items.length).toBeGreaterThan(0);
    const recordedEvent = eventsPayload.items[0];
    expect(recordedEvent.name).toBe('epic.assigned');
    expect(recordedEvent.handlers[0].handler).toBe('EpicAssignmentNotifier');

    // Message should be enqueued to the message pool
    expect(messagePoolEnqueueMock).toHaveBeenCalledTimes(1);
    expect(messagePoolEnqueueMock).toHaveBeenCalledWith(
      agentId,
      expect.stringContaining('[Epic Assignment]'),
      expect.objectContaining({
        source: 'epic.assigned',
      }),
    );
    expect(launchSessionMock).not.toHaveBeenCalled();
  });

  it('does not publish epic.assigned when updating with same agentId (no-op)', async () => {
    // Step 1: Create epic and assign agent
    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/epics',
      payload: {
        projectId,
        statusId,
        title: 'No-Op Assignment Test',
      },
    });

    expect(createResponse.statusCode).toBe(201);
    const epic = JSON.parse(createResponse.payload);

    listActiveSessionsMock.mockResolvedValue([
      {
        id: 'session-123',
        agentId,
        epicId: epic.id,
        tmuxSessionId: 'devchain_project_session',
        status: 'running',
        startedAt: new Date().toISOString(),
        endedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);

    // First assignment (null -> agent)
    const firstUpdate = await app.inject({
      method: 'PUT',
      url: `/api/epics/${epic.id}`,
      payload: {
        agentId,
        version: epic.version,
      },
    });

    expect(firstUpdate.statusCode).toBe(200);
    const updatedEpic = JSON.parse(firstUpdate.payload);

    // Count events after first assignment
    const eventsAfterFirst = await waitForEventHandled('epic.assigned');
    const countAfterFirst = eventsAfterFirst.items.length;

    // Step 2: Update with the SAME agentId (no-op)
    messagePoolEnqueueMock.mockClear();

    const secondUpdate = await app.inject({
      method: 'PUT',
      url: `/api/epics/${epic.id}`,
      payload: {
        agentId, // Same agent - should be no-op
        version: updatedEpic.version,
      },
    });

    expect(secondUpdate.statusCode).toBe(200);

    // Verify no new epic.assigned event was published
    const eventsAfterSecond = await app.inject({
      method: 'GET',
      url: '/api/events?name=epic.assigned',
    });
    const countAfterSecond = JSON.parse(eventsAfterSecond.payload).items.length;

    expect(countAfterSecond).toBe(countAfterFirst);
    // Notifier should not have enqueued a message for no-op
    expect(messagePoolEnqueueMock).not.toHaveBeenCalled();
  });
});
