import { wrapLongProseLines } from './wrap-long-prose-lines';

const bytes = (text: string) => Buffer.byteLength(text, 'utf8');
const maxLineBytes = (text: string) => Math.max(...text.split('\n').map(bytes));

/** Numbered sentences joined by single spaces, about `totalChars` characters long. */
function paragraph(
  totalChars: number,
  sentence = 'This sentence explains one part of the plan in plain words for the reader',
): string {
  const parts: string[] = [];
  let length = 0;
  for (let n = 0; length < totalChars; n += 1) {
    const part = `${sentence} ${n}.`;
    parts.push(part);
    length += part.length + 1;
  }
  return parts.join(' ');
}

function expectSameExceptBreaks(input: string, output: string) {
  expect(output.length).toBe(input.length);
  for (let i = 0; i < input.length; i += 1) {
    if (output[i] !== input[i]) {
      expect([input[i], output[i]]).toEqual([' ', '\n']);
    }
  }
}

describe('wrapLongProseLines', () => {
  it('breaks a 4,458-byte paragraph after sentence ends into pieces of at most 1,500 bytes', () => {
    const input = paragraph(4458).slice(0, 4458);
    expect(bytes(input)).toBe(4458);

    const output = wrapLongProseLines(input);

    expectSameExceptBreaks(input, output);
    const pieces = output.split('\n');
    expect(pieces.length).toBeGreaterThanOrEqual(3);
    expect(maxLineBytes(output)).toBeLessThanOrEqual(1500);
    for (const piece of pieces.slice(0, -1)) {
      expect(piece.endsWith('.')).toBe(true);
    }
  });

  it('breaks at the last space before the limit when no sentence ends', () => {
    const input = Array.from({ length: 600 }, (_, n) => `word${n}`).join(' ');
    const output = wrapLongProseLines(input);

    expectSameExceptBreaks(input, output);
    const [first, second] = output.split('\n');
    expect(bytes(first)).toBeLessThanOrEqual(1500);
    // The next word would not have fit in the first piece.
    expect(bytes(`${first} ${second.split(' ')[0]}`)).toBeGreaterThan(1500);
  });

  it('counts UTF-8 bytes, not characters', () => {
    const input = paragraph(1500, 'Пояснення одного кроку плану простими словами');
    expect(input.length).toBeLessThan(2000);
    expect(bytes(input)).toBeGreaterThan(2000);

    const output = wrapLongProseLines(input);

    expectSameExceptBreaks(input, output);
    expect(maxLineBytes(output)).toBeLessThanOrEqual(1500);
  });

  it('never breaks inside an inline code span', () => {
    const code = `\`${Array.from({ length: 200 }, (_, n) => `arg${n}`).join(' ')}\``;
    const input = `${'x'.repeat(1000)} ${code} tail words here. ${paragraph(800)}`;

    const output = wrapLongProseLines(input);

    expectSameExceptBreaks(input, output);
    expect(output).toContain(code);
    for (const piece of output.split('\n')) {
      expect((piece.match(/`/g) ?? []).length % 2).toBe(0);
    }
  });

  it.each([
    '- item',
    '* item',
    '+ item',
    '# head',
    '> quote',
    '| cell',
    '12. item',
    '```js',
    '~~~ x',
  ])('never starts a piece with a block marker (%s)', (marker) => {
    // Every sentence end is followed by the marker, so those spaces are not usable.
    const input = Array.from(
      { length: 60 },
      (_, n) => `Sentence number ${n} of the long text. ${marker}`,
    ).join(' ');
    expect(bytes(input)).toBeGreaterThan(2000);

    const output = wrapLongProseLines(input);

    expectSameExceptBreaks(input, output);
    expect(output).not.toBe(input);
    for (const piece of output.split('\n').slice(1)) {
      expect(piece.startsWith(marker.split(' ')[0])).toBe(false);
    }
  });

  it('leaves fenced code, table rows, headings and a too-long word unchanged', () => {
    const long = paragraph(2500);
    const input = [
      '```',
      long,
      '```',
      '~~~',
      long,
      '~~~',
      `| ${long} |`,
      `# ${long}`,
      'y'.repeat(5000),
    ].join('\n');

    expect(wrapLongProseLines(input)).toBe(input);
  });

  it.each([
    ['4 spaces', '    '],
    ['5 spaces', '     '],
    ['a tab', '\t'],
  ])('leaves a fenced block nested in a list item at %s unchanged', (_case, indent) => {
    const code = `${indent}curl -d '${paragraph(2500)}' http://127.0.0.1/api`;
    const input = ['1. Step', '', `${indent}\`\`\`sh`, code, `${indent}\`\`\``, ''].join('\n');

    expect(wrapLongProseLines(input)).toBe(input);
  });

  it('keeps a too-long word whole and breaks at the first space after it', () => {
    const word = 'z'.repeat(2500);
    const input = `${word} ${paragraph(1000)}`;

    const output = wrapLongProseLines(input);

    expect(output.split('\n')[0]).toBe(word);
    expectSameExceptBreaks(input, output);
  });

  it('leaves lines up to 2,000 bytes and keepLines byte-identical', () => {
    const short = paragraph(1990).slice(0, 2000);
    const kept = paragraph(3000);
    const fresh = paragraph(
      3000,
      'Another sentence that is new in this version of the text for the reader',
    );
    const input = [short, kept, fresh].join('\n');

    const output = wrapLongProseLines(input, new Set([kept]));

    const lines = output.split('\n');
    expect(lines[0]).toBe(short);
    expect(lines[1]).toBe(kept);
    expect(lines.length).toBeGreaterThan(3);
  });

  it('is idempotent and keeps the length', () => {
    const input = [
      paragraph(4458),
      `${'q'.repeat(2500)} ${paragraph(3000)}`,
      Array.from({ length: 80 }, (_, n) => `Item ${n} closes here. - next`).join(' '),
      'short line\r',
    ].join('\n');

    const once = wrapLongProseLines(input);
    expect(once).not.toBe(input);
    expect(once.length).toBe(input.length);
    expect(wrapLongProseLines(once)).toBe(once);
  });

  it('keeps a carriage return in place and never breaks right before it', () => {
    const input = `${paragraph(3000)} \r\nnext`;
    const output = wrapLongProseLines(input);

    expectSameExceptBreaks(input, output);
    expect(output.endsWith(' \r\nnext')).toBe(true);
  });
});
