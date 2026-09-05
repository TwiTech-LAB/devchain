import type { EpicTimeDailyTotal } from './epic-time.models';
import {
  canonicalizeEpicTimeZone,
  isValidActivityDate,
  resolveLocalDayInterval,
} from './epic-time-local-day';

const MILLIS_PER_MINUTE = 60_000;

export type EpicTimeDailyExportStatus =
  | 'ok'
  | 'zone_rebind_required'
  | 'real_shrink'
  | 'stale_capture';

export interface EpicTimeDailyExportChunk {
  activityDate: string;
  /** ISO UTC instant of the local day start; every same-date chunk shares it. */
  startedAt: string;
  durationMs: number;
  minutes: number;
}

export interface EpicTimeDailyExportRebaseline {
  /** True only when continuing requires rebuilding the dated baseline (Set logged). */
  required: boolean;
  reason: 'zone_rebind' | 'dated_deficit' | null;
}

export interface EpicTimeDailyExportAllocation {
  status: EpicTimeDailyExportStatus;
  totalNewMinutes: number;
  /** Legacy scalar credit placed onto dates, oldest date first. */
  materializedCredit: EpicTimeDailyTotal[];
  /** Per-date increments to export, ascending by activityDate. */
  datedDeltas: EpicTimeDailyTotal[];
  /** Provider entries, oldest date first; each stays inside its local day. */
  entryChunks: EpicTimeDailyExportChunk[];
  rebaseline: EpicTimeDailyExportRebaseline;
  /** True only on ok: the stored canonical zone may rebind to the current zone as part of this settlement. */
  safeZoneRebind: boolean;
}

export interface EpicTimeDailyExportAllocatorInput {
  liveByDate: ReadonlyArray<EpicTimeDailyTotal>;
  capturedByDate: ReadonlyArray<EpicTimeDailyTotal>;
  ledgerByDate: ReadonlyArray<EpicTimeDailyTotal>;
  /** Derived persisted scalar credit: loggedMinutes minus dated ledger minutes. */
  unallocatedCreditMinutes: number;
  storedCanonicalTimeZone: string | null;
  currentCanonicalTimeZone: string;
}

function toTotalsMap(
  entries: ReadonlyArray<EpicTimeDailyTotal>,
  label: string,
): Map<string, number> {
  const map = new Map<string, number>();
  for (const entry of entries) {
    if (!isValidActivityDate(entry.activityDate)) {
      throw new Error(`${label} contains an invalid activity date.`);
    }
    if (!Number.isSafeInteger(entry.minutes) || entry.minutes < 0) {
      throw new Error(`${label} minutes must be nonnegative whole numbers.`);
    }
    map.set(entry.activityDate, (map.get(entry.activityDate) ?? 0) + entry.minutes);
  }
  return map;
}

function sumMinutes(values: Iterable<number>): number {
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total;
}

function requireCanonicalZone(zone: string): string {
  const canonical = canonicalizeEpicTimeZone(zone);
  if (!canonical) {
    throw new Error('A valid IANA time zone is required.');
  }
  return canonical;
}

function blockedAllocation(
  status: EpicTimeDailyExportStatus,
  rebaseline: EpicTimeDailyExportRebaseline,
): EpicTimeDailyExportAllocation {
  return {
    status,
    totalNewMinutes: 0,
    materializedCredit: [],
    datedDeltas: [],
    entryChunks: [],
    rebaseline,
    safeZoneRebind: false,
  };
}

function buildEntryChunks(
  datedDeltas: ReadonlyArray<EpicTimeDailyTotal>,
  timeZone: string,
): EpicTimeDailyExportChunk[] {
  const chunks: EpicTimeDailyExportChunk[] = [];
  for (const delta of datedDeltas) {
    const interval = resolveLocalDayInterval(delta.activityDate, timeZone);
    // Whole-minute cap: a chunk never outlives the local day, so 23-hour
    // DST days carry fewer minutes per chunk than ordinary days. The
    // provider-side maximum-duration guard stays redundant behind this cap.
    const maxChunkMinutes = Math.floor(interval.durationMs / MILLIS_PER_MINUTE);
    if (maxChunkMinutes < 1) {
      throw new Error(`The local day for ${delta.activityDate} fits no whole minutes.`);
    }
    let remainingMinutes = delta.minutes;
    while (remainingMinutes > 0) {
      const chunkMinutes = Math.min(remainingMinutes, maxChunkMinutes);
      chunks.push({
        activityDate: delta.activityDate,
        startedAt: new Date(interval.startUtcMs).toISOString(),
        durationMs: chunkMinutes * MILLIS_PER_MINUTE,
        minutes: chunkMinutes,
      });
      remainingMinutes -= chunkMinutes;
    }
  }
  return chunks;
}

/**
 * Pure dated-export plan shared by the browser preview and the server.
 * The captured snapshot is authoritative for what gets exported; live
 * growth beyond the capture stays for a later request. Persisted credit
 * (dated ledger rows and not-yet-placed scalar credit) is never moved,
 * rewritten, or re-exported — only genuinely new minutes become entries.
 *
 * Coverage is judged per activity date, never by scalar totals alone: a
 * ledger date that live no longer covers is a real deficit even when the
 * totals match. Scalar credit counts only in the aggregate comparison, so
 * it can never hide a dated deficit. A canonical-zone change is a safe
 * rebind (ok + safeZoneRebind) while the dated ledger stays covered; with
 * a deficit it is destructive and directs a Set-logged rebuild, exactly
 * like same-zone real shrink. A capture that trails the covered ledger
 * requests recapture instead of either destructive path.
 */
export function allocateDailyEstimateExport(
  input: EpicTimeDailyExportAllocatorInput,
): EpicTimeDailyExportAllocation {
  const currentZone = requireCanonicalZone(input.currentCanonicalTimeZone);
  const storedZone =
    input.storedCanonicalTimeZone === null
      ? null
      : requireCanonicalZone(input.storedCanonicalTimeZone);

  const liveByDate = toTotalsMap(input.liveByDate, 'Live totals');
  const capturedByDate = toTotalsMap(input.capturedByDate, 'Captured totals');
  const ledgerByDate = toTotalsMap(input.ledgerByDate, 'Ledger totals');
  if (!Number.isSafeInteger(input.unallocatedCreditMinutes) || input.unallocatedCreditMinutes < 0) {
    throw new Error('Unallocated credit minutes must be a nonnegative whole number.');
  }

  const persistedTotal = sumMinutes(ledgerByDate.values()) + input.unallocatedCreditMinutes;
  const liveTotal = sumMinutes(liveByDate.values());
  const capturedTotal = sumMinutes(capturedByDate.values());
  const zoneChanged = storedZone !== null && storedZone !== currentZone;

  const hasDatedDeficit = [...ledgerByDate.entries()].some(
    ([activityDate, ledgerMinutes]) => (liveByDate.get(activityDate) ?? 0) < ledgerMinutes,
  );
  const hasShrink = hasDatedDeficit || liveTotal < persistedTotal;

  // A zone change with a deficit is destructive: the stored dates cannot
  // be reinterpreted in the new zone, so only a rebuild (Set logged) can
  // continue. Same-zone deficits report real shrink with the same remedy.
  if (zoneChanged && hasShrink) {
    return blockedAllocation('zone_rebind_required', {
      required: true,
      reason: 'zone_rebind',
    });
  }
  if (hasShrink) {
    return blockedAllocation('real_shrink', { required: true, reason: 'dated_deficit' });
  }
  // Shrink checks passed, so live covers every ledger date: a capture that
  // still trails the ledger (per date or in aggregate behind the scalar
  // credit) is stale and only needs a fresh capture.
  const hasStaleCapture =
    capturedTotal < persistedTotal ||
    [...ledgerByDate.entries()].some(
      ([activityDate, ledgerMinutes]) => (capturedByDate.get(activityDate) ?? 0) < ledgerMinutes,
    );
  if (hasStaleCapture) {
    return blockedAllocation('stale_capture', { required: false, reason: null });
  }

  const materializedCredit: EpicTimeDailyTotal[] = [];
  const datedDeltas: EpicTimeDailyTotal[] = [];
  let remainingCreditMinutes = input.unallocatedCreditMinutes;
  const dates = [...new Set([...capturedByDate.keys(), ...ledgerByDate.keys()])].sort(
    (left, right) => left.localeCompare(right),
  );
  for (const activityDate of dates) {
    const capturedMinutes = capturedByDate.get(activityDate) ?? 0;
    const ledgerMinutes = ledgerByDate.get(activityDate) ?? 0;
    // Credit materializes once, oldest date first, and never beyond a
    // date's uncovered minutes — persisted credit is never relocated.
    const uncoveredMinutes = Math.max(0, capturedMinutes - ledgerMinutes);
    const placedMinutes = Math.min(remainingCreditMinutes, uncoveredMinutes);
    if (placedMinutes > 0) {
      materializedCredit.push({ activityDate, minutes: placedMinutes });
      remainingCreditMinutes -= placedMinutes;
    }
    const deltaMinutes = capturedMinutes - ledgerMinutes - placedMinutes;
    if (deltaMinutes > 0) {
      datedDeltas.push({ activityDate, minutes: deltaMinutes });
    }
  }

  return {
    status: 'ok',
    totalNewMinutes: sumMinutes(datedDeltas.map((delta) => delta.minutes)),
    materializedCredit,
    datedDeltas,
    entryChunks: buildEntryChunks(datedDeltas, currentZone),
    rebaseline: { required: false, reason: null },
    safeZoneRebind: zoneChanged,
  };
}
