import { Injectable } from '@nestjs/common';
import { NotFoundError, ValidationError } from '../../../common/errors/error-types';
import type {
  EpicTimeBatchSummary,
  EpicTimeDetailSummary,
  EpicTimeSummaryItem,
  EpicTimeTaskItem,
} from '../models/epic-time.models';
import { EpicTimeStore, type EpicTimeSummarySegment } from './epic-time.store';

const MILLIS_PER_MINUTE = 60_000;
const MAX_BATCH_EPICS = 1_000;
const MAX_ERROR_IDS = 20;

interface TimeGroup {
  activityDate: string;
  agentId: string;
  durationMs: number;
  latestName: string;
  latestLastActivityAt: string;
  latestUpdatedAt: string;
  latestSegmentId: string;
}

interface TaskShare {
  epicId: string;
  epicTitle: string;
  isDirect: boolean;
  durationMs: number;
}

@Injectable()
export class EpicTimeService {
  constructor(private readonly store: EpicTimeStore) {}

  getDetail(epicId: string, timeZone: string): EpicTimeDetailSummary {
    const formatter = this.createDateFormatter(timeZone);
    const scope = this.store.getEpicTimeScope(epicId);
    if (!scope) {
      throw new NotFoundError('Epic', epicId);
    }
    const segments = this.store.listClosedSegmentsForEpic(epicId, scope.parentId === null);
    const totalItems = this.quantize(segments, formatter);
    const directItems = this.quantize(
      segments.filter((segment) => segment.isDirect),
      formatter,
    );
    const totalMinutes = this.sumMinutes(totalItems);
    const directMinutes = this.sumMinutes(directItems);
    return {
      isRoot: scope.parentId === null,
      directMinutes: Math.min(directMinutes, totalMinutes),
      totalMinutes,
      items: totalItems,
      taskItems: this.allocateTaskItems(epicId, segments, formatter),
    };
  }

  getBatch(epicIds: string[], timeZone: string): EpicTimeBatchSummary {
    const formatter = this.createDateFormatter(timeZone);
    this.validateBatchInput(epicIds);
    const roots = this.store.getEpicTimeScopes(epicIds);
    const rootsById = new Map(roots.map((root) => [root.id, root]));
    const invalidIds = epicIds.filter((id) => {
      const root = rootsById.get(id);
      return !root || root.parentId !== null;
    });
    if (invalidIds.length > 0) {
      throw new ValidationError('Batch time summaries require existing root Epics.', {
        invalidCount: invalidIds.length,
        invalidEpicIds: invalidIds.slice(0, MAX_ERROR_IDS),
      });
    }

    const segments = this.store.listClosedSegmentsForRoots(epicIds);
    const segmentsByRoot = new Map<string, EpicTimeSummarySegment[]>();
    for (const segment of segments) {
      const rootEpicId = segment.rootEpicId;
      if (!rootEpicId) {
        continue;
      }
      const group = segmentsByRoot.get(rootEpicId) ?? [];
      group.push(segment);
      segmentsByRoot.set(rootEpicId, group);
    }
    return {
      items: epicIds.map((epicId) => ({
        epicId,
        totalMinutes: this.sumMinutes(this.quantize(segmentsByRoot.get(epicId) ?? [], formatter)),
      })),
    };
  }

  private quantize(
    segments: readonly EpicTimeSummarySegment[],
    formatter: Intl.DateTimeFormat,
  ): EpicTimeSummaryItem[] {
    const groups = new Map<string, TimeGroup>();
    for (const segment of segments) {
      const activityDate = this.formatActivityDate(segment.lastActivityAt, formatter);
      const key = `${activityDate}\u0000${segment.agentId}`;
      const existing = groups.get(key);
      if (!existing) {
        groups.set(key, {
          activityDate,
          agentId: segment.agentId,
          durationMs: segment.durationMs,
          latestName: segment.agentName,
          latestLastActivityAt: segment.lastActivityAt,
          latestUpdatedAt: segment.updatedAt,
          latestSegmentId: segment.id,
        });
        continue;
      }
      existing.durationMs += segment.durationMs;
      if (this.isLaterNameSnapshot(segment, existing)) {
        existing.latestName = segment.agentName;
        existing.latestLastActivityAt = segment.lastActivityAt;
        existing.latestUpdatedAt = segment.updatedAt;
        existing.latestSegmentId = segment.id;
      }
    }

    return [...groups.values()]
      .map((group) => ({
        activityDate: group.activityDate,
        agentId: group.agentId,
        agentName: group.latestName,
        minutes: Math.floor(group.durationMs / MILLIS_PER_MINUTE),
      }))
      .filter((group) => group.minutes > 0)
      .sort(
        (left, right) =>
          right.activityDate.localeCompare(left.activityDate) ||
          left.agentId.localeCompare(right.agentId),
      );
  }

  private isLaterNameSnapshot(segment: EpicTimeSummarySegment, group: TimeGroup): boolean {
    return (
      segment.lastActivityAt > group.latestLastActivityAt ||
      (segment.lastActivityAt === group.latestLastActivityAt &&
        (segment.updatedAt > group.latestUpdatedAt ||
          (segment.updatedAt === group.latestUpdatedAt && segment.id > group.latestSegmentId)))
    );
  }

  private allocateTaskItems(
    requestedEpicId: string,
    segments: readonly EpicTimeSummarySegment[],
    formatter: Intl.DateTimeFormat,
  ): EpicTimeTaskItem[] {
    const buckets = new Map<string, Map<string, TaskShare>>();
    for (const segment of segments) {
      const activityDate = this.formatActivityDate(segment.lastActivityAt, formatter);
      const bucketKey = `${activityDate}\u0000${segment.agentId}`;
      const shares = buckets.get(bucketKey) ?? new Map<string, TaskShare>();
      const existing = shares.get(segment.epicId);
      if (existing) {
        existing.durationMs += segment.durationMs;
      } else {
        shares.set(segment.epicId, {
          epicId: segment.epicId,
          epicTitle: segment.epicTitle,
          isDirect: segment.isDirect,
          durationMs: segment.durationMs,
        });
      }
      buckets.set(bucketKey, shares);
    }

    const totals = new Map<string, EpicTimeTaskItem>();
    for (const shares of buckets.values()) {
      const allocations = [...shares.values()].map((share) => ({
        ...share,
        minutes: Math.floor(share.durationMs / MILLIS_PER_MINUTE),
        remainderMs: share.durationMs % MILLIS_PER_MINUTE,
      }));
      const bucketMinutes = Math.floor(
        allocations.reduce((total, share) => total + share.durationMs, 0) / MILLIS_PER_MINUTE,
      );
      let remainingMinutes =
        bucketMinutes - allocations.reduce((total, share) => total + share.minutes, 0);
      allocations.sort(
        (left, right) =>
          right.remainderMs - left.remainderMs || left.epicId.localeCompare(right.epicId),
      );
      for (const allocation of allocations) {
        if (remainingMinutes > 0) {
          allocation.minutes += 1;
          remainingMinutes -= 1;
        }
        if (allocation.minutes === 0) {
          continue;
        }
        const existing = totals.get(allocation.epicId);
        if (existing) {
          existing.minutes += allocation.minutes;
        } else {
          totals.set(allocation.epicId, {
            epicId: allocation.epicId,
            epicTitle: allocation.epicTitle,
            isDirect: allocation.isDirect,
            minutes: allocation.minutes,
          });
        }
      }
    }

    return [...totals.values()].sort((left, right) => {
      if (left.epicId === requestedEpicId) return -1;
      if (right.epicId === requestedEpicId) return 1;
      return (
        left.epicTitle.localeCompare(right.epicTitle) || left.epicId.localeCompare(right.epicId)
      );
    });
  }

  private formatActivityDate(value: string, formatter: Intl.DateTimeFormat): string {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) {
      throw new Error('Epic time persistence contains an invalid last activity timestamp.');
    }
    const parts = new Map(
      formatter
        .formatToParts(date)
        .filter((part) => part.type === 'year' || part.type === 'month' || part.type === 'day')
        .map((part) => [part.type, part.value]),
    );
    return `${parts.get('year')}-${parts.get('month')}-${parts.get('day')}`;
  }

  private createDateFormatter(timeZone: string): Intl.DateTimeFormat {
    const normalized = timeZone.trim();
    if (!normalized || normalized.length > 128 || /^[+-]\d{2}:?\d{2}$/.test(normalized)) {
      throw new ValidationError('A valid IANA time zone is required.');
    }
    try {
      return new Intl.DateTimeFormat('en-US', {
        timeZone: normalized,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
    } catch {
      throw new ValidationError('A valid IANA time zone is required.');
    }
  }

  private validateBatchInput(epicIds: string[]): void {
    if (epicIds.length === 0 || epicIds.length > MAX_BATCH_EPICS) {
      throw new ValidationError(`Batch time summaries require 1-${MAX_BATCH_EPICS} Epic IDs.`);
    }
    if (new Set(epicIds).size !== epicIds.length) {
      throw new ValidationError('Batch time summary Epic IDs must be unique.');
    }
  }

  private sumMinutes(items: readonly EpicTimeSummaryItem[]): number {
    return items.reduce((total, item) => total + item.minutes, 0);
  }
}
