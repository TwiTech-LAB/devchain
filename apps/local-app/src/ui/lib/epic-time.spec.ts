import {
  epicTimeExportScopeLabel,
  epicTimeTotalLabel,
  formatEpicTimeMinutes,
  resolveEpicTimeZone,
} from '@/ui/lib/epic-time';

// Layer: pure unit. Formatting is deterministic over the native Intl
// formatter with the pinned 'en' locale this UI renders.
describe('formatEpicTimeMinutes', () => {
  it('labels whole minutes under an hour as minutes', () => {
    expect(formatEpicTimeMinutes(30)).toBe('30m');
    expect(formatEpicTimeMinutes(1)).toBe('1m');
    expect(formatEpicTimeMinutes(59)).toBe('59m');
  });

  it('labels compound durations as hours and minutes', () => {
    expect(formatEpicTimeMinutes(60)).toBe('1h');
    expect(formatEpicTimeMinutes(90)).toBe('1h 30m');
    expect(formatEpicTimeMinutes(125)).toBe('2h 5m');
  });

  it('keeps hour-minute form past a day instead of switching units', () => {
    expect(formatEpicTimeMinutes(24 * 60)).toBe('24h');
    expect(formatEpicTimeMinutes(24 * 60 + 30)).toBe('24h 30m');
  });

  it('labels zero as 0m and floors non-integer or invalid input', () => {
    expect(formatEpicTimeMinutes(0)).toBe('0m');
    expect(formatEpicTimeMinutes(30.9)).toBe('30m');
    expect(formatEpicTimeMinutes(-15)).toBe('0m');
    expect(formatEpicTimeMinutes(Number.NaN)).toBe('0m');
  });
});

describe('resolveEpicTimeZone', () => {
  it('returns a non-empty IANA zone string', () => {
    const timeZone = resolveEpicTimeZone();

    expect(typeof timeZone).toBe('string');
    expect(timeZone.trim().length).toBeGreaterThan(0);
    expect(timeZone).not.toMatch(/^[+-]\d{2}:?\d{2}$/);
  });
});

describe('epicTimeTotalLabel and epicTimeExportScopeLabel', () => {
  it('name the related scope only when the rollup admits routed roots', () => {
    expect(epicTimeTotalLabel(false, false)).toBe('Total');
    expect(epicTimeTotalLabel(false, true)).toBe('Total');
    expect(epicTimeTotalLabel(true, false)).toBe('Total (incl. sub-epics)');
    expect(epicTimeTotalLabel(true, true)).toBe('Total (incl. sub-epics and related Epics)');
    expect(epicTimeExportScopeLabel(false, false)).toBe('Task total');
    expect(epicTimeExportScopeLabel(false, true)).toBe('Task total');
    expect(epicTimeExportScopeLabel(true, false)).toBe('Total including sub-epics');
    expect(epicTimeExportScopeLabel(true, true)).toBe(
      'Total including sub-epics and related Epics',
    );
  });
});
