import { TerminalSession } from './terminal-session';
import type { TerminalIORef } from './terminal-session';
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
    });

    it('debounces rapid resize calls', () => {
      jest.useFakeTimers();
      const session = createSession();
      session.subscribe('client-1');

      session.resize('client-1', { cols: 100, rows: 30 });
      const second = session.resize('client-1', { cols: 120, rows: 40 });

      expect(second.applied).toBe(false);
      expect(second.reason).toBe('debounced');

      jest.runAllTimers();
      expect(session.getDimensions()).toEqual({ cols: 120, rows: 40 });
      jest.useRealTimers();
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

describe('Unified seed_ansi protocol', () => {
  it('subscribe with io emits chunked seed_ansi in client wire format', async () => {
    const mockIO: TerminalIORef = {
      captureHistory: jest.fn().mockResolvedValue({ ok: true, output: 'ansi-content' }),
    };
    const session = new TerminalSession({
      sessionId: 'seed-test',
      tmuxSessionName: 'tmux-seed',
    });
    session.bindIO(mockIO);

    const frames: FrameEvent[] = [];
    session.stream.on('frame', (f) => frames.push(f));

    session.subscribe('client-1');

    await new Promise((r) => setTimeout(r, 50));

    const seedFrames = frames.filter((f) => f.type === 'seed_ansi');
    expect(seedFrames).toHaveLength(1);
    const payload = seedFrames[0].payload as {
      data: string;
      chunk: number;
      totalChunks: number;
      hasHistory?: boolean;
    };
    expect(payload.data).toBe('ansi-content');
    expect(payload.chunk).toBe(0);
    expect(payload.totalChunks).toBe(1);
    expect(payload.hasHistory).toBe(true);
  });

  it('emits same chunked seed_ansi for all providers (no strategy branching)', async () => {
    const mockIO: TerminalIORef = {
      captureHistory: jest.fn().mockResolvedValue({ ok: true, output: 'capture' }),
    };
    const session = new TerminalSession({
      sessionId: 'seed-test',
      tmuxSessionName: 'tmux-seed',
    });
    session.bindIO(mockIO);

    const frames: FrameEvent[] = [];
    session.stream.on('frame', (f) => frames.push(f));

    session.subscribe('client-1');

    await new Promise((r) => setTimeout(r, 50));

    const seedFrames = frames.filter((f) => f.type === 'seed_ansi');
    expect(seedFrames).toHaveLength(1);
    const payload = seedFrames[0].payload as { data: string; chunk: number; totalChunks: number };
    expect(payload.data).toBe('capture');
    expect(payload.totalChunks).toBe(1);
  });

  it('large content is chunked into multiple seed_ansi frames', async () => {
    const largeContent = 'x'.repeat(128 * 1024);
    const mockIO: TerminalIORef = {
      captureHistory: jest.fn().mockResolvedValue({ ok: true, output: largeContent }),
    };
    const session = new TerminalSession({
      sessionId: 'seed-large',
      tmuxSessionName: 'tmux-large',
    });
    session.bindIO(mockIO);

    const frames: FrameEvent[] = [];
    session.stream.on('frame', (f) => frames.push(f));

    session.subscribe('client-1');

    await new Promise((r) => setTimeout(r, 50));

    const seedFrames = frames.filter((f) => f.type === 'seed_ansi');
    expect(seedFrames).toHaveLength(2);
    const first = seedFrames[0].payload as {
      chunk: number;
      totalChunks: number;
      hasHistory?: boolean;
    };
    const last = seedFrames[1].payload as {
      chunk: number;
      totalChunks: number;
      hasHistory?: boolean;
    };
    expect(first.chunk).toBe(0);
    expect(first.totalChunks).toBe(2);
    expect(first.hasHistory).toBeUndefined();
    expect(last.chunk).toBe(1);
    expect(last.hasHistory).toBe(true);
  });

  it('normalizes bare LF in captured seed output when configured', async () => {
    const mockIO: TerminalIORef = {
      captureHistory: jest.fn().mockResolvedValue({
        ok: true,
        output: 'line 1\nline 2\r\nline 3',
      }),
    };
    const session = new TerminalSession({
      sessionId: 'seed-normalized',
      tmuxSessionName: 'tmux-normalized',
      normalizeCapturedLineEndings: true,
    });
    session.bindIO(mockIO);

    const frames: FrameEvent[] = [];
    session.stream.on('frame', (f) => frames.push(f));

    session.subscribe('client-1');

    await new Promise((r) => setTimeout(r, 50));

    const seedFrame = frames.find((f) => f.type === 'seed_ansi');
    expect(seedFrame).toBeDefined();
    expect((seedFrame!.payload as { data: string }).data).toBe('line 1\r\nline 2\r\nline 3');
  });

  it('subscribe without io does not initiate seeding', async () => {
    const session = new TerminalSession({
      sessionId: 'no-io',
      tmuxSessionName: 'tmux-no-io',
    });

    const frames: FrameEvent[] = [];
    session.stream.on('frame', (f) => frames.push(f));

    session.subscribe('client-1');

    await new Promise((r) => setTimeout(r, 50));

    expect(frames.filter((f) => f.type === 'seed_ansi')).toHaveLength(0);
  });
});
