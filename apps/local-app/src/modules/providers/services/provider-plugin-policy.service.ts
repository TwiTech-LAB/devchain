import { Inject, Injectable } from '@nestjs/common';
import { ValidationError } from '../../../common/errors/error-types';
import { STORAGE_SERVICE, type StorageService } from '../../storage/interfaces/storage.interface';

const MAX_PLUGIN_ID_LENGTH = 512;
const ASCII_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;

export type ProviderPluginPolicySource = 'project' | 'default';

export interface EffectiveProviderPluginPolicy {
  providerId: string;
  pluginId: string;
  enabled: boolean;
  source: ProviderPluginPolicySource;
}

@Injectable()
export class ProviderPluginPolicyService {
  constructor(@Inject(STORAGE_SERVICE) private readonly storage: StorageService) {}

  async setDefault(
    providerId: string,
    pluginId: string,
    enabled: boolean,
  ): Promise<EffectiveProviderPluginPolicy> {
    const normalizedPluginId = this.normalizePluginId(pluginId);
    const row = await this.storage.upsertProviderPluginDefault({
      providerId,
      pluginId: normalizedPluginId,
      enabled,
    });
    return {
      providerId: row.providerId,
      pluginId: row.pluginId,
      enabled: row.enabled,
      source: 'default',
    };
  }

  async resetDefault(providerId: string, pluginId: string): Promise<boolean> {
    return this.storage.deleteProviderPluginDefault(providerId, this.normalizePluginId(pluginId));
  }

  async setProjectOverride(
    projectId: string,
    providerId: string,
    pluginId: string,
    enabled: boolean,
  ): Promise<EffectiveProviderPluginPolicy> {
    const normalizedPluginId = this.normalizePluginId(pluginId);
    const row = await this.storage.upsertProjectProviderPluginOverride({
      projectId,
      providerId,
      pluginId: normalizedPluginId,
      enabled,
    });
    return {
      providerId: row.providerId,
      pluginId: row.pluginId,
      enabled: row.enabled,
      source: 'project',
    };
  }

  async resetProjectOverride(
    projectId: string,
    providerId: string,
    pluginId: string,
  ): Promise<boolean> {
    return this.storage.deleteProjectProviderPluginOverride(
      projectId,
      providerId,
      this.normalizePluginId(pluginId),
    );
  }

  async resolve(
    projectId: string,
    providerId: string,
    pluginId: string,
  ): Promise<EffectiveProviderPluginPolicy | null> {
    const normalizedPluginId = this.normalizePluginId(pluginId);
    const projectOverride = await this.storage.getProjectProviderPluginOverride(
      projectId,
      providerId,
      normalizedPluginId,
    );
    if (projectOverride) {
      return {
        providerId,
        pluginId: projectOverride.pluginId,
        enabled: projectOverride.enabled,
        source: 'project',
      };
    }

    const providerDefault = await this.storage.getProviderPluginDefault(
      providerId,
      normalizedPluginId,
    );
    return providerDefault
      ? {
          providerId,
          pluginId: providerDefault.pluginId,
          enabled: providerDefault.enabled,
          source: 'default',
        }
      : null;
  }

  async resolveAll(
    projectId: string,
    providerId: string,
  ): Promise<EffectiveProviderPluginPolicy[]> {
    const [defaults, overrides] = await Promise.all([
      this.storage.listProviderPluginDefaults(providerId),
      this.storage.listProjectProviderPluginOverrides(projectId, providerId),
    ]);
    const effectiveByPluginId = new Map<string, EffectiveProviderPluginPolicy>();

    for (const row of defaults) {
      effectiveByPluginId.set(row.pluginId, {
        providerId,
        pluginId: row.pluginId,
        enabled: row.enabled,
        source: 'default',
      });
    }
    for (const row of overrides) {
      effectiveByPluginId.set(row.pluginId, {
        providerId,
        pluginId: row.pluginId,
        enabled: row.enabled,
        source: 'project',
      });
    }

    return [...effectiveByPluginId.values()].sort((left, right) =>
      left.pluginId.localeCompare(right.pluginId),
    );
  }

  /**
   * Return both configured layers for management UIs. This intentionally differs
   * from resolveAll(), which collapses project overrides over provider defaults
   * for launch-time effective policy resolution.
   */
  async listConfigured(
    projectId: string,
    providerId: string,
  ): Promise<EffectiveProviderPluginPolicy[]> {
    const [defaults, overrides] = await Promise.all([
      this.storage.listProviderPluginDefaults(providerId),
      this.storage.listProjectProviderPluginOverrides(projectId, providerId),
    ]);

    return [
      ...defaults.map((row) => ({
        providerId,
        pluginId: row.pluginId,
        enabled: row.enabled,
        source: 'default' as const,
      })),
      ...overrides.map((row) => ({
        providerId,
        pluginId: row.pluginId,
        enabled: row.enabled,
        source: 'project' as const,
      })),
    ].sort(
      (left, right) =>
        left.pluginId.localeCompare(right.pluginId) || left.source.localeCompare(right.source),
    );
  }

  private normalizePluginId(pluginId: string): string {
    if (typeof pluginId !== 'string') {
      throw new ValidationError(
        'Plugin ID must contain 1 to 512 characters and no ASCII control characters.',
        { field: 'pluginId' },
      );
    }
    const normalized = pluginId.trim();
    const characterCount = Array.from(normalized).length;
    if (
      characterCount === 0 ||
      characterCount > MAX_PLUGIN_ID_LENGTH ||
      ASCII_CONTROL_PATTERN.test(normalized)
    ) {
      throw new ValidationError(
        'Plugin ID must contain 1 to 512 characters and no ASCII control characters.',
        { field: 'pluginId' },
      );
    }
    return normalized;
  }
}
