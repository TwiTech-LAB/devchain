import { MAX_HISTORY_IN_FLIGHT_BYTES, TerminalSession } from './terminal-session';
import type { FrameEvent } from './terminal-frame-stream';

function createSession(overrides?: { sessionId?: string; tmuxSessionName?: string }) {
  return new TerminalSession({
    sessionId: overrides?.sessionId ?? 'session-1',
    tmuxSessionName: overrides?.tmuxSessionName ?? 'tmux-session-1',
  });
}

function collectFrames(session: TerminalSession): FrameEvent[] {
  const frames: FrameEvent[] = [];
  session.stream.on('frame', (f) => frames.push(f));
  return frames;
}

describe('TerminalSession', () => {
  describe('subscribe', () => {
    it('adds client to subscribers and emits subscribed event', () => {
      const session = createSession();
      const frames = collectFrames(session);

      session.subscribe('client-1');

      expect(session.hasSubscriber('client-1')).toBe(true);
      expect(frames.some((f) => f.type === 'subscribed')).toBe(true);
    });

    it('grants authority to first subscriber automatically', () => {
      const session = createSession();
      const frames = collectFrames(session);

      session.subscribe('client-1');

      expect(session.getAuthority()).toBe('client-1');
      expect(frames.some((f) => f.type === 'focus_changed')).toBe(true);
    });

    it('connected-on-mount: subscribe immediately works', () => {
      const session = createSession();

      session.subscribe('client-1');

      expect(session.hasSubscriber('client-1')).toBe(true);
      expect(session.getAuthority()).toBe('client-1');
    });

    it('does not override authority when second client subscribes', () => {
      const session = createSession();

      session.subscribe('client-1');
      session.subscribe('client-2');

      expect(session.getAuthority()).toBe('client-1');
    });
  });

  describe('claimAuthority (subscribe-before-focus)', () => {
    it('rejects focus claim from non-subscriber', () => {
      const session = createSession();

      const result = session.claimAuthority('unknown-client');

      expect(result.granted).toBe(false);
    });

    it('grants focus to subscribed client', () => {
      const session = createSession();
      session.subscribe('client-1');
      session.subscribe('client-2');

      const result = session.claimAuthority('client-2');

      expect(result.granted).toBe(true);
      expect(result.previousHolder).toBe('client-1');
      expect(session.getAuthority()).toBe('client-2');
    });

    it('emits focus_changed on authority transfer', () => {
      const session = createSession();
      const frames = collectFrames(session);
      session.subscribe('client-1');
      session.subscribe('client-2');

      session.claimAuthority('client-2');

      const focusEvents = frames.filter((f) => f.type === 'focus_changed');
      const lastFocus = focusEvents[focusEvents.length - 1];
      expect((lastFocus.payload as { clientId: string }).clientId).toBe('client-2');
    });
  });

  describe('claimInitialAuthority (subscribe-time latch)', () => {
    it('grants when authority is unheld and does NOT emit focus_changed', () => {
      const session = createSession();
      const frames = collectFrames(session);

      const granted = session.claimInitialAuthority('client-1');

      expect(granted).toBe(true);
      expect(session.getAuthority()).toBe('client-1');
      expect(frames.filter((f) => f.type === 'focus_changed')).toHaveLength(0);
    });

    it('refuses and leaves authority untouched when already held', () => {
      const session = createSession();
      session.claimInitialAuthority('client-1');

      const granted = session.claimInitialAuthority('client-2');

      expect(granted).toBe(false);
      expect(session.getAuthority()).toBe('client-1');
    });

    it('grants to a non-subscriber (deliberate exception vs claimAuthority)', () => {
      const session = createSession();

      // Not subscribed yet — the latch fires just before subscribe().
      expect(session.hasSubscriber('client-1')).toBe(false);
      expect(session.claimInitialAuthority('client-1')).toBe(true);
      expect(session.getAuthority()).toBe('client-1');
    });

    it('resolves concurrent latch attempts to a single winner (interleaved subscribes)', () => {
      const session = createSession();

      const first = session.claimInitialAuthority('client-1');
      const second = session.claimInitialAuthority('client-2');

      expect(first).toBe(true);
      expect(second).toBe(false);
      expect(session.getAuthority()).toBe('client-1');
    });

    it('subscribe() no-ops its own grant for the latch winner (no duplicate focus_changed)', () => {
      const session = createSession();
      session.claimInitialAuthority('client-1');
      const frames = collectFrames(session);

      session.subscribe('client-1');

      expect(session.getAuthority()).toBe('client-1');
      expect(frames.filter((f) => f.type === 'focus_changed')).toHaveLength(0);
    });

    it('unsubscribe releases latched authority even without membership (disconnect safety)', () => {
      const session = createSession();
      session.claimInitialAuthority('client-1');

      // Client latched then died before subscribe() ran — no membership, but authority clears.
      session.unsubscribe('client-1');

      expect(session.getAuthority()).toBeNull();
    });
  });

  describe('notifyInitialAuthority (deferred grant forwarding)', () => {
    it('emits exactly one focus_changed for the current authority holder', () => {
      const session = createSession();
      session.claimInitialAuthority('client-1');
      const frames = collectFrames(session);

      session.notifyInitialAuthority('client-1');

      const focus = frames.filter((f) => f.type === 'focus_changed');
      expect(focus).toHaveLength(1);
      expect(focus[0].payload).toEqual(
        expect.objectContaining({ clientId: 'client-1', granted: true }),
      );
    });

    it('no-ops when the client no longer holds authority (voided by a steal/disconnect)', () => {
      const session = createSession();
      session.claimInitialAuthority('client-1');
      const frames = collectFrames(session);

      session.notifyInitialAuthority('client-2');

      expect(frames.filter((f) => f.type === 'focus_changed')).toHaveLength(0);
    });
  });

  describe('unsubscribe', () => {
    it('removes client from subscribers', () => {
      const session = createSession();
      session.subscribe('client-1');

      session.unsubscribe('client-1');

      expect(session.hasSubscriber('client-1')).toBe(false);
    });

    it('transfers authority to next subscriber when authority holder leaves', () => {
      const session = createSession();
      session.subscribe('client-1');
      session.subscribe('client-2');

      session.unsubscribe('client-1');

      expect(session.getAuthority()).toBe('client-2');
    });

    it('clears authority when last subscriber leaves', () => {
      const session = createSession();
      session.subscribe('client-1');

      session.unsubscribe('client-1');

      expect(session.getAuthority()).toBeNull();
    });
  });

  describe('resize', () => {
    it('rejects resize from non-authority client', () => {
      const session = createSession();
      session.subscribe('client-1');
      session.subscribe('client-2');

      const result = session.resize('client-2', { cols: 120, rows: 40 });

      expect(result.applied).toBe(false);
      expect(result.reason).toBe('not_authority');
    });

    it('rejects resize when dimensions unchanged', () => {
      const session = createSession();
      session.subscribe('client-1');

      const result = session.resize('client-1', { cols: 80, rows: 24 });

      expect(result.applied).toBe(false);
      expect(result.reason).toBe('unchanged');
    });

    it('applies resize from authority client with dimension change', () => {
      const session = createSession();
      session.subscribe('client-1');

      const result = session.resize('client-1', { cols: 120, rows: 40 });

      expect(result.applied).toBe(true);
      expect(result.ptyDimensions).toEqual({ cols: 120, rows: 40 });
    });

    it('debounces rapid resize calls', () => {
      jest.useFakeTimers();
      const session = createSession();
      session.subscribe('client-1');

      session.resize('client-1', { cols: 100, rows: 30 });
      const second = session.resize('client-1', { cols: 120, rows: 40 });

      expect(second.applied).toBe(false);
      expect(second.reason).toBe('debounced');
      expect(second.ptyDimensions).toEqual({ cols: 120, rows: 40 });

      jest.runAllTimers();
      expect(session.getDimensions()).toEqual({ cols: 120, rows: 40 });
      jest.useRealTimers();
    });

    it('keeps restore resize when a shrink is pending', () => {
      jest.useFakeTimers();
      try {
        const session = createSession();
        session.subscribe('client-1');

        const shrink = session.resize('client-1', { cols: 80, rows: 23 });
        const restore = session.resize('client-1', { cols: 80, rows: 24 });

        expect(shrink.ptyDimensions).toEqual({ cols: 80, rows: 23 });
        expect(restore.applied).toBe(false);
        expect(restore.reason).toBe('debounced');
        expect(restore.ptyDimensions).toEqual({ cols: 80, rows: 24 });

        jest.runAllTimers();
        expect(session.getDimensions()).toEqual({ cols: 80, rows: 24 });
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('confirm-first seed-async ordering', () => {
    it('emits subscribed before seed can be delivered', () => {
      const session = createSession();
      const frames = collectFrames(session);

      session.subscribe('client-1');

      const subscribedIdx = frames.findIndex((f) => f.type === 'subscribed');
      expect(subscribedIdx).toBeGreaterThanOrEqual(0);
    });
  });

  describe('live-frame buffering during full-history rewrite', () => {
    it('buffers frames during history-in-flight and replays after delivery', () => {
      const session = createSession();
      const frames = collectFrames(session);
      session.subscribe('client-1');
      frames.length = 0;

      session.requestFullHistory();

      session.pushFrame('live-frame-1');
      session.pushFrame('live-frame-2');
      expect(frames.filter((f) => f.type === 'data')).toHaveLength(0);

      session.deliverFullHistory('full-history-content');

      const historyFrame = frames.find((f) => f.type === 'full_history');
      expect(historyFrame).toBeDefined();
      expect((historyFrame!.payload as { ansi: string }).ansi).toBe('full-history-content');

      const dataFrames = frames.filter((f) => f.type === 'data');
      expect(dataFrames).toHaveLength(2);
      expect((dataFrames[0].payload as { data: string }).data).toBe('live-frame-1');
      expect((dataFrames[1].payload as { data: string }).data).toBe('live-frame-2');
    });

    it('resumes normal frame emission after history delivered', () => {
      const session = createSession();
      const frames = collectFrames(session);
      session.subscribe('client-1');
      frames.length = 0;

      session.requestFullHistory();
      session.deliverFullHistory('history');
      frames.length = 0;

      session.pushFrame('post-history-frame');

      expect(frames).toHaveLength(1);
      expect(frames[0].type).toBe('data');
    });

    it('aborts an overflowing history window and refetches without draining stale frames', async () => {
      const captures: Array<(result: { ok: boolean; output: string }) => void> = [];
      const session = createSession();
      const frames = collectFrames(session);
      session.bindIO({
        captureHistory: jest.fn().mockImplementation(
          () =>
            new Promise<{ ok: boolean; output: string }>((resolve) => {
              captures.push(resolve);
            }),
        ),
      });

      const firstRequest = session.requestFullHistory();
      session.pushFrame('x'.repeat(MAX_HISTORY_IN_FLIGHT_BYTES));
      session.pushFrame('overflow');
      expect(captures).toHaveLength(2);

      captures[0]({ ok: true, output: 'stale-history' });
      await firstRequest;
      expect(
        frames.some((frame) => (frame.payload as { ansi?: string }).ansi === 'stale-history'),
      ).toBe(false);

      captures[1]({ ok: true, output: 'fresh-history' });
      await Promise.resolve();
      expect(
        frames.some((frame) => (frame.payload as { ansi?: string }).ansi === 'fresh-history'),
      ).toBe(true);
      expect(frames.some((frame) => (frame.payload as { data?: string }).data === 'overflow')).toBe(
        false,
      );
    });
  });

  describe('pushFrame and activity', () => {
    it('tracks lastDataAt on frame push', () => {
      const session = createSession();
      session.subscribe('client-1');

      expect(session.getActivityState().lastDataAt).toBeNull();

      session.pushFrame('data');

      expect(session.getActivityState().lastDataAt).not.toBeNull();
    });

    it('does not emit after dispose', () => {
      const session = createSession();
      const frames = collectFrames(session);
      session.subscribe('client-1');
      frames.length = 0;

      session.dispose();
      session.pushFrame('should-not-emit');

      expect(frames).toHaveLength(0);
    });
  });

  describe('getActivityState', () => {
    it('reports subscriber count and authority', () => {
      const session = createSession();

      const before = session.getActivityState();
      expect(before.subscriberCount).toBe(0);
      expect(before.hasAuthority).toBe(false);

      session.subscribe('c1');
      session.subscribe('c2');

      const after = session.getActivityState();
      expect(after.subscriberCount).toBe(2);
      expect(after.hasAuthority).toBe(true);
    });
  });

  describe('dispose', () => {
    it('clears all state', () => {
      const session = createSession();
      session.subscribe('c1');
      session.subscribe('c2');

      session.dispose();

      expect(session.hasSubscriber('c1')).toBe(false);
      expect(session.getAuthority()).toBeNull();
      expect(session.getActivityState().subscriberCount).toBe(0);
    });
  });
});

describe('TerminalFrameStream', () => {
  it('emits frame events to listeners', () => {
    const session = createSession();
    const received: FrameEvent[] = [];
    session.stream.on('frame', (f) => received.push(f));

    session.pushFrame('test-data');

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('data');
    expect(received[0].sessionId).toBe('session-1');
  });

  it('stops emitting after removeAllListeners', () => {
    const session = createSession();
    const received: FrameEvent[] = [];
    session.stream.on('frame', (f) => received.push(f));

    session.stream.removeAllListeners();
    session.pushFrame('should-not-arrive');

    expect(received).toHaveLength(0);
  });
});
