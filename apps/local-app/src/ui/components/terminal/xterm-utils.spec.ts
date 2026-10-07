import {
  decodeOsc52ClipboardPayload,
  isTerminalInternalSequence,
  supportsWheelMouseTracking,
} from './xterm-utils';

describe('xterm-utils', () => {
  describe('isTerminalInternalSequence', () => {
    describe('OSC sequences (Operating System Command)', () => {
      it.each([
        ['\x1b]10;rgb:c9c9/d1d1/d9d9\x1b\\', true],
        ['\x1b]11;rgb:1a1a/1a1a/1a1a\x1b\\', true],
        ['\x1b]0;Terminal Title\x07', true],
        ['\x1b]52;c;aGVsbG8=\x07', true],
        ['\x1b]10;', true],
        ['\x1bP1$r1 q\x1b\\', true],
        ['\x1bPq#0;2;0;0;0#1;2;100;100;0#2;2;0;100;0\x1b\\', true],
        ['\x1b^some privacy message\x1b\\', true],
        ['\x1b_some application command\x1b\\', true],
      ])('filters internal sequence %p as %s', (input, expected) => {
        expect(isTerminalInternalSequence(input)).toBe(expected);
      });
    });

    describe('Regular user input', () => {
      it.each([
        ['text', ['ls -la', 'hello world', 'echo "test"']],
        ['Enter', ['\r', '\n']],
        ['Ctrl+C', ['\x03']],
        ['Ctrl+D', ['\x04']],
        ['Escape', ['\x1b']],
        ['arrows', ['\x1b[A', '\x1b[B', '\x1b[C', '\x1b[D']],
        ['Tab', ['\t']],
        ['Delete', ['\x7f']],
        ['CSI', ['\x1b[1;1H', '\x1b[2J']],
        ['empty', ['']],
      ])('passes %s input sequences', (_name, inputs) => {
        for (const input of inputs) expect(isTerminalInternalSequence(input)).toBe(false);
      });
    });
  });

  describe('supportsWheelMouseTracking', () => {
    it.each([
      ['any', true],
      ['drag', true],
      ['none', false],
      ['vt200', true],
      ['vt200Highlight', false],
      ['x10', false],
      ['', false],
    ])('supports wheel tracking %s as %s', (input, expected) => {
      expect(supportsWheelMouseTracking(input)).toBe(expected);
    });
  });

  describe('decodeOsc52ClipboardPayload', () => {
    function encode(text: string): string {
      return Buffer.from(text, 'utf-8').toString('base64');
    }

    it.each([
      [encode('—'), '—'],
      [encode('Привет'), 'Привет'],
    ])('decodes clipboard %s', (input, expected) => {
      expect(decodeOsc52ClipboardPayload(input)).toBe(expected);
    });
  });
});
