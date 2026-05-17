import { renderHook, act } from '@testing-library/react';
import { useActiveSessionConfirm } from './useActiveSessionConfirm';

describe('useActiveSessionConfirm', () => {
  it('calls onConfirm immediately when no active agents', () => {
    const { result } = renderHook(() => useActiveSessionConfirm());
    const onConfirm = jest.fn();

    act(() => {
      result.current.confirmIfActiveSessions([], onConfirm);
    });

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(result.current.dialogProps.open).toBe(false);
  });

  it('opens dialog when active agents are present', () => {
    const { result } = renderHook(() => useActiveSessionConfirm());
    const onConfirm = jest.fn();

    act(() => {
      result.current.confirmIfActiveSessions(['Agent A', 'Agent B'], onConfirm);
    });

    expect(onConfirm).not.toHaveBeenCalled();
    expect(result.current.dialogProps.open).toBe(true);
    expect(result.current.dialogProps.description).toContain('Agent A, Agent B');
  });

  it('calls stored onConfirm and closes dialog when confirmed', () => {
    const { result } = renderHook(() => useActiveSessionConfirm());
    const onConfirm = jest.fn();

    act(() => {
      result.current.confirmIfActiveSessions(['Agent A'], onConfirm);
    });

    expect(result.current.dialogProps.open).toBe(true);

    act(() => {
      result.current.dialogProps.onConfirm();
    });

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(result.current.dialogProps.open).toBe(false);
  });

  it('closes dialog without calling onConfirm when cancelled', () => {
    const { result } = renderHook(() => useActiveSessionConfirm());
    const onConfirm = jest.fn();

    act(() => {
      result.current.confirmIfActiveSessions(['Agent A'], onConfirm);
    });

    act(() => {
      result.current.dialogProps.onOpenChange(false);
    });

    expect(onConfirm).not.toHaveBeenCalled();
    expect(result.current.dialogProps.open).toBe(false);
  });

  it('returns default variant and confirmText', () => {
    const { result } = renderHook(() => useActiveSessionConfirm());

    expect(result.current.dialogProps.variant).toBe('default');
    expect(result.current.dialogProps.confirmText).toBe('Continue');
    expect(result.current.dialogProps.title).toBe('Active sessions detected');
  });
});
