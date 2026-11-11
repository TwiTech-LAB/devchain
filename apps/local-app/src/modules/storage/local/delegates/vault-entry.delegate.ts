import { randomUUID } from 'node:crypto';
import type { VaultEntryStorage } from '../../interfaces/storage.interface';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../../../common/errors/error-types';
import { createLogger } from '../../../../common/logging/logger';
import type {
  CreateVaultEntry,
  UpdateVaultEntry,
  VaultAccessDecision,
  VaultEntry,
  VaultEntryGrant,
  VaultEntryKind,
  VaultFamilyAccess,
  VaultGrant,
  VaultGrantAccess,
  VaultProjectGrantChange,
  VaultResolvedEntry,
  VaultSnapshot,
  VaultUseFamilyApproval,
} from '../../models/domain.models';
import { BaseStorageDelegate, type StorageDelegateContext } from './base-storage.delegate';

const logger = createLogger('VaultEntryStorageDelegate');

interface VaultEntryRow {
  id: string;
  project_id: string | null;
  name: string;
  kind: string;
  description: string;
  revision: number;
  approval_required: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

/** The values-free entry columns that a Vault snapshot carries. */
const SNAPSHOT_ENTRY_COLUMNS =
  'id, project_id, name, kind, description, revision, approval_required';
type SnapshotEntryRow = Pick<
  VaultEntryRow,
  'id' | 'project_id' | 'name' | 'kind' | 'description' | 'revision' | 'approval_required'
>;
type SnapshotGrantRow = { entry_id: string; project_id: string; family_slug: string | null };
type SnapshotAccessRow = { project_id: string; family_slug: string | null };
type SnapshotApprovalRow = { entry_id: string; project_id: string; family_slug: string };
type ApprovalRow = SnapshotApprovalRow & { created_at: string };

/** `family_matched` of row `alias`: a null slug, or a profile of its project has the slug. */
function familyMatched(alias: 'a' | 'g'): string {
  return `CASE WHEN ${alias}.family_slug IS NULL OR ${profileHasFamily(alias)}
    THEN 1 ELSE 0 END AS family_matched`;
}

/**
 * An access row `a` admits `@familySlug` (normalized): a null row admits every agent,
 * a profile without a family included.
 */
const ACCESS_COVERS_FAMILY = '(a.family_slug IS NULL OR a.family_slug = @familySlug)';

function normalizedFamily(familySlug: string | null): string | null {
  return familySlug?.trim().toLowerCase() || null;
}

/** A profile of the row's project has the row's (normalized) family slug. */
function profileHasFamily(alias: 'a' | 'g' | 'u'): string {
  return `EXISTS (
    SELECT 1 FROM agent_profiles p
    WHERE p.project_id = ${alias}.project_id AND lower(trim(p.family_slug)) = ${alias}.family_slug
  )`;
}

/** An approval always names one family: an agent without a family is never approved by family. */
function requireApprovalFamily(familySlug: string): string {
  const slug = normalizedFamily(familySlug);
  if (!slug) {
    throw new ValidationError('A family approval needs a family.', {
      code: 'VAULT_APPROVAL_FAMILY_INVALID',
    });
  }
  return slug;
}

// Never select `value_ciphertext` here: metadata reads feed REST responses.
const SELECT_ENTRY = `SELECT id, project_id, name, kind, description, revision,
  approval_required, last_used_at, created_at, updated_at FROM vault_entries`;

/** Vault entry rows and grants. Encryption and name rules live in the vault module. */
export class VaultEntryStorageDelegate extends BaseStorageDelegate implements VaultEntryStorage {
  constructor(context: StorageDelegateContext) {
    super(context);
  }

  async listVaultEntries(filter?: { projectId?: string }): Promise<VaultEntry[]> {
    const rows = filter?.projectId
      ? (this.rawClient
          .prepare(
            `${SELECT_ENTRY} WHERE project_id IS NULL OR project_id = ?
             ORDER BY name, project_id IS NOT NULL`,
          )
          .all(filter.projectId) as VaultEntryRow[])
      : (this.rawClient
          .prepare(`${SELECT_ENTRY} ORDER BY name, project_id IS NOT NULL, project_id`)
          .all() as VaultEntryRow[]);
    return rows.map(mapEntry);
  }

  async getVaultEntry(id: string): Promise<VaultEntry> {
    return mapEntry(this.requireEntrySync(id));
  }

  async createVaultEntry(data: CreateVaultEntry): Promise<VaultEntry> {
    return this.txRunner.runImmediateQueuedOrJoin(() => {
      const owner = data.projects.length === 1 ? data.projects[0].projectId : null;
      if (owner) this.requireProjectSync(owner);
      const now = new Date().toISOString();
      this.translateNameConflict(data.name, owner, () =>
        this.rawClient
          .prepare(
            `INSERT INTO vault_entries
              (id, project_id, name, kind, description, value_ciphertext, revision,
               approval_required, last_used_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 1, ?, NULL, ?, ?)`,
          )
          .run(
            data.id,
            owner,
            data.name,
            data.kind,
            data.description,
            data.valueCiphertext,
            data.approvalRequired ? 1 : 0,
            now,
            now,
          ),
      );
      for (const project of data.projects) {
        this.replaceProjectGrantsSync(data.id, project.projectId, project, now);
      }
      logger.info(
        {
          entryId: data.id,
          kind: data.kind,
          owner: owner ? 'project' : 'global',
          projects: data.projects.length,
        },
        'Created vault entry',
      );
      return mapEntry(this.requireEntrySync(data.id));
    });
  }

  async updateVaultEntry(id: string, data: UpdateVaultEntry): Promise<VaultEntry> {
    return this.txRunner.runImmediateQueuedOrJoin(() => {
      const current = this.requireEntrySync(id);
      const name = data.name ?? current.name;
      const description = data.description ?? current.description;
      const owner =
        current.project_id &&
        data.projects?.some((project) => project.projectId !== current.project_id)
          ? null
          : current.project_id;
      const approvalRequired = data.approvalRequired ?? current.approval_required === 1;
      const now = new Date().toISOString();
      if (
        name !== current.name ||
        description !== current.description ||
        owner !== current.project_id ||
        approvalRequired !== (current.approval_required === 1)
      ) {
        // The revision tracks what a session receives (name, value), not the owner or the flag.
        const revision = name === current.name ? current.revision : current.revision + 1;
        this.translateNameConflict(name, owner, () =>
          this.rawClient
            .prepare(
              `UPDATE vault_entries SET name = ?, description = ?, project_id = ?, revision = ?,
                 approval_required = ?, updated_at = ? WHERE id = ?`,
            )
            .run(name, description, owner, revision, approvalRequired ? 1 : 0, now, id),
        );
      }
      if (data.projects) {
        const listed = data.projects.map((project) => project.projectId);
        const keep =
          listed.length === 0 ? '' : ` AND project_id NOT IN (${listed.map(() => '?').join(', ')})`;
        this.rawClient
          .prepare(`DELETE FROM vault_entry_grants WHERE entry_id = ?${keep}`)
          .run(id, ...listed);
        for (const project of data.projects) {
          this.replaceProjectGrantsSync(id, project.projectId, project, now);
        }
      }
      logger.info(
        {
          entryId: id,
          ownerChanged: owner !== current.project_id,
          approvalRequired,
          projects: data.projects?.length,
        },
        'Updated vault entry metadata',
      );
      return mapEntry(this.requireEntrySync(id));
    });
  }

  async replaceVaultEntryValue(id: string, valueCiphertext: string): Promise<VaultEntry> {
    return this.txRunner.runImmediateQueuedOrJoin(() => {
      this.requireEntrySync(id);
      this.rawClient
        .prepare(
          `UPDATE vault_entries SET value_ciphertext = ?, revision = revision + 1, updated_at = ?
           WHERE id = ?`,
        )
        .run(valueCiphertext, new Date().toISOString(), id);
      logger.info({ entryId: id }, 'Replaced vault entry value');
      return mapEntry(this.requireEntrySync(id));
    });
  }

  async deleteVaultEntry(id: string): Promise<void> {
    return this.txRunner.runImmediateQueuedOrJoin(() => {
      const result = this.rawClient.prepare('DELETE FROM vault_entries WHERE id = ?').run(id);
      if (result.changes === 0) throw new NotFoundError('Vault entry', id);
      logger.info({ entryId: id }, 'Deleted vault entry');
    });
  }

  async listVaultEntryGrants(entryId: string): Promise<VaultEntryGrant[]> {
    this.requireEntrySync(entryId);
    return this.listGrantsSync(entryId);
  }

  async listVaultGrants(filter?: { projectId?: string }): Promise<VaultGrant[]> {
    return this.selectGrantsSync(filter?.projectId ? { projectId: filter.projectId } : {});
  }

  async setVaultProjectGrants(
    projectId: string,
    entries: VaultProjectGrantChange[],
    access?: VaultGrantAccess,
  ): Promise<VaultGrant[]> {
    return this.txRunner.runImmediateQueuedOrJoin(() => {
      this.requireProjectSync(projectId);
      if (access) this.replaceFamilyAccessSync(projectId, access);
      const now = new Date().toISOString();
      for (const change of entries) {
        this.requireGrantableSync(this.requireEntrySync(change.entryId), projectId);
        this.replaceProjectGrantsSync(change.entryId, projectId, change, now);
      }
      logger.info({ projectId, entries: entries.length }, 'Set vault project grants');
      return this.selectGrantsSync({ projectId });
    });
  }

  async setVaultEntryProjectGrants(
    entryId: string,
    projectId: string,
    access: VaultGrantAccess,
  ): Promise<VaultEntryGrant[]> {
    return this.txRunner.runImmediateQueuedOrJoin(() => {
      this.requireGrantableSync(this.requireEntrySync(entryId), projectId);
      this.replaceProjectGrantsSync(entryId, projectId, access, new Date().toISOString());
      return this.listGrantsSync(entryId);
    });
  }

  async listVaultUseFamilyApprovals(filter?: {
    entryId?: string;
    projectId?: string;
  }): Promise<VaultUseFamilyApproval[]> {
    return this.selectApprovalsSync(filter ?? {});
  }

  async addVaultUseFamilyApproval(
    entryId: string,
    projectId: string,
    familySlug: string,
  ): Promise<VaultUseFamilyApproval[]> {
    return this.txRunner.runImmediateQueuedOrJoin(() => {
      const slug = requireApprovalFamily(familySlug);
      this.requireGrantableSync(this.requireEntrySync(entryId), projectId);
      this.requireProjectSync(projectId);
      this.rawClient
        .prepare(
          `INSERT INTO vault_use_family_approvals (id, entry_id, project_id, family_slug, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(entry_id, project_id, family_slug) DO NOTHING`,
        )
        .run(randomUUID(), entryId, projectId, slug, new Date().toISOString());
      logger.info({ entryId, projectId }, 'Added vault use family approval');
      return this.selectApprovalsSync({ entryId });
    });
  }

  async removeVaultUseFamilyApproval(
    entryId: string,
    projectId: string,
    familySlug: string,
  ): Promise<VaultUseFamilyApproval[]> {
    return this.txRunner.runImmediateQueuedOrJoin(() => {
      const slug = requireApprovalFamily(familySlug);
      this.requireEntrySync(entryId);
      this.rawClient
        .prepare(
          `DELETE FROM vault_use_family_approvals
           WHERE entry_id = ? AND project_id = ? AND family_slug = ?`,
        )
        .run(entryId, projectId, slug);
      logger.info({ entryId, projectId }, 'Removed vault use family approval');
      return this.selectApprovalsSync({ entryId });
    });
  }

  async listVaultFamilyAccess(filter?: { projectId?: string }): Promise<VaultFamilyAccess[]> {
    return this.selectFamilyAccessSync(filter?.projectId ?? null);
  }

  async setVaultFamilyAccess(
    projectId: string,
    access: VaultGrantAccess,
  ): Promise<VaultFamilyAccess[]> {
    return this.txRunner.runImmediateQueuedOrJoin(() => {
      this.requireProjectSync(projectId);
      this.replaceFamilyAccessSync(projectId, access);
      return this.selectFamilyAccessSync(projectId);
    });
  }

  async getVaultAccessDecision(
    projectId: string,
    familySlug: string | null,
  ): Promise<VaultAccessDecision> {
    const row = this.rawClient
      .prepare(
        `SELECT COUNT(*) AS total,
           SUM(CASE WHEN ${ACCESS_COVERS_FAMILY} THEN 1 ELSE 0 END) AS covering
         FROM vault_family_access a WHERE a.project_id = @projectId`,
      )
      .get({ projectId, familySlug: normalizedFamily(familySlug) }) as {
      total: number;
      covering: number | null;
    };
    if (row.total === 0) return 'not_enabled';
    return row.covering ? 'granted' : 'denied';
  }

  async addVaultEntryGrant(
    entryId: string,
    projectId: string,
    familySlug: string | null,
  ): Promise<VaultEntryGrant[]> {
    return this.txRunner.runImmediateQueuedOrJoin(() => {
      this.requireGrantableSync(this.requireEntrySync(entryId), projectId);
      this.requireProjectSync(projectId);
      const now = new Date().toISOString();
      if (familySlug === null) {
        // "All agents" covers every family row, so it replaces them.
        this.replaceProjectGrantsSync(entryId, projectId, { mode: 'all' }, now);
        return this.listGrantsSync(entryId);
      }
      const coveredByAll = this.rawClient
        .prepare(
          `SELECT 1 FROM vault_entry_grants
           WHERE entry_id = ? AND project_id = ? AND family_slug IS NULL`,
        )
        .get(entryId, projectId);
      const [slug] = this.requireProjectFamiliesSync(projectId, [familySlug], {
        held: `SELECT family_slug AS slug FROM vault_entry_grants
               WHERE entry_id = @entryId AND project_id = @projectId AND family_slug IS NOT NULL`,
        params: { entryId },
        code: 'VAULT_GRANT_UNKNOWN_FAMILY',
      });
      if (!coveredByAll) {
        this.rawClient
          .prepare(
            `INSERT INTO vault_entry_grants (id, entry_id, project_id, family_slug, created_at)
             SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (
               SELECT 1 FROM vault_entry_grants
               WHERE entry_id = ? AND project_id = ? AND family_slug = ?
             )`,
          )
          .run(randomUUID(), entryId, projectId, slug, now, entryId, projectId, slug);
      }
      logger.info({ entryId, projectId, mode: 'add-family' }, 'Added vault entry grant');
      return this.listGrantsSync(entryId);
    });
  }

  async resolveVaultGrantsForAgent(
    projectId: string,
    familySlug: string | null,
  ): Promise<VaultResolvedEntry[]> {
    const rows = this.rawClient
      .prepare(
        `SELECT DISTINCT e.id, e.project_id, e.name, e.kind, e.description, e.revision,
           e.approval_required
         FROM vault_entries e
         JOIN vault_entry_grants g ON g.entry_id = e.id AND g.project_id = @projectId
         WHERE (e.project_id IS NULL OR e.project_id = @projectId)
           AND (g.family_slug IS NULL OR g.family_slug = @familySlug)
           AND EXISTS (
             SELECT 1 FROM vault_family_access a
             WHERE a.project_id = @projectId AND ${ACCESS_COVERS_FAMILY}
           )
         ORDER BY e.name, e.project_id IS NULL`,
      )
      .all({ projectId, familySlug: normalizedFamily(familySlug) }) as Array<SnapshotEntryRow>;
    const byName = new Map<string, VaultResolvedEntry>();
    // Rows come project-owned first within each name, so the first row per name wins.
    for (const row of rows) {
      if (byName.has(row.name)) continue;
      byName.set(row.name, {
        id: row.id,
        name: row.name,
        kind: row.kind as VaultEntryKind,
        description: row.description,
        revision: row.revision,
        owner: row.project_id ? 'project' : 'global',
        approvalRequired: row.approval_required === 1,
      });
    }
    return [...byName.values()];
  }

  /** Sealed values for the launch path only; the vault module decrypts them. */
  async readVaultEntryCiphertexts(
    ids: readonly string[],
  ): Promise<Array<{ id: string; valueCiphertext: string }>> {
    if (ids.length === 0) return [];
    return this.rawClient
      .prepare(
        `SELECT id, value_ciphertext AS valueCiphertext FROM vault_entries
         WHERE id IN (${ids.map(() => '?').join(', ')})`,
      )
      .all(...ids) as Array<{ id: string; valueCiphertext: string }>;
  }

  async markVaultEntriesUsed(ids: readonly string[], at: string): Promise<void> {
    if (ids.length === 0) return;
    return this.txRunner.runImmediateQueuedOrJoin(() => {
      this.rawClient
        .prepare(
          `UPDATE vault_entries SET last_used_at = ?
           WHERE id IN (${ids.map(() => '?').join(', ')})`,
        )
        .run(at, ...ids);
    });
  }

  async readVaultSnapshot(): Promise<VaultSnapshot> {
    const entries = this.rawClient
      .prepare(`SELECT ${SNAPSHOT_ENTRY_COLUMNS} FROM vault_entries ORDER BY id`)
      .all() as Array<SnapshotEntryRow>;
    const grants = this.rawClient
      .prepare(
        `SELECT entry_id, project_id, family_slug FROM vault_entry_grants
         ORDER BY entry_id, project_id, family_slug`,
      )
      .all() as SnapshotGrantRow[];
    const access = this.rawClient
      .prepare(
        `SELECT project_id, family_slug FROM vault_family_access
         ORDER BY project_id, family_slug`,
      )
      .all() as SnapshotAccessRow[];
    const approvals = this.rawClient
      .prepare(
        `SELECT entry_id, project_id, family_slug FROM vault_use_family_approvals
         ORDER BY entry_id, project_id, family_slug`,
      )
      .all() as SnapshotApprovalRow[];
    return {
      entries: entries.map(mapSnapshotEntry),
      grants: grants.map(mapSnapshotGrant),
      access: access.map(mapSnapshotAccess),
      approvals: approvals.map(mapSnapshotApproval),
    };
  }

  async readVaultPushSnapshot(projectIds: readonly string[]): Promise<VaultSnapshot> {
    if (projectIds.length === 0) return { entries: [], grants: [], access: [], approvals: [] };
    const inProjects = projectIds.map(() => '?').join(', ');
    const grants = this.rawClient
      .prepare(
        `SELECT g.entry_id, g.project_id, g.family_slug FROM vault_entry_grants g
         WHERE g.project_id IN (${inProjects})
           AND (g.family_slug IS NULL OR ${profileHasFamily('g')})
         ORDER BY g.entry_id, g.project_id, g.family_slug`,
      )
      .all(...projectIds) as SnapshotGrantRow[];
    const entryIds = [...new Set(grants.map((grant) => grant.entry_id))];
    const inEntries = entryIds.map(() => '?').join(', ');
    const entries =
      entryIds.length === 0
        ? []
        : (this.rawClient
            .prepare(
              `SELECT ${SNAPSHOT_ENTRY_COLUMNS} FROM vault_entries
               WHERE id IN (${inEntries}) ORDER BY id`,
            )
            .all(...entryIds) as Array<SnapshotEntryRow>);
    // All rows, matched or not: the VM must decide `denied` and `not_enabled` as home does.
    const access = this.rawClient
      .prepare(
        `SELECT project_id, family_slug FROM vault_family_access
         WHERE project_id IN (${inProjects})
         ORDER BY project_id, family_slug`,
      )
      .all(...projectIds) as SnapshotAccessRow[];
    const approvals =
      entryIds.length === 0
        ? []
        : (this.rawClient
            .prepare(
              `SELECT u.entry_id, u.project_id, u.family_slug FROM vault_use_family_approvals u
               WHERE u.project_id IN (${inProjects})
                 AND u.entry_id IN (${inEntries})
                 AND ${profileHasFamily('u')}
               ORDER BY u.entry_id, u.project_id, u.family_slug`,
            )
            .all(...projectIds, ...entryIds) as SnapshotApprovalRow[]);
    return {
      entries: entries.map(mapSnapshotEntry),
      grants: grants.map(mapSnapshotGrant),
      access: access.map(mapSnapshotAccess),
      approvals: approvals.map(mapSnapshotApproval),
    };
  }

  async replaceVaultSnapshot(snapshot: VaultSnapshot): Promise<void> {
    return this.txRunner.runImmediateQueuedOrJoin(() => {
      const projectIds = new Set([
        ...snapshot.entries.flatMap((entry) => (entry.projectId ? [entry.projectId] : [])),
        ...snapshot.grants.map((grant) => grant.projectId),
        ...snapshot.access.map((row) => row.projectId),
        ...snapshot.approvals.map((row) => row.projectId),
      ]);
      const missing = [...projectIds].filter(
        (id) => !this.rawClient.prepare('SELECT 1 FROM projects WHERE id = ?').get(id),
      );
      if (missing.length > 0) {
        throw new ConflictError('The Vault push names projects that this VM does not have.', {
          code: 'VAULT_SNAPSHOT_PROJECT_MISSING',
          projectIds: missing,
        });
      }

      const wanted = new Map(snapshot.entries.map((entry) => [entry.id, entry]));
      const current = this.rawClient
        .prepare('SELECT id, project_id, name FROM vault_entries')
        .all() as Array<Pick<VaultEntryRow, 'id' | 'project_id' | 'name'>>;
      const remove = this.rawClient.prepare('DELETE FROM vault_entries WHERE id = ?');
      // Entries that change owner or name first take a name no entry can have, so a swap
      // of two names inside one push does not hit the unique name indexes.
      const park = this.rawClient.prepare('UPDATE vault_entries SET name = ? WHERE id = ?');
      for (const row of current) {
        const next = wanted.get(row.id);
        if (!next) remove.run(row.id);
        else if (next.projectId !== row.project_id || next.name !== row.name)
          park.run(`\u0000${row.id}`, row.id);
      }

      const now = new Date().toISOString();
      // `value_ciphertext` stays empty: a VM never holds the data key or a sealed value.
      const upsert = this.rawClient.prepare(
        `INSERT INTO vault_entries
           (id, project_id, name, kind, description, value_ciphertext, revision,
            approval_required, last_used_at, created_at, updated_at)
         VALUES (@id, @projectId, @name, @kind, @description, '', @revision,
            @approvalRequired, NULL, @now, @now)
         ON CONFLICT(id) DO UPDATE SET
           project_id = excluded.project_id, name = excluded.name, kind = excluded.kind,
           description = excluded.description, revision = excluded.revision,
           approval_required = excluded.approval_required, updated_at = excluded.updated_at`,
      );
      for (const entry of snapshot.entries) {
        upsert.run({ ...entry, approvalRequired: entry.approvalRequired ? 1 : 0, now });
      }

      this.rawClient.prepare('DELETE FROM vault_entry_grants').run();
      for (const grant of snapshot.grants) {
        this.insertGrantSync(grant.entryId, grant.projectId, grant.familySlug, now);
      }
      this.rawClient.prepare('DELETE FROM vault_family_access').run();
      const insertAccess = this.rawClient.prepare(
        `INSERT INTO vault_family_access (id, project_id, family_slug, created_at)
         VALUES (?, ?, ?, ?)`,
      );
      for (const row of snapshot.access) {
        insertAccess.run(randomUUID(), row.projectId, row.familySlug, now);
      }
      this.rawClient.prepare('DELETE FROM vault_use_family_approvals').run();
      const insertApproval = this.rawClient.prepare(
        `INSERT INTO vault_use_family_approvals (id, entry_id, project_id, family_slug, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const row of snapshot.approvals) {
        insertApproval.run(randomUUID(), row.entryId, row.projectId, row.familySlug, now);
      }
      logger.info(
        {
          entries: snapshot.entries.length,
          grants: snapshot.grants.length,
          access: snapshot.access.length,
          approvals: snapshot.approvals.length,
        },
        'Replaced the Vault snapshot from home',
      );
    });
  }

  private replaceFamilyAccessSync(projectId: string, access: VaultGrantAccess): void {
    const slugs =
      access.mode === 'families'
        ? this.requireProjectFamiliesSync(projectId, access.familySlugs, {
            held: `SELECT family_slug AS slug FROM vault_family_access
                   WHERE project_id = @projectId AND family_slug IS NOT NULL`,
            params: {},
            code: 'VAULT_ACCESS_UNKNOWN_FAMILY',
          })
        : [];
    this.rawClient.prepare('DELETE FROM vault_family_access WHERE project_id = ?').run(projectId);
    const insert = this.rawClient.prepare(
      `INSERT INTO vault_family_access (id, project_id, family_slug, created_at)
       VALUES (?, ?, ?, ?)`,
    );
    const now = new Date().toISOString();
    if (access.mode === 'all') insert.run(randomUUID(), projectId, null, now);
    for (const slug of slugs) insert.run(randomUUID(), projectId, slug, now);
    logger.info({ projectId, mode: access.mode }, 'Set vault family access');
  }

  private requireEntrySync(id: string): VaultEntryRow {
    const row = this.rawClient.prepare(`${SELECT_ENTRY} WHERE id = ?`).get(id) as
      | VaultEntryRow
      | undefined;
    if (!row) throw new NotFoundError('Vault entry', id);
    return row;
  }

  private requireProjectSync(projectId: string): void {
    const row = this.rawClient.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId);
    if (!row) throw new NotFoundError('Project', projectId);
  }

  private requireGrantableSync(entry: VaultEntryRow, projectId: string): void {
    if (entry.project_id && entry.project_id !== projectId) {
      throw new ValidationError('A project entry can be granted only in its own project.', {
        code: 'VAULT_GRANT_OTHER_PROJECT',
      });
    }
  }

  /** Replaces the grants of one entry in one project; the caller checks the owner. */
  private replaceProjectGrantsSync(
    entryId: string,
    projectId: string,
    access: VaultGrantAccess,
    now: string,
  ): void {
    this.requireProjectSync(projectId);
    const slugs =
      access.mode === 'families'
        ? this.requireProjectFamiliesSync(projectId, access.familySlugs, {
            held: `SELECT family_slug AS slug FROM vault_entry_grants
                   WHERE entry_id = @entryId AND project_id = @projectId
                     AND family_slug IS NOT NULL`,
            params: { entryId },
            code: 'VAULT_GRANT_UNKNOWN_FAMILY',
          })
        : [];
    this.rawClient
      .prepare('DELETE FROM vault_entry_grants WHERE entry_id = ? AND project_id = ?')
      .run(entryId, projectId);
    if (access.mode === 'all') this.insertGrantSync(entryId, projectId, null, now);
    for (const slug of slugs) this.insertGrantSync(entryId, projectId, slug, now);
    logger.info({ entryId, projectId, mode: access.mode }, 'Set vault entry grants');
  }

  /**
   * Lowercase, de-duplicated slugs. Refuses a slug that no profile of the project has,
   * unless the `held` rows already hold it: a role can lose its last profile while the
   * user saves the rest of the access.
   */
  private requireProjectFamiliesSync(
    projectId: string,
    familySlugs: readonly string[],
    rule: { held: string; params: Record<string, string>; code: string },
  ): string[] {
    const wanted = [...new Set(familySlugs.map((slug) => slug.trim().toLowerCase()))];
    if (wanted.length === 0) {
      throw new ValidationError('Choose at least one family, or grant no access.', {
        code: 'VAULT_GRANT_FAMILIES_EMPTY',
      });
    }
    const known = new Set(
      (
        this.rawClient
          .prepare(
            `SELECT lower(trim(family_slug)) AS slug FROM agent_profiles
             WHERE project_id = @projectId AND family_slug IS NOT NULL
             UNION ${rule.held}`,
          )
          .all({ ...rule.params, projectId }) as Array<{ slug: string }>
      ).map((row) => row.slug),
    );
    const unknown = wanted.filter((slug) => !known.has(slug));
    if (unknown.length > 0) {
      throw new ValidationError('No profile of this project has these families.', {
        code: rule.code,
        familySlugs: unknown,
      });
    }
    return wanted;
  }

  private selectFamilyAccessSync(projectId: string | null): VaultFamilyAccess[] {
    const rows = this.rawClient
      .prepare(
        `SELECT a.project_id, a.family_slug, ${familyMatched('a')}
         FROM vault_family_access a
         WHERE (@projectId IS NULL OR a.project_id = @projectId)
         ORDER BY a.project_id, a.family_slug IS NOT NULL, a.family_slug`,
      )
      .all({ projectId }) as Array<{
      project_id: string;
      family_slug: string | null;
      family_matched: number;
    }>;
    return rows.map((row) => ({
      projectId: row.project_id,
      familySlug: row.family_slug,
      familyMatched: row.family_matched === 1,
    }));
  }

  private selectApprovalsSync(filter: {
    entryId?: string;
    projectId?: string;
  }): VaultUseFamilyApproval[] {
    const rows = this.rawClient
      .prepare(
        `SELECT entry_id, project_id, family_slug, created_at FROM vault_use_family_approvals
         WHERE (@entryId IS NULL OR entry_id = @entryId)
           AND (@projectId IS NULL OR project_id = @projectId)
         ORDER BY entry_id, project_id, family_slug`,
      )
      .all({
        entryId: filter.entryId ?? null,
        projectId: filter.projectId ?? null,
      }) as ApprovalRow[];
    return rows.map((row) => ({ ...mapSnapshotApproval(row), createdAt: row.created_at }));
  }

  private listGrantsSync(entryId: string): VaultEntryGrant[] {
    return this.selectGrantsSync({ entryId }).map(({ entryId: _entryId, ...grant }) => grant);
  }

  private selectGrantsSync(filter: { entryId?: string; projectId?: string }): VaultGrant[] {
    const rows = this.rawClient
      .prepare(
        `SELECT g.entry_id, g.project_id, g.family_slug, ${familyMatched('g')}
         FROM vault_entry_grants g
         WHERE (@entryId IS NULL OR g.entry_id = @entryId)
           AND (@projectId IS NULL OR g.project_id = @projectId)
         ORDER BY g.entry_id, g.project_id, g.family_slug IS NOT NULL, g.family_slug`,
      )
      .all({ entryId: filter.entryId ?? null, projectId: filter.projectId ?? null }) as Array<{
      entry_id: string;
      project_id: string;
      family_slug: string | null;
      family_matched: number;
    }>;
    return rows.map((row) => ({
      entryId: row.entry_id,
      projectId: row.project_id,
      familySlug: row.family_slug,
      familyMatched: row.family_matched === 1,
    }));
  }

  private insertGrantSync(
    entryId: string,
    projectId: string,
    familySlug: string | null,
    now: string,
  ): void {
    this.rawClient
      .prepare(
        `INSERT INTO vault_entry_grants (id, entry_id, project_id, family_slug, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), entryId, projectId, familySlug, now);
  }

  private translateNameConflict(name: string, owner: string | null, write: () => void): void {
    try {
      write();
    } catch (error) {
      if ((error as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new ConflictError(
          owner
            ? `Project ${this.projectNameSync(owner)} already has an entry named ${name}.`
            : `A shared entry named ${name} already exists.`,
          { code: 'VAULT_ENTRY_NAME_TAKEN' },
        );
      }
      throw error;
    }
  }

  private projectNameSync(projectId: string): string {
    const row = this.rawClient.prepare('SELECT name FROM projects WHERE id = ?').get(projectId) as
      | { name: string }
      | undefined;
    return row?.name ?? projectId;
  }
}

function mapEntry(row: VaultEntryRow): VaultEntry {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    kind: row.kind as VaultEntryKind,
    description: row.description,
    revision: row.revision,
    approvalRequired: row.approval_required === 1,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSnapshotEntry(row: SnapshotEntryRow): VaultSnapshot['entries'][number] {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    kind: row.kind as VaultEntryKind,
    description: row.description,
    revision: row.revision,
    approvalRequired: row.approval_required === 1,
  };
}

function mapSnapshotGrant(row: SnapshotGrantRow): VaultSnapshot['grants'][number] {
  return { entryId: row.entry_id, projectId: row.project_id, familySlug: row.family_slug };
}

function mapSnapshotAccess(row: SnapshotAccessRow): VaultSnapshot['access'][number] {
  return { projectId: row.project_id, familySlug: row.family_slug };
}

function mapSnapshotApproval(row: SnapshotApprovalRow): VaultSnapshot['approvals'][number] {
  return { entryId: row.entry_id, projectId: row.project_id, familySlug: row.family_slug };
}
