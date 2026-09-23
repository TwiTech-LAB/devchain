import {
  createMeaningfulOutputPredicate,
  countPlainTerminalInputCharacters,
  hasMeaningfulTerminalOutput,
  hasPrintableTerminalInput,
} from './terminal-activity';
import attachFixture from './__fixtures__/idle-animation-attach-stream.json';

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

  describe('idle particle filtering', () => {
    const PARTICLES = ['⠁', '⠂', '⠄', '⠈', '⠐', '⠠', '⡀', '⢀'];

    it('ignores each single-dot Braille particle in output', () => {
      for (const p of PARTICLES) {
        expect(hasMeaningfulTerminalOutput(p)).toBe(false);
      }
    });

    it('ignores particles mixed with ANSI and whitespace in output', () => {
      expect(hasMeaningfulTerminalOutput('\x1b[38;5;245m⠁\x1b[0m')).toBe(false);
      expect(hasMeaningfulTerminalOutput('⠁ ⠂ ⠄')).toBe(false);
    });

    it('counts particles as printable in input mode', () => {
      for (const p of PARTICLES) {
        expect(hasPrintableTerminalInput(p)).toBe(true);
      }
    });

    it('counts particles in exact input-length tracking', () => {
      expect(countPlainTerminalInputCharacters('⠁')).toBe(1);
      expect(countPlainTerminalInputCharacters('⠁⠂⠄')).toBe(3);
    });

    it('treats multi-dot Braille spinners as meaningful output', () => {
      expect(hasMeaningfulTerminalOutput('⠃')).toBe(true);
      expect(hasMeaningfulTerminalOutput('⠇')).toBe(true);
      expect(hasMeaningfulTerminalOutput('⣿')).toBe(true);
    });

    it('treats real text mixed with particles as meaningful output', () => {
      expect(hasMeaningfulTerminalOutput('⠁ ready')).toBe(true);
      expect(hasMeaningfulTerminalOutput('output⠂')).toBe(true);
    });

    it('replays the tmux attach-stream fixture chunk-by-chunk: no chunk is meaningful', () => {
      const predicate = createMeaningfulOutputPredicate();
      for (let i = 0; i < attachFixture.chunks.length; i++) {
        expect(predicate(attachFixture.chunks[i].data)).toBe(false);
      }
    });

    it('replays the fixture with arbitrary single-byte splits: still no meaningful output', () => {
      for (const splitWidth of [1, 2, 7, 31, 128]) {
        const predicate = createMeaningfulOutputPredicate();
        let meaningfulCount = 0;
        for (const chunk of attachFixture.chunks) {
          const chars = [...chunk.data];
          for (let i = 0; i < chars.length; i += splitWidth) {
            const slice = chars.slice(i, i + splitWidth).join('');
            if (predicate(slice)) meaningfulCount++;
          }
        }
        expect(meaningfulCount).toBe(0);
      }
    });

    it('replays the fixture with mid-CSI split: parser recovers and detects appended real text', () => {
      const predicate = createMeaningfulOutputPredicate();
      for (const chunk of attachFixture.chunks) {
        predicate(chunk.data);
      }
      expect(predicate('provider finished')).toBe(true);
    });
  });
});
