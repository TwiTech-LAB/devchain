import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, asc, count, desc, eq, gte, inArray, isNull, lte, sql, type SQL } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { NotFoundError, StorageError, ValidationError } from '../../../common/errors/error-types';
import { createLogger } from '../../../common/logging/logger';
import { SettingsService } from '../../settings/services/settings.service';
import { DB_CONNECTION } from '../../storage/db/db.provider';
import {
  epics,
  skillProjectDisabled,
  skills,
  skillUsageLog,
  sourceProjectEnabled,
  statuses,
} from '../../storage/db/schema';
import { parseSkillsRequired } from '../../storage/local/helpers/storage-helpers';
import type { ResolvedSkillSummary } from '../dtos/skill.dto';
import type {
  Skill,
  SkillStatus,
  SkillUsageLog as SkillUsageLogModel,
} from '../../storage/models/domain.models';
import { SkillSourceRegistryService, type SkillSourceKind } from './skill-source-registry.service';
import {
  parseSearchQuery,
  buildSearchCondition,
  sortByRelevance,
  type ParsedSearchQuery,
} from './skill-search.utils';

const logger = createLogger('SkillsService');

const VALID_SKILL_STATUSES: SkillStatus[] = ['available', 'outdated', 'sync_error'];

export interface ListSkillsOptions {
  source?: string;
  category?: string;
  status?: SkillStatus;
  q?: string;
}

export interface ListProjectSkillsOptions {
  q?: string;
  source?: string;
  category?: string;
}

export interface ProjectSkill extends Skill {
  disabled: boolean;
}

export interface StoredProjectSkill extends Skill {
  /** True when any of the three independent blocks below applies. */
  disabled: boolean;
  /** The project has a skill_project_disabled row for the skill. */
  skillDisabled: boolean;
  /** The source is enabled for the project (source_project_enabled, default true). */
  sourceProjectEnabled: boolean;
  /** The source is enabled in settings skills.sources (default true). */
  sourceGloballyEnabled: boolean;
}

export type ResolveDiscoverableSkillResult =
  | { status: 'resolved'; skill: Skill }
  | { status: 'disabled'; enabledAlternatives: string[] }
  | { status: 'ambiguous'; candidates: string[] }
  | { status: 'not_found' };

export type SetSourceProjectEnabledResult =
  | { status: 'ok'; name: string; projectId: string; projectEnabled: boolean }
  | { status: 'source_not_found'; name: string }
  | { status: 'source_disabled_globally'; name: string };

export interface UpsertSkillData {
  name?: string;
  displayName?: string;
  description?: string | null;
  shortDescription?: string | null;
  source?: string;
  sourceUrl?: string | null;
  sourceCommit?: string | null;
  category?: string | null;
  license?: string | null;
  compatibility?: string | null;
  frontmatter?: Record<string, unknown> | null;
  instructionContent?: string | null;
  contentPath?: string | null;
  resources?: string[];
  status?: SkillStatus;
  lastSyncedAt?: string | null;
}

export interface SkillUsageStatsOptions {
  projectId?: string | null;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
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

export interface SkillUsageStatsSummary {
  totalEvents: number;
  distinctSkills: number;
  firstEventAt: string | null;
  lastEventAt: string | null;
}

export interface CompleteSkillUsageStats {
  summary: SkillUsageStatsSummary;
  skills: SkillUsageStat[];
}

export interface SkillEpicReference {
  slug: string;
  total: number;
  byStatus: Record<string, number>;
}

export interface SetSkillsEnabledResult {
  updated: string[];
  unchanged: string[];
  notFound: string[];
}

export interface SkillUsageLogOptions {
  projectId?: string;
  skillId?: string;
  agentId?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export interface SkillUsageLogListResult {
  items: SkillUsageLogModel[];
  total: number;
  limit: number;
  offset: number;
}

export interface SkillSourceMetadata {
  name: string;
  kind: SkillSourceKind;
  enabled: boolean;
  projectEnabled?: boolean;
  repoUrl: string;
  skillCount: number;
}

@Injectable()
export class SkillsService {
  constructor(
    @Inject(DB_CONNECTION) private readonly db: BetterSQLite3Database,
    private readonly settingsService: SettingsService,
    private readonly skillSourceRegistry: SkillSourceRegistryService,
  ) {}

  async listSkills(options: ListSkillsOptions = {}): Promise<Skill[]> {
    const enabledSources = await this.getEnabledSources();
    if (enabledSources.length === 0) {
      return [];
    }

    const conditions: SQL<unknown>[] = [];
    conditions.push(inArray(skills.source, enabledSources));

    if (options.source) {
      conditions.push(eq(skills.source, options.source.trim().toLowerCase()));
    }
    if (options.category) {
      conditions.push(eq(skills.category, options.category));
    }
    if (options.status) {
      conditions.push(eq(skills.status, options.status));
    }
    const parsed = options.q ? parseSearchQuery(options.q) : null;
    if (parsed) {
      conditions.push(buildSearchCondition(parsed));
    }

    const whereClause = this.combineConditions(conditions);
    const query = this.db.select().from(skills);
    if (whereClause) {
      query.where(whereClause);
    }

    const rows = await query.orderBy(asc(skills.name), asc(skills.slug));
    const mapped = rows.map((row) => this.mapSkillRow(row));

    if (parsed) {
      return sortByRelevance(mapped, parsed);
    }
    return mapped;
  }

  async listAllForProject(
    projectId: string,
    options: ListProjectSkillsOptions = {},
  ): Promise<ProjectSkill[]> {
    const normalizedProjectId = this.requireNonEmpty(projectId, 'projectId');
    const enabledSources = await this.getEnabledSourcesForProject(normalizedProjectId);
    if (enabledSources.length === 0) {
      return [];
    }

    return this.queryProjectSkills(
      normalizedProjectId,
      [inArray(skills.source, enabledSources)],
      options,
      (skill, skillDisabled) => ({ ...skill, disabled: skillDisabled }),
    );
  }

  /**
   * Lists every stored skill for the project with the three independent
   * enablement flags (skill-level disable, per-project source enablement,
   * global source enablement) and their effective combination. Unlike
   * listAllForProject it applies no source filter: skills of project-disabled
   * and globally disabled sources appear, because a review must judge the
   * whole stored catalog.
   */
  async listAllStoredForProject(
    projectId: string,
    options: ListProjectSkillsOptions = {},
  ): Promise<StoredProjectSkill[]> {
    const normalizedProjectId = this.requireNonEmpty(projectId, 'projectId');
    const sourceSettings = this.settingsService.getSkillSourcesEnabled();
    const projectSourceEnabledMap = await this.getProjectSourceEnabledMap(normalizedProjectId);

    return this.queryProjectSkills(normalizedProjectId, [], options, (skill, skillDisabled) => {
      const sourceName = skill.source.trim().toLowerCase();
      const sourceProjectEnabled = projectSourceEnabledMap.get(sourceName) ?? true;
      const sourceGloballyEnabled = this.isSourceEnabled(sourceName, sourceSettings);
      return {
        ...skill,
        skillDisabled,
        sourceProjectEnabled,
        sourceGloballyEnabled,
        disabled: skillDisabled || !sourceProjectEnabled || !sourceGloballyEnabled,
      };
    });
  }

  async listDiscoverable(
    projectId: string,
    options: ListProjectSkillsOptions = {},
  ): Promise<Skill[]> {
    const normalizedProjectId = this.requireNonEmpty(projectId, 'projectId');
    const enabledSources = await this.getEnabledSourcesForProject(normalizedProjectId);
    if (enabledSources.length === 0) {
      return [];
    }

    const query = this.db
      .select({ skill: skills })
      .from(skills)
      .leftJoin(
        skillProjectDisabled,
        and(
          eq(skillProjectDisabled.skillId, skills.id),
          eq(skillProjectDisabled.projectId, normalizedProjectId),
        ),
      );

    const conditions: SQL<unknown>[] = [isNull(skillProjectDisabled.id)];
    conditions.push(inArray(skills.source, enabledSources));
    const parsed = this.appendProjectSkillFilterConditions(conditions, options);

    const whereClause = this.combineConditions(conditions);
    if (whereClause) {
      query.where(whereClause);
    }

    const rows = await query.orderBy(asc(skills.name), asc(skills.slug));
    const mapped = rows.map((row) => this.mapSkillRow(row.skill));

    if (parsed) {
      return sortByRelevance(mapped, parsed);
    }
    return mapped;
  }

  async getSkill(id: string): Promise<Skill> {
    const skillId = this.requireNonEmpty(id, 'id');
    const row = await this.db.select().from(skills).where(eq(skills.id, skillId)).limit(1);

    if (!row[0]) {
      throw new NotFoundError('Skill', skillId);
    }

    return this.mapSkillRow(row[0]);
  }

  async getSkillBySlug(slug: string): Promise<Skill> {
    const normalizedSlug = this.requireNonEmpty(slug, 'slug');
    const row = await this.db.select().from(skills).where(eq(skills.slug, normalizedSlug)).limit(1);

    if (!row[0]) {
      throw new NotFoundError('Skill', normalizedSlug);
    }

    return this.mapSkillRow(row[0]);
  }

  /**
   * Resolves a skill reference the way MCP agents ask for it: a full
   * `source/name` slug or a bare name matched against the slug name segment
   * only (never the frontmatter name). Only skills that pass the
   * listDiscoverable filter resolve; anything else reports why so callers can
   * surface disabled/ambiguous outcomes without a second lookup.
   */
  async resolveDiscoverableSkill(
    projectId: string,
    slugOrName: string,
  ): Promise<ResolveDiscoverableSkillResult> {
    const normalizedProjectId = this.requireNonEmpty(projectId, 'projectId');
    const normalizedInput = this.requireNonEmpty(slugOrName, 'slug').toLowerCase();

    const discoverable = await this.listDiscoverable(normalizedProjectId);

    if (normalizedInput.includes('/')) {
      const exact = discoverable.find((skill) => skill.slug === normalizedInput);
      if (exact) {
        return { status: 'resolved', skill: exact };
      }

      const [existing] = await this.db
        .select({ id: skills.id })
        .from(skills)
        .where(eq(skills.slug, normalizedInput))
        .limit(1);
      if (!existing) {
        return { status: 'not_found' };
      }

      return {
        status: 'disabled',
        enabledAlternatives: this.filterSkillsByNameSegment(
          discoverable,
          this.slugNameSegment(normalizedInput),
        ).map((skill) => skill.slug),
      };
    }

    const matches = this.filterSkillsByNameSegment(discoverable, normalizedInput);
    const [single] = matches;
    if (matches.length === 1 && single) {
      return { status: 'resolved', skill: single };
    }
    if (matches.length > 1) {
      const sourceKindByName = new Map(
        (await this.getRegisteredSources()).map((source) => [source.name, source.kind] as const),
      );
      const localMatches = matches.filter(
        (skill) => sourceKindByName.get(skill.source) === 'local',
      );
      const [localSingle] = localMatches;
      if (localMatches.length === 1 && localSingle) {
        return { status: 'resolved', skill: localSingle };
      }
      return { status: 'ambiguous', candidates: matches.map((skill) => skill.slug) };
    }

    const allSlugs = await this.db.select({ slug: skills.slug }).from(skills);
    const anySkillWithName = allSlugs.some(
      (row) => this.slugNameSegment(row.slug) === normalizedInput,
    );
    if (anySkillWithName) {
      return { status: 'disabled', enabledAlternatives: [] };
    }
    return { status: 'not_found' };
  }

  async listSkillsBySource(sourceName: string): Promise<Skill[]> {
    const normalizedSourceName = this.requireNonEmpty(sourceName, 'sourceName').toLowerCase();
    const rows = await this.db
      .select()
      .from(skills)
      .where(eq(skills.source, normalizedSourceName))
      .orderBy(asc(skills.name), asc(skills.slug));

    return rows.map((row) => this.mapSkillRow(row));
  }

  async deleteSkillBySlug(slug: string): Promise<boolean> {
    const normalizedSlug = this.requireNonEmpty(slug, 'slug').toLowerCase();
    const existing = await this.db
      .select({ id: skills.id })
      .from(skills)
      .where(eq(skills.slug, normalizedSlug))
      .limit(1);
    if (!existing[0]) {
      return false;
    }

    await this.db.delete(skills).where(eq(skills.slug, normalizedSlug));
    return true;
  }

  async resolveSkillSummariesBySlugs(
    slugsToResolve: string[],
  ): Promise<Record<string, ResolvedSkillSummary>> {
    const uniqueSlugs = Array.from(
      new Set(slugsToResolve.map((slug) => this.requireNonEmpty(slug, 'slug').toLowerCase())),
    );
    if (uniqueSlugs.length === 0) {
      return {};
    }

    const rows = await this.db
      .select({
        id: skills.id,
        slug: skills.slug,
        name: skills.name,
        displayName: skills.displayName,
        source: skills.source,
        category: skills.category,
        shortDescription: skills.shortDescription,
        description: skills.description,
      })
      .from(skills)
      .where(inArray(skills.slug, uniqueSlugs));

    const resolved: Record<string, ResolvedSkillSummary> = {};
    for (const row of rows) {
      resolved[row.slug] = {
        id: row.id,
        slug: row.slug,
        name: row.name,
        displayName: row.displayName,
        source: row.source,
        category: row.category,
        shortDescription: row.shortDescription,
        description: row.description,
      };
    }

    return resolved;
  }

  async upsertSkill(slug: string, data: UpsertSkillData): Promise<Skill> {
    const normalizedSlug = this.requireNonEmpty(slug, 'slug');
    const now = new Date().toISOString();
    const existing = await this.db
      .select()
      .from(skills)
      .where(eq(skills.slug, normalizedSlug))
      .limit(1);

    if (existing[0]) {
      const updatePayload: Partial<typeof skills.$inferInsert> = { updatedAt: now };

      if (data.name !== undefined) {
        updatePayload.name = this.requireNonEmpty(data.name, 'name');
      }
      if (data.displayName !== undefined) {
        updatePayload.displayName = this.requireNonEmpty(data.displayName, 'displayName');
      }
      if (data.source !== undefined) {
        updatePayload.source = this.requireNonEmpty(data.source, 'source');
      }

      if (data.description !== undefined) {
        updatePayload.description = this.normalizeNullableString(data.description);
      }
      if (data.shortDescription !== undefined) {
        updatePayload.shortDescription = this.normalizeNullableString(data.shortDescription);
      }
      if (data.sourceUrl !== undefined) {
        updatePayload.sourceUrl = this.normalizeNullableString(data.sourceUrl);
      }
      if (data.sourceCommit !== undefined) {
        updatePayload.sourceCommit = this.normalizeNullableString(data.sourceCommit);
      }
      if (data.category !== undefined) {
        updatePayload.category = this.normalizeNullableString(data.category);
      }
      if (data.license !== undefined) {
        updatePayload.license = this.normalizeNullableString(data.license);
      }
      if (data.compatibility !== undefined) {
        updatePayload.compatibility = this.normalizeNullableString(data.compatibility);
      }
      if (data.instructionContent !== undefined) {
        updatePayload.instructionContent = this.normalizeNullableString(data.instructionContent);
      }
      if (data.contentPath !== undefined) {
        updatePayload.contentPath = this.normalizeNullableString(data.contentPath);
      }
      if (data.lastSyncedAt !== undefined) {
        updatePayload.lastSyncedAt = this.normalizeNullableString(data.lastSyncedAt);
      }
      if (data.frontmatter !== undefined) {
        updatePayload.frontmatter = this.serializeJsonObject(data.frontmatter, 'frontmatter');
      }
      if (data.resources !== undefined) {
        updatePayload.resources = this.serializeResources(data.resources);
      }
      if (data.status !== undefined) {
        updatePayload.status = this.validateStatus(data.status);
      }

      await this.db.update(skills).set(updatePayload).where(eq(skills.slug, normalizedSlug));
      return this.getSkillBySlug(normalizedSlug);
    }

    const source = this.requireNonEmpty(data.source ?? '', 'source');
    const name = this.requireNonEmpty(data.name ?? normalizedSlug, 'name');
    const displayName = this.requireNonEmpty(
      data.displayName ?? data.name ?? normalizedSlug,
      'displayName',
    );

    const insertPayload: typeof skills.$inferInsert = {
      id: randomUUID(),
      slug: normalizedSlug,
      name,
      displayName,
      description: this.normalizeNullableString(data.description ?? null),
      shortDescription: this.normalizeNullableString(data.shortDescription ?? null),
      source,
      sourceUrl: this.normalizeNullableString(data.sourceUrl ?? null),
      sourceCommit: this.normalizeNullableString(data.sourceCommit ?? null),
      category: this.normalizeNullableString(data.category ?? null),
      license: this.normalizeNullableString(data.license ?? null),
      compatibility: this.normalizeNullableString(data.compatibility ?? null),
      frontmatter: this.serializeJsonObject(data.frontmatter ?? null, 'frontmatter'),
      instructionContent: this.normalizeNullableString(data.instructionContent ?? null),
      contentPath: this.normalizeNullableString(data.contentPath ?? null),
      resources: this.serializeResources(data.resources ?? []),
      status: this.validateStatus(data.status ?? 'available'),
      lastSyncedAt: this.normalizeNullableString(data.lastSyncedAt ?? null),
      createdAt: now,
      updatedAt: now,
    };

    await this.db.insert(skills).values(insertPayload);
    return this.getSkillBySlug(normalizedSlug);
  }

  async disableSkill(projectId: string, skillId: string): Promise<void> {
    const normalizedProjectId = this.requireNonEmpty(projectId, 'projectId');
    const normalizedSkillId = this.requireNonEmpty(skillId, 'skillId');
    const now = new Date().toISOString();

    try {
      await this.db.insert(skillProjectDisabled).values({
        id: randomUUID(),
        projectId: normalizedProjectId,
        skillId: normalizedSkillId,
        createdAt: now,
      });
    } catch (error) {
      if (this.isUniqueConstraintError(error)) {
        return;
      }

      if (this.isForeignKeyConstraintError(error)) {
        throw new ValidationError('Cannot disable skill for unknown project or skill.', {
          projectId: normalizedProjectId,
          skillId: normalizedSkillId,
        });
      }

      throw new StorageError('Failed to disable skill for project.', {
        projectId: normalizedProjectId,
        skillId: normalizedSkillId,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async enableSkill(projectId: string, skillId: string): Promise<void> {
    const normalizedProjectId = this.requireNonEmpty(projectId, 'projectId');
    const normalizedSkillId = this.requireNonEmpty(skillId, 'skillId');

    await this.db
      .delete(skillProjectDisabled)
      .where(
        and(
          eq(skillProjectDisabled.projectId, normalizedProjectId),
          eq(skillProjectDisabled.skillId, normalizedSkillId),
        ),
      );
  }

  async setSkillsEnabled(
    projectId: string,
    slugs: string[],
    enabled: boolean,
  ): Promise<SetSkillsEnabledResult> {
    const normalizedProjectId = this.requireNonEmpty(projectId, 'projectId');

    const normalizedSlugs = new Set(
      slugs.map((slug) => this.requireNonEmpty(slug, 'slug').toLowerCase()),
    );

    // Resolution covers skills of globally enabled sources, including sources
    // the project disabled: a review disables a source's non-matching skills
    // before it enables the source, so those toggles must land while the
    // source is still project-disabled. The compared state is the skill-level
    // skill_project_disabled row, independent of any source-level disable.
    const storedSkills = await this.listAllStoredForProject(normalizedProjectId);
    const skillBySlug = new Map(
      storedSkills
        .filter((skill) => skill.sourceGloballyEnabled)
        .map((skill) => [skill.slug, skill] as const),
    );

    const updated: string[] = [];
    const unchanged: string[] = [];
    const notFound: string[] = [];
    for (const slug of normalizedSlugs) {
      const skill = skillBySlug.get(slug);
      if (!skill) {
        notFound.push(slug);
        continue;
      }

      if (skill.skillDisabled !== enabled) {
        unchanged.push(slug);
        continue;
      }

      if (enabled) {
        await this.enableSkill(normalizedProjectId, skill.id);
      } else {
        await this.disableSkill(normalizedProjectId, skill.id);
      }
      updated.push(slug);
    }

    return { updated, unchanged, notFound };
  }

  async listDisabled(projectId: string): Promise<string[]> {
    const normalizedProjectId = this.requireNonEmpty(projectId, 'projectId');
    const rows = await this.db
      .select({ skillId: skillProjectDisabled.skillId })
      .from(skillProjectDisabled)
      .where(eq(skillProjectDisabled.projectId, normalizedProjectId))
      .orderBy(asc(skillProjectDisabled.createdAt));

    return rows.map((row) => row.skillId);
  }

  async disableAll(projectId: string): Promise<number> {
    const enabledSources = await this.getEnabledSources();
    if (enabledSources.length === 0) {
      return 0;
    }

    const normalizedProjectId = this.requireNonEmpty(projectId, 'projectId');
    const now = new Date().toISOString();

    const [allSkills, disabledRows] = await Promise.all([
      this.db
        .select({ skillId: skills.id })
        .from(skills)
        .where(inArray(skills.source, enabledSources)),
      this.db
        .select({ skillId: skillProjectDisabled.skillId })
        .from(skillProjectDisabled)
        .innerJoin(skills, eq(skills.id, skillProjectDisabled.skillId))
        .where(
          and(
            eq(skillProjectDisabled.projectId, normalizedProjectId),
            inArray(skills.source, enabledSources),
          ),
        ),
    ]);

    const disabledSet = new Set(disabledRows.map((row) => row.skillId));
    const rowsToInsert = allSkills
      .filter((row) => !disabledSet.has(row.skillId))
      .map((row) => ({
        id: randomUUID(),
        projectId: normalizedProjectId,
        skillId: row.skillId,
        createdAt: now,
      }));

    if (rowsToInsert.length === 0) {
      return 0;
    }

    await this.db.insert(skillProjectDisabled).values(rowsToInsert);
    return rowsToInsert.length;
  }

  async enableAll(projectId: string): Promise<number> {
    const enabledSources = await this.getEnabledSources();
    if (enabledSources.length === 0) {
      return 0;
    }

    const normalizedProjectId = this.requireNonEmpty(projectId, 'projectId');
    const disabledRows = await this.db
      .select({ skillId: skillProjectDisabled.skillId })
      .from(skillProjectDisabled)
      .innerJoin(skills, eq(skills.id, skillProjectDisabled.skillId))
      .where(
        and(
          eq(skillProjectDisabled.projectId, normalizedProjectId),
          inArray(skills.source, enabledSources),
        ),
      );

    if (disabledRows.length === 0) {
      return 0;
    }

    const disabledSkillIds = disabledRows.map((row) => row.skillId);
    await this.db
      .delete(skillProjectDisabled)
      .where(
        and(
          eq(skillProjectDisabled.projectId, normalizedProjectId),
          inArray(skillProjectDisabled.skillId, disabledSkillIds),
        ),
      );

    return disabledRows.length;
  }

  async listSources(projectId?: string): Promise<SkillSourceMetadata[]> {
    const sourceRows = await this.db
      .select({ source: skills.source, skillCount: count() })
      .from(skills)
      .groupBy(skills.source);

    const sourceCountMap = new Map(
      sourceRows.map((row) => [row.source.trim().toLowerCase(), Number(row.skillCount)]),
    );

    const sourceSettings = this.settingsService.getSkillSourcesEnabled();
    const registeredSources = await this.getRegisteredSources();
    const normalizedProjectId =
      projectId !== undefined ? this.requireNonEmpty(projectId, 'projectId') : undefined;
    const projectSourceEnabledMap = normalizedProjectId
      ? await this.getProjectSourceEnabledMap(normalizedProjectId)
      : null;

    return registeredSources.map((source) => {
      const globallyEnabled = this.isSourceEnabled(source.name, sourceSettings);
      const base: SkillSourceMetadata = {
        name: source.name,
        kind: source.kind,
        enabled: globallyEnabled,
        repoUrl: source.repoUrl,
        skillCount: sourceCountMap.get(source.name) ?? 0,
      };

      if (!projectSourceEnabledMap) {
        return base;
      }

      const projectSetting = projectSourceEnabledMap.get(source.name);
      return {
        ...base,
        projectEnabled: globallyEnabled && (projectSetting ?? true),
      };
    });
  }

  async setSourceEnabled(
    sourceName: string,
    enabled: boolean,
  ): Promise<{
    name: string;
    enabled: boolean;
  }> {
    const normalizedSourceName = await this.requireKnownSourceName(sourceName);
    await this.settingsService.setSkillSourceEnabled(normalizedSourceName, enabled);
    return { name: normalizedSourceName, enabled };
  }

  async setSourceProjectEnabled(
    sourceName: string,
    projectId: string,
    enabled: boolean,
  ): Promise<{
    name: string;
    projectId: string;
    projectEnabled: boolean;
  }> {
    const normalizedSourceName = await this.requireKnownSourceName(sourceName);
    const normalizedProjectId = this.requireNonEmpty(projectId, 'projectId');
    const now = new Date().toISOString();

    try {
      const existing = await this.db
        .select({ id: sourceProjectEnabled.id })
        .from(sourceProjectEnabled)
        .where(
          and(
            eq(sourceProjectEnabled.projectId, normalizedProjectId),
            eq(sourceProjectEnabled.sourceName, normalizedSourceName),
          ),
        )
        .limit(1);

      if (existing[0]) {
        await this.db
          .update(sourceProjectEnabled)
          .set({ enabled })
          .where(eq(sourceProjectEnabled.id, existing[0].id));
      } else {
        await this.db.insert(sourceProjectEnabled).values({
          id: randomUUID(),
          projectId: normalizedProjectId,
          sourceName: normalizedSourceName,
          enabled,
          createdAt: now,
        });
      }
    } catch (error) {
      if (this.isUniqueConstraintError(error)) {
        await this.db
          .update(sourceProjectEnabled)
          .set({ enabled })
          .where(
            and(
              eq(sourceProjectEnabled.projectId, normalizedProjectId),
              eq(sourceProjectEnabled.sourceName, normalizedSourceName),
            ),
          );
      } else if (this.isForeignKeyConstraintError(error)) {
        throw new ValidationError('Cannot update source for unknown project.', {
          projectId: normalizedProjectId,
        });
      } else {
        throw new StorageError('Failed to update source enablement for project.', {
          projectId: normalizedProjectId,
          sourceName: normalizedSourceName,
          enabled,
          cause: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      name: normalizedSourceName,
      projectId: normalizedProjectId,
      projectEnabled: enabled,
    };
  }

  /**
   * Project-level source toggle for MCP: refuses unknown sources and sources
   * that settings disable globally (a project toggle has no effect while the
   * source is globally disabled), then delegates to setSourceProjectEnabled.
   * The REST routes keep the direct setSourceProjectEnabled path.
   */
  async setSourceProjectEnabledForMcp(
    projectId: string,
    sourceName: string,
    enabled: boolean,
  ): Promise<SetSourceProjectEnabledResult> {
    const normalizedProjectId = this.requireNonEmpty(projectId, 'projectId');
    const normalizedSourceName = sourceName.trim().toLowerCase();

    try {
      await this.requireKnownSourceName(normalizedSourceName);
    } catch (error) {
      if (error instanceof ValidationError) {
        return { status: 'source_not_found', name: normalizedSourceName };
      }
      throw error;
    }

    const sourceSettings = this.settingsService.getSkillSourcesEnabled();
    if (!this.isSourceEnabled(normalizedSourceName, sourceSettings)) {
      return { status: 'source_disabled_globally', name: normalizedSourceName };
    }

    const result = await this.setSourceProjectEnabled(
      normalizedSourceName,
      normalizedProjectId,
      enabled,
    );
    return { status: 'ok', ...result };
  }

  async logUsage(
    skillId: string,
    skillSlug: string,
    projectId?: string | null,
    agentId?: string | null,
    agentNameSnapshot?: string | null,
  ): Promise<SkillUsageLogModel> {
    const normalizedSkillId = this.requireNonEmpty(skillId, 'skillId');
    const normalizedSkillSlug = this.requireNonEmpty(skillSlug, 'skillSlug');
    const now = new Date().toISOString();

    const usageRecord: SkillUsageLogModel = {
      id: randomUUID(),
      skillId: normalizedSkillId,
      skillSlug: normalizedSkillSlug,
      projectId: this.normalizeNullableString(projectId ?? null) ?? null,
      agentId: this.normalizeNullableString(agentId ?? null) ?? null,
      agentNameSnapshot: this.normalizeNullableString(agentNameSnapshot ?? null) ?? null,
      accessedAt: now,
    };

    await this.db.insert(skillUsageLog).values({
      id: usageRecord.id,
      skillId: usageRecord.skillId,
      skillSlug: usageRecord.skillSlug,
      projectId: usageRecord.projectId,
      agentId: usageRecord.agentId,
      agentNameSnapshot: usageRecord.agentNameSnapshot,
      accessedAt: usageRecord.accessedAt,
    });

    return usageRecord;
  }

  async getUsageStats(options: SkillUsageStatsOptions = {}): Promise<SkillUsageStat[]> {
    const conditions: SQL<unknown>[] = [];
    if (options.projectId !== undefined) {
      if (options.projectId === null) {
        conditions.push(isNull(skillUsageLog.projectId));
      } else {
        conditions.push(eq(skillUsageLog.projectId, options.projectId));
      }
    }
    if (options.from) {
      conditions.push(gte(skillUsageLog.accessedAt, options.from));
    }
    if (options.to) {
      conditions.push(lte(skillUsageLog.accessedAt, options.to));
    }

    return this.queryUsageStatsRows(
      this.combineConditions(conditions),
      options.limit ?? 100,
      options.offset ?? 0,
    );
  }

  async getCompleteUsageStats(options: {
    projectId: string;
    from?: string;
    to?: string;
  }): Promise<CompleteSkillUsageStats> {
    const normalizedProjectId = this.requireNonEmpty(options.projectId, 'projectId');
    const conditions: SQL<unknown>[] = [eq(skillUsageLog.projectId, normalizedProjectId)];
    if (options.from) {
      conditions.push(gte(skillUsageLog.accessedAt, options.from));
    }
    if (options.to) {
      conditions.push(lte(skillUsageLog.accessedAt, options.to));
    }
    const whereClause = this.combineConditions(conditions);

    // distinctSkills must count the same skill id + slug pairs the rows query
    // groups by; the concatenated key is injective because skill ids are
    // fixed-length UUIDs that never contain the separator.
    const summaryQuery = this.db
      .select({
        totalEvents: sql<number>`count(*)`,
        distinctSkills: sql<number>`count(distinct ${skillUsageLog.skillId} || '|' || ${skillUsageLog.skillSlug})`,
        firstEventAt: sql<string | null>`min(${skillUsageLog.accessedAt})`,
        lastEventAt: sql<string | null>`max(${skillUsageLog.accessedAt})`,
      })
      .from(skillUsageLog);
    if (whereClause) {
      summaryQuery.where(whereClause);
    }
    const summaryRows = await summaryQuery;
    const summaryRow = summaryRows[0];

    const skills = await this.queryUsageStatsRows(whereClause, null, 0);

    return {
      summary: {
        totalEvents: Number(summaryRow?.totalEvents ?? 0),
        distinctSkills: Number(summaryRow?.distinctSkills ?? 0),
        firstEventAt: summaryRow?.firstEventAt ?? null,
        lastEventAt: summaryRow?.lastEventAt ?? null,
      },
      skills,
    };
  }

  async getSkillsEpicReferences(projectId: string): Promise<SkillEpicReference[]> {
    const normalizedProjectId = this.requireNonEmpty(projectId, 'projectId');

    // Deliberately includes epics with MCP-hidden statuses: hidden is read
    // visibility, not a closed state, and their skill requirements stay in
    // force.
    const rows = await this.db
      .select({
        skillsRequired: epics.skillsRequired,
        statusLabel: statuses.label,
      })
      .from(epics)
      .innerJoin(statuses, eq(statuses.id, epics.statusId))
      .where(eq(epics.projectId, normalizedProjectId));

    const references = new Map<string, { total: number; byStatus: Map<string, number> }>();
    for (const row of rows) {
      const requiredSlugs = parseSkillsRequired(row.skillsRequired);
      if (!requiredSlugs) continue;

      // One epic counts once per slug, even when a legacy row lists the slug twice.
      for (const slug of new Set(requiredSlugs)) {
        let entry = references.get(slug);
        if (!entry) {
          entry = { total: 0, byStatus: new Map() };
          references.set(slug, entry);
        }
        entry.total += 1;
        entry.byStatus.set(row.statusLabel, (entry.byStatus.get(row.statusLabel) ?? 0) + 1);
      }
    }

    return Array.from(references.entries())
      .map(([slug, entry]) => ({
        slug,
        total: entry.total,
        byStatus: Object.fromEntries(entry.byStatus),
      }))
      .sort((a, b) => a.slug.localeCompare(b.slug));
  }

  private async queryUsageStatsRows(
    whereClause: SQL<unknown> | undefined,
    limit: number | null,
    offset: number,
  ): Promise<SkillUsageStat[]> {
    const usageCountExpr = count();
    const firstAccessedExpr = sql<string | null>`min(${skillUsageLog.accessedAt})`;
    const lastAccessedExpr = sql<string | null>`max(${skillUsageLog.accessedAt})`;

    const query = this.db
      .select({
        skillId: skillUsageLog.skillId,
        skillSlug: skillUsageLog.skillSlug,
        usageCount: usageCountExpr,
        firstAccessedAt: firstAccessedExpr,
        lastAccessedAt: lastAccessedExpr,
        skillName: skills.name,
        skillDisplayName: skills.displayName,
      })
      .from(skillUsageLog)
      .leftJoin(skills, eq(skills.id, skillUsageLog.skillId));

    if (whereClause) {
      query.where(whereClause);
    }

    const grouped = query
      .groupBy(skillUsageLog.skillId, skillUsageLog.skillSlug, skills.name, skills.displayName)
      .orderBy(desc(usageCountExpr), desc(lastAccessedExpr));

    const rows = limit === null ? await grouped : await grouped.limit(limit).offset(offset);

    return rows.map((row) => ({
      skillId: row.skillId,
      skillSlug: row.skillSlug,
      usageCount: Number(row.usageCount ?? 0),
      firstAccessedAt: row.firstAccessedAt,
      lastAccessedAt: row.lastAccessedAt,
      skillName: row.skillName ?? null,
      skillDisplayName: row.skillDisplayName ?? null,
    }));
  }

  async listUsageLog(options: SkillUsageLogOptions = {}): Promise<SkillUsageLogListResult> {
    const conditions: SQL<unknown>[] = [];
    if (options.projectId) {
      conditions.push(eq(skillUsageLog.projectId, options.projectId));
    }
    if (options.skillId) {
      conditions.push(eq(skillUsageLog.skillId, options.skillId));
    }
    if (options.agentId) {
      conditions.push(eq(skillUsageLog.agentId, options.agentId));
    }
    if (options.from) {
      conditions.push(gte(skillUsageLog.accessedAt, options.from));
    }
    if (options.to) {
      conditions.push(lte(skillUsageLog.accessedAt, options.to));
    }

    const whereClause = this.combineConditions(conditions);
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    const itemsQuery = this.db.select().from(skillUsageLog);
    if (whereClause) {
      itemsQuery.where(whereClause);
    }

    const rows = await itemsQuery
      .orderBy(desc(skillUsageLog.accessedAt))
      .limit(limit)
      .offset(offset);

    const totalQuery = this.db.select({ count: sql<number>`count(*)` }).from(skillUsageLog);
    if (whereClause) {
      totalQuery.where(whereClause);
    }
    const totalResult = await totalQuery;
    const total = Number(totalResult[0]?.count ?? 0);

    return {
      items: rows.map((row) => ({
        id: row.id,
        skillId: row.skillId,
        skillSlug: row.skillSlug,
        projectId: row.projectId,
        agentId: row.agentId,
        agentNameSnapshot: row.agentNameSnapshot,
        accessedAt: row.accessedAt,
      })),
      total,
      limit,
      offset,
    };
  }

  /**
   * Shared query of the project listings that report skill-level disables:
   * skills left-joined to this project's skill_project_disabled rows, filtered
   * by the given conditions plus the optional q, ordered by name, then by
   * relevance when q is present.
   */
  private async queryProjectSkills<T extends Skill>(
    projectId: string,
    conditions: SQL<unknown>[],
    options: ListProjectSkillsOptions,
    mapRow: (skill: Skill, skillDisabled: boolean) => T,
  ): Promise<T[]> {
    const query = this.db
      .select({
        skill: skills,
        disabled: sql<number>`case when ${skillProjectDisabled.id} is null then 0 else 1 end`,
      })
      .from(skills)
      .leftJoin(
        skillProjectDisabled,
        and(
          eq(skillProjectDisabled.skillId, skills.id),
          eq(skillProjectDisabled.projectId, projectId),
        ),
      );

    const parsed = this.appendProjectSkillFilterConditions(conditions, options);

    const whereClause = this.combineConditions(conditions);
    if (whereClause) {
      query.where(whereClause);
    }

    const rows = await query.orderBy(asc(skills.name), asc(skills.slug));
    const mapped = rows.map((row) =>
      mapRow(this.mapSkillRow(row.skill), Number(row.disabled) === 1),
    );

    if (parsed) {
      return sortByRelevance(mapped, parsed);
    }
    return mapped;
  }

  private appendProjectSkillFilterConditions(
    conditions: SQL<unknown>[],
    options: ListProjectSkillsOptions,
  ): ParsedSearchQuery | null {
    const parsed = options.q ? parseSearchQuery(options.q) : null;
    if (parsed) {
      conditions.push(buildSearchCondition(parsed));
    }
    if (options.source) {
      conditions.push(eq(skills.source, options.source.trim().toLowerCase()));
    }
    if (options.category) {
      conditions.push(eq(skills.category, options.category));
    }
    return parsed;
  }

  private mapSkillRow(row: typeof skills.$inferSelect): Skill {
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      displayName: row.displayName,
      description: row.description,
      shortDescription: row.shortDescription,
      source: row.source,
      sourceUrl: row.sourceUrl,
      sourceCommit: row.sourceCommit,
      category: row.category,
      license: row.license,
      compatibility: row.compatibility,
      frontmatter: this.parseJsonObject(row.frontmatter, 'frontmatter'),
      instructionContent: row.instructionContent,
      contentPath: row.contentPath,
      resources: this.parseResources(row.resources),
      status: this.parseStatus(row.status),
      lastSyncedAt: row.lastSyncedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private parseJsonObject(
    rawValue: string | null,
    fieldName: string,
  ): Record<string, unknown> | null {
    if (rawValue === null) {
      return null;
    }

    try {
      const parsed = JSON.parse(rawValue);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      logger.warn({ fieldName }, 'Expected JSON object but found different type');
      return null;
    } catch (error) {
      logger.warn(
        {
          fieldName,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to parse JSON object field',
      );
      return null;
    }
  }

  private parseResources(rawValue: string | null): string[] {
    if (rawValue === null) {
      return [];
    }

    try {
      const parsed = JSON.parse(rawValue);
      if (!Array.isArray(parsed)) {
        logger.warn('Expected resources JSON array but found different type');
        return [];
      }

      return parsed
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
    } catch (error) {
      logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'Failed to parse resources JSON field',
      );
      return [];
    }
  }

  private serializeJsonObject(
    value: Record<string, unknown> | null | undefined,
    fieldName: string,
  ): string | null | undefined {
    if (value === undefined) {
      return undefined;
    }
    if (value === null) {
      return null;
    }

    try {
      return JSON.stringify(value);
    } catch (error) {
      throw new ValidationError(`Invalid ${fieldName}: value is not serializable JSON.`, {
        fieldName,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private serializeResources(resources: string[] | null | undefined): string | null | undefined {
    if (resources === undefined) {
      return undefined;
    }
    if (resources === null) {
      return null;
    }
    if (!Array.isArray(resources)) {
      throw new ValidationError('Invalid resources: expected an array of strings.');
    }

    const normalizedResources = resources
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);

    try {
      return JSON.stringify(normalizedResources);
    } catch (error) {
      throw new ValidationError('Invalid resources: value is not serializable JSON.', {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private validateStatus(status: string): SkillStatus {
    if (VALID_SKILL_STATUSES.includes(status as SkillStatus)) {
      return status as SkillStatus;
    }

    throw new ValidationError('Invalid skill status value.', {
      status,
      supportedStatuses: VALID_SKILL_STATUSES,
    });
  }

  private parseStatus(status: string): SkillStatus {
    if (VALID_SKILL_STATUSES.includes(status as SkillStatus)) {
      return status as SkillStatus;
    }
    logger.warn({ status }, 'Unknown skill status in database; defaulting to available');
    return 'available';
  }

  private normalizeNullableString(value: string | null | undefined): string | null | undefined {
    if (value === undefined) {
      return undefined;
    }
    if (value === null) {
      return null;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private requireNonEmpty(value: string, fieldName: string): string {
    const normalized = value.trim();
    if (!normalized) {
      throw new ValidationError(`${fieldName} is required.`, { fieldName });
    }
    return normalized;
  }

  private combineConditions(conditions: SQL<unknown>[]): SQL<unknown> | undefined {
    if (conditions.length === 0) {
      return undefined;
    }
    if (conditions.length === 1) {
      return conditions[0];
    }
    return and(...conditions);
  }

  private slugNameSegment(slug: string): string {
    const separatorIndex = slug.indexOf('/');
    return separatorIndex === -1 ? slug : slug.slice(separatorIndex + 1);
  }

  private filterSkillsByNameSegment(skillsToFilter: Skill[], name: string): Skill[] {
    return skillsToFilter.filter((skill) => this.slugNameSegment(skill.slug) === name);
  }

  private async getRegisteredSources(): Promise<
    Array<{ name: string; repoUrl: string; kind: SkillSourceKind }>
  > {
    return this.skillSourceRegistry.listRegisteredSources();
  }

  private async getEnabledSources(): Promise<string[]> {
    const sourceSettings = this.settingsService.getSkillSourcesEnabled();
    const registeredSources = await this.getRegisteredSources();
    return registeredSources
      .map((source) => source.name)
      .filter((sourceName) => this.isSourceEnabled(sourceName, sourceSettings));
  }

  private async getEnabledSourcesForProject(projectId: string): Promise<string[]> {
    const enabledSources = await this.getEnabledSources();
    if (enabledSources.length === 0) {
      return [];
    }

    const projectSourceEnabledMap = await this.getProjectSourceEnabledMap(projectId);
    return enabledSources.filter((sourceName) => projectSourceEnabledMap.get(sourceName) ?? true);
  }

  private async getProjectSourceEnabledMap(projectId: string): Promise<Map<string, boolean>> {
    const normalizedProjectId = this.requireNonEmpty(projectId, 'projectId');
    const rows = await this.db
      .select({
        sourceName: sourceProjectEnabled.sourceName,
        enabled: sourceProjectEnabled.enabled,
      })
      .from(sourceProjectEnabled)
      .where(eq(sourceProjectEnabled.projectId, normalizedProjectId));

    return new Map(
      rows.map((row) => [row.sourceName.trim().toLowerCase(), Boolean(row.enabled)] as const),
    );
  }

  private isSourceEnabled(sourceName: string, sourceSettings: Record<string, boolean>): boolean {
    return sourceSettings[sourceName] !== false;
  }

  private async requireKnownSourceName(sourceName: string): Promise<string> {
    const normalized = this.requireNonEmpty(sourceName, 'sourceName').toLowerCase();
    const knownSources = new Set((await this.getRegisteredSources()).map((source) => source.name));
    if (!knownSources.has(normalized)) {
      throw new ValidationError(`Unknown skill source: ${normalized}`, { sourceName: normalized });
    }
    return normalized;
  }

  private isUniqueConstraintError(error: unknown): boolean {
    const code = this.readErrorCode(error);
    const message = this.readErrorMessage(error);
    return (
      code === 'SQLITE_CONSTRAINT' ||
      code === 'SQLITE_CONSTRAINT_UNIQUE' ||
      code === 19 ||
      message.includes('UNIQUE constraint failed')
    );
  }

  private isForeignKeyConstraintError(error: unknown): boolean {
    const code = this.readErrorCode(error);
    const message = this.readErrorMessage(error);
    return (
      code === 'SQLITE_CONSTRAINT_FOREIGNKEY' ||
      code === 'SQLITE_CONSTRAINT' ||
      code === 19 ||
      message.includes('FOREIGN KEY constraint failed')
    );
  }

  private readErrorCode(error: unknown): string | number | undefined {
    if (typeof error !== 'object' || error === null || !('code' in error)) {
      return undefined;
    }
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' || typeof code === 'number') {
      return code;
    }
    return undefined;
  }

  private readErrorMessage(error: unknown): string {
    if (typeof error !== 'object' || error === null || !('message' in error)) {
      return '';
    }
    const message = (error as { message?: unknown }).message;
    return typeof message === 'string' ? message : '';
  }
}
