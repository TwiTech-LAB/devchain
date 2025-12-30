/**
 * Terminal control key mapping utilities
 * Maps raw input sequences to tmux key names for send-keys
 */

export const CONTROL_KEY_MAP: Readonly<Record<string, readonly string[]>> = Object.freeze({
  '\x1b': ['Escape'], // ESC
  '\r': ['Enter'],
  '\n': ['Enter'],
  '\x03': ['C-c'], // Ctrl+C
  '\x04': ['C-d'], // Ctrl+D
  '\x0c': ['C-l'], // Ctrl+L (form feed / clear)
  '\x1a': ['C-z'], // Ctrl+Z
  '\t': ['Tab'],
  '\x7f': ['BSpace'], // Backspace/DEL
  // ANSI arrows
  '\x1b[A': ['Up'],
  '\x1b[B': ['Down'],
  '\x1b[C': ['Right'],
  '\x1b[D': ['Left'],
});

export function isControlKey(data: string): boolean {
  return Object.prototype.hasOwnProperty.call(CONTROL_KEY_MAP, data);
}

export function toTmuxKeys(data: string): string[] {
  const mapped = CONTROL_KEY_MAP[data];
  if (mapped) return [...mapped];
  return [data];
}
