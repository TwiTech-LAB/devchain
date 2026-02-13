export type SkillStatus = 'available' | 'outdated' | 'sync_error';

export type SkillCategory =
  | 'security'
  | 'testing'
  | 'deployment'
  | 'documents'
  | 'design'
  | 'integration'
  | 'creative'
  | 'communication'
  | 'development';

export interface Skill {
  id: string;
  slug: string;
  name: string;
  displayName: string;
  description: string | null;
  shortDescription: string | null;
  source: string;
  sourceUrl: string | null;
  sourceCommit: string | null;
  category: string | null;
  license: string | null;
  compatibility: string | null;
  frontmatter: Record<string, unknown> | null;
  instructionContent: string | null;
  contentPath: string | null;
  resources: string[];
  status: SkillStatus;
  lastSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type SkillSummary = Pick<
  Skill,
  | 'id'
  | 'slug'
  | 'name'
  | 'displayName'
  | 'description'
  | 'shortDescription'
  | 'source'
  | 'category'
  | 'status'
  | 'lastSyncedAt'
>;

export interface SkillSyncError {
  sourceName: string;
  skillSlug?: string;
  message: string;
}

export interface SkillSyncResult {
  status: 'completed' | 'already_running';
  added: number;
  updated: number;
  removed: number;
  failed: number;
  unchanged: number;
  errors: SkillSyncError[];
}

export type SkillListItem = SkillSummary & { disabled: boolean };

export type SkillSourceKind = 'builtin' | 'community' | 'local';

export interface SkillSource {
  name: string;
  kind: SkillSourceKind;
  enabled: boolean;
  projectEnabled?: boolean;
  repoUrl: string;
  folderPath?: string;
  skillCount: number;
}

export interface CommunitySource {
  id: string;
  name: string;
  repoOwner: string;
  repoName: string;
  branch: string;
  createdAt: string;
  updatedAt: string;
}

export interface LocalSource {
  id: string;
  name: string;
  folderPath: string;
  createdAt: string;
  updatedAt: string;
}

export interface AddCommunitySourceInput {
  name: string;
  url?: string;
  repoOwner?: string;
  repoName?: string;
  branch?: string;
}

export interface AddLocalSourceInput {
  name: string;
  folderPath: string;
}

export interface SkillUsageStat {
  skillId: string;
  skillSlug: string;
  usageCount: number;
  firstAccessedAt: string | null;
  lastAccessedAt: string | null;
  skillName: string | null;
  skillDisplayName: string | null;
}

export interface SkillUsageLogEntry {
  id: string;
  skillId: string;
  skillSlug: string;
  projectId: string | null;
  agentId: string | null;
  agentNameSnapshot: string | null;
  accessedAt: string;
}

export interface SkillUsageLogResponse {
  items: SkillUsageLogEntry[];
  total: number;
  limit: number;
  offset: number;
}

export interface SkillUsageStatsQuery {
  projectId?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export interface SkillUsageLogQuery extends SkillUsageStatsQuery {
  skillId?: string;
  agentId?: string;
}

export interface SkillCategoryConfig {
  label: string;
  badgeClassName: string;
}

export const SKILL_CATEGORY_CONFIG: Record<SkillCategory, SkillCategoryConfig> = {
  security: {
    label: 'Security',
    badgeClassName: 'border-red-200 bg-red-50 text-red-800',
  },
  testing: {
    label: 'Testing',
    badgeClassName: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  },
  deployment: {
    label: 'Deployment',
    badgeClassName: 'border-sky-200 bg-sky-50 text-sky-800',
  },
  documents: {
    label: 'Documents',
    badgeClassName: 'border-amber-200 bg-amber-50 text-amber-800',
  },
  design: {
    label: 'Design',
    badgeClassName: 'border-rose-200 bg-rose-50 text-rose-800',
  },
  integration: {
    label: 'Integration',
    badgeClassName: 'border-cyan-200 bg-cyan-50 text-cyan-800',
  },
  creative: {
    label: 'Creative',
    badgeClassName: 'border-orange-200 bg-orange-50 text-orange-800',
  },
  communication: {
    label: 'Communication',
    badgeClassName: 'border-lime-200 bg-lime-50 text-lime-800',
  },
  development: {
    label: 'Development',
    badgeClassName: 'border-slate-200 bg-slate-50 text-slate-800',
  },
};

export const SKILL_CATEGORY_LABELS: Record<SkillCategory, string> = Object.fromEntries(
  Object.entries(SKILL_CATEGORY_CONFIG).map(([key, config]) => [key, config.label]),
) as Record<SkillCategory, string>;

export const SKILL_CATEGORY_BADGE_COLORS: Record<SkillCategory, string> = Object.fromEntries(
  Object.entries(SKILL_CATEGORY_CONFIG).map(([key, config]) => [key, config.badgeClassName]),
) as Record<SkillCategory, string>;

function normalizeCategory(category?: string | null): SkillCategory {
  const normalized = category?.trim().toLowerCase();
  if (!normalized) {
    return 'development';
  }

  if (normalized in SKILL_CATEGORY_CONFIG) {
    return normalized as SkillCategory;
  }

  return 'development';
}

export function getSkillCategoryConfig(category?: string | null): SkillCategoryConfig {
  return SKILL_CATEGORY_CONFIG[normalizeCategory(category)];
}

export function getSkillCategoryLabel(category?: string | null): string {
  return getSkillCategoryConfig(category).label;
}

export function getSkillCategoryBadgeClassName(category?: string | null): string {
  return getSkillCategoryConfig(category).badgeClassName;
}

async function readApiErrorMessage(response: Response, fallback: string): Promise<string> {
  const payload = await response.json().catch(() => null);
  if (
    payload &&
    typeof payload === 'object' &&
    'message' in payload &&
    typeof payload.message === 'string' &&
    payload.message.trim().length > 0
  ) {
    return payload.message;
  }

  return fallback;
}

async function fetchJsonOrThrow<T>(
  url: string,
  options: RequestInit,
  fallbackError: string,
): Promise<T> {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(await readApiErrorMessage(response, fallbackError));
  }

  return response.json() as Promise<T>;
}

function appendQueryParam(params: URLSearchParams, key: string, value?: string): void {
  if (typeof value !== 'string') {
    return;
  }

  const normalized = value.trim();
  if (normalized.length > 0) {
    params.set(key, normalized);
  }
}

function appendNumericQueryParam(params: URLSearchParams, key: string, value?: number): void {
  if (typeof value === 'number' && Number.isFinite(value)) {
    params.set(key, String(value));
  }
}

/**
 * Fetch skills list with optional project scoping and filters.
 */
export async function fetchSkills(
  projectId: string,
  q?: string,
  source?: string,
  category?: string,
): Promise<SkillListItem[]> {
  const params = new URLSearchParams();
  appendQueryParam(params, 'projectId', projectId);
  appendQueryParam(params, 'q', q);
  appendQueryParam(params, 'source', source);
  appendQueryParam(params, 'category', category);

  const query = params.toString();
  const url = query ? `/api/skills?${query}` : '/api/skills';
  return fetchJsonOrThrow<SkillListItem[]>(url, {}, 'Failed to fetch skills');
}

/**
 * Fetch full skill data by ID.
 */
export async function fetchSkill(id: string): Promise<Skill> {
  return fetchJsonOrThrow<Skill>(
    `/api/skills/${encodeURIComponent(id)}`,
    {},
    'Failed to fetch skill',
  );
}

/**
 * Fetch full skill data by source + name slug parts.
 */
export async function fetchSkillBySlug(source: string, name: string): Promise<Skill> {
  return fetchJsonOrThrow<Skill>(
    `/api/skills/by-slug/${encodeURIComponent(source)}/${encodeURIComponent(name)}`,
    {},
    'Failed to fetch skill by slug',
  );
}

/**
 * Resolve multiple skill slugs into summary payloads keyed by slug.
 */
export async function resolveSkillSlugs(slugs: string[]): Promise<Record<string, SkillSummary>> {
  const normalizedSlugs = Array.from(
    new Set(slugs.map((slug) => slug.trim().toLowerCase()).filter((slug) => slug.length > 0)),
  );
  if (normalizedSlugs.length === 0) {
    return {};
  }

  return fetchJsonOrThrow<Record<string, SkillSummary>>(
    '/api/skills/resolve',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slugs: normalizedSlugs }),
    },
    'Failed to resolve skills',
  );
}

/**
 * Trigger skills sync for all sources (or one specific source).
 */
export async function triggerSync(sourceName?: string): Promise<SkillSyncResult> {
  const payload = sourceName ? { sourceName } : {};
  return fetchJsonOrThrow<SkillSyncResult>(
    '/api/skills/sync',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
    'Failed to trigger skills sync',
  );
}

/**
 * Fetch source metadata with optional project-scoped enablement state.
 */
export async function fetchSources(projectId?: string): Promise<SkillSource[]> {
  const params = new URLSearchParams();
  appendQueryParam(params, 'projectId', projectId);
  const query = params.toString();
  const url = query ? `/api/skills/sources?${query}` : '/api/skills/sources';

  return fetchJsonOrThrow<SkillSource[]>(url, {}, 'Failed to fetch skill sources');
}

/**
 * Fetch all community skill sources.
 */
export async function fetchCommunitySources(): Promise<CommunitySource[]> {
  return fetchJsonOrThrow<CommunitySource[]>(
    '/api/skills/community-sources',
    {},
    'Failed to fetch community skill sources',
  );
}

/**
 * Add a community skill source.
 */
export async function addCommunitySource(
  payload: AddCommunitySourceInput,
): Promise<CommunitySource> {
  return fetchJsonOrThrow<CommunitySource>(
    '/api/skills/community-sources',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
    'Failed to add community source',
  );
}

/**
 * Remove a community skill source.
 */
export async function removeCommunitySource(id: string): Promise<void> {
  await fetchJsonOrThrow<{ success: boolean }>(
    `/api/skills/community-sources/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
    'Failed to remove community source',
  );
}

/**
 * Fetch all local skill sources.
 */
export async function fetchLocalSources(): Promise<LocalSource[]> {
  return fetchJsonOrThrow<LocalSource[]>(
    '/api/skills/local-sources',
    {},
    'Failed to fetch local skill sources',
  );
}

/**
 * Add a local skill source.
 */
export async function addLocalSource(payload: AddLocalSourceInput): Promise<LocalSource> {
  return fetchJsonOrThrow<LocalSource>(
    '/api/skills/local-sources',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
    'Failed to add local source',
  );
}

/**
 * Remove a local skill source.
 */
export async function removeLocalSource(id: string): Promise<void> {
  await fetchJsonOrThrow<{ success: boolean }>(
    `/api/skills/local-sources/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
    'Failed to remove local source',
  );
}

/**
 * Enable a skill source globally.
 */
export async function enableSource(
  sourceName: string,
): Promise<{ name: string; enabled: boolean }> {
  return fetchJsonOrThrow<{ name: string; enabled: boolean }>(
    `/api/skills/sources/${encodeURIComponent(sourceName)}/enable`,
    { method: 'POST' },
    'Failed to enable skill source',
  );
}

/**
 * Disable a skill source globally.
 */
export async function disableSource(
  sourceName: string,
): Promise<{ name: string; enabled: boolean }> {
  return fetchJsonOrThrow<{ name: string; enabled: boolean }>(
    `/api/skills/sources/${encodeURIComponent(sourceName)}/disable`,
    { method: 'POST' },
    'Failed to disable skill source',
  );
}

/**
 * Enable a skill source for a project.
 */
export async function enableSourceForProject(
  sourceName: string,
  projectId: string,
): Promise<{ name: string; projectId: string; projectEnabled: boolean }> {
  return fetchJsonOrThrow<{ name: string; projectId: string; projectEnabled: boolean }>(
    `/api/skills/sources/${encodeURIComponent(sourceName)}/enable-project`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId }),
    },
    'Failed to enable skill source for project',
  );
}

/**
 * Disable a skill source for a project.
 */
export async function disableSourceForProject(
  sourceName: string,
  projectId: string,
): Promise<{ name: string; projectId: string; projectEnabled: boolean }> {
  return fetchJsonOrThrow<{ name: string; projectId: string; projectEnabled: boolean }>(
    `/api/skills/sources/${encodeURIComponent(sourceName)}/disable-project`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId }),
    },
    'Failed to disable skill source for project',
  );
}

/**
 * Disable a skill for a project.
 */
export async function disableSkill(
  projectId: string,
  skillId: string,
): Promise<{ projectId: string; skillId: string }> {
  return fetchJsonOrThrow<{ projectId: string; skillId: string }>(
    `/api/skills/${encodeURIComponent(skillId)}/disable`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId }),
    },
    'Failed to disable skill',
  );
}

/**
 * Enable a skill for a project.
 */
export async function enableSkill(
  projectId: string,
  skillId: string,
): Promise<{ projectId: string; skillId: string }> {
  return fetchJsonOrThrow<{ projectId: string; skillId: string }>(
    `/api/skills/${encodeURIComponent(skillId)}/enable`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId }),
    },
    'Failed to enable skill',
  );
}

/**
 * Disable all skills for a project.
 */
export async function disableAllSkills(
  projectId: string,
): Promise<{ projectId: string; disabledCount: number }> {
  return fetchJsonOrThrow<{ projectId: string; disabledCount: number }>(
    '/api/skills/disable-all',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId }),
    },
    'Failed to disable all skills',
  );
}

/**
 * Enable all skills for a project.
 */
export async function enableAllSkills(
  projectId: string,
): Promise<{ projectId: string; enabledCount: number }> {
  return fetchJsonOrThrow<{ projectId: string; enabledCount: number }>(
    '/api/skills/enable-all',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId }),
    },
    'Failed to enable all skills',
  );
}

/**
 * Fetch aggregated skill usage statistics.
 */
export async function fetchUsageStats(
  options: SkillUsageStatsQuery = {},
): Promise<SkillUsageStat[]> {
  const params = new URLSearchParams();
  appendQueryParam(params, 'projectId', options.projectId);
  appendQueryParam(params, 'from', options.from);
  appendQueryParam(params, 'to', options.to);
  appendNumericQueryParam(params, 'limit', options.limit);
  appendNumericQueryParam(params, 'offset', options.offset);

  const query = params.toString();
  const url = query ? `/api/skills/usage/stats?${query}` : '/api/skills/usage/stats';
  return fetchJsonOrThrow<SkillUsageStat[]>(url, {}, 'Failed to fetch skill usage stats');
}

/**
 * Fetch paginated skill usage log entries.
 */
export async function fetchUsageLog(
  options: SkillUsageLogQuery = {},
): Promise<SkillUsageLogResponse> {
  const params = new URLSearchParams();
  appendQueryParam(params, 'projectId', options.projectId);
  appendQueryParam(params, 'skillId', options.skillId);
  appendQueryParam(params, 'agentId', options.agentId);
  appendQueryParam(params, 'from', options.from);
  appendQueryParam(params, 'to', options.to);
  appendNumericQueryParam(params, 'limit', options.limit);
  appendNumericQueryParam(params, 'offset', options.offset);

  const query = params.toString();
  const url = query ? `/api/skills/usage/log?${query}` : '/api/skills/usage/log';
  return fetchJsonOrThrow<SkillUsageLogResponse>(url, {}, 'Failed to fetch skill usage log');
}
