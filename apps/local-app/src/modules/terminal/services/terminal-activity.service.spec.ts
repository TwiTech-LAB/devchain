import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import Database from 'better-sqlite3';
import {
  POST_STOP_OUTPUT_GRACE_MS,
  TerminalActivityService,
  TURN_FALLBACK_IDLE_MS,
} from './terminal-activity.service';
import { DB_CONNECTION } from '../../storage/db/db.provider';
import { SettingsService } from '../../settings/services/settings.service';
import { PendingAskUserQuestionService } from '../../hooks/services/pending-ask-user-question.service';
import { TerminalSessionRegistry } from './terminal-session/terminal-session-registry';
import { TerminalFrameStream } from './terminal-session/terminal-frame-stream';
import type { SessionTranscriptTurnSignal, SessionTurnHookSignal } from './session-turn-signals';

// Module-unit with a real in-memory `sessions` table: the state machine's contract is the rows it
// writes and the transitions it emits, which statement-level mocks would assume away.

function makeStream(): TerminalFrameStream {
  return new TerminalFrameStream();
}

function makeSession(sessionId: string, stream: TerminalFrameStream) {
  return { sessionId, stream } as unknown as ReturnType<TerminalSessionRegistry['get']>;
}

interface SessionRow {
  status: string;
  activity_state: string | null;
  busy_since: string | null;
  last_activity_at: string | null;
}

describe('TerminalActivityService', () => {
  let service: TerminalActivityService;
  let db: Database.Database;
  let mockEventEmitter: { emit: jest.Mock };
  let mockSettings: { getSetting: jest.Mock };
  let mockRegistry: { get: jest.Mock };
  let mockPending: { hasPendingQuestion: jest.Mock; clearBySession: jest.Mock };

  async function createService(): Promise<TerminalActivityService> {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TerminalActivityService,
        { provide: DB_CONNECTION, useValue: db },
        { provide: EventEmitter2, useValue: mockEventEmitter },
        { provide: SettingsService, useValue: mockSettings },
        { provide: TerminalSessionRegistry, useValue: mockRegistry },
        { provide: PendingAskUserQuestionService, useValue: mockPending },
      ],
    }).compile();
    return module.get<TerminalActivityService>(TerminalActivityService);
  }

  beforeEach(async () => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      activity_state TEXT,
      busy_since TEXT,
      last_activity_at TEXT,
      updated_at TEXT,
      provider_name_at_launch TEXT
    )`);
    mockEventEmitter = { emit: jest.fn() };
    mockSettings = { getSetting: jest.fn().mockReturnValue(undefined) };
    mockRegistry = { get: jest.fn() };
    mockPending = {
      hasPendingQuestion: jest.fn().mockReturnValue(false),
      clearBySession: jest.fn(),
    };
    service = await createService();
  });

  afterEach(() => {
    service.onModuleDestroy();
    db.close();
    jest.restoreAllMocks();
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  function addSession(
    id: string,
    provider: string | null = 'opencode',
    activityState: string | null = null,
    status = 'running',
  ): void {
    db.prepare(
      `INSERT INTO sessions (id, status, activity_state, provider_name_at_launch)
       VALUES (?, ?, ?, ?)`,
    ).run(id, status, activityState, provider);
  }

  function row(id: string): SessionRow {
    return db
      .prepare(
        `SELECT status, activity_state, busy_since, last_activity_at FROM sessions WHERE id = ?`,
      )
      .get(id) as SessionRow;
  }

  function transitions(id: string): string[] {
    return mockEventEmitter.emit.mock.calls
      .filter(
        ([name, payload]) =>
          name === 'session.activity.changed' &&
          (payload as { sessionId: string }).sessionId === id,
      )
      .map(([, payload]) => (payload as { state: string }).state);
  }

  /** Watch `id` and return a function that emits one meaningful output frame. */
  function watchOutput(id: string): (data?: string) => void {
    const stream = makeStream();
    mockRegistry.get.mockReturnValue(makeSession(id, stream));
    service.watchSession(id);
    return (data = 'hello') =>
      stream.emit('frame', { type: 'data', sessionId: id, payload: { data } });
  }

  function hook(id: string, kind: SessionTurnHookSignal['kind'], providerName = 'claude'): void {
    service.handleTurnHook({ sessionId: id, providerName, kind, firedAtMs: Date.now() });
  }

  function transcript(
    id: string,
    turn: SessionTranscriptTurnSignal['turn'],
    { grew = true, providerName = 'claude' }: { grew?: boolean; providerName?: string } = {},
  ): void {
    service.handleTranscriptTurn({ sessionId: id, providerName, turn, grew });
  }

  describe('watchSession', () => {
    it('replaces the listener when called twice for the same session', () => {
      const stream = makeStream();
      const offSpy = jest.spyOn(stream, 'off');
      const onSpy = jest.spyOn(stream, 'on');
      mockRegistry.get.mockReturnValue(makeSession('s1', stream));

      service.watchSession('s1');
      service.watchSession('s1');

      expect(offSpy).toHaveBeenCalledTimes(1);
      expect(onSpy).toHaveBeenCalledTimes(2);
    });

    describe('frame listener', () => {
      const sessionId = 'sess-42';
      let output: (data?: string) => void;

      beforeEach(() => {
        addSession(sessionId);
        output = watchOutput(sessionId);
      });

      it('signals activity for real text in a data frame', () => {
        output('hello world');
        expect(row(sessionId)).toMatchObject({ activity_state: 'busy' });
        expect(row(sessionId).last_activity_at).not.toBeNull();
      });

      it.each([['ANSI-only', '\x1B[31m\x1B[0m']])(
        'does not signal for %s data frames',
        (_label, data) => {
          output(data);
          expect(row(sessionId).last_activity_at).toBeNull();
        },
      );

      it('does not treat a split ANSI sequence as visible output', () => {
        output('\x1b[');
        output('31');
        output('m');
        expect(row(sessionId).last_activity_at).toBeNull();
      });

      it('ignores non-data frame types', () => {
        const stream = mockRegistry.get.mock.results[0].value.stream as TerminalFrameStream;
        stream.emit('frame', { type: 'seed_ansi', sessionId, payload: { data: 'hello' } });
        expect(row(sessionId).last_activity_at).toBeNull();
      });

      it('suppresses frames emitted before suppressUntil and allows them afterwards', () => {
        jest.useFakeTimers();
        service.updateSuppression(sessionId, Date.now() + 1000);
        output();
        expect(row(sessionId).last_activity_at).toBeNull();

        jest.advanceTimersByTime(1001);
        output();
        expect(row(sessionId).activity_state).toBe('busy');
      });
    });
  });

  describe('output-driven providers', () => {
    it('emits busy once, then idle after the idle timeout', () => {
      jest.useFakeTimers();
      addSession('s1');
      const output = watchOutput('s1');

      output();
      output();
      expect(transitions('s1')).toEqual(['busy']);
      expect(row('s1').busy_since).not.toBeNull();

      jest.advanceTimersByTime(29_999);
      expect(transitions('s1')).toEqual(['busy']);
      jest.advanceTimersByTime(1);
      expect(transitions('s1')).toEqual(['busy', 'idle']);
      expect(row('s1').activity_state).toBe('idle');
    });

    it('does not signal when the session is not running', () => {
      addSession('s1', 'opencode', null, 'stopped');
      watchOutput('s1')();
      expect(row('s1').last_activity_at).toBeNull();
      expect(transitions('s1')).toEqual([]);
    });

    it('treats a Claude session without any turn evidence like an output provider', () => {
      jest.useFakeTimers();
      addSession('s1', 'claude');
      watchOutput('s1')();
      jest.advanceTimersByTime(30_000);
      expect(transitions('s1')).toEqual(['busy', 'idle']);
    });

    it('clearSession cancels a pending idle transition', () => {
      jest.useFakeTimers();
      addSession('s1');
      watchOutput('s1')();
      service.clearSession('s1');
      jest.advanceTimersByTime(60_000);
      expect(transitions('s1')).toEqual(['busy']);
    });
  });

  describe('Claude turns', () => {
    beforeEach(() => {
      jest.useFakeTimers();
      addSession('c1', 'claude');
    });

    it('is busy from prompt submit to Stop and stamps the turn end', () => {
      hook('c1', 'prompt-submitted');
      expect(transitions('c1')).toEqual(['busy']);
      const busySince = row('c1').busy_since;

      jest.advanceTimersByTime(95_000);
      hook('c1', 'stopped');

      expect(transitions('c1')).toEqual(['busy', 'idle']);
      expect(row('c1').last_activity_at).toBe(
        new Date(Date.parse(busySince!) + 95_000).toISOString(),
      );
    });

    it('ends the turn on a transcript interrupt', () => {
      hook('c1', 'prompt-submitted');
      jest.advanceTimersByTime(5_000);
      transcript('c1', { open: false, atMs: Date.now() });
      expect(transitions('c1')).toEqual(['busy', 'idle']);
    });

    it('stays busy through a quiet tool run and keeps agent time continuous', () => {
      hook('c1', 'prompt-submitted');
      const stamps: string[] = [];
      for (let second = 0; second < 300; second += 5) {
        jest.advanceTimersByTime(5_000);
        stamps.push(row('c1').last_activity_at!);
      }

      expect(transitions('c1')).toEqual(['busy']);
      // No gap between activity stamps reaches the idle timeout.
      const times = [row('c1').busy_since!, ...stamps].map((stamp) => Date.parse(stamp));
      const gaps = times.slice(1).map((time, index) => time - times[index]);
      expect(Math.max(...gaps)).toBeLessThan(30_000);
    });

    it('ignores output after the turn and typing while idle', () => {
      const output = watchOutput('c1');
      hook('c1', 'prompt-submitted');
      hook('c1', 'stopped');

      output('repaint after the turn');
      output('typing in the input box');
      jest.advanceTimersByTime(60_000);

      expect(transitions('c1')).toEqual(['busy', 'idle']);
      expect(row('c1').activity_state).toBe('idle');
    });

    it('does not let the previous turn end cancel a new prompt', () => {
      hook('c1', 'prompt-submitted');
      jest.advanceTimersByTime(10_000);
      const previousEnd = Date.now();
      hook('c1', 'stopped');
      jest.advanceTimersByTime(1_000);
      hook('c1', 'prompt-submitted');

      // The watcher reports the previous turn's end_turn after the new prompt.
      transcript('c1', { open: false, atMs: previousEnd });

      expect(transitions('c1')).toEqual(['busy', 'idle', 'busy']);
      expect(row('c1').activity_state).toBe('busy');
    });

    it('ignores a Stop that fired before the latest prompt', () => {
      const staleStop = Date.now();
      jest.advanceTimersByTime(1_000);
      hook('c1', 'prompt-submitted');
      service.handleTurnHook({
        sessionId: 'c1',
        providerName: 'claude',
        kind: 'stopped',
        firedAtMs: staleStop,
      });
      expect(row('c1').activity_state).toBe('busy');
    });

    it('ignores a prompt hook that arrives after a later Stop', () => {
      const firedAtMs = Date.now();
      jest.advanceTimersByTime(1_000);
      hook('c1', 'stopped');
      service.handleTurnHook({
        sessionId: 'c1',
        providerName: 'claude',
        kind: 'prompt-submitted',
        firedAtMs,
      });
      expect(transitions('c1')).toEqual([]);
    });

    it('keeps idle when an append after end_turn carries no turn evidence', () => {
      hook('c1', 'prompt-submitted');
      transcript('c1', { open: false, atMs: Date.now() });
      // A tool_result-only or metadata-only append leaves the parsed turn ended.
      transcript('c1', { open: false, atMs: Date.now() - 1 });
      transcript('c1', null);
      expect(transitions('c1')).toEqual(['busy', 'idle']);
    });

    it('opens a turn from the transcript when no prompt hook arrived', () => {
      transcript('c1', { open: true, atMs: Date.now() });
      expect(transitions('c1')).toEqual(['busy']);
    });

    describe('when the Stop is lost', () => {
      it('goes idle after the turn fallback without output or transcript growth', () => {
        hook('c1', 'prompt-submitted');
        jest.advanceTimersByTime(TURN_FALLBACK_IDLE_MS - 1);
        expect(row('c1').activity_state).toBe('busy');
        jest.advanceTimersByTime(1);
        expect(transitions('c1')).toEqual(['busy', 'idle']);
      });

      it('restarts the fallback window on output and transcript growth', () => {
        const output = watchOutput('c1');
        hook('c1', 'prompt-submitted');
        jest.advanceTimersByTime(TURN_FALLBACK_IDLE_MS - 1_000);
        output();
        jest.advanceTimersByTime(TURN_FALLBACK_IDLE_MS - 1_000);
        transcript('c1', { open: true, atMs: Date.now() });
        jest.advanceTimersByTime(TURN_FALLBACK_IDLE_MS - 1_000);
        expect(transitions('c1')).toEqual(['busy']);

        jest.advanceTimersByTime(1_000);
        expect(transitions('c1')).toEqual(['busy', 'idle']);
      });

      it('never fires while an AskUserQuestion is pending', () => {
        hook('c1', 'prompt-submitted');
        mockPending.hasPendingQuestion.mockReturnValue(true);

        jest.advanceTimersByTime(TURN_FALLBACK_IDLE_MS * 3);
        expect(transitions('c1')).toEqual(['busy']);
        expect(mockPending.hasPendingQuestion).toHaveBeenCalledWith('c1');

        mockPending.hasPendingQuestion.mockReturnValue(false);
        jest.advanceTimersByTime(TURN_FALLBACK_IDLE_MS);
        expect(transitions('c1')).toEqual(['busy', 'idle']);
      });
    });

    it('holds a deferred-delivery window shut while a question is pending, then opens on Stop', () => {
      // Deferred `on_idle` delivery waits for an idle transition; none may happen mid-question.
      const output = watchOutput('c1');
      hook('c1', 'prompt-submitted');
      mockPending.hasPendingQuestion.mockReturnValue(true);
      output('Which option?');
      jest.advanceTimersByTime(TURN_FALLBACK_IDLE_MS * 2);
      expect(transitions('c1')).toEqual(['busy']);

      mockPending.hasPendingQuestion.mockReturnValue(false);
      hook('c1', 'stopped');
      expect(transitions('c1')).toEqual(['busy', 'idle']);
    });

    describe('with the real pending-question store', () => {
      const SESSION = 'c1';
      let store: PendingAskUserQuestionService;
      let clock: number;

      /** Records a question the way the AskUserQuestion PreToolUse hook does. */
      const ask = (toolUseId = 'tu-1') =>
        store.set({
          projectId: 'p1',
          agentId: 'a1',
          sessionId: SESSION,
          claudeSessionId: 'cs1',
          toolUseId,
          questions: [],
          now: clock,
        });

      beforeEach(async () => {
        store = new PendingAskUserQuestionService();
        service.onModuleDestroy();
        mockPending = store as unknown as typeof mockPending;
        service = await createService();
        clock = Date.now();
      });

      it('keeps the open turn busy through a 45-minute wait, past the fallback', () => {
        const output = watchOutput(SESSION);
        hook(SESSION, 'prompt-submitted');
        ask();
        output('Which option?');

        jest.advanceTimersByTime(45 * 60 * 1000);

        expect(transitions(SESSION)).toEqual(['busy']);
        expect(store.hasPendingQuestion(SESSION)).toBe(true);
        // The mobile poll hides the entry once it is older than its TTL.
        expect(store.getBySession(SESSION, clock + 45 * 60 * 1000)).toEqual([]);
      });

      it('ends the turn at the next fallback after the answer clears the entry', () => {
        hook(SESSION, 'prompt-submitted');
        ask();
        jest.advanceTimersByTime(45 * 60 * 1000);
        expect(transitions(SESSION)).toEqual(['busy']);

        store.clearByToolUseId(SESSION, 'tu-1');
        jest.advanceTimersByTime(TURN_FALLBACK_IDLE_MS);

        expect(transitions(SESSION)).toEqual(['busy', 'idle']);
      });

      it('clears an entry whose PostToolUse never arrived when the turn ends', () => {
        hook(SESSION, 'prompt-submitted');
        ask();
        jest.advanceTimersByTime(45 * 60 * 1000);

        hook(SESSION, 'stopped');

        expect(transitions(SESSION)).toEqual(['busy', 'idle']);
        expect(store.hasPendingQuestion(SESSION)).toBe(false);

        // The next turn (a prompt later than the Stop) gets the fallback again.
        jest.advanceTimersByTime(1_000);
        hook(SESSION, 'prompt-submitted');
        jest.advanceTimersByTime(TURN_FALLBACK_IDLE_MS);
        expect(transitions(SESSION)).toEqual(['busy', 'idle', 'busy', 'idle']);
      });

      it('clears the entry when the transcript shows the turn ended', () => {
        hook(SESSION, 'prompt-submitted');
        ask();
        transcript(SESSION, { open: false, atMs: Date.now() + 1_000 });

        expect(store.hasPendingQuestion(SESSION)).toBe(false);
        expect(transitions(SESSION)).toEqual(['busy', 'idle']);
      });

      it('keeps the question when an earlier turn end arrives late', () => {
        hook(SESSION, 'prompt-submitted');
        ask();
        transcript(SESSION, { open: false, atMs: Date.now() - 60_000 });

        expect(store.hasPendingQuestion(SESSION)).toBe(true);
        expect(transitions(SESSION)).toEqual(['busy']);
      });
    });
  });

  describe('Codex turns', () => {
    beforeEach(() => {
      jest.useFakeTimers();
      addSession('x1', 'codex');
    });

    const codex = (open: boolean, grew = true) =>
      transcript('x1', { open, atMs: null }, { grew, providerName: 'codex' });

    it('goes idle on a completion-only transcript event', () => {
      codex(true);
      codex(false);
      expect(transitions('x1')).toEqual(['busy', 'idle']);
    });

    it('keeps a quiet known-open turn busy past the output timeout', () => {
      const output = watchOutput('x1');
      output();
      codex(true);
      jest.advanceTimersByTime(5 * 60_000);
      expect(transitions('x1')).toEqual(['busy']);
    });

    it('uses the output timeout when no open turn is known', () => {
      const output = watchOutput('x1');
      codex(false, false);
      output();
      jest.advanceTimersByTime(30_000);
      expect(transitions('x1')).toEqual(['busy', 'idle']);
    });
  });

  describe('Copilot turns', () => {
    it('goes idle on Stop and busy again for the next turn', () => {
      jest.useFakeTimers();
      addSession('p1', 'copilot');
      const output = watchOutput('p1');

      output('working');
      hook('p1', 'stopped', 'copilot');
      output('final repaint');
      expect(transitions('p1')).toEqual(['busy', 'idle']);

      jest.advanceTimersByTime(POST_STOP_OUTPUT_GRACE_MS);
      output('second turn');
      expect(transitions('p1')).toEqual(['busy', 'idle', 'busy']);
    });
  });

  describe('restart', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    it('gives a stored busy of an output provider the idle timeout', () => {
      addSession('s1', 'opencode', 'busy');
      service.onApplicationBootstrap();
      jest.advanceTimersByTime(30_000);
      expect(transitions('s1')).toEqual(['idle']);
    });

    it.each([
      ['an ended transcript', { open: false, atMs: 1 }, 'idle'],
      ['an ongoing transcript', { open: true, atMs: 1 }, 'busy'],
    ])('reconciles a stored Claude busy with %s', (_label, turn, expected) => {
      addSession('c1', 'claude', 'busy');
      service.onApplicationBootstrap();
      transcript('c1', turn, { grew: false });

      jest.advanceTimersByTime(60_000);
      expect(row('c1').activity_state).toBe(expected);
    });

    it('turns a stored idle Claude session busy when its transcript shows a new prompt', () => {
      addSession('c1', 'claude', 'idle');
      service.onApplicationBootstrap();
      transcript('c1', { open: true, atMs: 1 }, { grew: false });
      expect(transitions('c1')).toEqual(['busy']);
    });

    it('goes idle within the fallback when the Stop was lost mid-turn', () => {
      addSession('c1', 'claude', 'busy');
      service.onApplicationBootstrap();
      transcript('c1', { open: true, atMs: 1 }, { grew: false });

      jest.advanceTimersByTime(TURN_FALLBACK_IDLE_MS);
      expect(transitions('c1')).toEqual(['idle']);
    });
  });

  describe('idle timeout refresh', () => {
    it('picks up a replica-written setting on the remote sync wake-up', () => {
      mockSettings.getSetting.mockReturnValue('45000');

      service.handleRemoteProjectSynced();

      expect(service.idleTimeoutMs).toBe(45000);
      expect(mockSettings.getSetting).toHaveBeenCalledWith('activity.idleTimeoutMs');
    });

    it('keeps the default when the stored value is not a positive number', () => {
      mockSettings.getSetting.mockReturnValue('not-a-number');

      service.handleRemoteProjectSynced();

      expect(service.idleTimeoutMs).toBe(30000);
    });

    it('applies a refreshed timeout to newly scheduled idle transitions', () => {
      jest.useFakeTimers();
      mockSettings.getSetting.mockReturnValue('45000');
      service.handleRemoteProjectSynced();
      addSession('s1');

      watchOutput('s1')();

      jest.advanceTimersByTime(44999);
      expect(transitions('s1')).toEqual(['busy']);
      jest.advanceTimersByTime(1);
      expect(transitions('s1')).toEqual(['busy', 'idle']);
    });

    it('re-arms each open turn heartbeat once at the new interval', () => {
      jest.useFakeTimers();
      addSession('c1', 'claude');
      addSession('c2', 'claude');
      hook('c1', 'prompt-submitted');
      hook('c2', 'prompt-submitted');
      const setIntervalBefore = global.setInterval;
      let armed = 0;
      jest.spyOn(global, 'setInterval').mockImplementation(((
        handler: () => void,
        intervalMs?: number,
      ) => {
        armed += 1;
        // A refresh that keeps re-arming never returns: fail instead of hanging the run.
        if (armed > 2) throw new Error('a heartbeat was re-armed more than once');
        return setIntervalBefore(handler, intervalMs);
      }) as unknown as typeof setInterval);

      mockSettings.getSetting.mockReturnValue('60000');
      service.handleRemoteProjectSynced();

      expect(armed).toBe(2);
      jest.advanceTimersByTime(20_000);
      const now = new Date().toISOString();
      expect(row('c1').last_activity_at).toBe(now);
      expect(row('c2').last_activity_at).toBe(now);
    });

    describe('with an idle transition already pending', () => {
      const idleCount = () => transitions('s1').filter((state) => state === 'idle').length;

      beforeEach(() => {
        jest.useFakeTimers();
        addSession('s1');
        watchOutput('s1')();
        jest.advanceTimersByTime(1000);
      });

      it.each([
        { timeout: '45000', before: 29000, remaining: 15000 },
        { timeout: '10000', before: 8999, remaining: 1 },
      ])('reschedules pending idle deadline to $timeout', ({ timeout, before, remaining }) => {
        mockSettings.getSetting.mockReturnValue(timeout);
        service.handleRemoteProjectSynced();
        jest.advanceTimersByTime(before);
        expect(idleCount()).toBe(0);
        jest.advanceTimersByTime(remaining);
        expect(idleCount()).toBe(1);
      });

      it('does not re-arm a transition that already fired', () => {
        jest.advanceTimersByTime(29000);
        expect(idleCount()).toBe(1);

        mockSettings.getSetting.mockReturnValue('45000');
        service.handleRemoteProjectSynced();
        jest.advanceTimersByTime(60000);
        expect(idleCount()).toBe(1);
      });
    });
  });
});
