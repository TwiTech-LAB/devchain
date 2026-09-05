/**
 * Estimated native Epic time: shared query keys, IANA time-zone resolution,
 * and the native whole-minute duration label. Connected-board duration
 * helpers (`ui/lib/external-time`) are intentionally not reused — external
 * time-entry contracts and native estimates evolve separately.
 */

import type { EpicTimeTaskItem } from '@/modules/epic-time/models/epic-time.models';

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
  buffers: (projectId: string, scope: EpicTimeQueryScope = 'main') =>
    ['agent-time-buffers', projectId, scope] as const,
  detailRoot: (): string[] => ['epic-time-detail'],
  batchRoot: (): string[] => ['epic-time-batch'],
  bufferRoot: (): string[] => ['agent-time-buffers'],
};

/** Minimum settled buffer shown in Chat; smaller balances remain buffered but undisclosed. */
export const MIN_VISIBLE_AGENT_TIME_BUFFER_MINUTES = 10;

/** One agent's claimable aggregate on the agent-time-buffer wire. */
export interface AgentTimeBufferItemWire {
  agentId: string;
  snapshotToken: string;
  minutes: number;
  durationMs: number;
  segmentCount: number;
  oldestActivityAt: string;
  newestActivityAt: string;
}

/** GET /api/agent-time-buffers response as cached, without normalization. */
export interface AgentTimeBufferSnapshotWire {
  capturedAt: string | null;
  items: AgentTimeBufferItemWire[];
}

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

/**
 * Total-scope label for the Epic-time card. A child focal stays self-only; a
 * root names the sub-Epic and, when the resolved rollup admits routed Related
 * roots, the related scope. The related clause is scope-derived, so it stays
 * accurate when a routed root has zero closed segments.
 */
export function epicTimeTotalLabel(isRoot: boolean, includesRelatedTime: boolean): string {
  if (!isRoot) return 'Total';
  return includesRelatedTime
    ? 'Total (incl. sub-epics and related Epics)'
    : 'Total (incl. sub-epics)';
}

/** Long-form of the same scope phrase for export confirmations. */
export function epicTimeExportScopeLabel(isRoot: boolean, includesRelatedTime: boolean): string {
  if (!isRoot) return 'Task total';
  return includesRelatedTime
    ? 'Total including sub-epics and related Epics'
    : 'Total including sub-epics';
}

export interface EpicTimeContributorRow {
  epicId: string;
  epicTitle: string;
  minutes: number;
}

export interface EpicTimeContributorGroup {
  groupEpicId: string;
  groupEpicTitle: string;
  /** True only for the requested focal's own group. */
  isFocal: boolean;
  /** The row whose epicId equals groupEpicId; never derived from isDirect. */
  ownActivity: EpicTimeContributorRow | null;
  /** Included sub-Epic rows, sorted by title then Epic ID. */
  children: EpicTimeContributorRow[];
  includedTotalMinutes: number;
  /** Groups with child detail disclose; own-only groups stay compact lines. */
  disclosable: boolean;
}

function compareContributorRows(
  left: EpicTimeContributorRow,
  right: EpicTimeContributorRow,
): number {
  return left.epicTitle.localeCompare(right.epicTitle) || left.epicId.localeCompare(right.epicId);
}

function compareContributorGroups(
  left: EpicTimeContributorGroup,
  right: EpicTimeContributorGroup,
): number {
  return (
    left.groupEpicTitle.localeCompare(right.groupEpicTitle) ||
    left.groupEpicId.localeCompare(right.groupEpicId)
  );
}

type GroupedEpicTimeTaskItem = EpicTimeTaskItem & {
  groupEpicId: string;
  groupEpicTitle: string;
};

function hasContributorGroupMetadata(item: EpicTimeTaskItem): item is GroupedEpicTimeTaskItem {
  return (
    typeof item.groupEpicId === 'string' &&
    item.groupEpicId.length > 0 &&
    typeof item.groupEpicTitle === 'string'
  );
}

/**
 * Partitions estimate task items into display-owner groups: the requested
 * focal's group first, then related groups sorted by title and Epic ID. Own
 * activity is the row whose epicId equals the group id. Returns null when
 * any row lacks the valid group pair — the caller then renders the legacy
 * flat list and claims no relationship.
 */
export function groupEpicTimeContributors(
  taskItems: readonly EpicTimeTaskItem[],
  focalEpicId: string,
): EpicTimeContributorGroup[] | null {
  if (taskItems.length === 0) {
    return null;
  }
  const rowsByGroup = new Map<string, { title: string; rows: EpicTimeContributorRow[] }>();
  for (const item of taskItems) {
    if (!hasContributorGroupMetadata(item)) {
      return null;
    }
    const row: EpicTimeContributorRow = {
      epicId: item.epicId,
      epicTitle: item.epicTitle,
      minutes: item.minutes,
    };
    const group = rowsByGroup.get(item.groupEpicId);
    if (group) {
      group.rows.push(row);
    } else {
      rowsByGroup.set(item.groupEpicId, { title: item.groupEpicTitle, rows: [row] });
    }
  }
  const groups: EpicTimeContributorGroup[] = [];
  for (const [groupEpicId, group] of rowsByGroup) {
    const ownActivity = group.rows.find((row) => row.epicId === groupEpicId) ?? null;
    const children = group.rows
      .filter((row) => row.epicId !== groupEpicId)
      .sort(compareContributorRows);
    groups.push({
      groupEpicId,
      groupEpicTitle: group.title,
      isFocal: groupEpicId === focalEpicId,
      ownActivity,
      children,
      includedTotalMinutes:
        (ownActivity?.minutes ?? 0) + children.reduce((total, row) => total + row.minutes, 0),
      disclosable: children.length > 0,
    });
  }
  const focal = groups.filter((group) => group.isFocal);
  const related = groups.filter((group) => !group.isFocal).sort(compareContributorGroups);
  return [...focal, ...related];
}
