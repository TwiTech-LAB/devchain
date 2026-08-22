import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  ConflictError,
  NotFoundError,
  StorageError,
  ValidationError,
} from '../../../../common/errors/error-types';
import { externalTaskLinks, integrationConnections } from '../../db/schema';
import type {
  CreateExternalTaskLink,
  CreateEpicWithExternalTaskLink,
  CreateEpicWithExternalTaskLinkResult,
  Epic,
  ExternalTaskLink,
  IntegrationConnection,
  IntegrationCredentials,
  IntegrationProvider,
  ReplaceIntegrationConnection,
} from '../../models/domain.models';
import { isSqliteUniqueConstraint } from '../helpers/storage-helpers';
import { IntegrationCredentialCipher } from '../integration-credential-cipher';
import { BaseStorageDelegate, type StorageDelegateContext } from './base-storage.delegate';

export type VerifyIntegrationCredentials = (credentials: IntegrationCredentials) => Promise<void>;

const CONNECTION_STATE_COLUMNS = {
  id: integrationConnections.id,
  provider: integrationConnections.provider,
  generation: integrationConnections.generation,
  createdAt: integrationConnections.createdAt,
  updatedAt: integrationConnections.updatedAt,
};

export interface IntegrationStorageDelegateDependencies {
  createEpicInCurrentTransaction: (data: CreateEpicWithExternalTaskLink['epic']) => Promise<Epic>;
  getEpic: (id: string) => Promise<Epic>;
}

export class IntegrationStorageDelegate extends BaseStorageDelegate {
  constructor(
    context: StorageDelegateContext,
    private readonly credentialCipher: IntegrationCredentialCipher,
    private readonly dependencies: IntegrationStorageDelegateDependencies,
  ) {
    super(context);
  }

  async replaceIntegrationConnection(
    data: ReplaceIntegrationConnection,
    verify: VerifyIntegrationCredentials,
  ): Promise<IntegrationConnection> {
    this.validateReplacement(data);
    await verify(data.credentials);

    const credentialCiphertext = this.credentialCipher.encrypt(data.credentials);
    const now = new Date().toISOString();
    await this.db
      .insert(integrationConnections)
      .values({
        id: randomUUID(),
        provider: data.provider,
        credentialCiphertext,
        generation: 1,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: integrationConnections.provider,
        set: {
          credentialCiphertext,
          generation: sql`${integrationConnections.generation} + 1`,
          updatedAt: now,
        },
      });

    const stored = await this.getIntegrationConnection(data.provider);
    if (!stored) {
      throw new StorageError('Integration connection replacement did not persist a row.');
    }
    return stored;
  }

  async getIntegrationConnection(
    provider: IntegrationProvider,
  ): Promise<IntegrationConnection | null> {
    const rows = await this.db
      .select(CONNECTION_STATE_COLUMNS)
      .from(integrationConnections)
      .where(eq(integrationConnections.provider, provider))
      .limit(1);
    return rows[0] ?? null;
  }

  async listIntegrationConnections(): Promise<IntegrationConnection[]> {
    return this.db
      .select(CONNECTION_STATE_COLUMNS)
      .from(integrationConnections)
      .orderBy(asc(integrationConnections.provider));
  }

  async getIntegrationConnectionCredentials(
    provider: IntegrationProvider,
  ): Promise<IntegrationCredentials | null> {
    const rows = await this.db
      .select({ credentialCiphertext: integrationConnections.credentialCiphertext })
      .from(integrationConnections)
      .where(eq(integrationConnections.provider, provider))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return null;
    }
    const credentials = this.credentialCipher.decrypt(row.credentialCiphertext);
    if (credentials.provider !== provider) {
      throw new StorageError('Stored integration credentials do not match their provider.');
    }
    return credentials;
  }

  async disconnectIntegrationConnection(provider: IntegrationProvider): Promise<boolean> {
    const result = await this.db
      .delete(integrationConnections)
      .where(eq(integrationConnections.provider, provider));
    return result.changes > 0;
  }

  async createExternalTaskLink(data: CreateExternalTaskLink): Promise<ExternalTaskLink> {
    const normalized = await this.normalizeLinkInput(data);
    const link: ExternalTaskLink = {
      ...normalized,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    try {
      await this.db.insert(externalTaskLinks).values(link);
    } catch (error) {
      if (isSqliteUniqueConstraint(error)) {
        throw new ConflictError('External task is already linked.', {
          provider: link.provider,
          remoteScopeKey: link.remoteScopeKey,
          remoteTaskId: link.remoteTaskId,
        });
      }
      throw error;
    }
    return link;
  }

  async createEpicWithExternalTaskLink(
    data: CreateEpicWithExternalTaskLink,
  ): Promise<CreateEpicWithExternalTaskLinkResult> {
    const remoteScopeKey = data.externalTaskLink.remoteScopeKey.trim();
    const remoteTaskId = data.externalTaskLink.remoteTaskId.trim();
    if (!remoteScopeKey || !remoteTaskId) {
      throw new ValidationError('Remote scope and remote task identifiers are required.');
    }

    const existing = await this.findExternalTaskLink(
      data.externalTaskLink.provider,
      remoteScopeKey,
      remoteTaskId,
    );
    if (existing) {
      return this.loadExistingImport(existing);
    }

    let uniquenessConflict: ConflictError | null = null;
    try {
      return await this.txRunner.runImmediateAsync(async () => {
        const epic = await this.dependencies.createEpicInCurrentTransaction(data.epic);
        const externalTaskLink = await this.createExternalTaskLink({
          ...data.externalTaskLink,
          epicId: epic.id,
          remoteScopeKey,
          remoteTaskId,
        });
        return { epic, externalTaskLink, created: true };
      });
    } catch (error) {
      if (
        !this.isMatchingExternalTaskLinkConflict(
          error,
          data.externalTaskLink.provider,
          remoteScopeKey,
          remoteTaskId,
        )
      ) {
        throw error;
      }
      uniquenessConflict = error;
    }

    const winner = await this.findExternalTaskLink(
      data.externalTaskLink.provider,
      remoteScopeKey,
      remoteTaskId,
    );
    if (!winner) {
      throw uniquenessConflict;
    }
    return this.loadExistingImport(winner);
  }

  async findExternalTaskLink(
    provider: IntegrationProvider,
    remoteScopeKey: string,
    remoteTaskId: string,
  ): Promise<ExternalTaskLink | null> {
    const rows = await this.db
      .select()
      .from(externalTaskLinks)
      .where(
        and(
          eq(externalTaskLinks.provider, provider),
          eq(externalTaskLinks.remoteScopeKey, remoteScopeKey),
          eq(externalTaskLinks.remoteTaskId, remoteTaskId),
        ),
      )
      .limit(1);
    return (rows[0] as ExternalTaskLink | undefined) ?? null;
  }

  async listExternalTaskLinksByRemoteScope(
    provider: IntegrationProvider,
    remoteScopeKey: string,
  ): Promise<ExternalTaskLink[]> {
    return this.db
      .select()
      .from(externalTaskLinks)
      .where(
        and(
          eq(externalTaskLinks.provider, provider),
          eq(externalTaskLinks.remoteScopeKey, remoteScopeKey),
        ),
      )
      .orderBy(asc(externalTaskLinks.remoteTaskId)) as Promise<ExternalTaskLink[]>;
  }

  async listExternalTaskLinksForEpic(epicId: string): Promise<ExternalTaskLink[]> {
    return this.db
      .select()
      .from(externalTaskLinks)
      .where(eq(externalTaskLinks.epicId, epicId))
      .orderBy(asc(externalTaskLinks.createdAt)) as Promise<ExternalTaskLink[]>;
  }

  /**
   * One IN query for a bounded Epic batch. The API limit (1,000 IDs) stays
   * below the bundled SQLite bind-variable limit, so no chunking is needed.
   */
  async listExternalTaskLinksForEpics(epicIds: string[]): Promise<ExternalTaskLink[]> {
    return this.db
      .select()
      .from(externalTaskLinks)
      .where(inArray(externalTaskLinks.epicId, epicIds))
      .orderBy(asc(externalTaskLinks.epicId), asc(externalTaskLinks.createdAt)) as Promise<
      ExternalTaskLink[]
    >;
  }

  private validateReplacement(data: ReplaceIntegrationConnection): void {
    if (data.credentials.provider !== data.provider) {
      throw new ValidationError('Integration credentials must match the selected provider.');
    }
    if (!data.credentials.token.trim()) {
      throw new ValidationError('Integration credential token is required.');
    }
    if (
      data.credentials.provider === 'jira' &&
      (!data.credentials.siteUrl.trim() || !data.credentials.email.trim())
    ) {
      throw new ValidationError('Jira site URL and email are required.');
    }
  }

  private async normalizeLinkInput(data: CreateExternalTaskLink): Promise<CreateExternalTaskLink> {
    const remoteScopeKey = data.remoteScopeKey.trim();
    const remoteTaskId = data.remoteTaskId.trim();
    if (!data.epicId.trim() || !remoteScopeKey || !remoteTaskId) {
      throw new ValidationError('Epic, remote scope, and remote task identifiers are required.');
    }
    if (
      !data.sourceSnapshot ||
      typeof data.sourceSnapshot !== 'object' ||
      Array.isArray(data.sourceSnapshot)
    ) {
      throw new ValidationError('External task source snapshot must be an object.');
    }
    if (data.connectionId) {
      const connection = await this.getIntegrationConnectionById(data.connectionId);
      if (!connection) {
        throw new NotFoundError('Integration connection', data.connectionId);
      }
      if (connection.provider !== data.provider) {
        throw new ValidationError('External task link provider must match its connection.');
      }
    }
    return { ...data, remoteScopeKey, remoteTaskId };
  }

  private async getIntegrationConnectionById(id: string): Promise<IntegrationConnection | null> {
    const rows = await this.db
      .select(CONNECTION_STATE_COLUMNS)
      .from(integrationConnections)
      .where(eq(integrationConnections.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  private async loadExistingImport(
    externalTaskLink: ExternalTaskLink,
  ): Promise<CreateEpicWithExternalTaskLinkResult> {
    return {
      epic: await this.dependencies.getEpic(externalTaskLink.epicId),
      externalTaskLink,
      created: false,
    };
  }

  private isMatchingExternalTaskLinkConflict(
    error: unknown,
    provider: IntegrationProvider,
    remoteScopeKey: string,
    remoteTaskId: string,
  ): error is ConflictError {
    if (!(error instanceof ConflictError)) {
      return false;
    }
    return (
      error.details?.provider === provider &&
      error.details.remoteScopeKey === remoteScopeKey &&
      error.details.remoteTaskId === remoteTaskId
    );
  }
}
