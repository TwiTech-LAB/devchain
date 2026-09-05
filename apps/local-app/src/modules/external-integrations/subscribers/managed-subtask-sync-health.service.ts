import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError } from '../../../common/errors/error-types';
import { STORAGE_SERVICE, type StorageService } from '../../storage/interfaces/storage.interface';
import type {
  ExternalManagedSubtaskLink,
  IntegrationCredentials,
  IntegrationProvider,
} from '../../storage/models/domain.models';
import { normalizeExternalTaskSourceUrl } from '../models/external-task-source';
import {
  ExternalSubtaskSyncSubscriber,
  type ManagedSubtaskReconcileResult,
} from './external-subtask-sync.subscriber';
import { managedSubtaskRetryDecision } from './managed-subtask-recovery-policy';

export type ManagedSubtaskSyncHealthStatus =
  | 'disabled'
  | 'idle'
  | 'syncing'
  | 'needs_attention'
  | 'orphan_risk';

export interface ManagedSubtaskSyncHealthItem {
  id: string;
  epicId: string;
  phase: ExternalManagedSubtaskLink['operationPhase'];
  tombstoneState: ExternalManagedSubtaskLink['tombstoneState'];
  safeErrorCode: string | null;
  retryAt: string | null;
  remoteTaskId: string | null;
  openInSourceUrl: string | null;
  canVerify: boolean;
  canRetry: boolean;
}

export interface ManagedSubtaskSyncHealth {
  provider: IntegrationProvider;
  enabled: boolean;
  syncSettingRevision: number | null;
  status: ManagedSubtaskSyncHealthStatus;
  counts: {
    total: number;
    pending: number;
    outcomeUnknown: number;
    needsAttention: number;
    orphanRisk: number;
  };
  items: ManagedSubtaskSyncHealthItem[];
  truncated: boolean;
}

@Injectable()
export class ManagedSubtaskSyncHealthService {
  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly subscriber: ExternalSubtaskSyncSubscriber,
  ) {}

  async getHealth(
    projectId: string,
    provider: IntegrationProvider,
  ): Promise<ManagedSubtaskSyncHealth> {
    await this.storage.getProject(projectId);
    const connection = await this.storage.getIntegrationConnection({ projectId, provider });
    return this.buildHealth(provider, connection);
  }

  async getLegacyHealth(connectionId: string): Promise<ManagedSubtaskSyncHealth> {
    const connection = await this.requireUnassignedConnection(connectionId);
    return this.buildHealth(connection.provider, connection);
  }

  async verifyLegacy(connectionId: string, id: string): Promise<ManagedSubtaskReconcileResult> {
    await this.assertLegacyScope(connectionId, id);
    return this.subscriber.verifyManagedLink(id, connectionId);
  }

  async retryLegacy(connectionId: string, id: string): Promise<ManagedSubtaskReconcileResult> {
    await this.assertLegacyScope(connectionId, id);
    return this.subscriber.retryManagedLink(id, connectionId);
  }

  private async buildHealth(
    provider: IntegrationProvider,
    connection: Awaited<ReturnType<StorageService['getIntegrationConnection']>>,
  ): Promise<ManagedSubtaskSyncHealth> {
    const rows = connection
      ? (await this.storage.listExternalManagedSubtaskLinksByConnection(connection.id)).filter(
          (row) => row.provider === provider,
        )
      : [];
    const pending = rows.filter(
      (row) => row.operationPhase === 'pre_dispatch' || row.operationPhase === 'dispatch_admitted',
    ).length;
    const outcomeUnknown = rows.filter((row) => row.operationPhase === 'outcome_unknown').length;
    const needsAttention = rows.filter((row) => row.operationPhase === 'needs_attention').length;
    const orphanRisk = rows.filter((row) => row.tombstoneState === 'orphan_risk').length;
    const counts = { total: rows.length, pending, outcomeUnknown, needsAttention, orphanRisk };
    const boundedRows = rows.slice(0, 100);
    const links = boundedRows.length
      ? await this.storage.listExternalTaskLinksForEpics([
          ...new Set(boundedRows.map((row) => row.epicIdSnapshot)),
        ])
      : [];
    const credentials = await this.loadCredentialsForUrls(connection?.id ?? null, boundedRows);
    const items = await Promise.all(boundedRows.map((row) => this.toItem(row, credentials, links)));
    return {
      provider,
      enabled: connection?.subtaskSyncEnabled ?? false,
      syncSettingRevision: connection?.syncSettingRevision ?? null,
      status: this.status(connection?.subtaskSyncEnabled ?? false, counts),
      counts,
      items,
      truncated: rows.length > boundedRows.length,
    };
  }

  async verify(
    projectId: string,
    provider: IntegrationProvider,
    id: string,
  ): Promise<ManagedSubtaskReconcileResult> {
    const connectionId = await this.assertScope(projectId, provider, id);
    return this.subscriber.verifyManagedLink(id, connectionId);
  }

  async retry(
    projectId: string,
    provider: IntegrationProvider,
    id: string,
  ): Promise<ManagedSubtaskReconcileResult> {
    const connectionId = await this.assertScope(projectId, provider, id);
    return this.subscriber.retryManagedLink(id, connectionId);
  }

  private async toItem(
    row: ExternalManagedSubtaskLink,
    credentials: IntegrationCredentials | null,
    links: Awaited<ReturnType<StorageService['listExternalTaskLinksForEpics']>>,
  ): Promise<ManagedSubtaskSyncHealthItem> {
    const recognition = links.find(
      (link) =>
        link.epicId === row.epicIdSnapshot &&
        link.connectionId === row.connectionIdSnapshot &&
        link.provider === row.provider &&
        link.remoteScopeKey === row.remoteScopeKey &&
        link.remoteTaskId === row.remoteTaskId,
    );
    const storedUrl = recognition?.sourceSnapshot.webUrl;
    const openInSourceUrl =
      normalizeExternalTaskSourceUrl(row.provider, storedUrl) ?? this.derivedUrl(row, credentials);
    const retryDecision = managedSubtaskRetryDecision(row);
    return {
      id: row.id,
      epicId: row.epicIdSnapshot,
      phase: row.operationPhase,
      tombstoneState: row.tombstoneState,
      safeErrorCode: row.safeErrorCode,
      retryAt: row.retryAt,
      remoteTaskId: row.remoteTaskId,
      openInSourceUrl,
      canVerify:
        row.operationPhase === 'outcome_unknown' || row.operationPhase === 'needs_attention',
      canRetry: retryDecision.allowed,
    };
  }

  private async loadCredentialsForUrls(
    connectionId: string | null,
    rows: ExternalManagedSubtaskLink[],
  ): Promise<IntegrationCredentials | null> {
    if (
      !connectionId ||
      !rows.some((row) => row.provider === 'jira' && row.remoteTaskId && row.remoteKey)
    ) {
      return null;
    }
    try {
      return await this.storage.getIntegrationConnectionCredentialsById(connectionId);
    } catch {
      return null;
    }
  }

  private derivedUrl(
    row: ExternalManagedSubtaskLink,
    credentials: IntegrationCredentials | null,
  ): string | null {
    if (!row.remoteTaskId) {
      return null;
    }
    if (row.provider === 'clickup') {
      const candidate = `https://app.clickup.com/t/${encodeURIComponent(row.remoteTaskId)}`;
      return normalizeExternalTaskSourceUrl(row.provider, candidate);
    }
    if (credentials?.provider !== 'jira' || !row.remoteKey) {
      return null;
    }
    const candidate = `${new URL(credentials.siteUrl).origin}/browse/${encodeURIComponent(row.remoteKey)}`;
    return normalizeExternalTaskSourceUrl(row.provider, candidate);
  }

  private status(
    enabled: boolean,
    counts: ManagedSubtaskSyncHealth['counts'],
  ): ManagedSubtaskSyncHealthStatus {
    if (counts.orphanRisk > 0) return 'orphan_risk';
    if (counts.needsAttention > 0 || counts.outcomeUnknown > 0) return 'needs_attention';
    if (!enabled) return 'disabled';
    if (counts.pending > 0) return 'syncing';
    return 'idle';
  }

  private async assertScope(
    projectId: string,
    provider: IntegrationProvider,
    id: string,
  ): Promise<string> {
    await this.storage.getProject(projectId);
    const [row, connection] = await Promise.all([
      this.storage.getExternalManagedSubtaskLink(id),
      this.storage.getIntegrationConnection({ projectId, provider }),
    ]);
    if (row.provider !== provider || !connection || row.connectionIdSnapshot !== connection.id) {
      throw new NotFoundError('Managed subtask link', id);
    }
    return connection.id;
  }

  private async assertLegacyScope(connectionId: string, id: string): Promise<void> {
    const [connection, row] = await Promise.all([
      this.requireUnassignedConnection(connectionId),
      this.storage.getExternalManagedSubtaskLink(id),
    ]);
    if (row.connectionIdSnapshot !== connection.id || row.provider !== connection.provider) {
      throw new NotFoundError('Managed subtask link', id);
    }
  }

  private async requireUnassignedConnection(
    connectionId: string,
  ): Promise<NonNullable<Awaited<ReturnType<StorageService['getIntegrationConnectionById']>>>> {
    const connection = await this.storage.getIntegrationConnectionById(connectionId);
    if (!connection || connection.projectId !== null) {
      throw new NotFoundError('Unassigned integration connection', connectionId);
    }
    return connection;
  }
}
