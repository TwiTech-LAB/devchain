import { renderHook, act } from '@testing-library/react';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';

describe('useKeyboardShortcuts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each([
    { handler: 'onNextFile', event: { key: 'j' } },
    { handler: 'onPreviousFile', event: { key: 'k' } },
    { handler: 'onNextComment', event: { key: 'n' } },
    { handler: 'onPreviousComment', event: { key: 'p' } },
    { handler: 'onOpenComment', event: { key: 'c' } },
    { handler: 'onReply', event: { key: 'r' } },
    { handler: 'onEscape', event: { key: 'Escape' } },
    { handler: 'onSubmit', event: { key: 'Enter', metaKey: true } },
    { handler: 'onSubmit', event: { key: 'Enter', ctrlKey: true } },
  ] as const)('dispatches $event.key to $handler', ({ handler, event }) => {
    const callback = jest.fn();
    renderHook(() => useKeyboardShortcuts({ handlers: { [handler]: callback } }));
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', event));
    });
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('toggles help modal when ? is pressed', () => {
    const { result } = renderHook(() => useKeyboardShortcuts({ handlers: {} }));

    expect(result.current.isHelpOpen).toBe(false);

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '?' }));
    });

    expect(result.current.isHelpOpen).toBe(true);

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '?' }));
    });

    expect(result.current.isHelpOpen).toBe(false);
  });

  it('opens help and closes it with Escape or closeHelp', () => {
    const { result } = renderHook(() => useKeyboardShortcuts({ handlers: {} }));

    act(() => {
      result.current.openHelp();
    });

    expect(result.current.isHelpOpen).toBe(true);

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });

    expect(result.current.isHelpOpen).toBe(false);
    act(() => result.current.openHelp());
    expect(result.current.isHelpOpen).toBe(true);
    act(() => result.current.closeHelp());
    expect(result.current.isHelpOpen).toBe(false);
  });

  it('does not call handlers when disabled', () => {
    const onNextFile = jest.fn();
    renderHook(() => useKeyboardShortcuts({ enabled: false, handlers: { onNextFile } }));

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j' }));
    });

    expect(onNextFile).not.toHaveBeenCalled();
  });

  it.each(['input', 'textarea'] as const)('ignores navigation while %s is focused', (tag) => {
    const onNextFile = jest.fn();
    renderHook(() => useKeyboardShortcuts({ handlers: { onNextFile } }));
    const input = document.createElement(tag);
    document.body.appendChild(input);
    input.focus();
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j' }));
    });
    expect(onNextFile).not.toHaveBeenCalled();
    input.remove();
  });

  it('still calls onSubmit when input is focused (Cmd+Enter)', () => {
    const onSubmit = jest.fn();
    renderHook(() => useKeyboardShortcuts({ handlers: { onSubmit } }));

    // Create and focus an input element
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true }));
    });

    expect(onSubmit).toHaveBeenCalledTimes(1);

    // Cleanup
    document.body.removeChild(input);
  });
});
