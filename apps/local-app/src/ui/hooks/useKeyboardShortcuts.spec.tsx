import { renderHook, act } from '@testing-library/react';
import { useKeyboardShortcuts, KEYBOARD_SHORTCUTS } from './useKeyboardShortcuts';

describe('useKeyboardShortcuts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('calls onNextFile when j is pressed', () => {
    const onNextFile = jest.fn();
    renderHook(() => useKeyboardShortcuts({ handlers: { onNextFile } }));

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j' }));
    });

    expect(onNextFile).toHaveBeenCalledTimes(1);
  });

  it('calls onPreviousFile when k is pressed', () => {
    const onPreviousFile = jest.fn();
    renderHook(() => useKeyboardShortcuts({ handlers: { onPreviousFile } }));

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k' }));
    });

    expect(onPreviousFile).toHaveBeenCalledTimes(1);
  });

  it('calls onNextComment when n is pressed', () => {
    const onNextComment = jest.fn();
    renderHook(() => useKeyboardShortcuts({ handlers: { onNextComment } }));

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'n' }));
    });

    expect(onNextComment).toHaveBeenCalledTimes(1);
  });

  it('calls onPreviousComment when p is pressed', () => {
    const onPreviousComment = jest.fn();
    renderHook(() => useKeyboardShortcuts({ handlers: { onPreviousComment } }));

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p' }));
    });

    expect(onPreviousComment).toHaveBeenCalledTimes(1);
  });

  it('calls onOpenComment when c is pressed', () => {
    const onOpenComment = jest.fn();
    renderHook(() => useKeyboardShortcuts({ handlers: { onOpenComment } }));

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'c' }));
    });

    expect(onOpenComment).toHaveBeenCalledTimes(1);
  });

  it('calls onReply when r is pressed', () => {
    const onReply = jest.fn();
    renderHook(() => useKeyboardShortcuts({ handlers: { onReply } }));

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'r' }));
    });

    expect(onReply).toHaveBeenCalledTimes(1);
  });

  it('calls onEscape when Escape is pressed', () => {
    const onEscape = jest.fn();
    renderHook(() => useKeyboardShortcuts({ handlers: { onEscape } }));

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });

    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it('calls onSubmit when Cmd+Enter is pressed', () => {
    const onSubmit = jest.fn();
    renderHook(() => useKeyboardShortcuts({ handlers: { onSubmit } }));

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true }));
    });

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('calls onSubmit when Ctrl+Enter is pressed', () => {
    const onSubmit = jest.fn();
    renderHook(() => useKeyboardShortcuts({ handlers: { onSubmit } }));

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true }));
    });

    expect(onSubmit).toHaveBeenCalledTimes(1);
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

  it('closes help modal when Escape is pressed while open', () => {
    const { result } = renderHook(() => useKeyboardShortcuts({ handlers: {} }));

    act(() => {
      result.current.openHelp();
    });

    expect(result.current.isHelpOpen).toBe(true);

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });

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

  it('does not call handlers when input is focused', () => {
    const onNextFile = jest.fn();
    renderHook(() => useKeyboardShortcuts({ handlers: { onNextFile } }));

    // Create and focus an input element
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j' }));
    });

    expect(onNextFile).not.toHaveBeenCalled();

    // Cleanup
    document.body.removeChild(input);
  });

  it('does not call handlers when textarea is focused', () => {
    const onNextFile = jest.fn();
    renderHook(() => useKeyboardShortcuts({ handlers: { onNextFile } }));

    // Create and focus a textarea element
    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    textarea.focus();

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j' }));
    });

    expect(onNextFile).not.toHaveBeenCalled();

    // Cleanup
    document.body.removeChild(textarea);
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

  it('provides openHelp and closeHelp functions', () => {
    const { result } = renderHook(() => useKeyboardShortcuts({ handlers: {} }));

    expect(result.current.isHelpOpen).toBe(false);

    act(() => {
      result.current.openHelp();
    });
    expect(result.current.isHelpOpen).toBe(true);

    act(() => {
      result.current.closeHelp();
    });
    expect(result.current.isHelpOpen).toBe(false);
  });
});

describe('KEYBOARD_SHORTCUTS', () => {
  it('contains all expected shortcuts', () => {
    const keys = KEYBOARD_SHORTCUTS.map((s) => s.key);

    expect(keys).toContain('j');
    expect(keys).toContain('k');
    expect(keys).toContain('n');
    expect(keys).toContain('p');
    expect(keys).toContain('c');
    expect(keys).toContain('r');
    expect(keys).toContain('Escape');
    expect(keys).toContain('⌘/Ctrl + Enter');
    expect(keys).toContain('?');
  });

  it('each shortcut has a description', () => {
    KEYBOARD_SHORTCUTS.forEach((shortcut) => {
      expect(shortcut.description).toBeTruthy();
      expect(typeof shortcut.description).toBe('string');
    });
  });
});
