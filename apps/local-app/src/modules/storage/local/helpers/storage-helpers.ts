import type { ListOptions } from '../../interfaces/storage.interface';
import { ValidationError } from '../../../../common/errors/error-types';
import { createLogger } from '../../../../common/logging/logger';

const logger = createLogger('StorageHelpers');
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const COMMUNITY_SOURCE_NAME_PATTERN = /^[a-z0-9-]+$/;
export const RESERVED_COMMUNITY_SOURCE_NAMES = new Set([
  'anthropic',
  'openai',
  'microsoft',
  'trailofbits',
  'vercel',
]);

export interface NormalizedListOptions {
  limit: number;
  offset: number;
  orderBy?: string;
  orderDirection: 'asc' | 'desc';
}

export function validateUuid(value: string, fieldName = 'id'): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new ValidationError(`${fieldName} is required.`, { fieldName });
  }
  if (!UUID_PATTERN.test(normalized)) {
    throw new ValidationError(`${fieldName} must be a valid UUID.`, {
      fieldName,
      value: normalized,
    });
  }
  return normalized;
}

export function normalizeListOptions(
  options: ListOptions = {},
  defaults: { limit?: number; offset?: number; maxLimit?: number } = {},
): NormalizedListOptions {
  const baseLimit = defaults.limit ?? 100;
  const baseOffset = defaults.offset ?? 0;
  const maxLimit = defaults.maxLimit ?? 500;
  const requestedLimit = Number(options.limit ?? baseLimit);
  const requestedOffset = Number(options.offset ?? baseOffset);

  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(Math.floor(requestedLimit), maxLimit))
    : baseLimit;
  const offset = Number.isFinite(requestedOffset) ? Math.max(0, Math.floor(requestedOffset)) : 0;

  return {
    limit,
    offset,
    orderBy: options.orderBy,
    orderDirection: options.orderDirection === 'desc' ? 'desc' : 'asc',
  };
}

export function parseJsonSafe<T>(value: string | null | undefined, fallback: T): T {
  if (!value) {
    return fallback;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function extractSearchFilter(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const normalized = value.trim();
  return normalized || null;
}

/**
 * Safely parse provider config env JSON.
 * Returns null for null/undefined input.
 * Throws ValidationError with context on parse failure.
 */
export function parseProviderConfigEnv(
  envJson: string | null | undefined,
  configId: string,
  profileId: string,
): Record<string, string> | null {
  if (!envJson) {
    return null;
  }

  try {
    const parsed = JSON.parse(envJson);
    // Validate it's a Record<string, string>
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('env must be an object');
    }
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== 'string') {
        throw new Error(`env["${key}"] must be a string, got ${typeof value}`);
      }
    }
    return parsed as Record<string, string>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(
      { configId, profileId, error: message },
      'Failed to parse provider config env JSON',
    );
    throw new ValidationError(`Invalid JSON in provider config env field: ${message}`, {
      configId,
      profileId,
      rawValue: envJson.slice(0, 100) + (envJson.length > 100 ? '...' : ''),
    });
  }
}

export function parseProviderEnv(
  envJson: string | null | undefined,
  providerId: string,
): Record<string, string> | null {
  if (!envJson) {
    return null;
  }

  try {
    const parsed = JSON.parse(envJson);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('env must be an object');
    }
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== 'string') {
        throw new Error(`env["${key}"] must be a string, got ${typeof value}`);
      }
    }
    return parsed as Record<string, string>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn({ providerId, error: message }, 'Failed to parse provider env JSON');
    throw new ValidationError(`Invalid JSON in provider env field: ${message}`, {
      providerId,
      rawValue: envJson.slice(0, 100) + (envJson.length > 100 ? '...' : ''),
    });
  }
}

export function normalizeEnvForStorage(
  env: Record<string, string> | null | undefined,
): string | null {
  if (env === null || env === undefined) {
    return null;
  }
  if (Object.keys(env).length === 0) {
    return null;
  }
  return JSON.stringify(env);
}

export function parseSkillsRequired(raw: unknown): string[] | null {
  if (raw === null || raw === undefined) {
    return null;
  }

  if (Array.isArray(raw)) {
    if (raw.every((value) => typeof value === 'string')) {
      return raw;
    }
    return null;
  }

  if (typeof raw !== 'string') {
    return null;
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = parseJsonSafe<unknown>(trimmed, null);
  return Array.isArray(parsed) && parsed.every((value) => typeof value === 'string')
    ? (parsed as string[])
    : null;
}

export function serializeSkillsRequired(
  skillsRequired: string[] | null | undefined,
): string | null {
  if (skillsRequired === null || skillsRequired === undefined) {
    return null;
  }
  return JSON.stringify(skillsRequired);
}

export function normalizeCommunitySourceName(name: string): string {
  const normalized = name.trim().toLowerCase();
  if (!normalized) {
    throw new ValidationError('name is required.', { fieldName: 'name' });
  }
  if (!COMMUNITY_SOURCE_NAME_PATTERN.test(normalized)) {
    throw new ValidationError(
      'Invalid community source name. Use lowercase letters, numbers, and hyphens only.',
      { name: normalized },
    );
  }
  if (RESERVED_COMMUNITY_SOURCE_NAMES.has(normalized)) {
    throw new ValidationError('Community source name conflicts with a built-in source.', {
      name: normalized,
    });
  }
  return normalized;
}

export function normalizeCommunitySourceNameForLookup(name: string): string {
  const normalized = name.trim().toLowerCase();
  if (!normalized) {
    throw new ValidationError('name is required.', { fieldName: 'name' });
  }
  if (!COMMUNITY_SOURCE_NAME_PATTERN.test(normalized)) {
    throw new ValidationError(
      'Invalid community source name. Use lowercase letters, numbers, and hyphens only.',
      { name: normalized },
    );
  }
  return normalized;
}

export function normalizeCommunityRepoPart(
  value: string,
  fieldName: 'repoOwner' | 'repoName',
): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    throw new ValidationError(`${fieldName} is required.`, { fieldName });
  }
  return normalized;
}

export function normalizeCommunityBranch(branch: string | undefined): string {
  const normalized = (branch ?? 'main').trim();
  if (!normalized) {
    throw new ValidationError('branch is required.', { fieldName: 'branch' });
  }
  return normalized;
}

export function normalizeLocalSkillSourceFolderPath(folderPath: string): string {
  const normalized = folderPath.trim();
  if (!normalized) {
    throw new ValidationError('folderPath is required.', { fieldName: 'folderPath' });
  }
  return normalized;
}

export function normalizeProjectIdForSourceEnablement(projectId: string): string {
  const normalized = projectId.trim();
  if (!normalized) {
    throw new ValidationError('projectId is required.', { fieldName: 'projectId' });
  }
  return normalized;
}

export function normalizeSourceNameForSourceEnablement(sourceName: string): string {
  const normalized = sourceName.trim().toLowerCase();
  if (!normalized) {
    throw new ValidationError('sourceName is required.', { fieldName: 'sourceName' });
  }
  return normalized;
}

export function isSqliteUniqueConstraint(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const code = 'code' in error ? (error as { code?: unknown }).code : undefined;
  const message = 'message' in error ? (error as { message?: unknown }).message : undefined;
  const normalizedMessage = typeof message === 'string' ? message : '';
  return (
    code === 'SQLITE_CONSTRAINT' ||
    code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    code === 19 ||
    normalizedMessage.includes('UNIQUE constraint failed')
  );
}

export function extractPromptId(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value === 'object') {
    if ('initialSessionPromptId' in (value as Record<string, unknown>)) {
      return extractPromptId(
        (value as { initialSessionPromptId?: unknown }).initialSessionPromptId,
      );
    }
    if ('value' in (value as Record<string, unknown>)) {
      return extractPromptId((value as { value?: unknown }).value);
    }
    return null;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    try {
      const parsed = JSON.parse(trimmed);
      return extractPromptId(parsed);
    } catch {
      // not JSON encoded
    }

    if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
      return trimmed.slice(1, -1).trim() || null;
    }

    return trimmed;
  }

  return String(value).trim() || null;
}

export function extractPromptIdFromMap(value: unknown, projectId: string | null): string | null {
  try {
    const obj = typeof value === 'string' ? JSON.parse(value) : value;
    if (obj && typeof obj === 'object') {
      const map = obj as Record<string, unknown>;
      if (projectId && typeof map[projectId] === 'string') {
        const selectedPromptId = (map[projectId] as string).trim();
        return selectedPromptId || null;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

export function normalizeTagList(tags?: string[]): string[] {
  if (!tags?.length) {
    return [];
  }

  const unique = new Set<string>();
  for (const tag of tags) {
    const trimmed = tag.trim();
    if (trimmed) {
      unique.add(trimmed);
    }
  }

  return Array.from(unique);
}

export function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}
