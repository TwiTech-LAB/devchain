import type { Terminal } from '@xterm/xterm';
import {
  DEFAULT_TERMINAL_WRITE_BATCH_BYTES,
  DEFAULT_TERMINAL_WRITE_QUEUE_BYTES,
  TerminalWritePump,
  utf8ByteLength,
} from './terminal-write-pump';

function terminalWithCallbacks(): {
  terminal: Terminal;
  write: jest.Mock;
  callbacks: Array<() => void>;
} {
  const callbacks: Array<() => void> = [];
  const write = jest.fn((_data: string, callback?: () => void) => {
    if (callback) callbacks.push(callback);
  });
  return { terminal: { write } as unknown as Terminal, write, callbacks };
}

describe('TerminalWritePump', () => {
  it('caps pending bytes when the xterm callback never resolves', () => {
    const overflow = jest.fn();
    const { terminal, write } = terminalWithCallbacks();
    const pump = new TerminalWritePump({ onOverflow: overflow });
    pump.setTerminal(terminal);

    for (let index = 0; index < 100; index += 1) {
      pump.write('x'.repeat(DEFAULT_TERMINAL_WRITE_BATCH_BYTES));
    }

    expect(write).toHaveBeenCalledTimes(1);
    expect(pump.getSnapshot()).toMatchObject({
      status: 'desynchronized',
      queuedBytes: 0,
      inFlightBytes: DEFAULT_TERMINAL_WRITE_BATCH_BYTES,
      overflowCount: 1,
    });
    expect(pump.getSnapshot().queuedBytes).toBeLessThanOrEqual(DEFAULT_TERMINAL_WRITE_QUEUE_BYTES);
    expect(overflow).toHaveBeenCalledTimes(1);
  });

  it('keeps exactly one write in flight and preserves operation order', () => {
    const { terminal, write, callbacks } = terminalWithCallbacks();
    const pump = new TerminalWritePump({ queueBytes: 1024, batchBytes: 8, onOverflow: jest.fn() });
    pump.setTerminal(terminal);
    const completed: string[] = [];

    pump.write('first', { onComplete: () => completed.push('first') });
    pump.write('second', { onComplete: () => completed.push('second') });

    expect(write.mock.calls.map(([data]) => data)).toEqual(['first']);
    callbacks.shift()?.();
    expect(write.mock.calls.map(([data]) => data)).toEqual(['first', 'second']);
    expect(completed).toEqual(['first']);
    callbacks.shift()?.();
    expect(completed).toEqual(['first', 'second']);
  });

  it('places an assembled seed ahead of live frames staged during seed arrival', () => {
    const { terminal, write, callbacks } = terminalWithCallbacks();
    const pump = new TerminalWritePump({ queueBytes: 1024, batchBytes: 64, onOverflow: jest.fn() });
    pump.setTerminal(terminal);
    pump.beginSeed();

    pump.write('live-after-capture');
    expect(write).not.toHaveBeenCalled();
    pump.write('seed-snapshot', {
      kind: 'seed',
      onComplete: () => pump.completeRecovery(),
    });
    expect(write.mock.calls.map(([data]) => data)).toEqual(['seed-snapshot']);

    callbacks.shift()?.();
    expect(write.mock.calls.map(([data]) => data)).toEqual(['seed-snapshot', 'live-after-capture']);
  });

  it('splits oversized Unicode writes without corrupting code points', () => {
    const { terminal, write, callbacks } = terminalWithCallbacks();
    const pump = new TerminalWritePump({ queueBytes: 1024, batchBytes: 5, onOverflow: jest.fn() });
    pump.setTerminal(terminal);

    pump.write('a🙂b🙂c');
    while (callbacks.length > 0) callbacks.shift()?.();

    const chunks = write.mock.calls.map(([data]) => data as string);
    expect(chunks.join('')).toBe('a🙂b🙂c');
    expect(chunks.every((chunk) => utf8ByteLength(chunk) <= 5)).toBe(true);
  });

  it('coalesces overflow to one notification until recovery completes', () => {
    const overflow = jest.fn();
    const { terminal, callbacks } = terminalWithCallbacks();
    const pump = new TerminalWritePump({ queueBytes: 10, batchBytes: 10, onOverflow: overflow });
    pump.setTerminal(terminal);

    pump.write('1234567890');
    pump.write('overflow');
    for (let index = 0; index < 20; index += 1) pump.write('continued');
    expect(overflow).toHaveBeenCalledTimes(1);

    pump.beginRecovery();
    expect(pump.write('seed', { kind: 'seed' })).toBe(true);
    callbacks.shift()?.();
    callbacks.shift()?.();
    pump.completeRecovery();
    expect(pump.getSnapshot().status).toBe('ready');

    pump.write('1234567890');
    pump.write('overflow-again');
    expect(overflow).toHaveBeenCalledTimes(2);
  });

  it('invalidates callbacks from a disposed terminal before attaching a replacement', () => {
    const first = terminalWithCallbacks();
    const second = terminalWithCallbacks();
    const completed = jest.fn();
    const pump = new TerminalWritePump({ queueBytes: 1024, batchBytes: 64, onOverflow: jest.fn() });
    pump.setTerminal(first.terminal);
    pump.write('old', { onComplete: completed });
    pump.write('must-not-reach-old-terminal');

    pump.setTerminal(null);
    first.callbacks.shift()?.();
    expect(completed).not.toHaveBeenCalled();
    expect(first.write).toHaveBeenCalledTimes(1);

    pump.setTerminal(second.terminal);
    pump.write('new');
    expect(second.write).toHaveBeenCalledWith('new', expect.any(Function));
  });
});
