import type {
  ExternalProviderError,
  ExternalProviderFailureReason,
} from '../errors/external-provider.errors';
import { mapSafeVendorFailure } from '../errors/external-provider.errors';
import {
  MAX_COMMENT_LENGTH,
  MAX_REMOTE_TASK_ID_LENGTH,
  MAX_STATUS_LENGTH,
  MAX_TASK_COMMENT_AUTHOR_LENGTH,
  MAX_TIME_ENTRY_DURATION_MS,
  MAX_TIME_ENTRY_NOTE_LENGTH,
  type ExternalTaskCommentAuthor,
  type ExternalTaskCommentInput,
  type ExternalTaskStatusInput,
  type ExternalTaskTimeEntryInput,
  type ExternalWorkArea,
} from '../models/external-provider.models';
import { SafeVendorHttpError } from '../transport/safe-vendor-http-client';

export const RECENT_COMPLETED_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;
export const WORK_AREA_METADATA_TTL_MS = 15 * 60 * 1_000;
export const WORK_AREA_METADATA_CACHE_MAX_ENTRIES = 128;
export const VENDOR_DISCOVERY_CONCURRENCY = 4;

export type CachedWorkAreaMetadata = Omit<ExternalWorkArea, 'assignedTaskCount' | 'refresh'>;

export type VendorErrorFactory = (
  reason: Extract<ExternalProviderFailureReason, 'invalid_response' | 'request_rejected'>,
) => ExternalProviderError;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Ascending remote-id order: numeric when both ids are numeric strings
 * (ClickUp and Jira worklog ids), lexicographic otherwise. */
export function compareRemoteIds(left: string, right: string): number {
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
    return Number(left) - Number(right);
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

export const UNKNOWN_COMMENT_AUTHOR_NAME = 'Unknown user';

/** Names the vendor fields a comment author is read from. */
export interface VendorCommentAuthorSpec {
  nameKey: string;
  idKey: string;
  /** ClickUp sends numeric user ids; Jira account ids are always strings. */
  idFormat: 'identifier' | 'string';
}

export interface VendorPayloadValidators {
  requiredString(value: unknown): string;
  requiredIdentifier(value: unknown): string;
  requiredTaskId(value: unknown): string;
  statusInput(input: ExternalTaskStatusInput): string;
  commentInput(input: ExternalTaskCommentInput): void;
  commentAuthor(value: unknown, spec: VendorCommentAuthorSpec): ExternalTaskCommentAuthor;
  timeEntryInput(input: ExternalTaskTimeEntryInput): number;
}

export function createVendorValidators(createError: VendorErrorFactory): VendorPayloadValidators {
  const validators: VendorPayloadValidators = {
    requiredString(value: unknown): string {
      if (typeof value !== 'string' || !value.trim()) {
        throw createError('invalid_response');
      }
      return value.trim();
    },
    requiredIdentifier(value: unknown): string {
      if (
        (typeof value !== 'string' && typeof value !== 'number') ||
        (typeof value === 'number' && !Number.isFinite(value)) ||
        !String(value).trim()
      ) {
        throw createError('invalid_response');
      }
      return String(value).trim();
    },
    requiredTaskId(value: unknown): string {
      if (
        typeof value !== 'string' ||
        !value.trim() ||
        value.trim().length > MAX_REMOTE_TASK_ID_LENGTH
      ) {
        throw createError('request_rejected');
      }
      return value.trim();
    },
    statusInput(input: ExternalTaskStatusInput): string {
      if (typeof input.status !== 'string' || !input.status.trim()) {
        throw createError('request_rejected');
      }
      const status = input.status.trim();
      if (status.length > MAX_STATUS_LENGTH) {
        throw createError('request_rejected');
      }
      return status;
    },
    commentInput(input: ExternalTaskCommentInput): void {
      if (
        typeof input.text !== 'string' ||
        !input.text.trim() ||
        input.text.length > MAX_COMMENT_LENGTH ||
        typeof input.notifyAll !== 'boolean'
      ) {
        throw createError('request_rejected');
      }
    },
    commentAuthor(value: unknown, spec: VendorCommentAuthorSpec): ExternalTaskCommentAuthor {
      // A comment with no author is normal (vendor automations, deleted users);
      // an author that is not an object is a malformed payload.
      if (value === null || value === undefined) {
        return { remoteId: null, displayName: UNKNOWN_COMMENT_AUTHOR_NAME };
      }
      if (!isRecord(value)) {
        throw createError('invalid_response');
      }
      const name = value[spec.nameKey];
      const id = value[spec.idKey];
      return {
        remoteId:
          id === null || id === undefined
            ? null
            : spec.idFormat === 'identifier'
              ? validators.requiredIdentifier(id)
              : validators.requiredString(id),
        displayName:
          typeof name === 'string' && name.trim()
            ? name.trim().slice(0, MAX_TASK_COMMENT_AUTHOR_LENGTH)
            : UNKNOWN_COMMENT_AUTHOR_NAME,
      };
    },
    timeEntryInput(input: ExternalTaskTimeEntryInput): number {
      const startedAt = Date.parse(input.startedAt);
      if (
        !Number.isSafeInteger(startedAt) ||
        !Number.isSafeInteger(input.durationMs) ||
        input.durationMs <= 0 ||
        input.durationMs > MAX_TIME_ENTRY_DURATION_MS ||
        (input.note !== null &&
          (typeof input.note !== 'string' || input.note.length > MAX_TIME_ENTRY_NOTE_LENGTH))
      ) {
        throw createError('request_rejected');
      }
      return startedAt;
    },
  };
  return validators;
}

export interface VendorCacheEntry<T> {
  value: T;
  fetchedAt: number;
}

/**
 * Bounded LRU map for provider metadata. Entries are never dropped by age —
 * expired entries stay retrievable so adapters can serve them as a stale
 * fallback when a refresh fails.
 */
export class VendorMetadataCache<T> {
  private readonly entries = new Map<string, VendorCacheEntry<T>>();

  constructor(private readonly maxEntries: number) {}

  get(key: string): VendorCacheEntry<T> | undefined {
    const entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    return entry;
  }

  set(key: string, entry: VendorCacheEntry<T>): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) {
        break;
      }
      this.entries.delete(oldest);
    }
  }
}

export function vendorRetryAt(error: ExternalProviderError): string | null {
  return typeof error.details?.retryAt === 'string' ? error.details.retryAt : null;
}

export function mapVendorTransportError(
  error: unknown,
  createError: (
    reason: ExternalProviderFailureReason,
    retryAt?: string,
    dispatched?: boolean,
  ) => ExternalProviderError,
): ExternalProviderError {
  if (error instanceof SafeVendorHttpError) {
    return createError(mapSafeVendorFailure(error), error.retryAt, error.dispatched);
  }
  return createError('unavailable');
}

export function materializeWorkArea(
  metadata: CachedWorkAreaMetadata,
  assignedTaskCount: number,
  refresh: ExternalWorkArea['refresh'],
): ExternalWorkArea {
  return {
    ...metadata,
    hierarchy: metadata.hierarchy.map((location) => ({ ...location })),
    workflow: {
      isOverridden: metadata.workflow.isOverridden,
      columns: metadata.workflow.columns.map((column) => ({
        ...column,
        ...(column.remoteStatusIds ? { remoteStatusIds: [...column.remoteStatusIds] } : {}),
      })),
    },
    assignedTaskCount,
    refresh,
  };
}

/**
 * Order-preserving concurrent map, bounded so parallel vendor fan-outs stay
 * within the SafeVendorHttpClient request queue.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  map: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let failed = false;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (!failed && nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = await map(items[index]!, index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  });
  await Promise.all(workers);
  return results;
}
