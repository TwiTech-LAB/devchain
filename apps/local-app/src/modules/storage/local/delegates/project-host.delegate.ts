import type { ProjectHostStorage, FrozenProject } from '../../interfaces/storage.interface';
import { DEFAULT_PROJECT_WORKSPACE_ID } from '../../db/schema';
import { PROJECT_REPLICA_SETTING_KEYS } from '@devchain/shared';
import { ConflictError, NotFoundError } from '../../../../common/errors/error-types';
import { createLogger } from '../../../../common/logging/logger';
import { dropProviderEnvKeysOfProject } from '../helpers/storage-helpers';
import { BaseStorageDelegate, type StorageDelegateContext } from './base-storage.delegate';

const logger = createLogger('ProjectHostStorageDelegate');

/** Host-side storage for remote projects: the handoff freeze, release and lookups. */
export class ProjectHostStorageDelegate extends BaseStorageDelegate implements ProjectHostStorage {
  constructor(context: StorageDelegateContext) {
    super(context);
  }

  async setProjectFrozen(projectId: string, frozenAt: string | null): Promise<void> {
    await this.txRunner.runImmediateQueuedOrJoin(() => {
      const result = this.rawClient
        .prepare('UPDATE projects SET frozen_at = ? WHERE id = ?')
        .run(frozenAt, projectId);
      if (result.changes === 0) {
        throw new NotFoundError('Project', projectId);
      }
    });
  }

  async listFrozenProjects(): Promise<FrozenProject[]> {
    const rows = this.rawClient
      .prepare('SELECT id, frozen_at FROM projects WHERE frozen_at IS NOT NULL ORDER BY id')
      .all() as Array<{ id: string; frozen_at: string }>;
    return rows.map((row) => ({ projectId: row.id, frozenAt: row.frozen_at }));
  }

  async findEpicIdByIdempotencyKey(projectId: string, key: string): Promise<string | null> {
    const row = this.rawClient
      .prepare(
        `SELECT id FROM epics
         WHERE project_id = ? AND json_valid(data) AND json_extract(data, '$.idempotencyKey') = ?
         ORDER BY created_at, id LIMIT 1`,
      )
      .get(projectId, key) as { id: string } | undefined;
    return row?.id ?? null;
  }

  /**
   * Deletes a frozen project with every row that belongs to it, including its
   * agents' sessions and the events whose payload names it. The workspace goes
   * too unless it is the default one or another project still uses it.
   */
  async releaseProject(projectId: string): Promise<void> {
    await this.txRunner.runImmediateQueued(() => {
      const project = this.rawClient
        .prepare('SELECT workspace_id, frozen_at FROM projects WHERE id = ?')
        .get(projectId) as { workspace_id: string; frozen_at: string | null } | undefined;
      if (!project) {
        throw new NotFoundError('Project', projectId);
      }
      if (project.frozen_at === null) {
        throw new ConflictError('Only a frozen project can be released.', {
          code: 'PROJECT_NOT_FROZEN',
          projectId,
        });
      }
      const connection = this.rawClient
        .prepare('SELECT 1 FROM integration_connections WHERE project_id = ? LIMIT 1')
        .get(projectId);
      if (connection) {
        throw new ConflictError('Cannot release a project with an integration connection.', {
          code: 'PROJECT_HAS_INTEGRATION_CONNECTIONS',
          projectId,
        });
      }

      const run = (sql: string, ...params: unknown[]) =>
        this.rawClient.prepare(sql).run(...params).changes;
      const agentsOfProject = 'SELECT id FROM agents WHERE project_id = ?';
      // sessions.agent_id and agents.provider_config_id are RESTRICT, so sessions and
      // agents go before the project row whose cascade removes everything else.
      const sessions = run(
        `DELETE FROM sessions WHERE agent_id IN (${agentsOfProject})`,
        projectId,
      );
      run('DELETE FROM agents WHERE project_id = ?', projectId);
      const events = run(
        `DELETE FROM events WHERE json_valid(payload_json)
           AND json_extract(payload_json, '$.projectId') = ?`,
        projectId,
      );
      this.removeSettingsSlices(projectId);
      dropProviderEnvKeysOfProject(this.rawClient, projectId);
      run('DELETE FROM projects WHERE id = ?', projectId);

      const workspaceInUse = this.rawClient
        .prepare('SELECT 1 FROM projects WHERE workspace_id = ? LIMIT 1')
        .get(project.workspace_id);
      if (!workspaceInUse && project.workspace_id !== DEFAULT_PROJECT_WORKSPACE_ID) {
        run('DELETE FROM project_workspaces WHERE id = ?', project.workspace_id);
      }
      logger.info({ projectId, sessions, events }, 'Released project');
    });
  }

  private removeSettingsSlices(projectId: string): void {
    for (const key of PROJECT_REPLICA_SETTING_KEYS) {
      const row = this.rawClient.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
        | { value: string }
        | undefined;
      if (!row) continue;
      let map: unknown;
      try {
        map = JSON.parse(row.value);
      } catch {
        continue;
      }
      if (typeof map !== 'object' || map === null || !(projectId in map)) continue;
      const { [projectId]: _removed, ...rest } = map as Record<string, unknown>;
      this.rawClient
        .prepare('UPDATE settings SET value = ?, updated_at = ? WHERE key = ?')
        .run(JSON.stringify(rest), new Date().toISOString(), key);
    }
  }
}
