import type { ProviderUsageSettings, UsageSnapshot, UsageWindow } from '@devchain/shared';

const WEEK_SEC = 7 * 86_400;
/** Too little of the week has passed for the average pace to mean anything. */
const MIN_ELAPSED_SEC = WEEK_SEC * 0.1;

export type UsageForecastKind = 'on-track' | 'runs-out' | 'reached';

export interface UsageForecast {
  kind: UsageForecastKind;
  text: string;
}

/** Whether the snapshot's percents are not current; shared by the graphics and the forecast. */
export function isUsageMuted(
  snapshot: UsageSnapshot,
  config: ProviderUsageSettings,
  now: number,
): boolean {
  if (['error', 'unsupported', 'not-available'].includes(snapshot.state)) return true;
  if (snapshot.fetchedAt === null) return true;
  return now - Date.parse(snapshot.fetchedAt) > 2 * config.openProjectMaxAgeMin * 60_000;
}

type Candidate = { prefix: string | null } & (
  | { kind: 'reached'; resetsAt: number }
  | { kind: 'on-track'; resetsAt: number; projected: number }
  | { kind: 'runs-out'; runOut: number }
);

/** Per-model windows name their model; the account's main weekly window has no prefix. */
function modelPrefix(window: UsageWindow): string | null {
  const name = window.label.split('·').pop()?.trim();
  return name ? name : null;
}

/** `asOf` is epoch ms; the window's `resetsAt` is epoch seconds. */
function evaluate(window: UsageWindow, prefix: string | null, asOf: number): Candidate | null {
  if (window.resetsAt === null) return null;
  const { resetsAt, usedPercent } = window;
  if (usedPercent >= 100) return { kind: 'reached', prefix, resetsAt };

  const asOfSec = asOf / 1000;
  const elapsed = asOfSec - (resetsAt - WEEK_SEC);
  const remaining = resetsAt - asOfSec;
  if (remaining <= 0 || elapsed < MIN_ELAPSED_SEC) return null;

  const rate = usedPercent / elapsed;
  const projected = usedPercent + rate * remaining;
  if (projected < 100) return { kind: 'on-track', prefix, resetsAt, projected };
  // A zero rate cannot project past 100, so the divisor is positive here.
  const runOut = asOfSec + (100 - usedPercent) / rate;
  return { kind: 'runs-out', prefix, runOut };
}

function pick(candidates: Candidate[]): Candidate | null {
  const reached = candidates.find((candidate) => candidate.kind === 'reached');
  if (reached) return reached;

  const runsOut = candidates
    .flatMap((candidate) => (candidate.kind === 'runs-out' ? [candidate] : []))
    .sort((a, b) => a.runOut - b.runOut);
  if (runsOut.length > 0) return runsOut[0];

  const onTrack = candidates
    .flatMap((candidate) => (candidate.kind === 'on-track' ? [candidate] : []))
    .sort((a, b) => b.projected - a.projected);
  return onTrack[0] ?? null;
}

function sameDay(a: Date, b: Date): boolean {
  return a.toDateString() === b.toDateString();
}

/** The 24-hour `HH:MM` time the hover card uses for resets and the forecast. */
export function formatTime(date: Date): string {
  return date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
}

function formatWeekday(date: Date): string {
  return date.toLocaleDateString('en-US', { weekday: 'short' });
}

/** Time only when the moment is today, otherwise the short weekday and the time. */
function formatMoment(epochMs: number, now: number): string {
  const date = new Date(epochMs);
  return sameDay(date, new Date(now))
    ? formatTime(date)
    : `${formatWeekday(date)} ${formatTime(date)}`;
}

/** Time only when the moment is today, otherwise just the short weekday. */
function formatDeadline(epochMs: number, now: number): string {
  const date = new Date(epochMs);
  return sameDay(date, new Date(now)) ? formatTime(date) : formatWeekday(date);
}

/** Capitalized at the start of the line, lower-case after a model prefix. */
function line(prefix: string | null, sentence: string): string {
  return prefix === null
    ? sentence
    : `${prefix}: ${sentence.charAt(0).toLowerCase()}${sentence.slice(1)}`;
}

function describe(candidate: Candidate, now: number): UsageForecast {
  const { prefix } = candidate;
  if (candidate.kind === 'reached') {
    const resets = formatMoment(candidate.resetsAt * 1000, now);
    return {
      kind: 'reached',
      text: line(prefix, `Used up for this week. Resets ${resets}.`),
    };
  }
  if (candidate.kind === 'on-track') {
    const by = formatDeadline(candidate.resetsAt * 1000, now);
    return {
      kind: 'on-track',
      text: line(
        prefix,
        `Enough for this week: about ${Math.round(candidate.projected)}% used by ${by}.`,
      ),
    };
  }
  const runOutMs = candidate.runOut * 1000;
  const sentence =
    runOutMs <= now
      ? 'Not enough for this week: may already have run out.'
      : `Not enough for this week: runs out around ${formatMoment(runOutMs, now)}.`;
  return { kind: 'runs-out', text: line(prefix, sentence) };
}

/**
 * Whether a weekly window lasts until its reset at the average pace since the week
 * started, as of the time the percents were read. `now` is epoch ms. Null when there is
 * nothing to say: muted data, or no weekly window far enough into its week.
 */
export function usageForecast(
  snapshot: UsageSnapshot,
  config: ProviderUsageSettings,
  now: number,
): UsageForecast | null {
  if (isUsageMuted(snapshot, config, now) || snapshot.fetchedAt === null) return null;
  const asOf = Date.parse(snapshot.fetchedAt);

  const candidates = [
    ...snapshot.windows.map((window) => ({ window, prefix: null })),
    ...snapshot.extras.map((window) => ({ window, prefix: modelPrefix(window) })),
  ]
    .filter(({ window }) => window.kind === 'weekly')
    .map(({ window, prefix }) => evaluate(window, prefix, asOf))
    .filter((candidate): candidate is Candidate => candidate !== null);

  const chosen = pick(candidates);
  return chosen === null ? null : describe(chosen, now);
}
