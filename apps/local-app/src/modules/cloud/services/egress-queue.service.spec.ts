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

/** Backdoor to the private drain for deterministic single-step tests. */
type QueueInternals = {
  drainOnce: () => Promise<void>;
  queue: Array<{
    payload: IngestPayload;
    attempts: number;
    nextAttemptAt: number;
    firstAttemptAt: number;
  }>;
};

describe('EgressQueueService', () => {
  let queue: EgressQueueService;
  let internals: QueueInternals;
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
    internals = queue as unknown as QueueInternals;
  });

  afterEach(() => {
    queue.onModuleDestroy();
    jest.restoreAllMocks();
  });

  it('should default NOTIFICATIONS_SERVICE_URL to notify.devchain.cc', async () => {
    // The URL is read at call-time, so deleting the env var is enough to exercise the
    // default — keeps the test hermetic w.r.t. a dev shell that exports the var.
    const prev = process.env.NOTIFICATIONS_SERVICE_URL;
    delete process.env.NOTIFICATIONS_SERVICE_URL;
    try {
      queue.enqueue(makePayload());
      await internals.drainOnce();

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('notify.devchain.cc'),
        expect.anything(),
      );
    } finally {
      if (prev === undefined) delete process.env.NOTIFICATIONS_SERVICE_URL;
      else process.env.NOTIFICATIONS_SERVICE_URL = prev;
    }
  });

  it('should enqueue and track length', () => {
    queue.enqueue(makePayload());
    expect(queue.length).toBe(1);
  });

  describe('status matrix', () => {
    it.each([200, 201, 204])('removes the entry as delivered on %i', async (status) => {
      // 204 must carry a null body per fetch semantics.
      jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(new Response(status === 204 ? null : '{}', { status }));
      queue.enqueue(makePayload());

      await internals.drainOnce();

      expect(queue.length).toBe(0);
      expect(broadcaster.broadcastEvent).not.toHaveBeenCalled();
    });

    it('does NOT count 401 as a delivery attempt and refreshes via the existing path', async () => {
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

      await internals.drainOnce();
      await internals.drainOnce();

      expect(queue.length).toBe(0);
      expect(refreshGate.attemptRefresh).toHaveBeenCalledTimes(1);
    });

    it.each([429, 500, 502, 503])('schedules a bounded retry on transient %i', async (status) => {
      jest.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status }));
      queue.enqueue(makePayload());

      await internals.drainOnce();

      expect(queue.length).toBe(1);
      expect(internals.queue[0].attempts).toBe(1);
      expect(broadcaster.broadcastEvent).not.toHaveBeenCalled();
    });

    it.each([400, 403, 409, 422])(
      'treats non-authentication %i as a TERMINAL producer failure (removed, never delivered)',
      async (status) => {
        jest.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status }));
        queue.enqueue(makePayload());

        await internals.drainOnce();

        expect(queue.length).toBe(0);
        expect(global.fetch).toHaveBeenCalledTimes(1);
        expect(broadcaster.broadcastEvent).toHaveBeenCalledWith('cloud', 'egress_disconnected', {
          reason: 'delivery_failed',
          detail: `terminal_response_${status}`,
        });
      },
    );

    it('network errors schedule a bounded retry', async () => {
      jest.spyOn(global, 'fetch').mockRejectedValue(new TypeError('fetch failed (ECONNREFUSED)'));
      queue.enqueue(makePayload());

      await internals.drainOnce();

      expect(queue.length).toBe(1);
      expect(internals.queue[0].attempts).toBe(1);
      expect(broadcaster.broadcastEvent).not.toHaveBeenCalled();
    });
  });

  describe('bounded 10-minute retry window', () => {
    it('retries transient failures with capped exponential backoff', async () => {
      jest.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 503 }));
      queue.enqueue(makePayload());

      await internals.drainOnce(); // first attempt anchors firstAttemptAt
      const entry = internals.queue[0];

      // Simulate successive drains at the scheduled times; backoff caps at 30s.
      for (let i = 0; i < 6; i++) {
        const scheduled = entry.nextAttemptAt;
        jest.spyOn(Date, 'now').mockReturnValue(scheduled);
        await internals.drainOnce();
        expect(entry.nextAttemptAt - scheduled).toBe(Math.min(1000 * 2 ** (i + 1), 30_000));
      }

      expect(queue.length).toBe(1);
      expect(entry.attempts).toBe(7);
      jest.spyOn(Date, 'now').mockRestore();
    });

    it('removes the entry with a safe failure outcome once the window expires', async () => {
      jest.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 500 }));
      queue.enqueue(makePayload());

      // Age the entry past the 10-minute window after its first attempt.
      await internals.drainOnce();
      const entry = internals.queue[0];
      jest.spyOn(Date, 'now').mockReturnValue(entry.firstAttemptAt + 10 * 60 * 1000 + 1);
      entry.nextAttemptAt = 0;

      await internals.drainOnce();

      expect(queue.length).toBe(0);
      expect(broadcaster.broadcastEvent).toHaveBeenCalledWith('cloud', 'egress_disconnected', {
        reason: 'delivery_failed',
        detail: 'retry_window_expired_after_transient_response_500',
      });
      jest.spyOn(Date, 'now').mockRestore();
    });

    it('expires a persistently failing network delivery too (never delivered)', async () => {
      jest.spyOn(global, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
      queue.enqueue(makePayload());

      await internals.drainOnce();
      const entry = internals.queue[0];
      jest.spyOn(Date, 'now').mockReturnValue(entry.firstAttemptAt + 10 * 60 * 1000 + 1);
      entry.nextAttemptAt = 0;

      await internals.drainOnce();

      expect(queue.length).toBe(0);
      expect(broadcaster.broadcastEvent).toHaveBeenCalledWith(
        'cloud',
        'egress_disconnected',
        expect.objectContaining({ reason: 'delivery_failed' }),
      );
      jest.spyOn(Date, 'now').mockRestore();
    });
  });

  describe('ordering and capacity', () => {
    it('preserves strict serial ordering (head-of-line blocks later entries)', async () => {
      let call = 0;
      const seen: string[] = [];
      jest.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
        call++;
        seen.push(JSON.parse((init as RequestInit).body as string).sourceEventId);
        return new Response('{}', { status: call === 1 ? 500 : 200 });
      });

      queue.enqueue(makePayload('evt-1'));
      queue.enqueue(makePayload('evt-2'));

      await internals.drainOnce(); // evt-1 fails transiently, stays at head

      expect(seen).toEqual(['evt-1']);
      expect(internals.queue.map((e) => e.payload.sourceEventId)).toEqual(['evt-1', 'evt-2']);
    });

    it('should cap queue at 1000 entries (overflow drops the OLDEST, in-process only)', () => {
      for (let i = 0; i < 1005; i++) {
        queue.enqueue(makePayload(`evt-${i}`));
      }
      expect(queue.length).toBe(1000);
      // The oldest five are gone; the head is now evt-5.
      expect(internals.queue[0].payload.sourceEventId).toBe('evt-5');
      expect(internals.queue[999].payload.sourceEventId).toBe('evt-1004');
    });

    it('an overflow can force-drop a retrying entry — no restart/crash durability is claimed', () => {
      jest.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 500 }));
      queue.enqueue(makePayload('evt-retrying'));

      // 1,000 subsequent events overflow the bound and drop the retrying head.
      for (let i = 0; i < 1000; i++) {
        queue.enqueue(makePayload(`evt-new-${i}`));
      }
      expect(queue.length).toBe(1000);
      expect(internals.queue.some((e) => e.payload.sourceEventId === 'evt-retrying')).toBe(false);
    });
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

    await internals.drainOnce();

    expect(queue.length).toBe(0);
    expect(broadcaster.broadcastEvent).toHaveBeenCalledWith('cloud', 'egress_disconnected', {
      reason: 'refresh_failed',
    });
  });
});
