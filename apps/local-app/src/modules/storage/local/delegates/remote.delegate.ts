import type { RemoteStorage, ListOptions, ListResult } from '../../interfaces/storage.interface';
import { randomUUID } from 'node:crypto';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../../../common/errors/error-types';
import { certificateFingerprint, normalizeCertificate } from '../../../../common/tls/certificate';
import { createLogger } from '../../../../common/logging/logger';
import type {
  CreateRemote,
  CreateVmProviderConnection,
  CreateRemoteOperation,
  Remote,
  VmProviderConnection,
  VmSpec,
  RemoteOperation,
  RemoteOperationState,
  RemoteOperationKind,
  RemoteProjectBinding,
  UpdateRemoteOperation,
  UpdateRemoteProjectBinding,
} from '../../models/domain.models';
import { isSqliteUniqueConstraint, normalizeListOptions } from '../helpers/storage-helpers';
import { BaseStorageDelegate, type StorageDelegateContext } from './base-storage.delegate';
import type { IntegrationCredentialCipher } from '../integration-credential-cipher';

const logger = createLogger('RemoteStorageDelegate');

interface RemoteRow {
  id: string;
  name: string;
  base_url: string | null;
  kind: string;
  vm_provider_connection_id: string | null;
  vm_identity: string | null;
  vm_spec_json: string | null;
  tls_certificate: string | null;
  created_at: string;
  updated_at: string;
}

interface VmProviderConnectionRow {
  id: string;
  kind: 'proxmox';
  name: string;
  api_url: string;
  node: string;
  pool: string;
  storage: string;
  image_storage: string;
  bridge: string;
  vmid_min: number;
  vmid_max: number;
  name_prefix: string;
  tag: string;
  ssl_fingerprint: string;
  ca_pem: string | null;
  token_id: string;
  token_secret_ciphertext: string;
  created_at: string;
  updated_at: string;
}

const REMOTE_API_KEY_CONTEXT = 'devchain-remote-api-key-v1';
const VM_PROVIDER_SECRET_CONTEXT = 'devchain-vm-provider-token-v1';
const SELECT_VM_PROVIDER_COLUMNS =
  'id, kind, name, api_url, node, pool, storage, image_storage, bridge, vmid_min, vmid_max, name_prefix, tag, ssl_fingerprint, ca_pem, token_id, token_secret_ciphertext, created_at, updated_at FROM vm_provider_connections';

interface RemoteProjectBindingRow {
  project_id: string;
  remote_id: string;
  state: string;
  host_cursor: string | null;
  sync_error: string | null;
  sync_failed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface RemoteOperationRow {
  id: string;
  kind: string;
  remote_id: string;
  project_id: string | null;
  state: string;
  steps: string;
  details: string;
  created_at: string;
  updated_at: string;
}

const SELECT_BINDING_COLUMNS =
  'project_id, remote_id, state, host_cursor, sync_error, sync_failed_at, created_at, updated_at FROM remote_project_bindings';
const SELECT_OPERATION_COLUMNS =
  'id, kind, remote_id, project_id, state, steps, details, created_at, updated_at FROM remote_operations';

const SELECT_REMOTE_COLUMNS =
  'id, name, base_url, kind, vm_provider_connection_id, vm_identity, vm_spec_json, tls_certificate, created_at, updated_at FROM remotes';

export class RemoteStorageDelegate extends BaseStorageDelegate implements RemoteStorage {
  constructor(
    context: StorageDelegateContext,
    private readonly cipher: IntegrationCredentialCipher,
  ) {
    super(context);
  }

  async readRemoteApiKey(id: string): Promise<string | null> {
    const row = this.rawClient
      .prepare('SELECT credential_ciphertext FROM remotes WHERE id = ?')
      .get(id) as { credential_ciphertext: string | null } | undefined;
    if (!row) throw new NotFoundError('Remote', id);
    return row.credential_ciphertext === null
      ? null
      : this.cipher.decryptValue(row.credential_ciphertext, REMOTE_API_KEY_CONTEXT);
  }

  async saveRemoteApiKey(id: string, key: string, onlyIfAbsent = false): Promise<void> {
    const ciphertext = this.cipher.encryptValue(key, REMOTE_API_KEY_CONTEXT);
    await this.txRunner.runImmediateQueuedOrJoin(() => {
      this.getRemoteSync(id);
      this.rawClient
        .prepare(
          `UPDATE remotes SET credential_ciphertext = ?, updated_at = ?
        WHERE id = ?${onlyIfAbsent ? ' AND credential_ciphertext IS NULL' : ''}`,
        )
        .run(ciphertext, new Date().toISOString(), id);
    });
  }

  async createRemote(data: CreateRemote): Promise<Remote> {
    const name = this.normalizeAndValidateName(data.name);
    const baseUrl = data.baseUrl?.trim() ?? null;
    if (data.kind === 'address' && !baseUrl) {
      throw new ConflictError('An address remote needs a base URL.');
    }
    const tlsCertificate = this.normalizeTlsCertificate(data.tlsCertificate ?? null);
    return this.txRunner.runImmediateQueuedOrJoin(() => {
      const now = new Date().toISOString();
      const id = randomUUID();

      try {
        this.rawClient
          .prepare(
            `INSERT INTO remotes (id, name, base_url, kind, vm_provider_connection_id, vm_identity, vm_spec_json, tls_certificate, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            name,
            baseUrl,
            data.kind,
            data.kind === 'proxmox' ? data.vmProviderConnectionId : null,
            data.kind === 'proxmox' ? data.vmIdentity : null,
            data.kind === 'proxmox' ? JSON.stringify(data.vmSpec) : null,
            tlsCertificate,
            now,
            now,
          );
      } catch (error) {
        this.rethrowNameConflict(error, name);
      }

      logger.info({ remoteId: id }, 'Created remote');
      return this.getRemoteSync(id);
    });
  }

  async getRemote(id: string): Promise<Remote> {
    return this.getRemoteSync(id);
  }

  async listRemotes(options: ListOptions = {}): Promise<ListResult<Remote>> {
    const { limit, offset } = normalizeListOptions(options);
    const rows = this.rawClient
      .prepare(`SELECT ${SELECT_REMOTE_COLUMNS} ORDER BY name COLLATE NOCASE LIMIT ? OFFSET ?`)
      .all(limit, offset) as RemoteRow[];
    const { count } = this.rawClient.prepare('SELECT COUNT(*) AS count FROM remotes').get() as {
      count: number;
    };

    return {
      items: rows.map((row) => this.mapRemote(row)),
      total: count,
      limit,
      offset,
    };
  }

  async updateRemoteName(id: string, rawName: string): Promise<Remote> {
    const name = this.normalizeAndValidateName(rawName);
    return this.txRunner.runImmediateQueuedOrJoin(() => {
      this.getRemoteSync(id);

      try {
        this.rawClient
          .prepare('UPDATE remotes SET name = ?, updated_at = ? WHERE id = ?')
          .run(name, new Date().toISOString(), id);
      } catch (error) {
        this.rethrowNameConflict(error, name);
      }

      logger.info({ remoteId: id }, 'Renamed remote');
      return this.getRemoteSync(id);
    });
  }

  async updateRemoteBaseUrl(id: string, baseUrl: string | null): Promise<Remote> {
    return this.txRunner.runImmediateQueuedOrJoin(() => {
      const remote = this.getRemoteSync(id);
      if (remote.kind === 'address' && !baseUrl) {
        throw new ConflictError('An address remote needs a base URL.');
      }
      this.rawClient
        .prepare('UPDATE remotes SET base_url = ?, updated_at = ? WHERE id = ?')
        .run(baseUrl, new Date().toISOString(), id);
      return this.getRemoteSync(id);
    });
  }

  async updateRemoteVmIdentity(id: string, vmIdentity: string | null): Promise<Remote> {
    return this.txRunner.runImmediateQueuedOrJoin(() => {
      const remote = this.getRemoteSync(id);
      if (remote.kind !== 'proxmox') throw new ConflictError('Remote has no VM identity.');
      this.rawClient
        .prepare('UPDATE remotes SET vm_identity = ?, updated_at = ? WHERE id = ?')
        .run(vmIdentity, new Date().toISOString(), id);
      return this.getRemoteSync(id);
    });
  }

  async updateRemoteTlsCertificate(id: string, certificate: string | null): Promise<Remote> {
    const normalized = this.normalizeTlsCertificate(certificate);
    return this.txRunner.runImmediateQueuedOrJoin(() => {
      this.getRemoteSync(id);
      this.rawClient
        .prepare('UPDATE remotes SET tls_certificate = ?, updated_at = ? WHERE id = ?')
        .run(normalized, new Date().toISOString(), id);
      logger.info({ remoteId: id, stored: normalized !== null }, 'Updated remote certificate');
      return this.getRemoteSync(id);
    });
  }

  async createVmProviderConnection(
    data: CreateVmProviderConnection,
  ): Promise<VmProviderConnection> {
    const ciphertext = this.cipher.encryptValue(data.tokenSecret, VM_PROVIDER_SECRET_CONTEXT);
    return this.txRunner.runImmediateQueuedOrJoin(() => {
      const id = randomUUID();
      const now = new Date().toISOString();
      this.rawClient
        .prepare(
          `INSERT INTO vm_provider_connections
         (id, kind, name, api_url, node, pool, storage, image_storage, bridge, vmid_min, vmid_max, name_prefix, tag, ssl_fingerprint, ca_pem, token_id, token_secret_ciphertext, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          data.kind,
          data.name,
          data.apiUrl,
          data.node,
          data.pool,
          data.storage,
          data.imageStorage,
          data.bridge,
          data.vmidMin,
          data.vmidMax,
          data.namePrefix,
          data.tag,
          data.sslFingerprint,
          data.caPem ?? null,
          data.tokenId,
          ciphertext,
          now,
          now,
        );
      return this.getVmProviderConnectionSync(id);
    });
  }

  async listVmProviderConnections(): Promise<VmProviderConnection[]> {
    return (
      this.rawClient
        .prepare(`SELECT ${SELECT_VM_PROVIDER_COLUMNS} ORDER BY name COLLATE NOCASE`)
        .all() as VmProviderConnectionRow[]
    ).map((row) => this.mapVmProviderConnection(row));
  }

  async getVmProviderConnection(id: string): Promise<VmProviderConnection> {
    return this.getVmProviderConnectionSync(id);
  }

  async readVmProviderTokenSecret(id: string): Promise<string> {
    return this.cipher.decryptValue(
      this.getVmProviderConnectionSync(id).tokenSecretCiphertext,
      VM_PROVIDER_SECRET_CONTEXT,
    );
  }

  async deleteVmProviderConnection(id: string): Promise<void> {
    return this.txRunner.runImmediateQueuedOrJoin(() => {
      this.getVmProviderConnectionSync(id);
      const used = this.rawClient
        .prepare('SELECT id FROM remotes WHERE vm_provider_connection_id = ? LIMIT 1')
        .get(id);
      if (used) throw new ConflictError('Connection is used by a remote.');
      this.rawClient.prepare('DELETE FROM vm_provider_connections WHERE id = ?').run(id);
    });
  }

  async deleteRemote(id: string): Promise<void> {
    return this.txRunner.runImmediateQueuedOrJoin(() => {
      this.getRemoteSync(id);

      const binding = this.rawClient
        .prepare('SELECT project_id FROM remote_project_bindings WHERE remote_id = ? LIMIT 1')
        .get(id) as { project_id: string } | undefined;
      if (binding) {
        throw new ConflictError('Cannot delete a remote with a project binding.', {
          code: 'REMOTE_HAS_PROJECT_BINDINGS',
          remoteId: id,
        });
      }

      this.rawClient.prepare('DELETE FROM remotes WHERE id = ?').run(id);
      logger.info({ remoteId: id }, 'Deleted remote');
    });
  }

  async listRemoteProjectBindings(): Promise<RemoteProjectBinding[]> {
    const rows = this.rawClient
      .prepare(`SELECT ${SELECT_BINDING_COLUMNS} ORDER BY project_id`)
      .all() as RemoteProjectBindingRow[];
    return rows.map((row) => this.mapBinding(row));
  }

  async getRemoteProjectBinding(projectId: string): Promise<RemoteProjectBinding | null> {
    return this.getBindingSync(projectId);
  }

  async createRemoteProjectBinding(data: {
    projectId: string;
    remoteId: string;
  }): Promise<RemoteProjectBinding> {
    return this.txRunner.runImmediateQueuedOrJoin(() => {
      this.getRemoteSync(data.remoteId);
      const existing = this.getBindingSync(data.projectId);
      if (existing) {
        throw new ConflictError('Project is already bound to a remote.', {
          code: 'REMOTE_BINDING_EXISTS',
          projectId: data.projectId,
          remoteId: existing.remoteId,
          state: existing.state,
        });
      }
      const now = new Date().toISOString();
      this.rawClient
        .prepare(
          `INSERT INTO remote_project_bindings
             (project_id, remote_id, state, host_cursor, created_at, updated_at)
           VALUES (?, ?, 'attaching', NULL, ?, ?)`,
        )
        .run(data.projectId, data.remoteId, now, now);
      logger.info({ projectId: data.projectId, remoteId: data.remoteId }, 'Created remote binding');
      return this.getBindingSync(data.projectId) as RemoteProjectBinding;
    });
  }

  async updateRemoteProjectBinding(
    projectId: string,
    data: UpdateRemoteProjectBinding,
  ): Promise<RemoteProjectBinding> {
    return this.txRunner.runImmediateQueuedOrJoin(() => {
      const current = this.getBindingSync(projectId);
      if (!current) {
        throw new NotFoundError('Remote project binding', projectId);
      }
      const now = new Date().toISOString();
      let syncError = current.syncError;
      let syncFailedAt = current.syncFailedAt;
      if (data.syncError !== undefined) {
        syncError = data.syncError;
        syncFailedAt = data.syncError === null ? null : now;
      }
      this.rawClient
        .prepare(
          `UPDATE remote_project_bindings
           SET state = ?, host_cursor = ?, sync_error = ?, sync_failed_at = ?, updated_at = ?
           WHERE project_id = ?`,
        )
        .run(
          data.state ?? current.state,
          data.hostCursor === undefined ? current.hostCursor : data.hostCursor,
          syncError,
          syncFailedAt,
          now,
          projectId,
        );
      return this.getBindingSync(projectId) as RemoteProjectBinding;
    });
  }

  async deleteRemoteProjectBinding(projectId: string): Promise<RemoteProjectBinding | null> {
    return this.txRunner.runImmediateQueuedOrJoin(() => {
      const current = this.getBindingSync(projectId);
      if (current) {
        this.rawClient
          .prepare('DELETE FROM remote_project_bindings WHERE project_id = ?')
          .run(projectId);
        logger.info({ projectId, remoteId: current.remoteId }, 'Deleted remote binding');
      }
      return current;
    });
  }

  async createRemoteOperation(data: CreateRemoteOperation): Promise<RemoteOperation> {
    return this.txRunner.runImmediateQueuedOrJoin(() => {
      this.getRemoteSync(data.remoteId);
      const id = data.id ?? randomUUID();
      const now = new Date().toISOString();
      try {
        this.rawClient
          .prepare(
            `INSERT INTO remote_operations
               (id, kind, remote_id, project_id, state, steps, details, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)`,
          )
          .run(
            id,
            data.kind,
            data.remoteId,
            data.projectId,
            JSON.stringify(data.steps),
            JSON.stringify(data.details),
            now,
            now,
          );
      } catch (error) {
        if (isSqliteUniqueConstraint(error)) {
          const open = this.rawClient
            .prepare(
              `SELECT id FROM remote_operations WHERE project_id = ? AND state IN ('running', 'failed')`,
            )
            .get(data.projectId) as { id: string } | undefined;
          throw new ConflictError('Another remote operation is open for this project.', {
            code: 'REMOTE_OPERATION_IN_PROGRESS',
            projectId: data.projectId,
            operationId: open?.id ?? null,
          });
        }
        throw error;
      }
      return this.getOperationSync(id);
    });
  }

  async getRemoteOperation(id: string): Promise<RemoteOperation> {
    return this.getOperationSync(id);
  }

  async listRemoteOperations(
    filter: {
      states?: readonly RemoteOperationState[];
      projectId?: string;
      remoteId?: string;
      kinds?: readonly RemoteOperationKind[];
      limit?: number;
    } = {},
  ): Promise<RemoteOperation[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.states && filter.states.length > 0) {
      where.push(`state IN (${filter.states.map(() => '?').join(', ')})`);
      params.push(...filter.states);
    }
    if (filter.projectId !== undefined) {
      where.push('project_id = ?');
      params.push(filter.projectId);
    }
    if (filter.remoteId !== undefined) {
      where.push('remote_id = ?');
      params.push(filter.remoteId);
    }
    if (filter.kinds && filter.kinds.length > 0) {
      where.push(`kind IN (${filter.kinds.map(() => '?').join(', ')})`);
      params.push(...filter.kinds);
    }
    const rows = this.rawClient
      .prepare(
        `SELECT ${SELECT_OPERATION_COLUMNS}
         ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(...params, filter.limit ?? 100) as RemoteOperationRow[];
    return rows.map((row) => this.mapOperation(row));
  }

  async updateRemoteOperation(id: string, data: UpdateRemoteOperation): Promise<RemoteOperation> {
    return this.txRunner.runImmediateQueuedOrJoin(() => {
      const current = this.getOperationSync(id);
      if (data.expectedState && current.state !== data.expectedState) {
        throw new ConflictError(`Operation is ${current.state}, not ${data.expectedState}.`, {
          code: 'REMOTE_OPERATION_STATE_CHANGED',
          operationId: id,
          state: current.state,
        });
      }
      this.rawClient
        .prepare(
          'UPDATE remote_operations SET state = ?, steps = ?, details = ?, updated_at = ? WHERE id = ?',
        )
        .run(
          data.state ?? current.state,
          JSON.stringify(data.steps ?? current.steps),
          JSON.stringify(data.details ?? current.details),
          new Date().toISOString(),
          id,
        );
      return this.getOperationSync(id);
    });
  }

  private getBindingSync(projectId: string): RemoteProjectBinding | null {
    const row = this.rawClient
      .prepare(`SELECT ${SELECT_BINDING_COLUMNS} WHERE project_id = ?`)
      .get(projectId) as RemoteProjectBindingRow | undefined;
    return row ? this.mapBinding(row) : null;
  }

  private getOperationSync(id: string): RemoteOperation {
    const row = this.rawClient
      .prepare(`SELECT ${SELECT_OPERATION_COLUMNS} WHERE id = ?`)
      .get(id) as RemoteOperationRow | undefined;
    if (!row) {
      throw new NotFoundError('Remote operation', id);
    }
    return this.mapOperation(row);
  }

  private mapOperation(row: RemoteOperationRow): RemoteOperation {
    return {
      id: row.id,
      kind: row.kind as RemoteOperation['kind'],
      remoteId: row.remote_id,
      projectId: row.project_id,
      state: row.state as RemoteOperation['state'],
      steps: JSON.parse(row.steps) as RemoteOperation['steps'],
      details: JSON.parse(row.details) as RemoteOperation['details'],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private getRemoteSync(id: string): Remote {
    const row = this.rawClient.prepare(`SELECT ${SELECT_REMOTE_COLUMNS} WHERE id = ?`).get(id) as
      | RemoteRow
      | undefined;
    if (!row) {
      throw new NotFoundError('Remote', id);
    }
    return this.mapRemote(row);
  }

  private mapRemote(row: RemoteRow): Remote {
    return {
      id: row.id,
      name: row.name,
      baseUrl: row.base_url,
      kind: row.kind as Remote['kind'],
      vmProviderConnectionId: row.vm_provider_connection_id,
      vmIdentity: row.vm_identity,
      vmSpec: row.vm_spec_json ? (JSON.parse(row.vm_spec_json) as VmSpec) : null,
      tlsCertificate: row.tls_certificate,
      tlsFingerprint: row.tls_certificate ? certificateFingerprint(row.tls_certificate) : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private getVmProviderConnectionSync(id: string): VmProviderConnection {
    const row = this.rawClient
      .prepare(`SELECT ${SELECT_VM_PROVIDER_COLUMNS} WHERE id = ?`)
      .get(id) as VmProviderConnectionRow | undefined;
    if (!row) throw new NotFoundError('VM provider connection', id);
    return this.mapVmProviderConnection(row);
  }

  private mapVmProviderConnection(row: VmProviderConnectionRow): VmProviderConnection {
    return {
      id: row.id,
      kind: row.kind,
      name: row.name,
      apiUrl: row.api_url,
      node: row.node,
      pool: row.pool,
      storage: row.storage,
      imageStorage: row.image_storage,
      bridge: row.bridge,
      vmidMin: row.vmid_min,
      vmidMax: row.vmid_max,
      namePrefix: row.name_prefix,
      tag: row.tag,
      sslFingerprint: row.ssl_fingerprint,
      caPem: row.ca_pem,
      tokenId: row.token_id,
      tokenSecretCiphertext: row.token_secret_ciphertext,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapBinding(row: RemoteProjectBindingRow): RemoteProjectBinding {
    return {
      projectId: row.project_id,
      remoteId: row.remote_id,
      state: row.state as RemoteProjectBinding['state'],
      hostCursor: row.host_cursor,
      syncError: row.sync_error,
      syncFailedAt: row.sync_failed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private normalizeTlsCertificate(certificate: string | null): string | null {
    if (certificate === null) return null;
    try {
      return normalizeCertificate(certificate);
    } catch {
      throw new ValidationError('The VM certificate is not a valid PEM certificate.', {
        reason: 'remote_tls_certificate_invalid',
      });
    }
  }

  private normalizeAndValidateName(rawName: string): string {
    const name = rawName.trim();
    if (name.length < 1 || name.length > 128) {
      throw new ConflictError('Remote name must be between 1 and 128 characters.', {
        code: 'REMOTE_NAME_INVALID',
      });
    }
    return name;
  }

  private rethrowNameConflict(error: unknown, name: string): never {
    if (isSqliteUniqueConstraint(error)) {
      throw new ConflictError(`Remote "${name}" already exists.`, { name });
    }
    throw error;
  }
}
