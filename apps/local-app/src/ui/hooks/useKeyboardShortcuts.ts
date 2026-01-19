import { useEffect, useCallback, useState } from 'react';

export interface KeyboardShortcutHandlers {
  /** Navigate to next file (j) */
  onNextFile?: () => void;
  /** Navigate to previous file (k) */
  onPreviousFile?: () => void;
  /** Navigate to next comment (n) */
  onNextComment?: () => void;
  /** Navigate to previous comment (p) */
  onPreviousComment?: () => void;
  /** Open comment dialog (c) */
  onOpenComment?: () => void;
  /** Reply to focused comment (r) */
  onReply?: () => void;
  /** Close dialog/clear selection (Escape) */
  onEscape?: () => void;
  /** Submit comment (Cmd/Ctrl+Enter) */
  onSubmit?: () => void;
}

export interface UseKeyboardShortcutsOptions {
  /** Whether shortcuts are enabled */
  enabled?: boolean;
  /** Handlers for each shortcut */
  handlers: KeyboardShortcutHandlers;
}

export interface UseKeyboardShortcutsResult {
  /** Whether the help modal is open */
  isHelpOpen: boolean;
  /** Open the help modal */
  openHelp: () => void;
  /** Close the help modal */
  closeHelp: () => void;
  /** Toggle the help modal */
  toggleHelp: () => void;
}

/**
 * Check if the current focus is on an input element where we shouldn't
 * override default keyboard behavior.
 */
function isInputFocused(): boolean {
  const activeElement = document.activeElement;
  if (!activeElement) return false;

  const tagName = activeElement.tagName.toLowerCase();
  if (tagName === 'input' || tagName === 'textarea' || tagName === 'select') {
    return true;
  }

  // Also check for contenteditable
  if (activeElement.getAttribute('contenteditable') === 'true') {
    return true;
  }

  return false;
}

/**
 * Keyboard shortcuts configuration for display in help modal
 */
export const KEYBOARD_SHORTCUTS = [
  { key: 'j', description: 'Next file' },
  { key: 'k', description: 'Previous file' },
  { key: 'n', description: 'Next comment' },
  { key: 'p', description: 'Previous comment' },
  { key: 'c', description: 'Add comment on selected line' },
  { key: 'r', description: 'Reply to focused comment' },
  { key: 'Escape', description: 'Close dialog / Clear selection' },
  { key: '⌘/Ctrl + Enter', description: 'Submit comment' },
  { key: '?', description: 'Show keyboard shortcuts' },
] as const;

/**
 * Hook for handling keyboard shortcuts in the review detail page.
 * Automatically ignores shortcuts when an input/textarea is focused.
 */
export function useKeyboardShortcuts(
  options: UseKeyboardShortcutsOptions,
): UseKeyboardShortcutsResult {
  const { enabled = true, handlers } = options;
  const [isHelpOpen, setIsHelpOpen] = useState(false);

  const openHelp = useCallback(() => setIsHelpOpen(true), []);
  const closeHelp = useCallback(() => setIsHelpOpen(false), []);
  const toggleHelp = useCallback(() => setIsHelpOpen((prev) => !prev), []);

  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      // Always allow Escape to close help modal
      if (event.key === 'Escape' && isHelpOpen) {
        event.preventDefault();
        closeHelp();
        return;
      }

      // Check for Cmd/Ctrl+Enter (allow even in inputs for submitting)
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        if (handlers.onSubmit) {
          event.preventDefault();
          handlers.onSubmit();
        }
        return;
      }

      // Don't override when input is focused (except for Escape and Cmd+Enter)
      if (isInputFocused()) return;

      // Handle single-key shortcuts
      switch (event.key) {
        case 'j':
          if (handlers.onNextFile) {
            event.preventDefault();
            handlers.onNextFile();
          }
          break;

        case 'k':
          if (handlers.onPreviousFile) {
            event.preventDefault();
            handlers.onPreviousFile();
          }
          break;

        case 'n':
          if (handlers.onNextComment) {
            event.preventDefault();
            handlers.onNextComment();
          }
          break;

        case 'p':
          if (handlers.onPreviousComment) {
            event.preventDefault();
            handlers.onPreviousComment();
          }
          break;

        case 'c':
          if (handlers.onOpenComment) {
            event.preventDefault();
            handlers.onOpenComment();
          }
          break;

        case 'r':
          if (handlers.onReply) {
            event.preventDefault();
            handlers.onReply();
          }
          break;

        case 'Escape':
          if (handlers.onEscape) {
            event.preventDefault();
            handlers.onEscape();
          }
          break;

        case '?':
          event.preventDefault();
          toggleHelp();
          break;
      }
    };

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [enabled, handlers, isHelpOpen, closeHelp, toggleHelp]);

  return {
    isHelpOpen,
    openHelp,
    closeHelp,
    toggleHelp,
  };
}

export default useKeyboardShortcuts;
