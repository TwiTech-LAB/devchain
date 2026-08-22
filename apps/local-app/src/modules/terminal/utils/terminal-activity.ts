type ParserState = 'text' | 'escape' | 'csi' | 'osc' | 'osc_escape';

/**
 * Builds a streaming predicate for terminal output. Parser state is retained across
 * chunks because PTY frames may split an ANSI sequence at any byte boundary.
 */
export function createMeaningfulOutputPredicate(): (data: string) => boolean {
  return createTerminalTextPredicate(false);
}

export function hasMeaningfulTerminalOutput(data: string): boolean {
  return createMeaningfulOutputPredicate()(data);
}

export function hasPrintableTerminalInput(data: string): boolean {
  return createTerminalTextPredicate(true)(data);
}

/**
 * Counts a plain text input chunk only when every code point is printable. A
 * control or escape byte makes the editor effect ambiguous, so callers must
 * discard exact draft-length tracking instead of guessing.
 */
export function countPlainTerminalInputCharacters(data: string): number | null {
  if (data.length === 0) return null;
  let count = 0;
  for (const char of data) {
    const code = char.codePointAt(0)!;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return null;
    count += 1;
  }
  return count;
}

function createTerminalTextPredicate(
  includePrintableWhitespace: boolean,
): (data: string) => boolean {
  let state: ParserState = 'text';

  return (data: string): boolean => {
    let meaningful = false;

    for (const char of data) {
      const code = char.charCodeAt(0);

      switch (state) {
        case 'text':
          if (char === '\x1b') {
            state = 'escape';
          } else if (!isIgnoredTextCharacter(char, code, includePrintableWhitespace)) {
            meaningful = true;
          }
          break;
        case 'escape':
          if (char === '[') {
            state = 'csi';
          } else if (char === ']') {
            state = 'osc';
          } else if (code >= 0x30 && code <= 0x7e) {
            state = 'text';
          }
          break;
        case 'csi':
          if (code >= 0x40 && code <= 0x7e) state = 'text';
          break;
        case 'osc':
          if (char === '\x07') {
            state = 'text';
          } else if (char === '\x1b') {
            state = 'osc_escape';
          }
          break;
        case 'osc_escape':
          if (char === '\\') {
            state = 'text';
          } else if (char !== '\x1b') {
            state = 'osc';
          }
          break;
        default: {
          const exhaustive: never = state;
          throw new Error(`Unhandled terminal parser state: ${String(exhaustive)}`);
        }
      }
    }

    return meaningful;
  };
}

function isIgnoredTextCharacter(
  char: string,
  code: number,
  includePrintableWhitespace: boolean,
): boolean {
  return code <= 0x1f || code === 0x7f || (!includePrintableWhitespace && /^\s$/u.test(char));
}
