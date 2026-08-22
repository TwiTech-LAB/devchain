import type { IntegrationConnectionEpoch } from '@/ui/lib/integration-connections';

export const MAX_TRACKED_DURATION_MS = 7 * 24 * 60 * 60_000;

/**
 * Parses the duration-first input: `15m`, `5h`, `1h 30m`, `90m`, or a bare
 * integer of minutes such as `30`. Returns positive whole-minute
 * `durationMs`, or null for anything the contract rejects — wrong unit
 * order, repeated units, decimals, zero, garbage, or totals above seven
 * days.
 */
export function parseDurationInput(input: string): number | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed || trimmed.length > 32) return null;
  const tokens = trimmed.split(/\s+/);
  if (tokens.length > 2) return null;

  const parts: Array<{ unit: 'h' | 'm'; value: number }> = [];
  for (const token of tokens) {
    const match = /^(\d+)([hm])$/.exec(token);
    if (match) {
      parts.push({ unit: match[2] as 'h' | 'm', value: Number(match[1]) });
      continue;
    }
    // A bare integer is minutes, and only valid as the whole input.
    if (tokens.length === 1 && /^\d+$/.test(token)) {
      parts.push({ unit: 'm', value: Number(token) });
      continue;
    }
    return null;
  }

  const units = parts.map((part) => part.unit);
  if (new Set(units).size !== units.length) return null;
  // Hours must precede minutes: `1h 30m` is the only compound order.
  if (units.length === 2 && units[0] !== 'h') return null;

  const minutes = parts.reduce(
    (total, part) => total + part.value * (part.unit === 'h' ? 60 : 1),
    0,
  );
  if (!Number.isSafeInteger(minutes) || minutes <= 0) return null;
  const durationMs = minutes * 60_000;
  if (durationMs > MAX_TRACKED_DURATION_MS) return null;
  return durationMs;
}

/** Compact human label for a duration, e.g. 5_400_000 → "1h 30m". */
export function formatDurationMs(durationMs: number): string {
  const totalMinutes = Math.round(durationMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

/**
 * The generation segment of a connection epoch (`connectionId:generation`).
 * Time requests send it as the X-DevChain-Connection-Epoch precondition.
 */
export function integrationConnectionGeneration(
  connectionEpoch: IntegrationConnectionEpoch | null,
): string | null {
  const generation = connectionEpoch?.split(':')[1];
  return generation && /^\d{1,10}$/.test(generation) ? generation : null;
}

/**
 * One resolved wire `startedAt` for a submit: the user's exact start when
 * supplied, otherwise an interval ending at the captured submit time.
 */
export function resolveStartedAtMs(
  durationMs: number,
  exactStart: string,
  submitTimeMs: number,
): number | null {
  if (exactStart) {
    const exact = new Date(exactStart).getTime();
    return Number.isFinite(exact) ? exact : null;
  }
  return submitTimeMs - durationMs;
}
