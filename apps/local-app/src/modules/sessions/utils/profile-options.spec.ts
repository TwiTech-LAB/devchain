import { parseProfileOptions, ProfileOptionsError } from './profile-options';

describe('parseProfileOptions', () => {
  it('returns empty array for empty input', () => {
    expect(parseProfileOptions(undefined)).toEqual([]);
    expect(parseProfileOptions(null)).toEqual([]);
    expect(parseProfileOptions('')).toEqual([]);
  });

  it('splits on whitespace', () => {
    expect(parseProfileOptions('--model sonnet --max-tokens 4000')).toEqual([
      '--model',
      'sonnet',
      '--max-tokens',
      '4000',
    ]);
  });

  it('honors quoted arguments', () => {
    expect(parseProfileOptions('--prompt \'Hello World\' "quoted value"')).toEqual([
      '--prompt',
      'Hello World',
      'quoted value',
    ]);
  });

  it('allows escaped spaces and quotes', () => {
    expect(parseProfileOptions('--flag\\ value "double\\"quote"')).toEqual([
      '--flag value',
      'double"quote',
    ]);
  });

  it('rejects control characters', () => {
    expect(() => parseProfileOptions('bad\nvalue')).toThrow(ProfileOptionsError);
  });

  it('rejects unterminated quotes', () => {
    expect(() => parseProfileOptions("--model 'unfinished")).toThrow(ProfileOptionsError);
  });
});
