import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { TerminalActivityService } from './terminal-activity.service';
import { DB_CONNECTION } from '../../storage/db/db.provider';
import { SettingsService } from '../../settings/services/settings.service';
import { TerminalSessionRegistry } from './terminal-session/terminal-session-registry';
import { TerminalFrameStream } from './terminal-session/terminal-frame-stream';

function makeStream(): TerminalFrameStream {
  return new TerminalFrameStream();
}

function makeSession(sessionId: string, stream: TerminalFrameStream) {
  return { sessionId, stream } as unknown as ReturnType<TerminalSessionRegistry['get']>;
}

describe('TerminalActivityService', () => {
  let service: TerminalActivityService;
  let mockDb: { prepare: jest.Mock };
  let mockEventEmitter: { emit: jest.Mock };
  let mockSettings: { getSetting: jest.Mock };
  let mockRegistry: { get: jest.Mock };
  let prepareStmt: { get: jest.Mock; run: jest.Mock };

  beforeEach(async () => {
    prepareStmt = { get: jest.fn(), run: jest.fn() };
    mockDb = {
      prepare: jest.fn().mockReturnValue(prepareStmt),
    };
    mockEventEmitter = { emit: jest.fn() };
    mockSettings = { getSetting: jest.fn().mockReturnValue(undefined) };
    mockRegistry = { get: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TerminalActivityService,
        { provide: DB_CONNECTION, useValue: mockDb },
        { provide: EventEmitter2, useValue: mockEventEmitter },
        { provide: SettingsService, useValue: mockSettings },
        { provide: TerminalSessionRegistry, useValue: mockRegistry },
      ],
    }).compile();

    service = module.get<TerminalActivityService>(TerminalActivityService);
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  describe('watchSession', () => {
    it('does nothing when session is not in registry', () => {
      mockRegistry.get.mockReturnValue(undefined);
      expect(() => service.watchSession('missing')).not.toThrow();
    });

    it('attaches a frame listener to the session stream', () => {
      const stream = makeStream();
      const onSpy = jest.spyOn(stream, 'on');
      mockRegistry.get.mockReturnValue(makeSession('s1', stream));

      service.watchSession('s1');

      expect(onSpy).toHaveBeenCalledWith('frame', expect.any(Function));
    });

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
      let stream: TerminalFrameStream;
      const sessionId = 'sess-42';

      beforeEach(() => {
        stream = makeStream();
        mockRegistry.get.mockReturnValue(makeSession(sessionId, stream));
        // Session is running
        prepareStmt.get.mockReturnValue({ status: 'running' });
        // Not already busy
        prepareStmt.get.mockReturnValueOnce({ status: 'running' }).mockReturnValueOnce({
          activity_state: null,
        });
        service.watchSession(sessionId);
      });

      it('signals activity for real text in a data frame', () => {
        prepareStmt.get
          .mockReturnValueOnce({ status: 'running' })
          .mockReturnValueOnce({ activity_state: null });

        stream.emit('frame', { type: 'data', sessionId, payload: { data: 'hello world' } });

        expect(mockDb.prepare).toHaveBeenCalledWith(
          expect.stringContaining('UPDATE sessions SET last_activity_at'),
        );
      });

      it('does not signal for ANSI-only data frames', () => {
        stream.emit('frame', {
          type: 'data',
          sessionId,
          payload: { data: '\x1B[31m\x1B[0m' },
        });
        expect(mockDb.prepare).not.toHaveBeenCalledWith(
          expect.stringContaining('last_activity_at'),
        );
      });

      it('does not signal for whitespace-only data frames', () => {
        stream.emit('frame', { type: 'data', sessionId, payload: { data: '   \t\n  ' } });
        expect(mockDb.prepare).not.toHaveBeenCalledWith(
          expect.stringContaining('last_activity_at'),
        );
      });

      it('ignores non-data frame types', () => {
        stream.emit('frame', { type: 'seed_ansi', sessionId, payload: { data: 'hello' } });
        expect(mockDb.prepare).not.toHaveBeenCalledWith(
          expect.stringContaining('last_activity_at'),
        );
      });

      it('suppresses frames emitted before suppressUntil', () => {
        jest.useFakeTimers();
        const suppressUntil = Date.now() + 1000;
        service.updateSuppression(sessionId, suppressUntil);

        stream.emit('frame', { type: 'data', sessionId, payload: { data: 'hello' } });

        expect(mockDb.prepare).not.toHaveBeenCalledWith(
          expect.stringContaining('last_activity_at'),
        );
      });

      it('allows frames emitted after suppressUntil has passed', () => {
        jest.useFakeTimers();
        const suppressUntil = Date.now() - 1; // already expired
        service.updateSuppression(sessionId, suppressUntil);

        prepareStmt.get
          .mockReturnValueOnce({ status: 'running' })
          .mockReturnValueOnce({ activity_state: null });

        stream.emit('frame', { type: 'data', sessionId, payload: { data: 'hello' } });

        expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining('last_activity_at'));
      });
    });
  });

  describe('clearSession', () => {
    it('removes the frame listener from the session stream', () => {
      const stream = makeStream();
      const offSpy = jest.spyOn(stream, 'off');
      mockRegistry.get.mockReturnValue(makeSession('s1', stream));

      service.watchSession('s1');
      service.clearSession('s1');

      expect(offSpy).toHaveBeenCalledWith('frame', expect.any(Function));
    });

    it('cancels a pending idle timer', () => {
      jest.useFakeTimers();
      const stream = makeStream();
      mockRegistry.get.mockReturnValue(makeSession('s1', stream));
      prepareStmt.get
        .mockReturnValueOnce({ status: 'running' })
        .mockReturnValueOnce({ activity_state: null });

      service.watchSession('s1');
      // trigger signal
      stream.emit('frame', { type: 'data', sessionId: 's1', payload: { data: 'hi' } });

      const clearSpy = jest.spyOn(global, 'clearTimeout');
      service.clearSession('s1');

      expect(clearSpy).toHaveBeenCalled();
    });

    it('is safe to call for a session that was never watched', () => {
      mockRegistry.get.mockReturnValue(undefined);
      expect(() => service.clearSession('unknown')).not.toThrow();
    });
  });

  describe('updateSuppression', () => {
    it('updates the suppression window for a session', () => {
      const stream = makeStream();
      mockRegistry.get.mockReturnValue(makeSession('s1', stream));
      service.watchSession('s1');

      jest.useFakeTimers();
      const future = Date.now() + 5000;
      service.updateSuppression('s1', future);

      // Frame emitted now should be suppressed
      stream.emit('frame', { type: 'data', sessionId: 's1', payload: { data: 'hi' } });
      expect(mockDb.prepare).not.toHaveBeenCalledWith(expect.stringContaining('last_activity_at'));
    });
  });

  describe('getBufferSize', () => {
    it('returns 0 (legacy no-op)', () => {
      expect(service.getBufferSize('any')).toBe(0);
    });
  });

  describe('signal logic', () => {
    it('emits session.activity.changed with busy when transitioning from non-busy', () => {
      const stream = makeStream();
      mockRegistry.get.mockReturnValue(makeSession('s1', stream));
      prepareStmt.get
        .mockReturnValueOnce({ status: 'running' })
        .mockReturnValueOnce({ activity_state: null });

      service.watchSession('s1');
      stream.emit('frame', { type: 'data', sessionId: 's1', payload: { data: 'hello' } });

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'session.activity.changed',
        expect.objectContaining({ sessionId: 's1', state: 'busy' }),
      );
    });

    it('does not emit event again if already busy', () => {
      const stream = makeStream();
      mockRegistry.get.mockReturnValue(makeSession('s1', stream));
      prepareStmt.get
        .mockReturnValueOnce({ status: 'running' })
        .mockReturnValueOnce({ activity_state: 'busy' });

      service.watchSession('s1');
      stream.emit('frame', { type: 'data', sessionId: 's1', payload: { data: 'hello' } });

      expect(mockEventEmitter.emit).not.toHaveBeenCalled();
    });

    it('does not signal when session is not running', () => {
      const stream = makeStream();
      mockRegistry.get.mockReturnValue(makeSession('s1', stream));
      prepareStmt.get.mockReturnValueOnce({ status: 'stopped' });

      service.watchSession('s1');
      stream.emit('frame', { type: 'data', sessionId: 's1', payload: { data: 'hello' } });

      expect(mockDb.prepare).not.toHaveBeenCalledWith(expect.stringContaining('last_activity_at'));
    });

    it('emits session.activity.changed with idle after IDLE_AFTER_MS', () => {
      jest.useFakeTimers();
      const stream = makeStream();
      mockRegistry.get.mockReturnValue(makeSession('s1', stream));
      prepareStmt.get
        .mockReturnValueOnce({ status: 'running' })
        .mockReturnValueOnce({ activity_state: null })
        // idle transition
        .mockReturnValueOnce({ status: 'running' });

      service.watchSession('s1');
      stream.emit('frame', { type: 'data', sessionId: 's1', payload: { data: 'hello' } });

      jest.runAllTimers();

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'session.activity.changed',
        expect.objectContaining({ sessionId: 's1', state: 'idle' }),
      );
    });
  });
});
