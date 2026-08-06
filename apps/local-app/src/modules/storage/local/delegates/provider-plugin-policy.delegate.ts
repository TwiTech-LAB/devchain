import { and, asc, eq } from 'drizzle-orm';
import { providerPluginDefaults, projectProviderPluginOverrides } from '../../db/schema';
import type {
  ProjectProviderPluginOverride,
  ProviderPluginDefault,
  UpsertProjectProviderPluginOverride,
  UpsertProviderPluginDefault,
} from '../../models/domain.models';
import { StorageError } from '../../../../common/errors/error-types';
import { BaseStorageDelegate, type StorageDelegateContext } from './base-storage.delegate';

export class ProviderPluginPolicyStorageDelegate extends BaseStorageDelegate {
  constructor(context: StorageDelegateContext) {
    super(context);
  }

  async upsertProviderPluginDefault(
    data: UpsertProviderPluginDefault,
  ): Promise<ProviderPluginDefault> {
    const now = new Date().toISOString();
    await this.db
      .insert(providerPluginDefaults)
      .values({ ...data, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: [providerPluginDefaults.providerId, providerPluginDefaults.pluginId],
        set: { enabled: data.enabled, updatedAt: now },
      });

    const row = await this.getProviderPluginDefault(data.providerId, data.pluginId);
    if (!row) {
      throw new StorageError('Provider plugin default upsert did not return its persisted row.');
    }
    return row;
  }

  async getProviderPluginDefault(
    providerId: string,
    pluginId: string,
  ): Promise<ProviderPluginDefault | null> {
    const rows = await this.db
      .select()
      .from(providerPluginDefaults)
      .where(
        and(
          eq(providerPluginDefaults.providerId, providerId),
          eq(providerPluginDefaults.pluginId, pluginId),
        ),
      )
      .limit(1);
    return (rows[0] as ProviderPluginDefault | undefined) ?? null;
  }

  async listProviderPluginDefaults(providerId: string): Promise<ProviderPluginDefault[]> {
    return this.db
      .select()
      .from(providerPluginDefaults)
      .where(eq(providerPluginDefaults.providerId, providerId))
      .orderBy(asc(providerPluginDefaults.pluginId));
  }

  async deleteProviderPluginDefault(providerId: string, pluginId: string): Promise<boolean> {
    const result = await this.db
      .delete(providerPluginDefaults)
      .where(
        and(
          eq(providerPluginDefaults.providerId, providerId),
          eq(providerPluginDefaults.pluginId, pluginId),
        ),
      );
    return result.changes > 0;
  }

  async upsertProjectProviderPluginOverride(
    data: UpsertProjectProviderPluginOverride,
  ): Promise<ProjectProviderPluginOverride> {
    const now = new Date().toISOString();
    await this.db
      .insert(projectProviderPluginOverrides)
      .values({ ...data, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: [
          projectProviderPluginOverrides.projectId,
          projectProviderPluginOverrides.providerId,
          projectProviderPluginOverrides.pluginId,
        ],
        set: { enabled: data.enabled, updatedAt: now },
      });

    const row = await this.getProjectProviderPluginOverride(
      data.projectId,
      data.providerId,
      data.pluginId,
    );
    if (!row) {
      throw new StorageError(
        'Project provider plugin override upsert did not return its persisted row.',
      );
    }
    return row;
  }

  async getProjectProviderPluginOverride(
    projectId: string,
    providerId: string,
    pluginId: string,
  ): Promise<ProjectProviderPluginOverride | null> {
    const rows = await this.db
      .select()
      .from(projectProviderPluginOverrides)
      .where(
        and(
          eq(projectProviderPluginOverrides.projectId, projectId),
          eq(projectProviderPluginOverrides.providerId, providerId),
          eq(projectProviderPluginOverrides.pluginId, pluginId),
        ),
      )
      .limit(1);
    return (rows[0] as ProjectProviderPluginOverride | undefined) ?? null;
  }

  async listProjectProviderPluginOverrides(
    projectId: string,
    providerId: string,
  ): Promise<ProjectProviderPluginOverride[]> {
    return this.db
      .select()
      .from(projectProviderPluginOverrides)
      .where(
        and(
          eq(projectProviderPluginOverrides.projectId, projectId),
          eq(projectProviderPluginOverrides.providerId, providerId),
        ),
      )
      .orderBy(asc(projectProviderPluginOverrides.pluginId));
  }

  async deleteProjectProviderPluginOverride(
    projectId: string,
    providerId: string,
    pluginId: string,
  ): Promise<boolean> {
    const result = await this.db
      .delete(projectProviderPluginOverrides)
      .where(
        and(
          eq(projectProviderPluginOverrides.projectId, projectId),
          eq(projectProviderPluginOverrides.providerId, providerId),
          eq(projectProviderPluginOverrides.pluginId, pluginId),
        ),
      );
    return result.changes > 0;
  }
}
