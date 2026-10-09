import type { ProjectWorkspaceStorage } from '../../interfaces/storage.interface';
import { randomUUID } from 'node:crypto';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../../../common/errors/error-types';
import { createLogger } from '../../../../common/logging/logger';
import { DEFAULT_PROJECT_WORKSPACE_ID } from '../../db/schema';
import type { DeleteProjectWorkspaceResult, ProjectWorkspace } from '../../models/domain.models';
import { isSqliteUniqueConstraint } from '../helpers/storage-helpers';
import { BaseStorageDelegate, type StorageDelegateContext } from './base-storage.delegate';

const logger = createLogger('ProjectWorkspaceStorageDelegate');

interface ProjectWorkspaceRow {
  id: string;
  name: string;
  is_default: number;
  position: number;
  project_count: number;
  device_grant_count: number;
  created_at: string;
  updated_at: string;
}

const SELECT_WORKSPACES = `
  SELECT
    workspace.id,
    workspace.name,
    workspace.is_default,
    workspace.position,
    workspace.created_at,
    workspace.updated_at,
    (
      SELECT COUNT(*)
      FROM projects project
      WHERE project.workspace_id = workspace.id
    ) AS project_count,
    (
      SELECT COUNT(*)
      FROM paired_device_workspace_grants grant_row
      WHERE grant_row.workspace_id = workspace.id
    ) AS device_grant_count
  FROM project_workspaces workspace
`;

export class ProjectWorkspaceStorageDelegate
  extends BaseStorageDelegate
  implements ProjectWorkspaceStorage
{
  constructor(context: StorageDelegateContext) {
    super(context);
  }

  async listProjectWorkspaces(): Promise<ProjectWorkspace[]> {
    return this.listProjectWorkspacesSync();
  }

  async getProjectWorkspace(id: string): Promise<ProjectWorkspace> {
    return this.getProjectWorkspaceSync(id);
  }

  async createProjectWorkspace(rawName: string): Promise<ProjectWorkspace> {
    const name = this.normalizeAndValidateName(rawName);
    return this.txRunner.runImmediateQueuedOrJoin(() => {
      const now = new Date().toISOString();
      const positionRow = this.rawClient
        .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS position FROM project_workspaces')
        .get() as { position: number };
      const id = randomUUID();

      try {
        this.rawClient
          .prepare(
            `INSERT INTO project_workspaces
              (id, name, is_default, position, created_at, updated_at)
             VALUES (?, ?, 0, ?, ?, ?)`,
          )
          .run(id, name, positionRow.position, now, now);
      } catch (error) {
        this.rethrowNameConflict(error, name);
      }

      logger.info({ workspaceId: id }, 'Created project workspace');
      return this.getProjectWorkspaceSync(id);
    });
  }

  async renameProjectWorkspace(id: string, rawName: string): Promise<ProjectWorkspace> {
    const name = this.normalizeAndValidateName(rawName);
    return this.txRunner.runImmediateQueuedOrJoin(() => {
      this.getProjectWorkspaceSync(id);

      try {
        this.rawClient
          .prepare('UPDATE project_workspaces SET name = ?, updated_at = ? WHERE id = ?')
          .run(name, new Date().toISOString(), id);
      } catch (error) {
        this.rethrowNameConflict(error, name);
      }

      logger.info({ workspaceId: id }, 'Renamed project workspace');
      return this.getProjectWorkspaceSync(id);
    });
  }

  async reorderProjectWorkspaces(workspaceIds: string[]): Promise<ProjectWorkspace[]> {
    if (!Array.isArray(workspaceIds)) {
      throw new ValidationError('workspaceIds must be an array.');
    }

    return this.txRunner.runImmediateQueuedOrJoin(() => {
      const existingIds = this.listProjectWorkspacesSync().map((workspace) => workspace.id);
      const requestedIds = workspaceIds.map((id) => (typeof id === 'string' ? id.trim() : ''));
      const requestedSet = new Set(requestedIds);
      const existingSet = new Set(existingIds);
      const hasExpectedSize = requestedIds.length === existingIds.length;
      const hasNoDuplicates = requestedSet.size === requestedIds.length;
      const containsOnlyExistingIds = requestedIds.every(
        (id) => id.length > 0 && existingSet.has(id),
      );

      if (!hasExpectedSize || !hasNoDuplicates || !containsOnlyExistingIds) {
        throw new ValidationError('Workspace reorder must contain every workspace exactly once.', {
          workspaceIds: requestedIds,
        });
      }

      const update = this.rawClient.prepare(
        'UPDATE project_workspaces SET position = ?, updated_at = ? WHERE id = ?',
      );
      const now = new Date().toISOString();
      requestedIds.forEach((id, position) => update.run(position, now, id));

      logger.info({ workspaceIds: requestedIds }, 'Reordered project workspaces');
      return this.listProjectWorkspacesSync();
    });
  }

  async deleteProjectWorkspace(
    id: string,
    replacementId: string,
  ): Promise<DeleteProjectWorkspaceResult> {
    return this.txRunner.runImmediateQueuedOrJoin(() => {
      const source = this.getProjectWorkspaceSync(id);
      if (source.id === DEFAULT_PROJECT_WORKSPACE_ID || source.isDefault) {
        throw new ValidationError('The Default workspace cannot be deleted.', { workspaceId: id });
      }

      const normalizedReplacementId = typeof replacementId === 'string' ? replacementId.trim() : '';
      if (!normalizedReplacementId) {
        throw new ValidationError('A replacement workspace is required.', { workspaceId: id });
      }
      if (normalizedReplacementId === id) {
        throw new ValidationError('Replacement workspace must differ from the deleted workspace.', {
          workspaceId: id,
          replacementId: normalizedReplacementId,
        });
      }
      this.getProjectWorkspaceSync(normalizedReplacementId);

      const { count: remappedDeviceGrantCount } = this.rawClient
        .prepare(
          'SELECT COUNT(*) AS count FROM paired_device_workspace_grants WHERE workspace_id = ?',
        )
        .get(id) as { count: number };
      const movedProjectCount = this.rawClient
        .prepare('UPDATE projects SET workspace_id = ?, updated_at = ? WHERE workspace_id = ?')
        .run(normalizedReplacementId, new Date().toISOString(), id).changes;

      this.rawClient
        .prepare(
          `INSERT OR IGNORE INTO paired_device_workspace_grants (device_kid, workspace_id)
           SELECT device_kid, ?
           FROM paired_device_workspace_grants
           WHERE workspace_id = ?`,
        )
        .run(normalizedReplacementId, id);
      this.rawClient
        .prepare('DELETE FROM paired_device_workspace_grants WHERE workspace_id = ?')
        .run(id);
      this.rawClient.prepare('DELETE FROM project_workspaces WHERE id = ?').run(id);

      logger.info(
        {
          workspaceId: id,
          replacementId: normalizedReplacementId,
          movedProjectCount,
          remappedDeviceGrantCount,
        },
        'Deleted project workspace with replacement',
      );
      return {
        movedProjectCount,
        remappedDeviceGrantCount,
      };
    });
  }

  private listProjectWorkspacesSync(): ProjectWorkspace[] {
    const rows = this.rawClient
      .prepare(`${SELECT_WORKSPACES} ORDER BY workspace.position, workspace.id`)
      .all() as ProjectWorkspaceRow[];
    return rows.map((row) => this.mapWorkspace(row));
  }

  private getProjectWorkspaceSync(id: string): ProjectWorkspace {
    const row = this.rawClient.prepare(`${SELECT_WORKSPACES} WHERE workspace.id = ?`).get(id) as
      | ProjectWorkspaceRow
      | undefined;
    if (!row) {
      throw new NotFoundError('Project workspace', id);
    }
    return this.mapWorkspace(row);
  }

  private mapWorkspace(row: ProjectWorkspaceRow): ProjectWorkspace {
    return {
      id: row.id,
      name: row.name,
      isDefault: Boolean(row.is_default),
      position: row.position,
      projectCount: Number(row.project_count),
      deviceGrantCount: Number(row.device_grant_count),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private normalizeAndValidateName(rawName: string): string {
    if (typeof rawName !== 'string') {
      throw new ValidationError('Workspace name must be a string.');
    }
    const name = rawName.trim();
    if (name.length < 1 || name.length > 64) {
      throw new ValidationError('Workspace name must be between 1 and 64 characters.');
    }
    return name;
  }

  private rethrowNameConflict(error: unknown, name: string): never {
    if (isSqliteUniqueConstraint(error)) {
      throw new ConflictError(`Workspace "${name}" already exists.`, { name });
    }
    throw error;
  }
}
