import { EgressQueueService } from './egress-queue.service';
import { CloudSessionManagerService } from './cloud-session-manager.service';
import { RefreshGateService } from './refresh-gate.service';
import type { RealtimeBroadcaster } from '../../realtime/ports/realtime-broadcaster.port';
import type { IngestPayload } from './event-mapper.service';

function makePayload(sourceEventId = 'evt-1'): IngestPayload {
  return {
    source: 'workflow',
    sourceEventId,
    sourceEventType: 'epic.created',
    forwardingUserId: 'user-1',
    recipientMode: 'self',
    recipientHints: [],
    occurredAt: new Date().toISOString(),
    payload: { epicId: 'e1', projectId: 'p1', title: 'Test', statusId: null },
    projectId: 'p1',
    orgId: null,
  };
}

describe('EgressQueueService', () => {
  let queue: EgressQueueService;
  let cloudSession: jest.Mocked<CloudSessionManagerService>;
  let refreshGate: jest.Mocked<RefreshGateService>;
  let broadcaster: jest.Mocked<RealtimeBroadcaster>;

  beforeEach(() => {
    cloudSession = {
      getAccessToken: jest.fn().mockReturnValue('mock-token'),
      getStatus: jest.fn().mockReturnValue({ connected: true, userId: 'user-1' }),
    } as unknown as jest.Mocked<CloudSessionManagerService>;

    refreshGate = {
      attemptRefresh: jest.fn(),
    } as unknown as jest.Mocked<RefreshGateService>;

    broadcaster = {
      broadcastEvent: jest.fn(),
    } as unknown as jest.Mocked<RealtimeBroadcaster>;

    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
      );

    queue = new EgressQueueService(cloudSession, refreshGate, broadcaster);
  });

  afterEach(() => {
    queue.onModuleDestroy();
    jest.restoreAllMocks();
  });

  it('should default NOTIFICATIONS_SERVICE_URL to port 3003', async () => {
    queue.enqueue(makePayload());
    await (queue as unknown as { drainOnce: () => Promise<void> }).drainOnce();

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('localhost:3003'),
      expect.anything(),
    );
  });

  it('should enqueue and track length', () => {
    queue.enqueue(makePayload());
    expect(queue.length).toBe(1);
  });

  it('should cap queue at MAX_QUEUE_SIZE (1000)', () => {
    for (let i = 0; i < 1050; i++) {
      queue.enqueue(makePayload(`evt-${i}`));
    }
    expect(queue.length).toBe(1000);
  });

  it('should drain queue on permanent refresh failure', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response('{}', { status: 401, headers: { 'Content-Type': 'application/json' } }),
      );
    refreshGate.attemptRefresh.mockResolvedValue('permanent_failure');

    queue.enqueue(makePayload('evt-1'));
    queue.enqueue(makePayload('evt-2'));
    queue.enqueue(makePayload('evt-3'));

    // Trigger drain manually by accessing the private method
    await (queue as unknown as { drainOnce: () => Promise<void> }).drainOnce();

    expect(queue.length).toBe(0);
    expect(broadcaster.broadcastEvent).toHaveBeenCalledWith('cloud', 'egress_disconnected', {
      reason: 'refresh_failed',
    });
  });

  it('should not count 401 as a delivery attempt', async () => {
    let callCount = 0;
    jest.spyOn(global, 'fetch').mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response('{}', { status: 401 });
      }
      return new Response('{}', { status: 200 });
    });

    refreshGate.attemptRefresh.mockResolvedValue('success');

    queue.enqueue(makePayload());

    // First drain: 401 → refresh → success → unpause
    await (queue as unknown as { drainOnce: () => Promise<void> }).drainOnce();
    // Second drain: retries with new token → 200 → dequeued
    await (queue as unknown as { drainOnce: () => Promise<void> }).drainOnce();

    expect(queue.length).toBe(0);
    expect(refreshGate.attemptRefresh).toHaveBeenCalledTimes(1);
  });

  it('should drop entry after 3 failed delivery attempts', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 500 }));

    queue.enqueue(makePayload());

    // Drain 3 times — entry should be dropped after 3 attempts
    for (let i = 0; i < 3; i++) {
      const entry = (queue as unknown as { queue: Array<{ nextAttemptAt: number }> }).queue[0];
      if (entry) entry.nextAttemptAt = 0;
      await (queue as unknown as { drainOnce: () => Promise<void> }).drainOnce();
    }

    expect(queue.length).toBe(0);
  });

  it('should treat 409 as success (idempotent duplicate)', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 409 }));

    queue.enqueue(makePayload());
    await (queue as unknown as { drainOnce: () => Promise<void> }).drainOnce();

    expect(queue.length).toBe(0);
  });
});
