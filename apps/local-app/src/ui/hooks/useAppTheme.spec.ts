import { renderHook, act, waitFor } from '@testing-library/react';
import { useAppTheme } from './useAppTheme';

describe('useAppTheme', () => {
  const root = document.documentElement;

  afterEach(() => {
    root.classList.remove('dark', 'theme-ocean');
  });

  it('returns dark when the dark class is present', () => {
    root.classList.add('dark');
    const { result } = renderHook(() => useAppTheme());
    expect(result.current).toBe('dark');
  });

  it('returns ocean when the theme-ocean class is present', () => {
    root.classList.add('theme-ocean');
    const { result } = renderHook(() => useAppTheme());
    expect(result.current).toBe('ocean');
  });

  it('defaults to dark when no theme class is present', () => {
    const { result } = renderHook(() => useAppTheme());
    expect(result.current).toBe('dark');
  });

  it('updates reactively when the document class changes to ocean', async () => {
    root.classList.add('dark');
    const { result } = renderHook(() => useAppTheme());
    expect(result.current).toBe('dark');

    act(() => {
      root.className = 'theme-ocean';
    });

    await waitFor(() => {
      expect(result.current).toBe('ocean');
    });
  });

  it('updates reactively when the document class changes to dark', async () => {
    root.classList.add('theme-ocean');
    const { result } = renderHook(() => useAppTheme());
    expect(result.current).toBe('ocean');

    act(() => {
      root.className = 'dark';
    });

    await waitFor(() => {
      expect(result.current).toBe('dark');
    });
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
