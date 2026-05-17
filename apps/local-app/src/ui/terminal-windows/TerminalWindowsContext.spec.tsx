import React, { useRef } from 'react';
import { renderHook, act } from '@testing-library/react';
import { TerminalWindowsProvider, useTerminalWindows } from './TerminalWindowsContext';

function wrapper({ children }: { children: React.ReactNode }) {
  return <TerminalWindowsProvider>{children}</TerminalWindowsProvider>;
}

describe('TerminalWindowsContext — updateWindowMeta short-circuit', () => {
  it('same-refs second call does not trigger consumer re-render (no-op)', () => {
    const { result } = renderHook(() => useTerminalWindows(), { wrapper });

    const details = [{ label: 'Session', value: 'test', title: 'test-id' }];
    const menuItems = [{ id: 'item', label: 'Test', onSelect: jest.fn() }];

    act(() => {
      result.current.openWindow({
        id: 'win-1',
        title: 'Test Window',
        content: <div />,
      });
    });

    act(() => {
      result.current.updateWindowMeta('win-1', {
        title: 'Updated Title',
        subtitle: 'Sub',
        details: details as any,
        menuItems: menuItems as any,
        sessionId: 'session-1',
      });
    });

    const windowsAfterFirst = result.current.windows;

    act(() => {
      result.current.updateWindowMeta('win-1', {
        title: 'Updated Title',
        subtitle: 'Sub',
        details: details as any,
        menuItems: menuItems as any,
        sessionId: 'session-1',
      });
    });

    const windowsAfterSecond = result.current.windows;
    expect(windowsAfterSecond).toBe(windowsAfterFirst);
  });

  it('id-missing returns prev unchanged', () => {
    const { result } = renderHook(() => useTerminalWindows(), { wrapper });

    act(() => {
      result.current.openWindow({
        id: 'win-1',
        title: 'Test Window',
        content: <div />,
      });
    });

    const windowsBefore = result.current.windows;

    act(() => {
      result.current.updateWindowMeta('non-existent-id', {
        title: 'New Title',
        details: [] as any,
      });
    });

    expect(result.current.windows).toBe(windowsBefore);
  });

  it('genuinely different values DO trigger state update', () => {
    const { result } = renderHook(() => useTerminalWindows(), { wrapper });

    act(() => {
      result.current.openWindow({
        id: 'win-1',
        title: 'Original',
        content: <div />,
      });
    });

    const windowsBefore = result.current.windows;

    act(() => {
      result.current.updateWindowMeta('win-1', {
        title: 'Changed Title',
      });
    });

    expect(result.current.windows).not.toBe(windowsBefore);
    expect(result.current.windows[0].title).toBe('Changed Title');
  });
});
