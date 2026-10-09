import { TerminalKeyInputFacade } from './terminal-key-input.facade';
import { AppError } from '../../../../common/errors/error-types';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { HumanPromptStateService } from '../human-prompt-state.service';
import { HumanPromptInputService } from '../human-prompt-input.service';

/**
 * TerminalKeyInputFacade — unit tests.
 *
 * Layer: module-unit. The facade is a thin orchestrator over terminal registry/IO,
 * and the shared prompt-input module. This is the cheapest layer for whitelist dispatch,
 * liveness admission, pre-await observation, and the per-session rate gap. The prompt-input
 * module owns protocol-order and phase tests. No tmux or DB is needed.
 *
 * Note on the rate gap: it is held in a module-level map keyed by sessionId. Each test
 * that drives a SUCCESSFUL send uses its own unique sessionId so the accepted-key
 * timestamp from one test can never gate a different test (tests are independent).
 */
describe('TerminalKeyInputFacade', () => {
  const TMUX_NAME = 'tmux-key-input';

  function makeSession() {
    return { sessionId: 'key-input-session', tmuxSessionName: TMUX_NAME, signalInput: jest.fn() };
  }

  function makeRegistry(session: ReturnType<typeof makeSession>) {
    return { get: jest.fn(() => session) };
  }

  function makeIO() {
    return {
      sessionExists: jest.fn().mockResolvedValue(true),
      sendControl: jest.fn().mockResolvedValue(undefined),
    };
  }

  function makeFacade(
    overrides: {
      session?: ReturnType<typeof makeSession>;
      io?: ReturnType<typeof makeIO>;
      registry?: { get: jest.Mock };
    } = {},
  ) {
    const session = overrides.session ?? makeSession();
    const io = overrides.io ?? makeIO();
    const registry = overrides.registry ?? makeRegistry(session);
    const humanPromptState = new HumanPromptStateService();
    const eventEmitter = new EventEmitter2();
    const humanPromptInput = new HumanPromptInputService(humanPromptState, eventEmitter);
    const facade = new TerminalKeyInputFacade(registry as never, io as never, humanPromptInput);
    return { facade, registry, io, session, humanPromptState, humanPromptInput };
  }

  describe('whitelist → tmux argv', () => {
    it.each(['Up', 'Down', 'Left', 'Right', 'Enter', 'Escape', 'Tab'] as const)(
      "named key '%s' dispatches sendControl with [name]",
      async (key) => {
        const { facade, io } = makeFacade();
        await facade.sendKey(`named-${key}`, key);
        expect(io.sendControl).toHaveBeenCalledWith({ name: TMUX_NAME }, [key]);
      },
    );

    it.each(['0', '9'] as const)(
      "digit '%s' dispatches sendControl literally as ['-l','--',digit]",
      async (key) => {
        const { facade, io, session, humanPromptInput } = makeFacade();
        const run = jest.spyOn(humanPromptInput, 'run');
        await facade.sendKey(`digit-${key}`, key);
        expect(run).toHaveBeenCalledWith(
          session,
          { kind: 'text', characterCount: 1 },
          expect.any(Function),
        );
        expect(io.sendControl).toHaveBeenCalledWith({ name: TMUX_NAME }, ['-l', '--', key]);
      },
    );

    it.each([
      ['raw arrow escape', '\x1b[A'],
      ['Ctrl-C token', 'C-c'],
      ['Ctrl-D token', 'C-d'],
      ['multi-char string', 'Up Up'],
      ['unknown named key', 'Space'],
      ['letter (not a digit)', 'a'],
      ['empty string', ''],
    ])('rejects %s (%j) with INVALID_KEY before any tmux call', async (_label, key) => {
      const { facade, registry, io } = makeFacade();
      await expect(facade.sendKey('reject-' + key, key)).rejects.toMatchObject({
        code: 'INVALID_KEY',
        statusCode: 400,
      });
      expect(registry.get).not.toHaveBeenCalled();
      expect(io.sessionExists).not.toHaveBeenCalled();
      expect(io.sendControl).not.toHaveBeenCalled();
    });
  });

  describe('session resolution + liveness', () => {
    it('throws SESSION_NOT_RUNNING when the session is not in the registry', async () => {
      const { facade, io } = makeFacade({ registry: { get: jest.fn(() => undefined) } });
      await expect(
        facade.sendKey('00000000-0000-4000-8000-0000000000a1', 'Up'),
      ).rejects.toMatchObject({
        code: 'SESSION_NOT_RUNNING',
        statusCode: 409,
      });
      expect(io.sessionExists).not.toHaveBeenCalled();
      expect(io.sendControl).not.toHaveBeenCalled();
    });

    it('throws SESSION_NOT_RUNNING when tmux reports the pane dead (sessionExists false)', async () => {
      const io = makeIO();
      io.sessionExists.mockResolvedValue(false);
      const { facade } = makeFacade({ io });
      await expect(
        facade.sendKey('00000000-0000-4000-8000-0000000000b2', 'Up'),
      ).rejects.toMatchObject({
        code: 'SESSION_NOT_RUNNING',
        statusCode: 409,
      });
      // Liveness was checked; nothing was sent.
      expect(io.sendControl).not.toHaveBeenCalled();
    });

    it('checks liveness before admitting input', async () => {
      const { facade, io, session } = makeFacade();
      await facade.sendKey('00000000-0000-4000-8000-0000000000d4', 'Up');

      expect(io.sessionExists).toHaveBeenCalledTimes(1);
      expect(session.signalInput).toHaveBeenCalledTimes(1);
      expect(io.sendControl).toHaveBeenCalledTimes(1);

      const livenessOrder = io.sessionExists.mock.invocationCallOrder[0];
      const signalOrder = session.signalInput.mock.invocationCallOrder[0];
      expect(livenessOrder).toBeLessThan(signalOrder);
    });
  });

  describe('per-session rate gap', () => {
    it('rejects a second rapid key to the SAME session with RATE_LIMITED and sends nothing extra', async () => {
      const { facade, io } = makeFacade();
      const sessionId = '00000000-0000-4000-8000-0000000000e5';

      await expect(facade.sendKey(sessionId, 'Up')).resolves.toEqual({ ok: true });
      // First key was dispatched once.
      expect(io.sendControl).toHaveBeenCalledTimes(1);

      // Second rapid key to the same session: gated, no extra tmux work.
      await expect(facade.sendKey(sessionId, 'Down')).rejects.toMatchObject({
        code: 'RATE_LIMITED',
        statusCode: 429,
      });
      expect(io.sendControl).toHaveBeenCalledTimes(1);
    });

    it('accepts two rapid keys to DIFFERENT sessions (gap is per-session)', async () => {
      const sessionA = makeSession();
      const sessionB = makeSession();
      const { facade, io } = makeFacade({
        registry: { get: jest.fn((id: string) => (id.endsWith('aa') ? sessionA : sessionB)) },
      });

      await expect(facade.sendKey('00000000-0000-4000-8000-0000000000aa', 'Up')).resolves.toEqual({
        ok: true,
      });
      // Different session, same facade + module-level gap map: still accepted.
      await expect(facade.sendKey('00000000-0000-4000-8000-0000000000bb', 'Down')).resolves.toEqual(
        {
          ok: true,
        },
      );

      expect(io.sendControl).toHaveBeenCalledTimes(2);
    });

    it('does not consume the gap window on a rejected key (failed attempt does not extend it)', async () => {
      // An INVALID_KEY attempt must not stamp the session, so a following valid key is still
      // accepted immediately (the failed attempt is invisible to the gap).
      const { facade, io } = makeFacade();
      const sessionId = '00000000-0000-4000-8000-0000000000f6';

      await expect(facade.sendKey(sessionId, 'C-c')).rejects.toMatchObject({ code: 'INVALID_KEY' });
      await expect(facade.sendKey(sessionId, 'Up')).resolves.toEqual({ ok: true });
      expect(io.sendControl).toHaveBeenCalledTimes(1);
    });

    it.each(['stopped', 'crashed'] as const)(
      'prunes the rate entry on session.%s across reconnect churn',
      async (event) => {
        const { facade, io } = makeFacade();
        const sessionId = `lifecycle-${event}`;

        for (let cycle = 0; cycle < 20; cycle += 1) {
          await facade.sendKey(sessionId, 'Up');
          if (event === 'stopped') facade.handleSessionStopped({ sessionId });
          else facade.handleSessionCrashed({ sessionId });
        }

        expect(io.sendControl).toHaveBeenCalledTimes(20);
      },
    );
  });

  describe('human prompt tracking', () => {
    it('captures the Enter generation before delayed liveness so a newer digit keeps its draft', async () => {
      const { facade, io, humanPromptState } = makeFacade();
      const sessionId = 'prompt-enter-liveness-race';
      humanPromptState.recordPromptText(TMUX_NAME);

      // Delay only Enter's liveness check.
      let releaseLiveness!: (alive: boolean) => void;
      io.sessionExists.mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            releaseLiveness = resolve;
          }),
      );

      const enter = facade.sendKey(sessionId, 'Enter');
      await Promise.resolve();

      await facade.sendKey(sessionId, '8');
      const newer = humanPromptState.getState(TMUX_NAME);

      releaseLiveness(true);
      await enter;

      expect(humanPromptState.getState(TMUX_NAME)).toEqual(newer);
      expect(newer).toEqual(expect.objectContaining({ phase: 'draft_active', generation: 2 }));
      expect(io.sendControl).toHaveBeenCalledWith({ name: TMUX_NAME }, ['Enter']);
    });

    it('leaves the observed draft unchanged when Enter liveness fails', async () => {
      const { facade, io, humanPromptState } = makeFacade();
      const sessionId = 'prompt-enter-dead';
      const draft = humanPromptState.recordPromptText(TMUX_NAME);
      io.sessionExists.mockResolvedValueOnce(false);

      await expect(facade.sendKey(sessionId, 'Enter')).rejects.toMatchObject({
        code: 'SESSION_NOT_RUNNING',
      });

      expect(io.sendControl).not.toHaveBeenCalled();
      expect(humanPromptState.getState(TMUX_NAME)).toEqual(
        expect.objectContaining({ phase: 'draft_active', generation: draft.generation }),
      );
    });
  });

  it('thrown errors are AppError instances (so toJsonRpcError preserves data.code)', async () => {
    const { facade } = makeFacade();
    const err = await facade.sendKey('00000000-0000-4000-8000-000000000077', 'C-c').catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe('INVALID_KEY');
  });
});
