import { act, renderHook } from '@testing-library/react';
import type { Terminal } from '@xterm/xterm';
import { useTerminalWritePump } from './useTerminalWritePump';

describe('useTerminalWritePump', () => {
  it('disposes queued work on unmount and ignores a late xterm callback', () => {
    const callbacks: Array<() => void> = [];
    const terminal = {
      write: jest.fn((_data: string, callback?: () => void) => {
        if (callback) callbacks.push(callback);
      }),
    } as unknown as Terminal;
    const onComplete = jest.fn();
    const xtermRef = { current: terminal };
    const { result, unmount } = renderHook(() => useTerminalWritePump(xtermRef, jest.fn()));

    act(() => {
      result.current.setTerminal(terminal);
      result.current.write('first', { onComplete });
      result.current.write('queued');
    });
    unmount();
    act(() => callbacks.shift()?.());

    expect(onComplete).not.toHaveBeenCalled();
    expect(terminal.write).toHaveBeenCalledTimes(1);
  });
});
