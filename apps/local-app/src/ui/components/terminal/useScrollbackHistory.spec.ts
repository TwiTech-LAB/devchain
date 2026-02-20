import { renderHook, fireEvent, act } from '@testing-library/react';
import { useScrollbackHistory } from './useScrollbackHistory';
import { getAppSocket } from '@/ui/lib/socket';

jest.mock('@/ui/lib/debug', () => ({
  termLog: jest.fn(),
}));

const fallbackSocket = {
  emit: jest.fn(),
  connected: true,
};

jest.mock('@/ui/lib/socket', () => ({
  getAppSocket: jest.fn(() => fallbackSocket),
}));

describe('useScrollbackHistory', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    Object.defineProperty(container, 'scrollHeight', {
      configurable: true,
      value: 1000,
    });
    Object.defineProperty(container, 'clientHeight', {
      configurable: true,
      value: 200,
    });
    Object.defineProperty(container, 'scrollTop', {
      configurable: true,
      writable: true,
      value: 750, // near bottom on mount
    });
    jest.clearAllMocks();
  });

  it('uses provided socket for history request when supplied', () => {
    const providedSocket = {
      emit: jest.fn(),
      connected: true,
    };
    const terminalRef = { current: container };
    const hasHistoryRef = { current: true };
    const isHistoryInFlightRef = { current: false };

    renderHook(() =>
      useScrollbackHistory(
        terminalRef,
        'session-1',
        hasHistoryRef,
        isHistoryInFlightRef,
        1000,
        providedSocket as never,
      ),
    );

    act(() => {
      container.scrollTop = 200; // far from bottom
      fireEvent.scroll(container);
    });

    expect(providedSocket.emit).toHaveBeenCalledWith('terminal:request_full_history', {
      sessionId: 'session-1',
      maxLines: 1000,
    });
    expect(fallbackSocket.emit).not.toHaveBeenCalled();
    expect(getAppSocket).not.toHaveBeenCalled();
  });

  it('falls back to singleton socket when no socket is provided', () => {
    const terminalRef = { current: container };
    const hasHistoryRef = { current: true };
    const isHistoryInFlightRef = { current: false };

    renderHook(() =>
      useScrollbackHistory(terminalRef, 'session-2', hasHistoryRef, isHistoryInFlightRef, 500),
    );

    act(() => {
      container.scrollTop = 200; // far from bottom
      fireEvent.scroll(container);
    });

    expect(getAppSocket).toHaveBeenCalled();
    expect(fallbackSocket.emit).toHaveBeenCalledWith('terminal:request_full_history', {
      sessionId: 'session-2',
      maxLines: 500,
    });
  });
});
