import { useEffect } from 'react';

export function isInlineTerminalPromptShortcut(event: KeyboardEvent): boolean {
  return (
    !event.defaultPrevented &&
    !event.repeat &&
    event.altKey &&
    event.shiftKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    event.code === 'KeyP'
  );
}

function isInlineTerminalInput(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[data-inline-terminal-input]') !== null;
}

export function useInlineTerminalPromptShortcut(enabled: boolean, onOpen: () => void): void {
  useEffect(() => {
    if (!enabled) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isInlineTerminalPromptShortcut(event) || !isInlineTerminalInput(event.target)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      onOpen();
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [enabled, onOpen]);
}
