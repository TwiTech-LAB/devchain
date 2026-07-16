import { TerminalKeyInputFacade } from './terminal-key-input.facade';
import { AppError } from '../../../../common/errors/error-types';

/**
 * TerminalKeyInputFacade — unit tests.
 *
 * Layer: module-unit. The facade is a thin orchestrator over three collaborators
 * (registry, terminalIO, and the session object), so mocking those three and asserting
 * the dispatch sequence + typed AppError codes is the cheapest layer that proves every
 * acceptance behavior (whitelist, liveness, ordering, per-session rate gap). No tmux, no
 * DB, no Nest DI graph needed.
 *
 * Note on the rate gap: it is held in a module-level map keyed by sessionId. Each test
 * that drives a SUCCESSFUL send uses its own unique sessionId so the accepted-key
 * timestamp from one test can never gate a different test (tests are independent).
 */
describe('TerminalKeyInputFacade', () => {
  const TMUX_NAME = 'tmux-key-input';

  function makeSession() {
    return { tmuxSessionName: TMUX_NAME, signalInput: jest.fn() };
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
    overrides: { session?: ReturnType<typeof makeSession>; io?: ReturnType<typeof makeIO> } = {},
  ) {
    const session = overrides.session ?? makeSession();
    const io = overrides.io ?? makeIO();
    const registry = makeRegistry(session);
    const facade = new TerminalKeyInputFacade(registry as never, io as never);
    return { facade, registry, io, session };
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

    it.each(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'] as const)(
      "digit '%s' dispatches sendControl literally as ['-l','--',digit]",
      async (key) => {
        const { facade, io } = makeFacade();
        await facade.sendKey(`digit-${key}`, key);
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
      const io = makeIO();
      const facade = new TerminalKeyInputFacade(
        { get: jest.fn(() => undefined) } as never,
        io as never,
      );
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

    it('pins to the EXACT requested sessionId (registry.get receives it verbatim)', async () => {
      const session = makeSession();
      const registry = { get: jest.fn(() => session) };
      const facade = new TerminalKeyInputFacade(registry as never, makeIO() as never);
      const exact = '00000000-0000-4000-8000-0000000000c3';
      await facade.sendKey(exact, 'Enter');
      expect(registry.get).toHaveBeenCalledWith(exact);
      expect(session.signalInput).toHaveBeenCalled();
    });

    it('checks liveness, signals input, THEN sends — in that order', async () => {
      const { facade, io, session } = makeFacade();
      await facade.sendKey('00000000-0000-4000-8000-0000000000d4', 'Up');

      expect(io.sessionExists).toHaveBeenCalledTimes(1);
      expect(session.signalInput).toHaveBeenCalledTimes(1);
      expect(io.sendControl).toHaveBeenCalledTimes(1);

      // invocationCallOrder is a single monotonic counter across the whole test — assert
      // the documented ordering: liveness < signalInput < sendControl.
      const livenessOrder = io.sessionExists.mock.invocationCallOrder[0];
      const signalOrder = session.signalInput.mock.invocationCallOrder[0];
      const sendOrder = io.sendControl.mock.invocationCallOrder[0];
      expect(livenessOrder).toBeLessThan(signalOrder);
      expect(signalOrder).toBeLessThan(sendOrder);
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
      const io = makeIO();
      const registry = {
        get: jest.fn((id: string) => (id.endsWith('aa') ? sessionA : sessionB)),
      };
      const facade = new TerminalKeyInputFacade(registry as never, io as never);

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
      const io = makeIO();
      const session = makeSession();
      const facade = new TerminalKeyInputFacade(
        { get: jest.fn(() => session) } as never,
        io as never,
      );
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

  it('resolves with { ok: true } on a successful named key', async () => {
    const { facade } = makeFacade();
    await expect(facade.sendKey('00000000-0000-4000-8000-000000000099', 'Enter')).resolves.toEqual({
      ok: true,
    });
  });

  it('thrown errors are AppError instances (so toJsonRpcError preserves data.code)', async () => {
    const { facade } = makeFacade();
    const err = await facade.sendKey('00000000-0000-4000-8000-000000000077', 'C-c').catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe('INVALID_KEY');
  });
});
