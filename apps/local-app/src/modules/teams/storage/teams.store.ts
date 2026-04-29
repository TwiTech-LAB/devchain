import { randomUUID } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql, inArray } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  ConflictError,
  NotFoundError,
  StorageError,
  TeamMemberCapReachedError,
} from '../../../common/errors/error-types';
import { DB_CONNECTION } from '../../storage/db/db.provider';
import {
  teams,
  teamMembers,
  teamProfiles,
  teamProfileConfigs,
  agentProfiles,
  profileProviderConfigs,
} from '../../storage/db/schema';
import { getRawSqliteClient } from '../../storage/db/sqlite-raw';
import { isSqliteUniqueConstraint } from '../../storage/local/helpers/storage-helpers';
import type { ListOptions, ListResult } from '../../storage/interfaces/storage.interface';
import type { Team, TeamMember, CreateTeam, UpdateTeam } from '../../storage/models/domain.models';

export interface TeamsListOptions extends ListOptions {
  q?: string;
}

@Injectable()
export class TeamsStore {
  constructor(@Inject(DB_CONNECTION) private readonly db: BetterSQLite3Database) {}

  async createTeam(data: CreateTeam): Promise<Team> {
    const sqlite = getRawSqliteClient(this.db);
    if (!sqlite || typeof sqlite.exec !== 'function') {
      throw new StorageError('Unable to access underlying SQLite client for transaction control');
    }

    const id = randomUUID();
    const now = new Date().toISOString();

    sqlite.exec('BEGIN IMMEDIATE TRANSACTION');

    try {
      await this.db.insert(teams).values({
        id,
        projectId: data.projectId,
        name: data.name,
        description: data.description ?? null,
        teamLeadAgentId: data.teamLeadAgentId ?? null,
        maxMembers: data.maxMembers ?? 5,
        maxConcurrentTasks: data.maxConcurrentTasks ?? data.maxMembers ?? 5,
        allowTeamLeadCreateAgents: data.allowTeamLeadCreateAgents ?? false,
        createdAt: now,
        updatedAt: now,
      });

      if (data.memberAgentIds.length > 0) {
        await this.db.insert(teamMembers).values(
          data.memberAgentIds.map((agentId) => ({
            teamId: id,
            agentId,
            createdAt: now,
          })),
        );
      }

      if (data.profileIds && data.profileIds.length > 0) {
        await this.db.insert(teamProfiles).values(
          data.profileIds.map((profileId) => ({
            teamId: id,
            profileId,
            createdAt: now,
          })),
        );
      }

      if (data.profileConfigSelections && data.profileConfigSelections.length > 0) {
        await this.writeTeamProfileConfigs(id, data.profileConfigSelections);
      }

      sqlite.exec('COMMIT');
    } catch (error) {
      try {
        sqlite.exec('ROLLBACK');
      } catch {
        // Rollback may fail if already committed; safe to ignore
      }

      if (isSqliteUniqueConstraint(error)) {
        const msg =
          'message' in (error as object) ? String((error as { message?: unknown }).message) : '';
        if (msg.includes('team_members')) {
          throw new StorageError('Duplicate agent in team members', {
            field: 'memberAgentIds',
          });
        }
        throw new ConflictError(`Team name "${data.name}" already exists in this project`, {
          field: 'name',
          projectId: data.projectId,
        });
      }

      throw error;
    }

    return {
      id,
      projectId: data.projectId,
      name: data.name,
      description: data.description ?? null,
      teamLeadAgentId: data.teamLeadAgentId ?? null,
      maxMembers: data.maxMembers ?? 5,
      maxConcurrentTasks: data.maxConcurrentTasks ?? data.maxMembers ?? 5,
      allowTeamLeadCreateAgents: data.allowTeamLeadCreateAgents ?? false,
      createdAt: now,
      updatedAt: now,
    };
  }

  async getTeam(id: string): Promise<
    | (Team & {
        members: TeamMember[];
        profileIds: string[];
        profileConfigSelections: Array<{ profileId: string; configIds: string[] }>;
      })
    | null
  > {
    const [row] = await this.db.select().from(teams).where(eq(teams.id, id));
    if (!row) return null;

    const members = await this.db.select().from(teamMembers).where(eq(teamMembers.teamId, id));
    const profileRows = await this.db
      .select()
      .from(teamProfiles)
      .where(eq(teamProfiles.teamId, id));
    const profileConfigSelections = await this.listProfileConfigSelections(id);

    return {
      ...this.toTeam(row),
      members: members.map(this.toTeamMember),
      profileIds: profileRows.map((r) => r.profileId),
      profileConfigSelections,
    };
  }

  async listTeams(
    projectId: string,
    options: TeamsListOptions = {},
  ): Promise<ListResult<Team & { memberCount: number }>> {
    const limit = options.limit || 100;
    const offset = options.offset || 0;

    const whereClause = options.q
      ? and(
          eq(teams.projectId, projectId),
          sql`${teams.name} LIKE ${'%' + options.q + '%'} COLLATE NOCASE`,
        )
      : eq(teams.projectId, projectId);

    const rows = await this.db.select().from(teams).where(whereClause).limit(limit).offset(offset);

    const countResult = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(teams)
      .where(whereClause);
    const total = Number(countResult[0]?.count ?? 0);

    // Get member counts for all returned teams
    const teamIds = rows.map((r) => r.id);
    const memberCounts: Record<string, number> = {};

    if (teamIds.length > 0) {
      const counts = await this.db
        .select({
          teamId: teamMembers.teamId,
          count: sql<number>`count(*)`,
        })
        .from(teamMembers)
        .where(inArray(teamMembers.teamId, teamIds))
        .groupBy(teamMembers.teamId);

      for (const c of counts) {
        memberCounts[c.teamId] = Number(c.count);
      }
    }

    return {
      items: rows.map((row) => ({
        ...this.toTeam(row),
        memberCount: memberCounts[row.id] ?? 0,
      })),
      total,
      limit,
      offset,
    };
  }

  async findTeamByExactName(projectId: string, name: string): Promise<Team | null> {
    const [row] = await this.db
      .select()
      .from(teams)
      .where(and(eq(teams.projectId, projectId), sql`${teams.name} = ${name} COLLATE NOCASE`))
      .limit(1);

    return row ? this.toTeam(row) : null;
  }

  async updateTeam(id: string, data: UpdateTeam): Promise<Team> {
    const sqlite = getRawSqliteClient(this.db);
    if (!sqlite || typeof sqlite.exec !== 'function') {
      throw new StorageError('Unable to access underlying SQLite client for transaction control');
    }

    const now = new Date().toISOString();

    sqlite.exec('BEGIN IMMEDIATE TRANSACTION');

    try {
      // Build update set
      const updateSet: Record<string, unknown> = { updatedAt: now };
      if (data.name !== undefined) updateSet.name = data.name;
      if (data.description !== undefined) updateSet.description = data.description;
      if (data.teamLeadAgentId !== undefined) updateSet.teamLeadAgentId = data.teamLeadAgentId;
      if (data.maxMembers !== undefined) updateSet.maxMembers = data.maxMembers;
      if (data.maxConcurrentTasks !== undefined)
        updateSet.maxConcurrentTasks = data.maxConcurrentTasks;
      if (data.allowTeamLeadCreateAgents !== undefined)
        updateSet.allowTeamLeadCreateAgents = data.allowTeamLeadCreateAgents;

      const [updated] = await this.db
        .update(teams)
        .set(updateSet)
        .where(eq(teams.id, id))
        .returning();

      if (!updated) {
        throw new NotFoundError('Team', id);
      }

      // Replace all members if memberAgentIds provided
      if (data.memberAgentIds !== undefined) {
        await this.db.delete(teamMembers).where(eq(teamMembers.teamId, id));

        if (data.memberAgentIds.length > 0) {
          await this.db.insert(teamMembers).values(
            data.memberAgentIds.map((agentId) => ({
              teamId: id,
              agentId,
              createdAt: now,
            })),
          );
        }
      }

      if (data.profileIds !== undefined) {
        // Diff-based: only remove/add changed profiles to preserve allowlist rows on retained profiles
        const existingRows = await this.db
          .select({ profileId: teamProfiles.profileId })
          .from(teamProfiles)
          .where(eq(teamProfiles.teamId, id));
        const existingSet = new Set(existingRows.map((r) => r.profileId));
        const nextSet = new Set(data.profileIds);

        const toRemove = [...existingSet].filter((pid) => !nextSet.has(pid));
        const toAdd = [...nextSet].filter((pid) => !existingSet.has(pid));

        if (toRemove.length > 0) {
          await this.db
            .delete(teamProfiles)
            .where(and(eq(teamProfiles.teamId, id), inArray(teamProfiles.profileId, toRemove)));
        }
        if (toAdd.length > 0) {
          await this.db.insert(teamProfiles).values(
            toAdd.map((profileId) => ({
              teamId: id,
              profileId,
              createdAt: now,
            })),
          );
        }
      }

      if (data.profileConfigSelections !== undefined) {
        await this.writeTeamProfileConfigs(id, data.profileConfigSelections);
      }

      sqlite.exec('COMMIT');

      return this.toTeam(updated);
    } catch (error) {
      try {
        sqlite.exec('ROLLBACK');
      } catch {
        // Rollback may fail if already committed; safe to ignore
      }

      if (error instanceof NotFoundError) throw error;

      if (isSqliteUniqueConstraint(error)) {
        const msg =
          'message' in (error as object) ? String((error as { message?: unknown }).message) : '';
        if (msg.includes('team_members')) {
          throw new StorageError('Duplicate agent in team members', {
            field: 'memberAgentIds',
          });
        }
        throw new ConflictError(
          `Team name "${data.name ?? '(unchanged)'}" already exists in this project`,
          { field: 'name' },
        );
      }

      throw error;
    }
  }

  async deleteTeam(id: string): Promise<void> {
    // Members cascade via FK on delete
    await this.db.delete(teams).where(eq(teams.id, id));
  }

  async listTeamsByAgent(agentId: string): Promise<Team[]> {
    const memberRows = await this.db
      .select({ teamId: teamMembers.teamId })
      .from(teamMembers)
      .where(eq(teamMembers.agentId, agentId));

    if (memberRows.length === 0) return [];

    const teamIds = memberRows.map((r) => r.teamId);
    const rows = await this.db.select().from(teams).where(inArray(teams.id, teamIds));

    return rows.map(this.toTeam);
  }

  async deleteTeamsByProject(projectId: string): Promise<void> {
    const projectTeams = await this.db
      .select({ id: teams.id })
      .from(teams)
      .where(eq(teams.projectId, projectId));

    const teamIds = projectTeams.map((t) => t.id);

    if (teamIds.length > 0) {
      await this.db.delete(teamProfileConfigs).where(inArray(teamProfileConfigs.teamId, teamIds));
      await this.db.delete(teamProfiles).where(inArray(teamProfiles.teamId, teamIds));
      await this.db.delete(teamMembers).where(inArray(teamMembers.teamId, teamIds));
      await this.db.delete(teams).where(inArray(teams.id, teamIds));
    }
  }

  async deleteTeamsByIds(ids: string[]): Promise<void> {
    if (ids.length === 0) return;

    const sqlite = getRawSqliteClient(this.db);
    if (!sqlite || typeof sqlite.exec !== 'function') {
      throw new StorageError('Unable to access underlying SQLite client for transaction control');
    }

    sqlite.exec('BEGIN IMMEDIATE TRANSACTION');
    try {
      await this.db.delete(teamProfileConfigs).where(inArray(teamProfileConfigs.teamId, ids));
      await this.db.delete(teamProfiles).where(inArray(teamProfiles.teamId, ids));
      await this.db.delete(teamMembers).where(inArray(teamMembers.teamId, ids));
      await this.db.delete(teams).where(inArray(teams.id, ids));
      sqlite.exec('COMMIT');
    } catch (error) {
      try {
        sqlite.exec('ROLLBACK');
      } catch {
        // safe to ignore
      }
      throw error;
    }
  }

  async getTeamLeadTeams(agentId: string): Promise<Team[]> {
    const rows = await this.db.select().from(teams).where(eq(teams.teamLeadAgentId, agentId));

    return rows.map(this.toTeam);
  }

  async listProfilesForTeam(teamId: string): Promise<string[]> {
    const rows = await this.db
      .select({ profileId: teamProfiles.profileId })
      .from(teamProfiles)
      .where(eq(teamProfiles.teamId, teamId));
    return rows.map((r) => r.profileId);
  }

  async listConfigsForTeam(teamId: string): Promise<
    Array<{
      id: string;
      profileId: string;
      providerId: string;
      name: string;
      description: string | null;
      options: string | null;
      env: string | null;
      position: number;
    }>
  > {
    const rows = await this.db
      .select({
        id: profileProviderConfigs.id,
        profileId: profileProviderConfigs.profileId,
        providerId: profileProviderConfigs.providerId,
        name: profileProviderConfigs.name,
        description: profileProviderConfigs.description,
        options: profileProviderConfigs.options,
        env: profileProviderConfigs.env,
        position: profileProviderConfigs.position,
      })
      .from(teamProfiles)
      .innerJoin(agentProfiles, eq(teamProfiles.profileId, agentProfiles.id))
      .innerJoin(profileProviderConfigs, eq(profileProviderConfigs.profileId, agentProfiles.id))
      .innerJoin(teams, eq(teamProfiles.teamId, teams.id))
      .where(
        and(
          eq(teamProfiles.teamId, teamId),
          eq(agentProfiles.projectId, teams.projectId),
          sql`(
            NOT EXISTS (
              SELECT 1 FROM team_profile_configs tpc
              WHERE tpc.team_id = ${teamProfiles.teamId}
                AND tpc.profile_id = ${teamProfiles.profileId}
            )
            OR EXISTS (
              SELECT 1 FROM team_profile_configs tpc
              WHERE tpc.team_id = ${teamProfiles.teamId}
                AND tpc.profile_id = ${teamProfiles.profileId}
                AND tpc.provider_config_id = ${profileProviderConfigs.id}
            )
          )`,
        ),
      );
    return rows;
  }

  async createTeamAgentAtomicCapped(opts: {
    teamId: string;
    maxMembers: number;
    teamLeadAgentId: string | null;
    createAgentFn: () => Promise<import('../../storage/models/domain.models').Agent>;
  }): Promise<import('../../storage/models/domain.models').Agent> {
    const sqlite = getRawSqliteClient(this.db);
    if (!sqlite || typeof sqlite.exec !== 'function') {
      throw new StorageError('Unable to access underlying SQLite client for transaction control');
    }
    sqlite.exec('BEGIN IMMEDIATE TRANSACTION');
    try {
      const countResult = sqlite
        .prepare(
          `SELECT COUNT(*) as cnt FROM team_members
           WHERE team_id = ?
             AND (? IS NULL OR agent_id <> ?)`,
        )
        .get(opts.teamId, opts.teamLeadAgentId, opts.teamLeadAgentId) as { cnt: number };

      if (countResult.cnt >= opts.maxMembers) {
        throw new TeamMemberCapReachedError(opts.maxMembers, countResult.cnt);
      }

      const agent = await opts.createAgentFn();
      const now = new Date().toISOString();
      await this.db.insert(teamMembers).values({
        teamId: opts.teamId,
        agentId: agent.id,
        createdAt: now,
      });
      sqlite.exec('COMMIT');
      return agent;
    } catch (error) {
      try {
        sqlite.exec('ROLLBACK');
      } catch {
        /* safe to ignore */
      }
      throw error;
    }
  }

  async countBusyTeamMembers(teamId: string, teamLeadAgentId: string | null): Promise<number> {
    const sqlite = getRawSqliteClient(this.db);
    if (!sqlite || typeof sqlite.exec !== 'function') {
      throw new StorageError('Unable to access underlying SQLite client for transaction control');
    }
    const result = sqlite
      .prepare(
        `SELECT COUNT(DISTINCT e.agent_id) as cnt
         FROM epics e
         JOIN statuses s ON e.status_id = s.id
         JOIN team_members tm ON tm.agent_id = e.agent_id
         WHERE tm.team_id = ?
           AND e.parent_id IS NOT NULL
           AND lower(s.label) <> 'done'
           AND (? IS NULL OR e.agent_id <> ?)`,
      )
      .get(teamId, teamLeadAgentId, teamLeadAgentId) as { cnt: number };
    return result.cnt;
  }

  async replaceTeamProfileConfigs(
    teamId: string,
    selections: Array<{ profileId: string; configIds: string[] }>,
  ): Promise<void> {
    const sqlite = getRawSqliteClient(this.db);
    if (!sqlite || typeof sqlite.exec !== 'function') {
      throw new StorageError('Unable to access underlying SQLite client for transaction control');
    }
    sqlite.exec('BEGIN IMMEDIATE TRANSACTION');
    try {
      await this.writeTeamProfileConfigs(teamId, selections);
      sqlite.exec('COMMIT');
    } catch (error) {
      try {
        sqlite.exec('ROLLBACK');
      } catch {
        /* safe to ignore */
      }
      throw error;
    }
  }

  async listProfileConfigSelections(
    teamId: string,
  ): Promise<Array<{ profileId: string; configIds: string[] }>> {
    const rows = await this.db
      .select({
        profileId: teamProfileConfigs.profileId,
        providerConfigId: teamProfileConfigs.providerConfigId,
      })
      .from(teamProfileConfigs)
      .where(eq(teamProfileConfigs.teamId, teamId));

    const map = new Map<string, string[]>();
    for (const row of rows) {
      const existing = map.get(row.profileId) ?? [];
      existing.push(row.providerConfigId);
      map.set(row.profileId, existing);
    }

    return Array.from(map.entries()).map(([profileId, configIds]) => ({ profileId, configIds }));
  }

  private async writeTeamProfileConfigs(
    teamId: string,
    selections: Array<{ profileId: string; configIds: string[] }>,
  ): Promise<void> {
    await this.db.delete(teamProfileConfigs).where(eq(teamProfileConfigs.teamId, teamId));

    const rows: Array<{
      teamId: string;
      profileId: string;
      providerConfigId: string;
      createdAt: string;
    }> = [];
    const now = new Date().toISOString();
    for (const sel of selections) {
      if (sel.configIds.length === 0) continue;
      for (const configId of sel.configIds) {
        rows.push({ teamId, profileId: sel.profileId, providerConfigId: configId, createdAt: now });
      }
    }

    if (rows.length > 0) {
      await this.db.insert(teamProfileConfigs).values(rows);
    }
  }

  private toTeam = (row: typeof teams.$inferSelect): Team => ({
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    description: row.description,
    teamLeadAgentId: row.teamLeadAgentId,
    maxMembers: row.maxMembers,
    maxConcurrentTasks: row.maxConcurrentTasks,
    allowTeamLeadCreateAgents: row.allowTeamLeadCreateAgents,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

  private toTeamMember = (row: typeof teamMembers.$inferSelect): TeamMember => ({
    teamId: row.teamId,
    agentId: row.agentId,
    createdAt: row.createdAt,
  });
}
