import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, asc, count, desc, eq, gte, inArray, isNull, lte, sql, type SQL } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { NotFoundError, StorageError, ValidationError } from '../../../common/errors/error-types';
import { createLogger } from '../../../common/logging/logger';
import { SettingsService } from '../../settings/services/settings.service';
import { DB_CONNECTION } from '../../storage/db/db.provider';
import { skillProjectDisabled, skills, skillUsageLog } from '../../storage/db/schema';
import type { ResolvedSkillSummary } from '../dtos/skill.dto';
import type {
  Skill,
  SkillStatus,
  SkillUsageLog as SkillUsageLogModel,
} from '../../storage/models/domain.models';
import { SKILL_SOURCE_ADAPTERS, SkillSourceAdapter } from '../adapters/skill-source.adapter';

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
  enabled: boolean;
  repoUrl: string;
  skillCount: number;
}

@Injectable()
export class SkillsService {
  constructor(
    @Inject(DB_CONNECTION) private readonly db: BetterSQLite3Database,
    private readonly settingsService: SettingsService,
    @Inject(SKILL_SOURCE_ADAPTERS) private readonly adapters: SkillSourceAdapter[],
  ) {}

  async listSkills(options: ListSkillsOptions = {}): Promise<Skill[]> {
    const enabledSources = this.getEnabledSources();
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
    const searchTerm = options.q?.trim().toLowerCase();
    if (searchTerm) {
      const likePattern = `%${searchTerm}%`;
      conditions.push(
        sql`(
          lower(${skills.slug}) LIKE ${likePattern}
          OR lower(${skills.name}) LIKE ${likePattern}
          OR lower(${skills.displayName}) LIKE ${likePattern}
          OR lower(coalesce(${skills.description}, '')) LIKE ${likePattern}
          OR lower(coalesce(${skills.shortDescription}, '')) LIKE ${likePattern}
          OR lower(coalesce(${skills.compatibility}, '')) LIKE ${likePattern}
        )`,
      );
    }

    const whereClause = this.combineConditions(conditions);
    const query = this.db.select().from(skills);
    if (whereClause) {
      query.where(whereClause);
    }

    const rows = await query.orderBy(asc(skills.name), asc(skills.slug));
    return rows.map((row) => this.mapSkillRow(row));
  }

  async listAllForProject(
    projectId: string,
    options: ListProjectSkillsOptions = {},
  ): Promise<ProjectSkill[]> {
    const enabledSources = this.getEnabledSources();
    if (enabledSources.length === 0) {
      return [];
    }

    const normalizedProjectId = this.requireNonEmpty(projectId, 'projectId');
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
          eq(skillProjectDisabled.projectId, normalizedProjectId),
        ),
      );

    const conditions: SQL<unknown>[] = [inArray(skills.source, enabledSources)];
    this.appendProjectSkillFilterConditions(conditions, options);

    const whereClause = this.combineConditions(conditions);
    if (whereClause) {
      query.where(whereClause);
    }

    const rows = await query.orderBy(asc(skills.name), asc(skills.slug));
    return rows.map((row) => ({
      ...this.mapSkillRow(row.skill),
      disabled: Number(row.disabled) === 1,
    }));
  }

  async listDiscoverable(
    projectId: string,
    options: ListProjectSkillsOptions = {},
  ): Promise<Skill[]> {
    const enabledSources = this.getEnabledSources();
    if (enabledSources.length === 0) {
      return [];
    }

    const normalizedProjectId = this.requireNonEmpty(projectId, 'projectId');
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
    this.appendProjectSkillFilterConditions(conditions, options);

    const whereClause = this.combineConditions(conditions);
    if (whereClause) {
      query.where(whereClause);
    }

    const rows = await query.orderBy(asc(skills.name), asc(skills.slug));
    return rows.map((row) => this.mapSkillRow(row.skill));
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
    const enabledSources = this.getEnabledSources();
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
    const enabledSources = this.getEnabledSources();
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

  async listSources(): Promise<SkillSourceMetadata[]> {
    const sourceRows = await this.db
      .select({ source: skills.source, skillCount: count() })
      .from(skills)
      .groupBy(skills.source);

    const sourceCountMap = new Map(
      sourceRows.map((row) => [row.source.trim().toLowerCase(), Number(row.skillCount)]),
    );

    const sourceSettings = this.settingsService.getSkillSourcesEnabled();
    return this.getRegisteredSources().map((source) => ({
      name: source.name,
      enabled: this.isSourceEnabled(source.name, sourceSettings),
      repoUrl: source.repoUrl,
      skillCount: sourceCountMap.get(source.name) ?? 0,
    }));
  }

  async setSourceEnabled(
    sourceName: string,
    enabled: boolean,
  ): Promise<{
    name: string;
    enabled: boolean;
  }> {
    const normalizedSourceName = this.requireKnownSourceName(sourceName);
    await this.settingsService.setSkillSourceEnabled(normalizedSourceName, enabled);
    return { name: normalizedSourceName, enabled };
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

    const usageCountExpr = count();
    const firstAccessedExpr = sql<string | null>`min(${skillUsageLog.accessedAt})`;
    const lastAccessedExpr = sql<string | null>`max(${skillUsageLog.accessedAt})`;
    const whereClause = this.combineConditions(conditions);
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

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

    const rows = await query
      .groupBy(skillUsageLog.skillId, skillUsageLog.skillSlug, skills.name, skills.displayName)
      .orderBy(desc(usageCountExpr), desc(lastAccessedExpr))
      .limit(limit)
      .offset(offset);

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

  private appendProjectSkillFilterConditions(
    conditions: SQL<unknown>[],
    options: ListProjectSkillsOptions,
  ): void {
    const searchTerm = options.q?.trim().toLowerCase();
    if (searchTerm) {
      const likePattern = `%${searchTerm}%`;
      conditions.push(
        sql`(
          lower(${skills.slug}) LIKE ${likePattern}
          OR lower(${skills.name}) LIKE ${likePattern}
          OR lower(${skills.displayName}) LIKE ${likePattern}
          OR lower(coalesce(${skills.description}, '')) LIKE ${likePattern}
          OR lower(coalesce(${skills.shortDescription}, '')) LIKE ${likePattern}
          OR lower(coalesce(${skills.compatibility}, '')) LIKE ${likePattern}
        )`,
      );
    }
    if (options.source) {
      conditions.push(eq(skills.source, options.source.trim().toLowerCase()));
    }
    if (options.category) {
      conditions.push(eq(skills.category, options.category));
    }
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

  private getRegisteredSources(): Array<{ name: string; repoUrl: string }> {
    const sourceMap = new Map<string, string>();
    for (const adapter of this.adapters) {
      const normalizedName = adapter.sourceName.trim().toLowerCase();
      if (!normalizedName || sourceMap.has(normalizedName)) {
        continue;
      }
      sourceMap.set(normalizedName, adapter.repoUrl);
    }
    return Array.from(sourceMap.entries())
      .map(([name, repoUrl]) => ({ name, repoUrl }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  private getEnabledSources(): string[] {
    const sourceSettings = this.settingsService.getSkillSourcesEnabled();
    return this.getRegisteredSources()
      .map((source) => source.name)
      .filter((sourceName) => this.isSourceEnabled(sourceName, sourceSettings));
  }

  private isSourceEnabled(sourceName: string, sourceSettings: Record<string, boolean>): boolean {
    return sourceSettings[sourceName] !== false;
  }

  private requireKnownSourceName(sourceName: string): string {
    const normalized = this.requireNonEmpty(sourceName, 'sourceName').toLowerCase();
    const knownSources = new Set(this.getRegisteredSources().map((source) => source.name));
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
