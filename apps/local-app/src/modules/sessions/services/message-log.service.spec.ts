/**
 * Layer: module-unit (pure in-memory, no DI/IO)
 * Justification: MessageLogService is a pure data structure with no external
 * dependencies. Testing its ring buffer, pruning, and index logic directly.
 */

import { MessageLogService } from './message-log.service';
import type { MessageLogEntry } from './sessions-message-pool.service';

function makeEntry(overrides: Partial<MessageLogEntry> = {}): MessageLogEntry {
  return {
    id: overrides.id ?? 'entry-1',
    timestamp: Date.now(),
    projectId: 'project-1',
    agentId: 'agent-1',
    agentName: 'Alpha',
    text: overrides.text ?? 'test message',
    source: 'test',
    status: overrides.status ?? 'queued',
    immediate: false,
    ...overrides,
  };
}

describe('MessageLogService', () => {
  let log: MessageLogService;

  beforeEach(() => {
    log = new MessageLogService();
  });

  it('adds and retrieves entries by id', () => {
    const entry = makeEntry({ id: 'e1' });
    log.addEntry(entry);

    expect(log.getById('e1')).toEqual(entry);
    expect(log.getById('nonexistent')).toBeNull();
  });

  it('updates entry fields', () => {
    log.addEntry(makeEntry({ id: 'e1' }));
    log.update('e1', { status: 'delivered', deliveredAt: 12345 });

    const updated = log.getById('e1');
    expect(updated?.status).toBe('delivered');
    expect(updated?.deliveredAt).toBe(12345);
  });

  it('queries with filters', () => {
    log.addEntry(makeEntry({ id: 'e1', agentId: 'a1', status: 'queued' }));
    log.addEntry(makeEntry({ id: 'e2', agentId: 'a2', status: 'delivered' }));
    log.addEntry(makeEntry({ id: 'e3', agentId: 'a1', status: 'delivered' }));

    expect(log.query({ agentId: 'a1' })).toHaveLength(2);
    expect(log.query({ status: 'delivered' })).toHaveLength(2);
    expect(log.query({ agentId: 'a1', status: 'delivered' })).toHaveLength(1);
    expect(log.query({ limit: 1 })).toHaveLength(1);
  });

  it('returns stats', () => {
    log.addEntry(makeEntry({ id: 'e1', text: 'hello' }));

    const stats = log.getStats();
    expect(stats.entryCount).toBe(1);
    expect(stats.bytesUsed).toBe(5);
    expect(stats.maxEntries).toBe(500);
  });

  it('prunes oldest non-queued entries when limit exceeded', () => {
    for (let i = 0; i < 500; i++) {
      log.addEntry(makeEntry({ id: `e${i}`, status: 'delivered', text: 'x' }));
    }

    expect(log.getStats().entryCount).toBe(500);

    log.addEntry(makeEntry({ id: 'overflow', text: 'x' }));

    expect(log.getStats().entryCount).toBe(500);
    expect(log.getById('e0')).toBeNull();
    expect(log.getById('overflow')).not.toBeNull();
  });

  it('protects queued entries from pruning', () => {
    for (let i = 0; i < 500; i++) {
      log.addEntry(makeEntry({ id: `e${i}`, status: 'queued', text: 'x' }));
    }

    log.addEntry(makeEntry({ id: 'overflow', text: 'x' }));

    // All entries are queued so none can be pruned; overflow is still added
    expect(log.getStats().entryCount).toBe(501);
  });

  describe('mobile idempotent prune protection', () => {
    const FIFTEEN_MIN_MS = 15 * 60 * 1000;

    function fillDelivered(count: number, startIndex = 0): void {
      for (let i = startIndex; i < startIndex + count; i++) {
        log.addEntry(makeEntry({ id: `d${i}`, status: 'delivered', text: 'x' }));
      }
    }

    it('protects non-terminal (unconfirmed) mobile entries under pruning pressure', () => {
      log.addEntry(
        makeEntry({
          id: 'mob',
          source: 'mobile',
          clientMessageId: 'c1',
          status: 'unconfirmed',
          text: 'x',
        }),
      );
      fillDelivered(499);

      // 500 entries; this overflow forces exactly one prune.
      log.addEntry(makeEntry({ id: 'overflow', status: 'delivered', text: 'x' }));

      expect(log.getById('mob')).not.toBeNull(); // protected: skipped
      expect(log.getById('d0')).toBeNull(); // oldest prunable removed instead
    });

    it('keeps a terminal mobile entry within the 15-minute retention floor', () => {
      const now = Date.now();
      log.addEntry(
        makeEntry({
          id: 'fresh',
          source: 'mobile',
          clientMessageId: 'c1',
          status: 'delivered',
          deliveredAt: now,
          text: 'x',
        }),
      );
      fillDelivered(499);

      log.addEntry(makeEntry({ id: 'overflow', status: 'delivered', text: 'x' }));

      expect(log.getById('fresh')).not.toBeNull();
      expect(log.getById('d0')).toBeNull();
    });

    it('stops protecting a terminal mobile entry once the 15-minute floor lapses', () => {
      const stale = Date.now() - (FIFTEEN_MIN_MS + 1000);
      log.addEntry(
        makeEntry({
          id: 'stale',
          source: 'mobile',
          clientMessageId: 'c1',
          status: 'delivered',
          timestamp: stale,
          deliveredAt: stale,
          text: 'x',
        }),
      );
      fillDelivered(499);

      log.addEntry(makeEntry({ id: 'overflow', status: 'delivered', text: 'x' }));

      // Past the floor → prunable, and it is the oldest, so it is removed first.
      expect(log.getById('stale')).toBeNull();
      expect(log.getById('d0')).not.toBeNull();
    });

    it('degrades oldest-first when protected mobile entries exceed the 100 cap', () => {
      // 101 protected (non-terminal) mobile entries: over the cap by one.
      for (let i = 0; i < 101; i++) {
        log.addEntry(
          makeEntry({
            id: `m${i}`,
            source: 'mobile',
            clientMessageId: `c${i}`,
            status: 'unconfirmed',
            timestamp: 1000 + i, // strictly increasing: m0 is the oldest
            text: 'x',
          }),
        );
      }
      // Add delivered entries until the log overflows and pruning is forced.
      fillDelivered(400);

      // Over the cap, only the NEWEST 100 protected survive; the oldest (m0)
      // reverted to prunable and — being the oldest overall — was pruned.
      expect(log.getById('m0')).toBeNull();
      expect(log.getById('m100')).not.toBeNull();
      expect(log.getById('m1')).not.toBeNull();
    });
  });
});
