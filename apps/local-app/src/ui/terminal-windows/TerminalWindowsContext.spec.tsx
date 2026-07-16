import React from 'react';
import { renderHook, act, waitFor } from '@testing-library/react';
import {
  MAX_MOUNTED_TERMINAL_WINDOWS,
  MAX_PERSISTED_TERMINAL_LAYOUTS,
  TerminalWindowsProvider,
  useTerminalWindows,
} from './TerminalWindowsContext';

const mockToast = jest.fn();

jest.mock('@/ui/lib/toast-helpers', () => ({
  useToastHelpers: () => ({ toast: mockToast }),
}));

function wrapper({ children }: { children: React.ReactNode }) {
  return <TerminalWindowsProvider>{children}</TerminalWindowsProvider>;
}

// Context unit tests are the cheapest layer that proves ordering and the mounted-count invariant.
describe('TerminalWindowsContext — mounted window LRU cap', () => {
  beforeEach(() => {
    mockToast.mockClear();
    window.localStorage.clear();
  });

  function openWindows(result: { current: ReturnType<typeof useTerminalWindows> }, count: number) {
    for (let index = 0; index < count; index += 1) {
      act(() => {
        result.current.openWindow({
          id: `window-${index}`,
          title: `Window ${index}`,
          content: <div>{index}</div>,
        });
      });
    }
  }

  it('auto-minimizes the least recently focused window when opening beyond the cap', () => {
    const { result } = renderHook(() => useTerminalWindows(), { wrapper });
    openWindows(result, MAX_MOUNTED_TERMINAL_WINDOWS);

    act(() => result.current.focusWindow('window-0'));
    act(() =>
      result.current.openWindow({
        id: 'worktree-window',
        title: 'Worktree Window',
        content: <div />,
      }),
    );

    expect(result.current.windows.filter((window) => !window.minimized)).toHaveLength(
      MAX_MOUNTED_TERMINAL_WINDOWS,
    );
    expect(result.current.windows.find((window) => window.id === 'window-0')?.minimized).toBe(
      false,
    );
    expect(result.current.windows.find((window) => window.id === 'window-1')?.minimized).toBe(true);
    expect(
      result.current.windows.find((window) => window.id === 'worktree-window')?.minimized,
    ).toBe(false);
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Terminal window minimized' }),
    );
  });

  it('restores over-cap windows by minimizing another LRU window', () => {
    const { result } = renderHook(() => useTerminalWindows(), { wrapper });
    openWindows(result, MAX_MOUNTED_TERMINAL_WINDOWS + 1);

    expect(result.current.windows.find((window) => window.id === 'window-0')?.minimized).toBe(true);
    act(() => result.current.restoreWindow('window-0'));

    expect(result.current.windows.filter((window) => !window.minimized)).toHaveLength(
      MAX_MOUNTED_TERMINAL_WINDOWS,
    );
    expect(result.current.windows.find((window) => window.id === 'window-0')?.minimized).toBe(
      false,
    );
    expect(result.current.windows.find((window) => window.id === 'window-1')?.minimized).toBe(true);
  });

  it('keeps mounted state bounded across a long sequence while manual minimize and close still work', () => {
    const { result } = renderHook(() => useTerminalWindows(), { wrapper });
    openWindows(result, MAX_MOUNTED_TERMINAL_WINDOWS * 4);

    expect(result.current.windows.filter((window) => !window.minimized)).toHaveLength(
      MAX_MOUNTED_TERMINAL_WINDOWS,
    );

    act(() => result.current.minimizeWindow('window-19'));
    expect(result.current.windows.find((window) => window.id === 'window-19')?.minimized).toBe(
      true,
    );
    expect(result.current.windows.filter((window) => !window.minimized)).toHaveLength(
      MAX_MOUNTED_TERMINAL_WINDOWS - 1,
    );

    act(() => result.current.closeWindow('window-18'));
    expect(result.current.windows.some((window) => window.id === 'window-18')).toBe(false);
  });
});

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
        details: details,
        menuItems: menuItems,
        sessionId: 'session-1',
      });
    });

    const windowsAfterFirst = result.current.windows;

    act(() => {
      result.current.updateWindowMeta('win-1', {
        title: 'Updated Title',
        subtitle: 'Sub',
        details: details,
        menuItems: menuItems,
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
        details: [],
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

describe('TerminalWindowsContext — bounded persisted layout cache', () => {
  beforeEach(() => window.localStorage.clear());

  it('caps both provider state persistence and localStorage to the newest layouts', async () => {
    const { result } = renderHook(() => useTerminalWindows(), { wrapper });

    for (let index = 0; index < MAX_PERSISTED_TERMINAL_LAYOUTS + 5; index += 1) {
      act(() => {
        result.current.openWindow({
          id: `layout-${index}`,
          title: `Layout ${index}`,
          content: null,
        });
        result.current.closeWindow(`layout-${index}`);
      });
    }

    await waitFor(() => {
      const persisted = JSON.parse(
        window.localStorage.getItem('devchain:terminalWindows') ?? '{}',
      ) as { layouts?: Record<string, unknown> };
      expect(Object.keys(persisted.layouts ?? {})).toHaveLength(MAX_PERSISTED_TERMINAL_LAYOUTS);
      expect(persisted.layouts).not.toHaveProperty('layout-0');
      expect(persisted.layouts).toHaveProperty(`layout-${MAX_PERSISTED_TERMINAL_LAYOUTS + 4}`);
    });
  });

  it('preserves cached geometry when a capped-in window is closed and reopened', () => {
    const { result } = renderHook(() => useTerminalWindows(), { wrapper });
    act(() => result.current.openWindow({ id: 'restore-me', title: 'Restore', content: null }));
    act(() =>
      result.current.updateWindowBounds('restore-me', { x: 33, y: 44, width: 777, height: 555 }),
    );
    act(() => result.current.closeWindow('restore-me'));
    act(() => result.current.openWindow({ id: 'restore-me', title: 'Restore', content: null }));

    expect(result.current.windows[0].bounds).toEqual({ x: 33, y: 44, width: 777, height: 555 });
  });

  it('drops layouts older than the persistence age limit during hydration', async () => {
    const now = Date.now();
    const layout = { x: 1, y: 2, width: 640, height: 480, maximized: false };
    window.localStorage.setItem(
      'devchain:terminalWindows',
      JSON.stringify({
        zCounter: 1000,
        layouts: {
          stale: { ...layout, lastUsedAt: now - 31 * 24 * 60 * 60 * 1000 },
          recent: { ...layout, lastUsedAt: now },
        },
      }),
    );

    renderHook(() => useTerminalWindows(), { wrapper });

    await waitFor(() => {
      const persisted = JSON.parse(
        window.localStorage.getItem('devchain:terminalWindows') ?? '{}',
      ) as { layouts?: Record<string, unknown> };
      expect(persisted.layouts).not.toHaveProperty('stale');
      expect(persisted.layouts).toHaveProperty('recent');
    });
  });
});
