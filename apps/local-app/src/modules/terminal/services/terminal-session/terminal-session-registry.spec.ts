import { TerminalSessionRegistry } from './terminal-session-registry';
import type { TerminalIORef } from './terminal-session';
import type { FrameEvent } from './terminal-frame-stream';
import { HumanPromptStateService } from '../human-prompt-state.service';

describe('TerminalSessionRegistry', () => {
  it('creates a session and retrieves it by id', () => {
    const registry = new TerminalSessionRegistry();

    const session = registry.create('s1', 'tmux-s1');

    expect(session.sessionId).toBe('s1');
    expect(session.tmuxSessionName).toBe('tmux-s1');
    expect(registry.get('s1')).toBe(session);
  });

  it('passes captured output normalization options into full-history capture', async () => {
    const registry = new TerminalSessionRegistry();
    const session = registry.create('s1', 'tmux-s1', {
      normalizeCapturedLineEndings: true,
    });
    const mockIO: TerminalIORef = {
      captureHistory: jest.fn().mockResolvedValue({ ok: true, output: 'one\ntwo' }),
    };
    registry.bind('s1', mockIO);

    const frames: FrameEvent[] = [];
    session.stream.on('frame', (f) => frames.push(f));

    await session.requestFullHistory();

    const historyFrame = frames.find((f) => f.type === 'full_history');
    expect(historyFrame).toBeDefined();
    expect((historyFrame!.payload as { ansi: string }).ansi).toBe('one\r\ntwo');
  });

  it('throws on double-create with same sessionId', () => {
    const registry = new TerminalSessionRegistry();
    registry.create('s1', 'tmux-s1');

    expect(() => registry.create('s1', 'tmux-s1')).toThrow(/already exists/);
  });

  it('returns undefined for unknown sessionId (no lazy creation)', () => {
    const registry = new TerminalSessionRegistry();

    expect(registry.get('unknown')).toBeUndefined();
  });

  it('dispose cleans up session and removes from registry', () => {
    const registry = new TerminalSessionRegistry();
    const session = registry.create('s1', 'tmux-s1');
    session.subscribe('client-1');

    registry.dispose('s1');

    expect(registry.get('s1')).toBeUndefined();
    expect(session.hasSubscriber('client-1')).toBe(false);
  });

  it('wires prompt clocks into sessions and clears state on dispose', () => {
    const promptState = new HumanPromptStateService();
    const registry = new TerminalSessionRegistry(undefined, promptState);
    const session = registry.create('s1', 'tmux-s1');

    session.signalInput();
    expect(promptState.getState('tmux-s1').executedInputEpoch).toBe(1);

    registry.dispose('s1');
    expect(promptState.getState('tmux-s1').executedInputEpoch).toBe(0);
  });

  it('list excludes disposed sessions', () => {
    const registry = new TerminalSessionRegistry();
    registry.create('s1', 'tmux-s1');
    registry.create('s2', 'tmux-s2');

    registry.dispose('s1');

    expect(registry.list()).toEqual(['s2']);
  });

  it('create + dispose roundtrip allows re-create', () => {
    const registry = new TerminalSessionRegistry();
    registry.create('s1', 'tmux-s1');
    registry.dispose('s1');

    const session = registry.create('s1', 'tmux-s1-v2');

    expect(session.tmuxSessionName).toBe('tmux-s1-v2');
    expect(registry.get('s1')).toBe(session);
  });

  describe('bind', () => {
    it('throws when binding to nonexistent session', () => {
      const registry = new TerminalSessionRegistry();
      const mockIO: TerminalIORef = {
        captureHistory: jest.fn(),
      };

      expect(() => registry.bind('nonexistent', mockIO)).toThrow(/not found/);
    });

    it('wires terminalIO so requestFullHistory captures and delivers', async () => {
      const registry = new TerminalSessionRegistry();
      const session = registry.create('s1', 'tmux-s1');
      session.subscribe('client-1');

      const mockIO: TerminalIORef = {
        captureHistory: jest.fn().mockResolvedValue({ ok: true, output: 'history-content' }),
      };

      registry.bind('s1', mockIO);

      const frames: FrameEvent[] = [];
      session.stream.on('frame', (f) => frames.push(f));

      await session.requestFullHistory();

      expect(mockIO.captureHistory).toHaveBeenCalledWith({ name: 'tmux-s1' });
      const historyFrame = frames.find((f) => f.type === 'full_history');
      expect(historyFrame).toBeDefined();
      expect((historyFrame!.payload as { ansi: string }).ansi).toBe('history-content');
    });
  });
});
