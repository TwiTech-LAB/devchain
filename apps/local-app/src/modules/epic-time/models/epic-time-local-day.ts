/**
 * Pure local-day math for the dated estimate export: canonical IANA zone
 * resolution and exact UTC instants for a canonical local activity date.
 * No runtime imports — the browser preview and the Nest backend share
 * this boundary.
 */

const MILLIS_PER_MINUTE = 60_000;
const MAX_ZONE_LENGTH = 128;
const FIXED_OFFSET_PATTERN = /^[+-]\d{2}:?\d{2}$/;
const ACTIVITY_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const WALL_CLOCK_ITERATIONS = 3;
const DAY_BOUNDARY_SEARCH_WINDOW_MS = 26 * 3_600_000;
const DAY_BOUNDARY_SEARCH_PRECISION_MS = 1_000;

interface CalendarParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export interface LocalDayInterval {
  activityDate: string;
  /** UTC instant of the local day start (00:00, or the first existing local time when midnight is skipped). */
  startUtcMs: number;
  /** UTC instant of the next local day start; the day interval is half-open [startUtcMs, nextStartUtcMs). */
  nextStartUtcMs: number;
  /** Exact local day length: 23h through 25h around DST transitions. */
  durationMs: number;
}

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = partsFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partsFormatters.set(timeZone, formatter);
  }
  return formatter;
}

function zoneParts(utcMs: number, timeZone: string): CalendarParts {
  const byType = new Map<string, string>();
  for (const part of partsFormatter(timeZone).formatToParts(new Date(utcMs))) {
    byType.set(part.type, part.value);
  }
  return {
    year: Number(byType.get('year')),
    month: Number(byType.get('month')),
    day: Number(byType.get('day')),
    hour: Number(byType.get('hour')),
    minute: Number(byType.get('minute')),
    second: Number(byType.get('second')),
  };
}

function localDateKey(utcMs: number, timeZone: string): string {
  const parts = zoneParts(utcMs, timeZone);
  return `${pad2(parts.year)}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : `${value}`;
}

function zoneOffsetMsAt(utcMs: number, timeZone: string): number {
  const parts = zoneParts(utcMs, timeZone);
  return (
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - utcMs
  );
}

/**
 * UTC instant of a wall-clock reading. The offset iteration converges
 * whenever the wall time exists; callers must verify skipped wall times
 * (a DST transition that jumps over midnight) before trusting the result.
 */
function wallClockToUtcMs(parts: CalendarParts, timeZone: string): number {
  const targetMs = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  let guessMs = targetMs;
  for (let pass = 0; pass < WALL_CLOCK_ITERATIONS; pass += 1) {
    const nextMs = targetMs - zoneOffsetMsAt(guessMs, timeZone);
    if (nextMs === guessMs) {
      break;
    }
    guessMs = nextMs;
  }
  return guessMs;
}

/**
 * First UTC instant whose local date is the target date, found by binary
 * search around a local-noon anchor. Noon exists on every real-zone date
 * (DST shifts never reach midday), and local dates never repeat, so the
 * date predicate is monotone inside the window.
 */
function firstInstantOfLocalDate(parts: CalendarParts, timeZone: string): number {
  const targetKey = `${pad2(parts.year)}-${pad2(parts.month)}-${pad2(parts.day)}`;
  const noonAnchorMs = wallClockToUtcMs({ ...parts, hour: 12, minute: 0, second: 0 }, timeZone);
  if (localDateKey(noonAnchorMs, timeZone) !== targetKey) {
    throw new Error('Unable to anchor the local day start.');
  }
  let lowerMs = noonAnchorMs - DAY_BOUNDARY_SEARCH_WINDOW_MS;
  let upperMs = noonAnchorMs;
  while (upperMs - lowerMs > DAY_BOUNDARY_SEARCH_PRECISION_MS) {
    const midMs = lowerMs + Math.floor((upperMs - lowerMs) / 2);
    if (localDateKey(midMs, timeZone) === targetKey) {
      upperMs = midMs;
    } else {
      lowerMs = midMs;
    }
  }
  // Refine to the exact millisecond: the search window's lower bound still
  // carries the previous date, so this walk stops inside the window.
  while (localDateKey(upperMs - 1, timeZone) === targetKey) {
    upperMs -= 1;
  }
  return upperMs;
}

function localDayStartUtcMs(parts: CalendarParts, timeZone: string): number {
  const guessMs = wallClockToUtcMs({ ...parts, hour: 0, minute: 0, second: 0 }, timeZone);
  const guessParts = zoneParts(guessMs, timeZone);
  if (
    guessParts.year === parts.year &&
    guessParts.month === parts.month &&
    guessParts.day === parts.day &&
    guessParts.hour === 0 &&
    guessParts.minute === 0 &&
    guessParts.second === 0
  ) {
    return guessMs;
  }
  return firstInstantOfLocalDate(parts, timeZone);
}

export function isValidActivityDate(activityDate: string): boolean {
  if (typeof activityDate !== 'string' || !ACTIVITY_DATE_PATTERN.test(activityDate)) {
    return false;
  }
  const [year, month, day] = activityDate.split('-').map(Number);
  const normalized = new Date(Date.UTC(year, month - 1, day));
  return (
    normalized.getUTCFullYear() === year &&
    normalized.getUTCMonth() === month - 1 &&
    normalized.getUTCDate() === day
  );
}

function parseActivityDate(activityDate: string): CalendarParts {
  if (!isValidActivityDate(activityDate)) {
    throw new Error(`Invalid activity date: ${activityDate}`);
  }
  const [year, month, day] = activityDate.split('-').map(Number);
  return { year, month, day, hour: 0, minute: 0, second: 0 };
}

function nextCalendarDate(parts: CalendarParts): CalendarParts {
  const next = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
    hour: 0,
    minute: 0,
    second: 0,
  };
}

/**
 * Canonical IANA zone name (`Intl.DateTimeFormat(...).resolvedOptions()
 * .timeZone`) for a requested zone, or null when the request is not a
 * valid named zone. UTC aliases (Etc/UTC, GMT, Zulu, …) canonicalize to
 * the same value so zone comparisons never false-positive on aliases.
 * Fixed-offset requests stay rejected — only named zones are accepted.
 */
export function canonicalizeEpicTimeZone(requested: string): string | null {
  try {
    const normalized = requested.trim();
    if (
      !normalized ||
      normalized.length > MAX_ZONE_LENGTH ||
      FIXED_OFFSET_PATTERN.test(normalized)
    ) {
      return null;
    }
    const resolved = new Intl.DateTimeFormat('en-US', {
      timeZone: normalized,
      year: 'numeric',
    }).resolvedOptions().timeZone;
    return resolved && resolved.trim().length > 0 ? resolved : null;
  } catch {
    return null;
  }
}

export function resolveLocalDayInterval(activityDate: string, timeZone: string): LocalDayInterval {
  const startParts = parseActivityDate(activityDate);
  const startUtcMs = localDayStartUtcMs(startParts, timeZone);
  const nextStartUtcMs = localDayStartUtcMs(nextCalendarDate(startParts), timeZone);
  if (
    !Number.isFinite(startUtcMs) ||
    !Number.isFinite(nextStartUtcMs) ||
    nextStartUtcMs <= startUtcMs
  ) {
    throw new Error(`Unable to resolve the local day interval for ${activityDate}.`);
  }
  const durationMs = nextStartUtcMs - startUtcMs;
  if (durationMs < MILLIS_PER_MINUTE) {
    throw new Error(`The local day for ${activityDate} is shorter than one minute.`);
  }
  return { activityDate, startUtcMs, nextStartUtcMs, durationMs };
}
