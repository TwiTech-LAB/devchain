import {
  MAX_TRACKED_DURATION_MS,
  formatDurationMs,
  integrationConnectionGeneration,
  parseDurationInput,
  resolveStartedAtMs,
} from './external-time';

const MINUTE = 60_000;

describe('parseDurationInput', () => {
  it.each([
    ['15m', 15 * MINUTE],
    ['5h', 5 * 60 * MINUTE],
    ['1h 30m', 90 * MINUTE],
    ['90m', 90 * MINUTE],
    ['30', 30 * MINUTE],
    ['1h', 60 * MINUTE],
    ['  2h  45m  ', 165 * MINUTE],
    ['1H 30M', 90 * MINUTE],
    ['10080m', MAX_TRACKED_DURATION_MS],
  ])('accepts %s', (input, durationMs) => {
    expect(parseDurationInput(input)).toBe(durationMs);
  });

  it.each([
    ['wrong unit order', '30m 1h'],
    ['duplicate hours', '1h 1h'],
    ['duplicate minutes', '30m 15m'],
    ['decimal hours', '1.5h'],
    ['decimal minutes', '0.5m'],
    ['decimal bare', '1.5'],
    ['zero', '0'],
    ['zero with unit', '0m'],
    ['zero compound', '0h 0m'],
    ['above seven days by minutes', '10081m'],
    ['above seven days compound', '168h 1m'],
    ['unknown unit', '1d'],
    ['no space compound', '1h30m'],
    ['garbage', 'abc'],
    ['empty', ''],
    ['whitespace only', '   '],
    ['three tokens', '1h 2h 3m'],
    ['negative', '-15m'],
    ['huge bare number', '999999999999999999999999'],
  ])('rejects %s (%s)', (label, input) => {
    expect(parseDurationInput(input as string)).toBeNull();
  });
});

describe('formatDurationMs', () => {
  it.each([
    [15 * MINUTE, '15m'],
    [60 * MINUTE, '1h'],
    [90 * MINUTE, '1h 30m'],
    [5 * 60 * MINUTE, '5h'],
  ])('formats %i ms as %s', (durationMs, label) => {
    expect(formatDurationMs(durationMs)).toBe(label);
  });
});

describe('integrationConnectionGeneration', () => {
  it('extracts the generation segment', () => {
    expect(integrationConnectionGeneration('connection-jira-a:7')).toBe('7');
  });

  it('rejects malformed and absent epochs', () => {
    expect(integrationConnectionGeneration(null)).toBeNull();
    expect(integrationConnectionGeneration('no-separator')).toBeNull();
    expect(integrationConnectionGeneration('a:not-a-number')).toBeNull();
  });
});

describe('resolveStartedAtMs', () => {
  const submitTime = Date.parse('2026-08-22T12:00:00.000Z');

  it('derives an interval ending at the captured submit time', () => {
    expect(resolveStartedAtMs(30 * MINUTE, '', submitTime)).toBe(submitTime - 30 * MINUTE);
  });

  it('prefers the exact start when supplied', () => {
    // datetime-local values carry no zone; the browser resolves them as
    // local time, which is exactly what the submit path must preserve.
    expect(resolveStartedAtMs(30 * MINUTE, '2026-08-22T09:30', submitTime)).toBe(
      new Date('2026-08-22T09:30').getTime(),
    );
  });

  it('rejects an unparseable exact start', () => {
    expect(resolveStartedAtMs(30 * MINUTE, 'not-a-time', submitTime)).toBeNull();
  });
});
