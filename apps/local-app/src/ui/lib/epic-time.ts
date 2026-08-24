/**
 * Estimated native Epic time: shared query keys, IANA time-zone resolution,
 * and the native whole-minute duration label. Connected-board duration
 * helpers (`ui/lib/external-time`) are intentionally not reused — external
 * time-entry contracts and native estimates evolve separately.
 */

// TypeScript 5.9 lib files do not ship Intl.DurationFormat yet; this mirrors
// the runtime-native ECMA-402 proposal surface this module consumes.
interface NativeDurationFormat {
  format(duration: { hours?: number; minutes?: number }): string;
}

type NativeDurationFormatConstructor = new (
  locale?: string,
  options?: { style?: 'long' | 'short' | 'narrow' | 'digital' },
) => NativeDurationFormat;

function durationFormatConstructor(): NativeDurationFormatConstructor | undefined {
  return (Intl as { DurationFormat?: NativeDurationFormatConstructor }).DurationFormat;
}

/**
 * Cache scope for time queries. Disabled runtimes (worktree tabs, unresolved
 * runtime) key under 'isolated' so their query observers can never read a
 * main-scope cache entry through any returned field.
 */
export type EpicTimeQueryScope = 'main' | 'isolated';

export const epicTimeQueryKeys = {
  detail: (epicId: string, timeZone: string, scope: EpicTimeQueryScope = 'main') =>
    ['epic-time-detail', epicId, timeZone, scope] as const,
  batch: (epicIds: readonly string[], timeZone: string, scope: EpicTimeQueryScope = 'main') =>
    ['epic-time-batch', epicIds, timeZone, scope] as const,
};

/** The user's IANA time zone; `UTC` when the runtime exposes none. */
export function resolveEpicTimeZone(): string {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return timeZone && timeZone.trim().length > 0 ? timeZone : 'UTC';
}

/** Whole-minute estimate label, e.g. 30 → "30m", 90 → "1h 30m", 0 → "0m". */
export function formatEpicTimeMinutes(minutes: number): string {
  const whole = Number.isFinite(minutes) ? Math.max(0, Math.floor(minutes)) : 0;
  const duration = { hours: Math.floor(whole / 60), minutes: whole % 60 };
  const DurationFormat = durationFormatConstructor();
  if (DurationFormat) {
    const formatted = new DurationFormat('en', { style: 'narrow' }).format(duration).trim();
    if (formatted.length > 0) {
      return formatted;
    }
  }
  if (duration.hours === 0) return `${duration.minutes}m`;
  if (duration.minutes === 0) return `${duration.hours}h`;
  return `${duration.hours}h ${duration.minutes}m`;
}
