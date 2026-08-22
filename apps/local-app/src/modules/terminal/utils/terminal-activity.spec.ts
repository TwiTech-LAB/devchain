import {
  createMeaningfulOutputPredicate,
  countPlainTerminalInputCharacters,
  hasMeaningfulTerminalOutput,
  hasPrintableTerminalInput,
} from './terminal-activity';

describe('terminal activity predicate', () => {
  it('recognizes visible text and rejects whitespace and ANSI-only output', () => {
    expect(hasMeaningfulTerminalOutput('provider output')).toBe(true);
    expect(hasMeaningfulTerminalOutput(' \t\r\n')).toBe(false);
    expect(hasMeaningfulTerminalOutput('\x1b[31m\x1b[0m')).toBe(false);
    expect(hasMeaningfulTerminalOutput('\x1b]0;title\x07')).toBe(false);
  });

  it('retains parser state across split CSI sequences', () => {
    const predicate = createMeaningfulOutputPredicate();

    expect(predicate('\x1b[')).toBe(false);
    expect(predicate('31')).toBe(false);
    expect(predicate('m')).toBe(false);
    expect(predicate('ready')).toBe(true);
  });

  it('retains parser state across split OSC terminators', () => {
    const predicate = createMeaningfulOutputPredicate();

    expect(predicate('\x1b]0;provider title')).toBe(false);
    expect(predicate('\x1b')).toBe(false);
    expect(predicate('\\')).toBe(false);
    expect(predicate('done')).toBe(true);
  });

  it('keeps split ANSI parser state independent for separate panes', () => {
    const firstPane = createMeaningfulOutputPredicate();
    const secondPane = createMeaningfulOutputPredicate();

    expect(firstPane('\x1b[')).toBe(false);
    expect(secondPane('visible on pane two')).toBe(true);
    expect(firstPane('31m')).toBe(false);
    expect(firstPane('visible on pane one')).toBe(true);
  });

  it('recognizes printable prompt input without treating controls or ANSI keys as text', () => {
    expect(hasPrintableTerminalInput('a')).toBe(true);
    expect(hasPrintableTerminalInput(' ')).toBe(true);
    expect(hasPrintableTerminalInput('hello world')).toBe(true);
    expect(hasPrintableTerminalInput('\r')).toBe(false);
    expect(hasPrintableTerminalInput('\x03')).toBe(false);
    expect(hasPrintableTerminalInput('\x1b[I')).toBe(false);
  });

  it('counts only plain prompt text for exact Backspace tracking', () => {
    expect(countPlainTerminalInputCharacters('hello world')).toBe(11);
    expect(countPlainTerminalInputCharacters('🙂')).toBe(1);
    expect(countPlainTerminalInputCharacters('')).toBeNull();
    expect(countPlainTerminalInputCharacters('\r')).toBeNull();
    expect(countPlainTerminalInputCharacters('\x1b[A')).toBeNull();
  });
});
