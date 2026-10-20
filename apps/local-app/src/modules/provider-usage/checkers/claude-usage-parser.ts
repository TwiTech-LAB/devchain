import type { UsageWindow } from '@devchain/shared';
import { isObject, standardWindow, type JsonObject } from './checker-helpers';

export type ParsedClaudeUsage =
  | { kind: 'ok'; windows: UsageWindow[]; extras: UsageWindow[] }
  | { kind: 'not-available' }
  | { kind: 'error' };

const WINDOW_LINE_RE =
  /^Current (session|week \((.+?)\)):\s*(\d+(?:\.\d+)?)%\s+used(?:\s+·\s+resets\s+(.+?))?\s*$/;
const RESET_RE =
  /^([A-Za-z]{3}) (\d{1,2})(?:,| at) (\d{1,2})(?::(\d{2}))?\s*(am|pm)\s+\(([^()]+)\)$/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/** Covers a Feb 29 reset that falls in a non-leap year. */
const MAX_YEARS_AHEAD = 4;
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

interface WindowEntry {
  window: UsageWindow;
  extra: boolean;
}

/**
 * Parses the stdout of `claude -p /usage --output-format stream-json --verbose`. The
 * `usage_report` of the assistant event has the percentages and UTC reset times, so no
 * date text is read. A version that does not send it falls back to the result event text.
 */
export function parseClaudeUsageStream(stdout: string, nowMs: number): ParsedClaudeUsage {
  let text: string | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    const event = parseJsonLine(line.trim());
    if (event?.type === 'assistant') {
      const parsed = parseUsageReport(event.usage_report);
      if (parsed) return parsed;
    } else if (event?.type === 'result' && typeof event.result === 'string') {
      text = event.result;
    }
  }
  return parseClaudeUsage(text ?? stdout, nowMs);
}

/**
 * Parses the text of `claude -p /usage`. A line that does not parse is dropped, and a
 * window whose reset time cannot be read is dropped with it, so no value shown is a guess.
 */
export function parseClaudeUsage(stdout: string, nowMs: number): ParsedClaudeUsage {
  const entries: WindowEntry[] = [];

  for (const raw of stdout.replace(ANSI_RE, '').split(/\r?\n/)) {
    const match = WINDOW_LINE_RE.exec(raw.trim());
    if (!match) continue;
    const [, scope, model, percent, reset] = match;

    let resetsAt: number | null = null;
    if (reset !== undefined) {
      resetsAt = parseResetEpochSeconds(reset, nowMs);
      if (resetsAt === null) continue;
    }

    const entry = buildWindow(scope === 'session' ? null : model, Number(percent), resetsAt);
    if (entry) entries.push(entry);
  }

  const parsed = collectWindows(entries);
  if (parsed) return parsed;
  return /^\s*Total cost:/m.test(stdout) ? { kind: 'not-available' } : { kind: 'error' };
}

/** Null when no limit has a known kind and a readable percent and reset time. */
function parseUsageReport(report: unknown): ParsedClaudeUsage | null {
  const limits =
    isObject(report) && isObject(report.rate_limits) ? report.rate_limits.limits : undefined;
  if (!Array.isArray(limits)) return null;

  const entries: WindowEntry[] = [];
  for (const limit of limits) {
    if (!isObject(limit)) continue;
    const model = reportModel(limit);
    const resetsAt = reportResetEpochSeconds(limit.resets_at);
    const usedPercent = limit.percent;
    if (model === undefined || resetsAt === undefined) continue;
    if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent) || usedPercent < 0) {
      continue;
    }
    const entry = buildWindow(model, usedPercent, resetsAt);
    if (entry) entries.push(entry);
  }
  return collectWindows(entries);
}

/** The `buildWindow` model of a limit; undefined for a kind this parser does not know. */
function reportModel(limit: JsonObject): string | null | undefined {
  switch (limit.kind) {
    case 'session':
      return null;
    case 'weekly_all':
      return 'all models';
    case 'weekly_scoped': {
      const scope = isObject(limit.scope) ? limit.scope : {};
      const name = isObject(scope.model) ? scope.model.display_name : undefined;
      return typeof name === 'string' ? name : undefined;
    }
    default:
      return undefined;
  }
}

/** Null when the window has not started; undefined when the value cannot be read. */
function reportResetEpochSeconds(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null;
  const epochMs = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(epochMs) ? Math.floor(epochMs / 1000) : undefined;
}

function parseJsonLine(line: string): JsonObject | null {
  if (!line.startsWith('{')) return null;
  try {
    const value: unknown = JSON.parse(line);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

/** The first window of each id wins. Null when there is no window. */
function collectWindows(entries: readonly WindowEntry[]): ParsedClaudeUsage | null {
  const windows: UsageWindow[] = [];
  const extras: UsageWindow[] = [];
  const seen = new Set<string>();
  for (const { window, extra } of entries) {
    if (seen.has(window.id)) continue;
    seen.add(window.id);
    (extra ? extras : windows).push(window);
  }
  return windows.length > 0 || extras.length > 0 ? { kind: 'ok', windows, extras } : null;
}

/** A null `model` is the session window, and `all models` is the weekly window. */
function buildWindow(
  model: string | null,
  usedPercent: number,
  resetsAt: number | null,
): WindowEntry | null {
  if (model === null) {
    return { window: standardWindow('5h', usedPercent, resetsAt), extra: false };
  }
  if (model.toLowerCase() === 'all models') {
    return { window: standardWindow('weekly', usedPercent, resetsAt), extra: false };
  }
  const slug = model
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  if (!slug) return null;
  return {
    window: {
      id: `weekly-${slug}`,
      label: `Weekly · ${model}`,
      kind: 'weekly',
      usedPercent,
      resetsAt,
    },
    extra: true,
  };
}

/**
 * `Oct 23, 12am (Europe/Madrid)`, or `Oct 23 at 12am (Europe/Madrid)` as Claude Code
 * 2.1.303 prints it on macOS, to epoch seconds. The text has no year: the result is the
 * first such moment after `nowMs`.
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
