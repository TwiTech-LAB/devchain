import { renderHook, act, waitFor } from '@testing-library/react';
import { useAppTheme } from './useAppTheme';

describe('useAppTheme', () => {
  const root = document.documentElement;

  afterEach(() => {
    root.classList.remove('dark', 'theme-ocean');
  });

  it.each([
    ['dark', 'dark'],
    ['theme-ocean', 'ocean'],
    ['', 'dark'],
  ] as const)('resolves class %s to %s', (className, theme) => {
    if (className) root.classList.add(className);
    const { result } = renderHook(() => useAppTheme());
    expect(result.current).toBe(theme);
  });

  it.each([
    ['dark', 'theme-ocean', 'dark', 'ocean'],
    ['theme-ocean', 'dark', 'ocean', 'dark'],
  ] as const)('reacts to %s becoming %s', async (fromClass, toClass, fromTheme, toTheme) => {
    root.classList.add(fromClass);
    const { result } = renderHook(() => useAppTheme());
    expect(result.current).toBe(fromTheme);
    act(() => {
      root.className = toClass;
    });
    await waitFor(() => expect(result.current).toBe(toTheme));
  });

  it('disconnects observer on unmount', () => {
    const disconnectSpy = jest.fn();
    const OriginalObserver = window.MutationObserver;
    window.MutationObserver = jest.fn().mockImplementation(() => ({
      observe: jest.fn(),
      disconnect: disconnectSpy,
    })) as unknown as typeof MutationObserver;

    const { unmount } = renderHook(() => useAppTheme());
    unmount();

    expect(disconnectSpy).toHaveBeenCalled();
    window.MutationObserver = OriginalObserver;
  });
});
