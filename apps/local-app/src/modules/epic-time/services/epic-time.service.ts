import { Injectable } from '@nestjs/common';
import { NotFoundError, ValidationError } from '../../../common/errors/error-types';
import type {
  AgentTimeBufferAssignmentInput,
  AgentTimeBufferAssignmentResult,
  AgentTimeBufferSnapshot,
  EpicTimeAttributionSource,
  EpicTimeBatchSummary,
  EpicTimeDailyProjection,
  EpicTimeDailyTotal,
  EpicTimeDetailSummary,
  EpicTimeSummaryItem,
  EpicTimeTaskItem,
} from '../models/epic-time.models';
import { canonicalizeEpicTimeZone } from '../models/epic-time-local-day';
import { EventsService } from '../../events/services/events.service';
import { EpicTimeStore, type EpicTimeScope, type EpicTimeSummarySegment } from './epic-time.store';

const MILLIS_PER_MINUTE = 60_000;
const MAX_BATCH_EPICS = 1_000;
const MAX_ERROR_IDS = 20;

interface TimeGroup {
  activityDate: string;
  agentId: string;
  latestName: string;
  latestLastActivityAt: string;
  latestUpdatedAt: string;
  latestSegmentId: string;
  sources: Map<string, SourceGroup>;
}

interface SourceGroup {
  attributionSource: EpicTimeAttributionSource;
  teamId: string | null;
  latestTeamName: string | null;
  durationMs: number;
  latestLastActivityAt: string;
  latestUpdatedAt: string;
  latestSegmentId: string;
}

interface TaskShare {
  epicId: string;
  epicTitle: string;
  groupEpicId: string;
  groupEpicTitle: string;
  isDirect: boolean;
  durationMs: number;
}

interface ResolvedDetailScope {
  scope: EpicTimeScope;
  segments: EpicTimeSummarySegment[];
  routedRootIdsByFocal: Map<string, string[]>;
}

@Injectable()
export class EpicTimeService {
  constructor(
    private readonly store: EpicTimeStore,
    private readonly eventsService: EventsService,
  ) {}

  /** Pass-through of the one project-scoped storage read; the projection is safe by construction. */
  getAgentTimeBuffers(projectId: string): AgentTimeBufferSnapshot {
    return this.store.listAgentTimeBuffers(projectId);
  }

  /**
   * Manual buffer assignment. The store transaction commits or rolls back
   * atomically before this resolves; only then does the transient scope
   * invalidation hint fire, so realtime consumers never see the hint for a
   * write that did not land.
   */
  async assignAgentTimeBuffer(
    input: AgentTimeBufferAssignmentInput,
  ): Promise<AgentTimeBufferAssignmentResult> {
    const result = await this.store.assignAgentTimeBuffer(input);
    await this.eventsService.publish('epic.time.scope.invalidated', {
      workspaceId: result.workspaceId,
    });
    return result;
  }

  getDetail(epicId: string, timeZone: string): EpicTimeDetailSummary {
    const formatter = this.createDateFormatter(timeZone);
    const { scope, segments, routedRootIdsByFocal } = this.loadResolvedDetail(epicId);
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
      includesRelatedTime:
        scope.parentId === null && (routedRootIdsByFocal.get(epicId)?.length ?? 0) > 0,
      items: totalItems,
      taskItems: this.allocateTaskItems(epicId, segments, formatter),
    };
  }

  /**
   * Daily estimate projection over the same resolved segments and
   * whole-minute quantization as getDetail, from one resolved-scope read.
   */
  getDailyProjection(epicId: string, timeZone: string): EpicTimeDailyProjection {
    const canonical = this.requireCanonicalZone(timeZone);
    const formatter = this.createDateFormatter(timeZone);
    const { segments } = this.loadResolvedDetail(epicId);
    const items = this.quantize(segments, formatter);
    const minutesByDate = new Map<string, number>();
    for (const item of items) {
      minutesByDate.set(
        item.activityDate,
        (minutesByDate.get(item.activityDate) ?? 0) + item.minutes,
      );
    }
    const currentByDate: EpicTimeDailyTotal[] = [...minutesByDate.entries()]
      .map(([activityDate, minutes]) => ({ activityDate, minutes }))
      .sort((left, right) => left.activityDate.localeCompare(right.activityDate));
    return {
      canonicalTimeZone: canonical,
      totalMinutes: this.sumMinutes(items),
      currentByDate,
    };
  }

  getBatch(epicIds: string[], timeZone: string): EpicTimeBatchSummary {
    const formatter = this.createDateFormatter(timeZone);
    this.validateBatchInput(epicIds);
    const scopes = this.store.getEpicTimeScopes(epicIds);
    const scopesById = new Map(scopes.map((scope) => [scope.id, scope]));
    const invalidIds = epicIds.filter((id) => !scopesById.has(id));
    if (invalidIds.length > 0) {
      throw new ValidationError('Batch time summaries require existing Epics.', {
        invalidCount: invalidIds.length,
        invalidEpicIds: invalidIds.slice(0, MAX_ERROR_IDS),
      });
    }

    const { segments } = this.store.listResolvedScope(epicIds);
    const segmentsByFocal = new Map<string, EpicTimeSummarySegment[]>();
    for (const segment of segments) {
      // rootEpicId is the focal ID of this batch request, so a sub-Epic
      // focal groups its own segments even while it also rolls up under a
      // root focal in the same result.
      const focalEpicId = segment.rootEpicId;
      if (!focalEpicId) {
        continue;
      }
      const group = segmentsByFocal.get(focalEpicId) ?? [];
      group.push(segment);
      segmentsByFocal.set(focalEpicId, group);
    }
    return {
      items: epicIds.map((epicId) => ({
        epicId,
        totalMinutes: this.sumMinutes(this.quantize(segmentsByFocal.get(epicId) ?? [], formatter)),
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
      let group = groups.get(key);
      if (!group) {
        group = {
          activityDate,
          agentId: segment.agentId,
          latestName: segment.agentName,
          latestLastActivityAt: segment.lastActivityAt,
          latestUpdatedAt: segment.updatedAt,
          latestSegmentId: segment.id,
          sources: new Map(),
        };
        groups.set(key, group);
      } else if (this.isLaterSnapshot(segment, group)) {
        group.latestName = segment.agentName;
        group.latestLastActivityAt = segment.lastActivityAt;
        group.latestUpdatedAt = segment.updatedAt;
        group.latestSegmentId = segment.id;
      }

      const isTeam =
        segment.attributionSource === 'team' &&
        Boolean(segment.teamId) &&
        Boolean(segment.teamName);
      const attributionSource: EpicTimeAttributionSource = isTeam ? 'team' : 'direct';
      const teamId = attributionSource === 'team' ? segment.teamId : null;
      const sourceKey = `${attributionSource}\u0000${teamId ?? ''}`;
      const source = group.sources.get(sourceKey);
      if (!source) {
        group.sources.set(sourceKey, {
          attributionSource,
          teamId,
          latestTeamName: attributionSource === 'team' ? segment.teamName : null,
          durationMs: segment.durationMs,
          latestLastActivityAt: segment.lastActivityAt,
          latestUpdatedAt: segment.updatedAt,
          latestSegmentId: segment.id,
        });
      } else {
        source.durationMs += segment.durationMs;
        if (this.isLaterSnapshot(segment, source)) {
          source.latestTeamName = attributionSource === 'team' ? segment.teamName : null;
          source.latestLastActivityAt = segment.lastActivityAt;
          source.latestUpdatedAt = segment.updatedAt;
          source.latestSegmentId = segment.id;
        }
      }
    }

    const items: EpicTimeSummaryItem[] = [];
    for (const group of groups.values()) {
      const allocations = this.allocateWholeMinutes([...group.sources.values()], (left, right) =>
        this.compareSources(left, right),
      );
      allocations.sort((left, right) => this.compareSources(left, right));
      for (const allocation of allocations) {
        if (allocation.minutes === 0) {
          continue;
        }
        items.push({
          activityDate: group.activityDate,
          agentId: group.agentId,
          agentName: group.latestName,
          attributionSource: allocation.attributionSource,
          teamId: allocation.teamId,
          teamName: allocation.latestTeamName,
          minutes: allocation.minutes,
        });
      }
    }

    return items.sort(
      (left, right) =>
        right.activityDate.localeCompare(left.activityDate) ||
        left.agentId.localeCompare(right.agentId) ||
        this.compareSources(left, right),
    );
  }

  private allocateWholeMinutes<T extends { durationMs: number }>(
    entries: readonly T[],
    compareTies: (left: T, right: T) => number,
  ): Array<T & { minutes: number }> {
    const allocations = entries.map((entry) => ({
      ...entry,
      minutes: Math.floor(entry.durationMs / MILLIS_PER_MINUTE),
      remainderMs: entry.durationMs % MILLIS_PER_MINUTE,
    }));
    const bucketMinutes = Math.floor(
      allocations.reduce((total, entry) => total + entry.durationMs, 0) / MILLIS_PER_MINUTE,
    );
    let remainingMinutes =
      bucketMinutes - allocations.reduce((total, entry) => total + entry.minutes, 0);
    allocations.sort(
      (left, right) => right.remainderMs - left.remainderMs || compareTies(left, right),
    );
    for (const allocation of allocations) {
      if (remainingMinutes <= 0) {
        break;
      }
      allocation.minutes += 1;
      remainingMinutes -= 1;
    }
    return allocations;
  }

  private isLaterSnapshot(
    segment: EpicTimeSummarySegment,
    group: Pick<
      TimeGroup | SourceGroup,
      'latestLastActivityAt' | 'latestUpdatedAt' | 'latestSegmentId'
    >,
  ): boolean {
    return (
      segment.lastActivityAt > group.latestLastActivityAt ||
      (segment.lastActivityAt === group.latestLastActivityAt &&
        (segment.updatedAt > group.latestUpdatedAt ||
          (segment.updatedAt === group.latestUpdatedAt && segment.id > group.latestSegmentId)))
    );
  }

  private compareSources(
    left: Pick<EpicTimeSummaryItem, 'attributionSource' | 'teamId'>,
    right: Pick<EpicTimeSummaryItem, 'attributionSource' | 'teamId'>,
  ): number {
    return (
      (left.attributionSource ?? 'direct').localeCompare(right.attributionSource ?? 'direct') ||
      (left.teamId ?? '').localeCompare(right.teamId ?? '')
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
          groupEpicId: segment.groupEpicId,
          groupEpicTitle: segment.groupEpicTitle,
          isDirect: segment.isDirect,
          durationMs: segment.durationMs,
        });
      }
      buckets.set(bucketKey, shares);
    }

    const totals = new Map<string, EpicTimeTaskItem>();
    for (const shares of buckets.values()) {
      const allocations = this.allocateWholeMinutes([...shares.values()], (left, right) =>
        left.epicId.localeCompare(right.epicId),
      );
      for (const allocation of allocations) {
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
            groupEpicId: allocation.groupEpicId,
            groupEpicTitle: allocation.groupEpicTitle,
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

  /** One resolved-scope database read shared by detail and the estimate projection. */
  private loadResolvedDetail(epicId: string): ResolvedDetailScope {
    const scope = this.store.getEpicTimeScope(epicId);
    if (!scope) {
      throw new NotFoundError('Epic', epicId);
    }
    const { segments, routedRootIdsByFocal } = this.store.listResolvedScope([epicId]);
    return { scope, segments, routedRootIdsByFocal };
  }

  private requireCanonicalZone(timeZone: string): string {
    const canonical = canonicalizeEpicTimeZone(timeZone);
    if (!canonical) {
      throw new ValidationError('A valid IANA time zone is required.');
    }
    return canonical;
  }

  private createDateFormatter(timeZone: string): Intl.DateTimeFormat {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: this.requireCanonicalZone(timeZone),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
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
