import { MetricsService } from '../../metrics/services/metrics.service';
import {
  MAX_REPLAY_BUFFER_BYTES,
  MAX_TERMINAL_FRAME_BYTES,
  TerminalStreamService,
} from './terminal-stream.service';

describe('TerminalStreamService replay coverage', () => {
  let service: TerminalStreamService;

  beforeEach(() => {
    const metricsService = {
      registerStatsProvider: jest.fn(),
    } as unknown as MetricsService;
    service = new TerminalStreamService(metricsService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns a covered delta while the requested boundary remains retained', () => {
    for (let sequence = 1; sequence <= 101; sequence += 1) {
      service.addFrame('covered', `frame-${sequence}`);
    }

    const result = service.getFramesSince('covered', 1);

    expect(result.status).toBe('covered');
    if (result.status !== 'covered') throw new Error('expected covered replay');
    expect(result.currentSequence).toBe(101);
    expect(result.frames).toHaveLength(100);
    expect(result.frames[0].payload).toMatchObject({ sequence: 2 });
  });

  it('returns a gap instead of a partial tail when the request predates the ring', () => {
    for (let sequence = 1; sequence <= 101; sequence += 1) {
      service.addFrame('gap', `frame-${sequence}`);
    }

    expect(service.getFramesSince('gap', 0)).toEqual({
      status: 'gap',
      currentSequence: 101,
      earliestAvailableSequence: 2,
    });
  });

  it('returns a gap when the client sequence is ahead of a reset stream', () => {
    service.initializeBuffer('reset');

    expect(service.getFramesSince('reset', 42)).toEqual({
      status: 'gap',
      currentSequence: 0,
    });
  });

  describe('sequence-domain (epoch) ownership', () => {
    it('mints a fresh, distinct epoch on every new domain and resets seq/recovery counter', () => {
      service.initializeBuffer('domain');
      const firstEpoch = service.getSequenceEpoch('domain');
      expect(firstEpoch).toEqual(expect.any(String));
      service.addFrame('domain', 'a');
      expect(service.nextRecoveryCounter('domain')).toBe(1);
      expect(service.getCurrentSequence('domain')).toBe(1);

      // Clearing retires the domain; the next domain gets a different epoch and reset counters.
      service.clearBuffer('domain');
      expect(service.getSequenceEpoch('domain')).toBeUndefined();
      expect(service.getCurrentSequence('domain')).toBe(0);

      service.initializeBuffer('domain');
      const secondEpoch = service.getSequenceEpoch('domain');
      expect(secondEpoch).toEqual(expect.any(String));
      expect(secondEpoch).not.toBe(firstEpoch);
      expect(service.nextRecoveryCounter('domain')).toBe(1);
    });

    it('samples the cursor (epoch + sequence) atomically', () => {
      service.addFrame('cursor', 'a');
      service.addFrame('cursor', 'b');
      const cursor = service.sampleCursor('cursor');
      expect(cursor).toEqual({
        sequenceEpoch: service.getSequenceEpoch('cursor'),
        currentSequence: 2,
      });
    });

    it('retains the recovery counter within a domain and restarts it in a new domain', () => {
      service.addFrame('rec', 'a');
      const epochA = service.getSequenceEpoch('rec');
      expect(service.nextRecoveryCounter('rec')).toBe(1);
      expect(service.nextRecoveryCounter('rec')).toBe(2);

      // A new domain (buffer cleared then re-minted) restarts the recovery counter at 1.
      service.clearBuffer('rec');
      service.addFrame('rec', 'b');
      expect(service.getSequenceEpoch('rec')).not.toBe(epochA);
      expect(service.nextRecoveryCounter('rec')).toBe(1);
    });

    it('replays by number when the reconnect cursor matches the live domain', () => {
      for (let sequence = 1; sequence <= 5; sequence += 1)
        service.addFrame('match', `f-${sequence}`);
      const epoch = service.getSequenceEpoch('match')!;

      const covered = service.getReconnectReplay('match', { sequenceEpoch: epoch, sequence: 3 });
      expect(covered.status).toBe('covered');
      expect(covered.sequenceEpoch).toBe(epoch);
      if (covered.status !== 'covered') throw new Error('expected covered');
      expect(covered.frames.map((f) => (f.payload as { sequence: number }).sequence)).toEqual([
        4, 5,
      ]);
    });

    it('returns a deterministic domain-mismatch gap for a cursor from a retired domain', () => {
      for (let sequence = 1; sequence <= 5; sequence += 1)
        service.addFrame('stale', `f-${sequence}`);
      const liveEpoch = service.getSequenceEpoch('stale')!;

      // A high sequence from a different (retired) epoch must NOT suppress fresh output — it is a gap.
      const mismatch = service.getReconnectReplay('stale', {
        sequenceEpoch: 'some-old-epoch',
        sequence: 999,
      });
      expect(mismatch).toEqual({
        status: 'gap',
        currentSequence: 5,
        sequenceEpoch: liveEpoch,
        domainMismatch: true,
      });
    });

    it('classifies a same-domain cursor that predates the ring as a numeric gap', () => {
      for (let sequence = 1; sequence <= 101; sequence += 1)
        service.addFrame('ring', `f-${sequence}`);
      const epoch = service.getSequenceEpoch('ring')!;

      const gap = service.getReconnectReplay('ring', { sequenceEpoch: epoch, sequence: 0 });
      expect(gap.status).toBe('gap');
      expect(gap.sequenceEpoch).toBe(epoch);
      expect(gap.domainMismatch).toBeUndefined();
      if (gap.status !== 'gap') throw new Error('expected gap');
      expect(gap.earliestAvailableSequence).toBe(2);
    });
  });

  it('coalesces a gated period into one discontinuity sequence without retaining bytes', () => {
    service.addFrame('paused', 'retained');
    const before = service.getBufferStats('paused');
    const metricsBefore = service.getFrameBufferStats();

    const firstEpoch = service.markDiscontinuous('paused');
    const sameEpoch = service.markDiscontinuous('paused');

    expect(firstEpoch).toBe(2);
    expect(sameEpoch).toBe(firstEpoch);
    expect(service.getBufferStats('paused')).toEqual({
      ...before,
      sequence: firstEpoch,
    });
    expect(service.getFrameBufferStats()).toMatchObject({
      totalFrames: metricsBefore.totalFrames,
      bytesEstimated: metricsBefore.bytesEstimated,
    });
    expect(service.getFramesSince('paused', 1)).toEqual({
      status: 'gap',
      currentSequence: firstEpoch,
      earliestAvailableSequence: 1,
      discontinuitySequence: firstEpoch,
    });
    expect(service.getFramesSince('paused', firstEpoch)).toEqual({
      status: 'covered',
      currentSequence: firstEpoch,
      frames: [],
    });

    service.resumeRetention('paused');
    expect(service.markDiscontinuous('paused')).toBe(firstEpoch + 1);
  });

  it('evicts by UTF-8 bytes and reports a replay gap at the evicted boundary', () => {
    const frame = 'x'.repeat(60 * 1024);
    for (let sequence = 1; sequence <= 18; sequence += 1) {
      service.addFrame('byte-gap', frame);
    }

    const stats = service.getBufferStats('byte-gap');
    expect(stats?.bytes).toBeLessThanOrEqual(MAX_REPLAY_BUFFER_BYTES);
    expect(stats?.size).toBeLessThan(18);
    expect(service.getFramesSince('byte-gap', 0)).toEqual(
      expect.objectContaining({ status: 'gap', currentSequence: 18 }),
    );
  });

  it('returns an already-safe ASCII frame without scanning every code point', () => {
    const sessionId = 'safe-frame';
    const input = 'a'.repeat(MAX_TERMINAL_FRAME_BYTES);
    service.initializeBuffer(sessionId);
    const byteLength = jest.spyOn(Buffer, 'byteLength');

    const frames = service.addFrame(sessionId, input);

    expect(frames).toHaveLength(1);
    expect(frames[0].payload).toMatchObject({ data: input, sequence: 1 });
    expect(byteLength).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['two-byte', 'é'],
    ['three-byte', '漢'],
    ['four-byte', '🙂'],
  ])('preserves %s code points at every frame-boundary byte offset', (_label, codePoint) => {
    const codePointBytes = Buffer.byteLength(codePoint, 'utf8');

    for (let availableBytes = 0; availableBytes <= codePointBytes; availableBytes += 1) {
      const sessionId = `boundary-${codePointBytes}-${availableBytes}`;
      const input = `${'a'.repeat(
        MAX_TERMINAL_FRAME_BYTES - availableBytes,
      )}${codePoint}\u001b[31mtail\u001b[0m`;
      const frames = service.addFrame(sessionId, input);
      const payloads = frames.map((frame) => frame.payload as { data: string; sequence: number });

      expect(payloads.map(({ data }) => data).join('')).toBe(input);
      expect(payloads.map(({ sequence }) => sequence)).toEqual(
        payloads.map((_, index) => index + 1),
      );
      for (const { data } of payloads) {
        expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(MAX_TERMINAL_FRAME_BYTES);
        expect(data).not.toContain('\ufffd');
      }
    }
  });

  it('chunks oversized Unicode and ANSI output losslessly before assigning sequences', () => {
    const input = `\u001b[31m${'a'.repeat(MAX_TERMINAL_FRAME_BYTES - 8)}🙂漢\u001b[0m`;
    const frames = service.addFrame('chunked', input);
    const payloads = frames.map((frame) => frame.payload as { data: string; sequence: number });

    expect(frames.length).toBeGreaterThan(1);
    expect(payloads.map(({ data }) => data).join('')).toBe(input);
    expect(payloads.map(({ sequence }) => sequence)).toEqual(payloads.map((_, index) => index + 1));
    for (const { data } of payloads) {
      expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(MAX_TERMINAL_FRAME_BYTES);
      expect(data).not.toContain('\ufffd');
    }
  });

  it('never rejects or drops an empty or oversized frame', () => {
    expect(service.addFrame('never-drop', '')).toHaveLength(1);
    const oversized = '🙂'.repeat(MAX_TERMINAL_FRAME_BYTES);
    const frames = service.addFrame('never-drop', oversized);
    expect(frames.map((frame) => (frame.payload as { data: string }).data).join('')).toBe(
      oversized,
    );
  });

  it('bounds replay bytes under sustained oversized Unicode and ANSI frames', () => {
    const sessionId = 'bounded-oversized';
    const input = `\u001b[35m${'🙂'.repeat(MAX_TERMINAL_FRAME_BYTES / 4 + 1024)}漢\u001b[0m`;
    const sequences: number[] = [];

    for (let burst = 0; burst < 20; burst += 1) {
      const frames = service.addFrame(sessionId, input);
      expect(frames.map((frame) => (frame.payload as { data: string }).data).join('')).toBe(input);
      sequences.push(...frames.map((frame) => (frame.payload as { sequence: number }).sequence));
    }

    const stats = service.getBufferStats(sessionId);
    expect(sequences).toEqual(sequences.map((_, index) => index + 1));
    expect(stats?.bytes).toBeLessThanOrEqual(MAX_REPLAY_BUFFER_BYTES);
    expect(stats?.size).toBeLessThan(sequences.length);
    expect(stats?.size).toBeLessThanOrEqual(100);
    expect(service.getFramesSince(sessionId, 0)).toEqual(
      expect.objectContaining({ status: 'gap', currentSequence: sequences.length }),
    );
  });

  describe('scheduled buffer clear (stopped-session replay retention)', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('clears the buffer and runs the expiry handler when the delay elapses', () => {
      const onExpire = jest.fn();
      service.setClearExpiryHandler(onExpire);
      service.addFrame('sched', 'output');
      const epoch = service.getSequenceEpoch('sched');
      expect(epoch).toBeDefined();
      service.scheduleClear('sched', 60000);

      jest.advanceTimersByTime(59999);
      expect(service.getBufferStats('sched')).not.toBeNull();
      expect(onExpire).not.toHaveBeenCalled();

      jest.advanceTimersByTime(1);
      // Buffer cleared → the domain is retired; a fresh initializeBuffer would mint a new epoch.
      expect(service.getBufferStats('sched')).toBeNull();
      expect(service.getSequenceEpoch('sched')).toBeUndefined();
      expect(onExpire).toHaveBeenCalledWith('sched');
    });

    it('cancelScheduledClear returns the pending delay and prevents the clear', () => {
      const onExpire = jest.fn();
      service.setClearExpiryHandler(onExpire);
      service.addFrame('sched', 'output');
      const epoch = service.getSequenceEpoch('sched');
      service.scheduleClear('sched', 60000);
      expect(service.hasScheduledClear('sched')).toBe(true);

      const cancelledDelay = service.cancelScheduledClear('sched');
      expect(cancelledDelay).toBe(60000);
      expect(service.hasScheduledClear('sched')).toBe(false);

      // Advancing well past the original deadline must NOT clear the retained domain.
      jest.advanceTimersByTime(120000);
      expect(service.getSequenceEpoch('sched')).toBe(epoch);
      expect(onExpire).not.toHaveBeenCalled();

      // A second cancel is idempotent and reports nothing pending.
      expect(service.cancelScheduledClear('sched')).toBeNull();
    });

    it('re-arming replaces a pending clear rather than stacking timers', () => {
      service.addFrame('sched', 'output');
      service.scheduleClear('sched', 60000);
      // Re-arm with a shorter delay; the superseded 60s timer must be cancelled, not stacked.
      service.scheduleClear('sched', 1000);

      jest.advanceTimersByTime(1000);
      expect(service.getBufferStats('sched')).toBeNull();

      // Re-initialize the domain; if the old 60s timer had survived, it would clear this new domain.
      service.initializeBuffer('sched');
      const epoch = service.getSequenceEpoch('sched');
      jest.advanceTimersByTime(120000);
      expect(service.getSequenceEpoch('sched')).toBe(epoch);
    });
  });
});
