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

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

// Horizontal movement, Home/End, Insert/Delete and readline word edits. Up/Down can recall history.
const EDITING_KEY = /^\x1b(?:O[CDFH]|\[(?:1;\d+)?[CDFH]|\[[123478](?:;\d+)?~|[bfd\x7f])/;
// xterm sends cursor, device, mode and window reports and focus events through the same onData hook.
const TERMINAL_REPORT =
  /^\x1b\[(?:\??\d+;\d+R|0n|[?>]\d+(?:;\d+)*c|\??\d+;\d+\$y|[468];\d+;\d+t|[IO])/;

function literalReplacesDraft(data: string): boolean {
  let remaining = data;
  while (remaining.length) {
    const control = remaining.search(/[\r\n\t\x03\x04\x0c\x0e\x10\x12\x15\x1a\x1b]/);
    if (control === -1) return false;
    remaining = remaining.slice(control);
    if (remaining.startsWith(PASTE_START)) {
      // A CR inside a complete bracketed paste is caption text. Check any keys after its first end.
      const end = remaining.indexOf(PASTE_END, PASTE_START.length);
      if (end === -1) return true;
      remaining = remaining.slice(end + PASTE_END.length);
    } else {
      const sequence = EDITING_KEY.exec(remaining) ?? TERMINAL_REPORT.exec(remaining);
      if (!sequence) return true;
      remaining = remaining.slice(sequence[0].length);
    }
  }
  return false;
}

/** Classifies incoming pane keys that can submit, clear or recall a different draft. */
export function replacesDraft(keys: readonly string[]): boolean {
  if (keys[0] === '-l') return literalReplacesDraft(keys.at(-1) ?? '');
  return keys.some((key) =>
    ['Enter', 'Escape', 'C-c', 'C-d', 'C-z', 'C-l', 'Tab', 'Up', 'Down'].includes(key),
  );
}
