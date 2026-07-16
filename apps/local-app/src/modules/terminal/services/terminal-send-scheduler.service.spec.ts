import { EventEmitter } from 'node:events';
import type { Socket } from 'socket.io';
import { createEnvelope } from '../dtos/ws-envelope.dto';
import {
  TerminalSendAdmission,
  TerminalSendSchedulerService,
} from './terminal-send-scheduler.service';
import { TerminalSocketDrainAdapter } from './terminal-socket-drain.adapter';

class FakeDrainAdapter {
  readonly sent = new Map<string, unknown[]>();
  readonly bufferedPackets = new Map<string, number>();
  private readonly writable = new Map<string, boolean>();
  private readonly completions = new Map<string, () => void>();
  private readonly ready = new Map<string, () => void>();

  setWritable(socket: Socket, writable: boolean): void {
    this.writable.set(socket.id, writable);
    if (writable) {
      const listener = this.ready.get(socket.id);
      this.ready.delete(socket.id);
      listener?.();
    }
  }

  isWritable(socket: Socket): boolean {
    return this.writable.get(socket.id) ?? false;
  }

  send(socket: Socket, envelope: unknown, complete: () => void): boolean {
    if (!this.isWritable(socket)) return false;
    const sent = this.sent.get(socket.id) ?? [];
    sent.push(envelope);
    this.sent.set(socket.id, sent);
    this.writable.set(socket.id, false);
    this.completions.set(socket.id, complete);
    return true;
  }

  onWritable(socket: Socket, listener: () => void): () => void {
    this.ready.set(socket.id, listener);
    return () => {
      if (this.ready.get(socket.id) === listener) this.ready.delete(socket.id);
    };
  }

  complete(socket: Socket): void {
    const complete = this.completions.get(socket.id);
    this.completions.delete(socket.id);
    complete?.();
    this.setWritable(socket, true);
  }

  getBufferedPacketCount(socket: Socket): number {
    return this.bufferedPackets.get(socket.id) ?? 0;
  }
}

function socket(id: string): Socket {
  return { id, connected: true } as Socket;
}

function dataEnvelope(value: string, sequence: number = 1, sessionId: string = 'session-a') {
  return createEnvelope(`terminal/${sessionId}`, 'data', { data: value, sequence });
}

describe('TerminalSendSchedulerService', () => {
  let adapter: FakeDrainAdapter;

  beforeEach(() => {
    adapter = new FakeDrainAdapter();
  });

  it('paused-transport harness keeps Engine.IO writeBuffer flat during a terminal burst', () => {
    const transport = Object.assign(new EventEmitter(), { writable: false });
    const connection = {
      readyState: 'open',
      transport,
      writeBuffer: [] as unknown[],
    };
    const client = {
      id: 'paused-harness',
      connected: true,
      conn: connection,
      emit: jest.fn(() => {
        connection.writeBuffer.push({});
        return true;
      }),
    } as unknown as Socket;
    const service = new TerminalSendSchedulerService(new TerminalSocketDrainAdapter(), {
      queueBytes: 512,
      batchBytes: 256,
    });

    for (let sequence = 1; sequence <= 100; sequence += 1) {
      service.enqueueLive(client, dataEnvelope('x'.repeat(40), sequence));
    }

    expect(client.emit).not.toHaveBeenCalled();
    expect(connection.writeBuffer).toHaveLength(0);
    expect(service.getStats().terminalQueues[client.id]).toMatchObject({
      queuedBytes: 0,
      desynchronized: true,
      engineBufferedPackets: 0,
    });
  });

  it('keeps all bytes in the bounded app queue while transport is unwritable', () => {
    const service = new TerminalSendSchedulerService(
      adapter as unknown as TerminalSocketDrainAdapter,
      { queueBytes: 1024, batchBytes: 256 },
    );
    const client = socket('stalled');
    adapter.setWritable(client, false);

    service.enqueueLive(client, dataEnvelope('a'.repeat(100)));
    service.enqueueLive(client, dataEnvelope('b'.repeat(100), 2));

    expect(adapter.sent.get(client.id)).toBeUndefined();
    expect(service.getStats().terminalQueues[client.id].queuedBytes).toBeLessThanOrEqual(1024);
    expect(service.getStats().terminalQueues[client.id].engineBufferedPackets).toBe(0);
  });

  it('allows only one emitted batch outside the queue until drain completes', () => {
    const service = new TerminalSendSchedulerService(
      adapter as unknown as TerminalSocketDrainAdapter,
      { queueBytes: 2048, batchBytes: 512 },
    );
    const client = socket('current');
    adapter.setWritable(client, true);

    service.enqueueLive(client, dataEnvelope('first'));
    service.enqueueLive(client, dataEnvelope('second', 2));
    service.enqueueLive(client, dataEnvelope('third', 3));

    expect(adapter.sent.get(client.id)).toHaveLength(1);
    expect(service.getStats().terminalQueues[client.id].inFlightBytes).toBeGreaterThan(0);

    adapter.complete(client);
    expect(adapter.sent.get(client.id)).toHaveLength(2);
    const merged = adapter.sent.get(client.id)![1] as {
      payload: { data: string; sequence: number };
    };
    expect(merged.payload).toMatchObject({ data: 'secondthird', sequence: 3 });
  });

  it('accepts the maximum configured seed as bounded chunks in the default queue', () => {
    const service = new TerminalSendSchedulerService(
      adapter as unknown as TerminalSocketDrainAdapter,
    );
    const client = socket('seed-target');
    adapter.setWritable(client, false);

    for (let chunk = 0; chunk < 64; chunk += 1) {
      expect(
        service.enqueueRecovery(
          client,
          createEnvelope('terminal/session-a', 'seed_ansi', {
            data: 'x'.repeat(64 * 1024),
            chunk,
            totalChunks: 64,
          }),
        ),
      ).toBe(TerminalSendAdmission.Accepted);
    }

    const stats = service.getStats().terminalQueues[client.id];
    expect(stats.desynchronized).toBe(false);
    expect(stats.queuedBytes).toBeGreaterThan(4 * 1024 * 1024);
    expect(stats.queuedBytes).toBeLessThanOrEqual(5 * 1024 * 1024);
  });

  it('reports the desynchronization transition once and suppresses later live data', () => {
    const service = new TerminalSendSchedulerService(
      adapter as unknown as TerminalSocketDrainAdapter,
      { queueBytes: 320, batchBytes: 256 },
    );
    const client = socket('overflow');
    adapter.setWritable(client, false);

    expect(service.enqueueLive(client, dataEnvelope('a'.repeat(100)))).toBe(
      TerminalSendAdmission.Accepted,
    );
    expect(service.enqueueLive(client, dataEnvelope('b'.repeat(200), 2))).toBe(
      TerminalSendAdmission.NewlyDesynchronized,
    );
    expect(service.enqueueLive(client, dataEnvelope('later', 3))).toBe(
      TerminalSendAdmission.Rejected,
    );

    const stats = service.getStats().terminalQueues[client.id];
    expect(stats).toMatchObject({
      queuedBytes: 0,
      inFlightBytes: 0,
      desynchronized: true,
      droppedFrames: 2,
    });
    expect(adapter.sent.get(client.id)).toBeUndefined();
  });

  it('isolates a stalled viewer from a current viewer of the same terminal', () => {
    const service = new TerminalSendSchedulerService(
      adapter as unknown as TerminalSocketDrainAdapter,
      { queueBytes: 4096, batchBytes: 512 },
    );
    const stalled = socket('stalled');
    const current = socket('current');
    adapter.setWritable(stalled, false);
    adapter.setWritable(current, true);

    for (let sequence = 1; sequence <= 4; sequence += 1) {
      const envelope = dataEnvelope(`frame-${sequence}`, sequence);
      service.enqueueLive(stalled, envelope);
      service.enqueueLive(current, envelope);
      adapter.complete(current);
    }

    expect(adapter.sent.get(stalled.id)).toBeUndefined();
    expect(adapter.sent.get(current.id)).toHaveLength(4);
    expect(service.getStats().terminalQueues[stalled.id].queuedBytes).toBeGreaterThan(0);
  });

  it('routes recovery through the same scheduler and exposes recovery state hooks', () => {
    const service = new TerminalSendSchedulerService(
      adapter as unknown as TerminalSocketDrainAdapter,
      { queueBytes: 320, batchBytes: 256 },
    );
    const client = socket('recovering');
    adapter.setWritable(client, false);
    service.enqueueLive(client, dataEnvelope('x'.repeat(400)));

    expect(service.isDesynchronized(client.id, 'session-a')).toBe(true);
    expect(service.enqueueRecovery(client, dataEnvelope('seed'))).toBe(
      TerminalSendAdmission.Rejected,
    );

    service.beginRecovery(client, 'session-a', 1);
    expect(service.enqueueRecovery(client, dataEnvelope('seed'))).toBe(
      TerminalSendAdmission.Accepted,
    );
    adapter.setWritable(client, true);
    expect(adapter.sent.get(client.id)).toHaveLength(1);

    service.markSynchronized(client.id, 'session-a', 1);
    expect(service.isDesynchronized(client.id, 'session-a')).toBe(false);
  });

  it('runs recovery completion only after the final scheduler drain', () => {
    const service = new TerminalSendSchedulerService(
      adapter as unknown as TerminalSocketDrainAdapter,
      { queueBytes: 2048, batchBytes: 512 },
    );
    const client = socket('recovery-tail');
    const completed = jest.fn();
    adapter.setWritable(client, true);
    service.beginRecovery(client, 'session-a', 1);

    expect(service.enqueueRecovery(client, dataEnvelope('tail'), completed)).toBe(
      TerminalSendAdmission.Accepted,
    );
    expect(completed).not.toHaveBeenCalled();

    adapter.complete(client);
    expect(completed).toHaveBeenCalledTimes(1);
  });

  it('pure unit: isolates lane overflow while preserving the aggregate socket cap and sibling queue', () => {
    const service = new TerminalSendSchedulerService(
      adapter as unknown as TerminalSocketDrainAdapter,
      { queueBytes: 700, batchBytes: 512 },
    );
    const client = socket('lane-overflow');
    adapter.setWritable(client, false);

    expect(service.enqueueLive(client, dataEnvelope('a'.repeat(100), 1, 'session-a'))).toBe(
      TerminalSendAdmission.Accepted,
    );
    expect(service.enqueueLive(client, dataEnvelope('b'.repeat(100), 1, 'session-b'))).toBe(
      TerminalSendAdmission.Accepted,
    );
    expect(service.enqueueLive(client, dataEnvelope('x'.repeat(300), 2, 'session-a'))).toBe(
      TerminalSendAdmission.NewlyDesynchronized,
    );

    const queue = service.getStats().terminalQueues[client.id];
    expect(queue.queuedBytes).toBeLessThanOrEqual(700);
    expect(queue.lanes['session-a']).toMatchObject({
      queuedBytes: 0,
      desynchronized: true,
      droppedFrames: 2,
    });
    expect(queue.lanes['session-b']).toMatchObject({
      desynchronized: false,
      droppedFrames: 0,
    });
    expect(queue.lanes['session-b'].queuedBytes).toBeGreaterThan(0);
  });

  it('fails bounded recovery admission without reporting a second desynchronization transition', () => {
    const service = new TerminalSendSchedulerService(
      adapter as unknown as TerminalSocketDrainAdapter,
      { queueBytes: 320, batchBytes: 256 },
    );
    const client = socket('recovery-overflow');
    adapter.setWritable(client, false);
    service.beginRecovery(client, 'session-a', 1);

    expect(service.enqueueRecovery(client, dataEnvelope('x'.repeat(400)))).toBe(
      TerminalSendAdmission.Rejected,
    );
    expect(service.enqueueRecovery(client, dataEnvelope('later'))).toBe(
      TerminalSendAdmission.Rejected,
    );
    expect(service.getStats().terminalQueues[client.id].lanes['session-a']).toMatchObject({
      desynchronized: true,
      recoveryActive: false,
      queuedBytes: 0,
    });
  });

  it('pure unit: round-robins writable lanes without weakening strict order within a lane', () => {
    const service = new TerminalSendSchedulerService(
      adapter as unknown as TerminalSocketDrainAdapter,
      { queueBytes: 4096, batchBytes: 512 },
    );
    const client = socket('fair-lanes');
    adapter.setWritable(client, false);

    service.enqueueLive(client, dataEnvelope('a1', 1, 'session-a'));
    service.enqueueLive(client, dataEnvelope('a2', 2, 'session-a'));
    service.enqueueLive(client, dataEnvelope('b1', 1, 'session-b'));
    service.enqueueLive(client, dataEnvelope('b2', 2, 'session-b'));
    adapter.setWritable(client, true);
    adapter.complete(client);
    service.enqueueLive(client, dataEnvelope('a3', 3, 'session-a'));
    adapter.complete(client);
    adapter.complete(client);

    const sent = (adapter.sent.get(client.id) ?? []) as Array<{
      topic: string;
      payload: { data: string };
    }>;
    const topics = sent.map((envelope) => envelope.topic);
    expect(topics.slice(0, 2)).toEqual(['terminal/session-a', 'terminal/session-b']);
    expect(
      sent
        .filter((envelope) => envelope.topic === 'terminal/session-a')
        .map((envelope) => envelope.payload.data),
    ).toEqual(['a1a2', 'a3']);
    expect(
      sent
        .filter((envelope) => envelope.topic === 'terminal/session-b')
        .map((envelope) => envelope.payload.data),
    ).toEqual(['b1b2']);
  });

  it('pure unit: rejects stale recovery completion without synchronizing another generation or lane', () => {
    const service = new TerminalSendSchedulerService(
      adapter as unknown as TerminalSocketDrainAdapter,
      { queueBytes: 2048, batchBytes: 512 },
    );
    const client = socket('lane-epochs');

    service.beginRecovery(client, 'session-a', 1);
    service.beginRecovery(client, 'session-b', 4);
    service.beginRecovery(client, 'session-a', 2);

    expect(service.markSynchronized(client.id, 'session-a', 1)).toBe(false);
    expect(service.isDesynchronized(client.id, 'session-a')).toBe(true);
    expect(service.isDesynchronized(client.id, 'session-b')).toBe(true);
    expect(service.markSynchronized(client.id, 'session-a', 2)).toBe(true);
    expect(service.isDesynchronized(client.id, 'session-a')).toBe(false);
    expect(service.isDesynchronized(client.id, 'session-b')).toBe(true);
  });

  it('pure unit: removes one lane without discarding sibling work and ignores callbacks after socket removal', () => {
    const service = new TerminalSendSchedulerService(
      adapter as unknown as TerminalSocketDrainAdapter,
      { queueBytes: 2048, batchBytes: 512 },
    );
    const client = socket('lane-removal');
    const completed = jest.fn();
    adapter.setWritable(client, false);
    service.beginRecovery(client, 'session-a', 1);
    service.enqueueRecovery(client, dataEnvelope('seed-a', 1, 'session-a'), completed);
    service.enqueueLive(client, dataEnvelope('live-b', 1, 'session-b'));

    adapter.setWritable(client, true);
    expect(adapter.sent.get(client.id)).toHaveLength(1);
    service.removeLane(client.id, 'session-a');
    const queue = service.getStats().terminalQueues[client.id];
    expect(queue.lanes['session-a']).toBeUndefined();
    expect(queue.lanes['session-b'].queuedBytes).toBeGreaterThan(0);

    adapter.complete(client);
    expect(completed).not.toHaveBeenCalled();
    expect(adapter.sent.get(client.id)).toHaveLength(2);
    service.removeSocket(client.id);
    adapter.complete(client);
    expect(service.getStats().terminalQueues[client.id]).toBeUndefined();
  });
});
