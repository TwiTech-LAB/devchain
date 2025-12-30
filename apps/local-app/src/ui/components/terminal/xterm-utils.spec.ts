import { isTerminalInternalSequence } from './xterm-utils';

describe('xterm-utils', () => {
  describe('isTerminalInternalSequence', () => {
    describe('OSC sequences (Operating System Command)', () => {
      it('should filter OSC 10 (foreground color query)', () => {
        const osc10 = '\x1b]10;rgb:c9c9/d1d1/d9d9\x1b\\';
        expect(isTerminalInternalSequence(osc10)).toBe(true);
      });

      it('should filter OSC 11 (background color query)', () => {
        const osc11 = '\x1b]11;rgb:1a1a/1a1a/1a1a\x1b\\';
        expect(isTerminalInternalSequence(osc11)).toBe(true);
      });

      it('should filter OSC 0 (window title)', () => {
        const osc0 = '\x1b]0;Terminal Title\x07';
        expect(isTerminalInternalSequence(osc0)).toBe(true);
      });

      it('should filter OSC 52 (clipboard operations)', () => {
        const osc52 = '\x1b]52;c;aGVsbG8=\x07';
        expect(isTerminalInternalSequence(osc52)).toBe(true);
      });

      it('should filter partial OSC sequence', () => {
        const partialOsc = '\x1b]10;';
        expect(isTerminalInternalSequence(partialOsc)).toBe(true);
      });
    });

    describe('DCS sequences (Device Control String)', () => {
      it('should filter DCS sequence', () => {
        const dcs = '\x1bP1$r1 q\x1b\\';
        expect(isTerminalInternalSequence(dcs)).toBe(true);
      });

      it('should filter sixel graphics DCS', () => {
        const sixel = '\x1bPq#0;2;0;0;0#1;2;100;100;0#2;2;0;100;0\x1b\\';
        expect(isTerminalInternalSequence(sixel)).toBe(true);
      });
    });

    describe('PM sequences (Privacy Message)', () => {
      it('should filter PM sequence', () => {
        const pm = '\x1b^some privacy message\x1b\\';
        expect(isTerminalInternalSequence(pm)).toBe(true);
      });
    });

    describe('APC sequences (Application Program Command)', () => {
      it('should filter APC sequence', () => {
        const apc = '\x1b_some application command\x1b\\';
        expect(isTerminalInternalSequence(apc)).toBe(true);
      });
    });

    describe('Regular user input', () => {
      it('should NOT filter regular text', () => {
        expect(isTerminalInternalSequence('ls -la')).toBe(false);
        expect(isTerminalInternalSequence('hello world')).toBe(false);
        expect(isTerminalInternalSequence('echo "test"')).toBe(false);
      });

      it('should NOT filter Enter key', () => {
        expect(isTerminalInternalSequence('\r')).toBe(false);
        expect(isTerminalInternalSequence('\n')).toBe(false);
      });

      it('should NOT filter Ctrl+C', () => {
        expect(isTerminalInternalSequence('\x03')).toBe(false);
      });

      it('should NOT filter Ctrl+D', () => {
        expect(isTerminalInternalSequence('\x04')).toBe(false);
      });

      it('should NOT filter ESC key alone', () => {
        expect(isTerminalInternalSequence('\x1b')).toBe(false);
      });

      it('should NOT filter arrow keys', () => {
        expect(isTerminalInternalSequence('\x1b[A')).toBe(false); // Up
        expect(isTerminalInternalSequence('\x1b[B')).toBe(false); // Down
        expect(isTerminalInternalSequence('\x1b[C')).toBe(false); // Right
        expect(isTerminalInternalSequence('\x1b[D')).toBe(false); // Left
      });

      it('should NOT filter Tab key', () => {
        expect(isTerminalInternalSequence('\t')).toBe(false);
      });

      it('should NOT filter Backspace/DEL', () => {
        expect(isTerminalInternalSequence('\x7f')).toBe(false);
      });

      it('should NOT filter CSI sequences (cursor movement, etc.)', () => {
        expect(isTerminalInternalSequence('\x1b[1;1H')).toBe(false); // Cursor home
        expect(isTerminalInternalSequence('\x1b[2J')).toBe(false); // Clear screen
      });

      it('should NOT filter empty string', () => {
        expect(isTerminalInternalSequence('')).toBe(false);
      });
    });
  });
});
