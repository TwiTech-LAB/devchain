import type { UsageWindow } from '@devchain/shared';
import { standardWindow } from './checker-helpers';

export type ParsedClaudeUsage =
  | { kind: 'ok'; windows: UsageWindow[]; extras: UsageWindow[] }
  | { kind: 'not-available' }
  | { kind: 'error' };

const WINDOW_LINE_RE =
  /^Current (session|week \((.+?)\)):\s*(\d+(?:\.\d+)?)%\s+used(?:\s+·\s+resets\s+(.+?))?\s*$/;
const RESET_RE = /^([A-Za-z]{3}) (\d{1,2}), (\d{1,2})(?::(\d{2}))?\s*(am|pm)\s+\(([^()]+)\)$/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/** Covers a Feb 29 reset that falls in a non-leap year. */
const MAX_YEARS_AHEAD = 4;
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * Parses the stdout of `claude -p /usage`. A line that does not parse is dropped, and a
 * window whose reset time cannot be read is dropped with it, so no value shown is a guess.
 */
export function parseClaudeUsage(stdout: string, nowMs: number): ParsedClaudeUsage {
  const windows: UsageWindow[] = [];
  const extras: UsageWindow[] = [];
  const seen = new Set<string>();

  for (const raw of stdout.replace(ANSI_RE, '').split(/\r?\n/)) {
    const match = WINDOW_LINE_RE.exec(raw.trim());
    if (!match) continue;
    const [, scope, model, percent, reset] = match;

    const window = buildWindow(scope, model, Number(percent));
    if (!window || seen.has(window.window.id)) continue;

    let resetsAt: number | null = null;
    if (reset !== undefined) {
      resetsAt = parseResetEpochSeconds(reset, nowMs);
      if (resetsAt === null) continue;
    }

    seen.add(window.window.id);
    (window.extra ? extras : windows).push({ ...window.window, resetsAt });
  }

  if (windows.length > 0 || extras.length > 0) return { kind: 'ok', windows, extras };
  return /^\s*Total cost:/m.test(stdout) ? { kind: 'not-available' } : { kind: 'error' };
}

function buildWindow(
  scope: string,
  model: string | undefined,
  usedPercent: number,
): { window: Omit<UsageWindow, 'resetsAt'>; extra: boolean } | null {
  if (scope === 'session') {
    return { window: standardWindow('5h', usedPercent, null), extra: false };
  }
  if (model === undefined) return null;
  if (model.toLowerCase() === 'all models') {
    return { window: standardWindow('weekly', usedPercent, null), extra: false };
  }
  const slug = model
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  if (!slug) return null;
  return {
    window: { id: `weekly-${slug}`, label: `Weekly · ${model}`, kind: 'weekly', usedPercent },
    extra: true,
  };
}

/**
 * `Oct 23, 12am (Europe/Madrid)` to epoch seconds. The text has no year: the result is
 * the first such moment after `nowMs`.
 */
export function parseResetEpochSeconds(text: string, nowMs: number): number | null {
  const match = RESET_RE.exec(text.trim());
  if (!match) return null;
  const [, monthName, dayText, hourText, minuteText, meridiem, zone] = match;
  const month = MONTHS.indexOf(monthName.toLowerCase());
  const day = Number(dayText);
  const hour12 = Number(hourText);
  const minute = minuteText === undefined ? 0 : Number(minuteText);
  if (month < 0 || hour12 < 1 || hour12 > 12 || minute > 59) return null;
  const hour = (hour12 % 12) + (meridiem.toLowerCase() === 'pm' ? 12 : 0);

  try {
    const firstYear = zonedParts(nowMs, zone).year;
    for (let year = firstYear; year <= firstYear + MAX_YEARS_AHEAD; year += 1) {
      if (new Date(Date.UTC(year, month, day)).getUTCDate() !== day) continue;
      const epochMs = zonedWallTimeToEpochMs(year, month, day, hour, minute, zone);
      if (epochMs > nowMs) return Math.floor(epochMs / 1000);
    }
  } catch {
    // An unknown IANA zone makes Intl throw a RangeError.
  }
  return null;
}

function zonedWallTimeToEpochMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  zone: string,
): number {
  const wallAsUtc = Date.UTC(year, month, day, hour, minute);
  // The second pass uses the offset at the first result, which settles dates near a DST change.
  const firstGuess = wallAsUtc - zoneOffsetMs(wallAsUtc, zone);
  return wallAsUtc - zoneOffsetMs(firstGuess, zone);
}

function zoneOffsetMs(epochMs: number, zone: string): number {
  const second = Math.floor(epochMs / 1000) * 1000;
  const p = zonedParts(second, zone);
  return Date.UTC(p.year, p.month, p.day, p.hour, p.minute, p.second) - second;
}

function zonedParts(epochMs: number, zone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(epochMs);
  const value = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: value('year'),
    month: value('month') - 1,
    day: value('day'),
    hour: value('hour'),
    minute: value('minute'),
    second: value('second'),
  };
}
