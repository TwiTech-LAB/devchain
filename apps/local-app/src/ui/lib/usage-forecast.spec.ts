import {
  PROVIDER_USAGE_SETTINGS_DEFAULTS,
  type UsageSnapshot,
  type UsageWindow,
} from '@devchain/shared';
import { usageForecast } from './usage-forecast';

// Layer: pure function. The calendar is built from local dates because the forecast
// words ("Sun 12:00", "by Tue") are rendered in the viewer's time zone.
const HOUR_MS = 3_600_000;
const config = { ...PROVIDER_USAGE_SETTINGS_DEFAULTS };

/** Local time on Oct 2026; Oct 17 is a Saturday. */
function local(day: number, hour: number, minute = 0): number {
  return new Date(2026, 9, day, hour, minute).getTime();
}

const NOW = local(17, 12);
/** Four of seven days into the week at NOW: pace 10 %/day per 40% used. */
const RESET_SEC = local(20, 12) / 1000;

function weekly(overrides: Partial<UsageWindow> = {}): UsageWindow {
  return {
    id: 'weekly',
    label: 'Weekly limit',
    kind: 'weekly',
    usedPercent: 40,
    resetsAt: RESET_SEC,
    ...overrides,
  };
}

function snapshot(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    accountKey: 'claude:login:/home/dev/.claude',
    provider: 'claude',
    label: 'Claude',
    windows: [weekly()],
    extras: [],
    plan: null,
    source: 'cli',
    fetchedAt: new Date(NOW).toISOString(),
    state: 'ok',
    error: null,
    ...overrides,
  };
}

describe('usageForecast', () => {
  it('too early: no line before 16.8 h', () => {
    const early = weekly({
      usedPercent: 50,
      resetsAt: (NOW + 7 * 24 * HOUR_MS - 10 * HOUR_MS) / 1000,
    });
    expect(usageForecast(snapshot({ windows: [early] }), config, NOW)).toBeNull();
  });

  it('reached early: used up shows before 16.8 h', () => {
    const resetsAt = local(24, 2) / 1000;
    const used = weekly({ usedPercent: 100, resetsAt });
    expect(usageForecast(snapshot({ windows: [used] }), config, NOW)).toEqual({
      kind: 'reached',
      text: 'Used up for this week. Resets Sat 02:00.',
    });

    const runsOut = weekly({ id: 'weekly-opus', label: 'Weekly · Opus', usedPercent: 80 });
    const forecast = usageForecast(snapshot({ windows: [used], extras: [runsOut] }), config, NOW);
    expect(forecast?.kind).toBe('reached');
  });

  it('on track: projected percent below 100', () => {
    expect(usageForecast(snapshot(), config, NOW)).toEqual({
      kind: 'on-track',
      text: 'Enough for this week: about 70% used by Tue.',
    });

    const today = weekly({
      usedPercent: 50,
      resetsAt: local(17, 21) / 1000,
    });
    expect(usageForecast(snapshot({ windows: [today] }), config, NOW)?.text).toBe(
      'Enough for this week: about 53% used by 21:00.',
    );
  });

  it('runs out: earliest run-out wins', () => {
    const later = weekly({ id: 'weekly-sonnet', label: 'Weekly · Sonnet', usedPercent: 80 });
    const sooner = weekly({ id: 'weekly-opus', label: 'Weekly · Opus', usedPercent: 90 });
    const forecast = usageForecast(
      snapshot({ windows: [weekly()], extras: [later, sooner] }),
      config,
      NOW,
    );
    expect(forecast).toEqual({
      kind: 'runs-out',
      text: 'Opus: not enough for this week: runs out around 22:40.',
    });

    const tomorrow = weekly({ usedPercent: 80 });
    expect(usageForecast(snapshot({ windows: [tomorrow] }), config, NOW)?.text).toBe(
      'Not enough for this week: runs out around Sun 12:00.',
    );
  });

  it('runs out in the past: may already have run out', () => {
    const almost = weekly({ usedPercent: 99.9 });
    const read = new Date(NOW - HOUR_MS).toISOString();
    expect(usageForecast(snapshot({ windows: [almost], fetchedAt: read }), config, NOW)).toEqual({
      kind: 'runs-out',
      text: 'Not enough for this week: may already have run out.',
    });
  });

  it('muted: no line for error or old data', () => {
    expect(usageForecast(snapshot({ state: 'error', error: 'failed' }), config, NOW)).toBeNull();
    expect(usageForecast(snapshot({ fetchedAt: null }), config, NOW)).toBeNull();
    const old = new Date(NOW - 61 * 60_000).toISOString();
    expect(usageForecast(snapshot({ fetchedAt: old }), config, NOW)).toBeNull();
  });

  it('skips 5-hour and other windows', () => {
    const fiveHour = weekly({ id: '5h', kind: '5h', usedPercent: 99 });
    const other = weekly({ id: 'other', kind: 'other', usedPercent: 100 });
    expect(usageForecast(snapshot({ windows: [fiveHour, other] }), config, NOW)).toBeNull();
  });

  it('uses fetchedAt as the reference time', () => {
    // Seventeen hours into the week now, but 16.5 h when the percent was read.
    const resetsAt = (NOW + 7 * 24 * HOUR_MS - 17 * HOUR_MS) / 1000;
    const read = new Date(NOW - 30 * 60_000).toISOString();
    const early = snapshot({
      windows: [weekly({ resetsAt, usedPercent: 5 })],
      fetchedAt: read,
    });
    expect(usageForecast(early, config, NOW)).toBeNull();

    const fresh = snapshot({ windows: [weekly({ resetsAt, usedPercent: 5 })] });
    expect(usageForecast(fresh, config, NOW)?.kind).toBe('on-track');
  });

  it('extras-only account (agy)', () => {
    const group = weekly({ id: 'gemini-pro', label: 'Gemini Pro', usedPercent: 80 });
    expect(usageForecast(snapshot({ windows: [], extras: [group] }), config, NOW)).toEqual({
      kind: 'runs-out',
      text: 'Gemini Pro: not enough for this week: runs out around Sun 12:00.',
    });
  });

  it('per-model extra prefixes the model name', () => {
    const opus = weekly({ id: 'weekly-opus', label: 'Weekly · Opus', usedPercent: 80 });
    const forecast = usageForecast(snapshot({ extras: [opus] }), config, NOW);
    expect(forecast?.text).toBe('Opus: not enough for this week: runs out around Sun 12:00.');

    const mainOnly = usageForecast(snapshot(), config, NOW);
    expect(mainOnly?.text.startsWith('Enough')).toBe(true);
  });
});
