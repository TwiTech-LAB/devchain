import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { createLogger } from '../../../../common/logging/logger';
import { ValidationError } from '../../../../common/errors/error-types';
import { TemplatePresetDto, TemplatePresetSchema } from '../../dtos/settings.dto';

const logger = createLogger('PresetSettingsDelegate');

export interface PresetDelegateContext {
  sqlite: Database.Database;
}

export interface RenameProviderConfigPresetAgentContext {
  name: string;
  profileId: string;
}

export interface RenameProviderConfigInProjectPresetsInput {
  profileId: string;
  oldName: string;
  newName: string;
  agents: readonly RenameProviderConfigPresetAgentContext[];
}

export class PresetSettingsDelegate {
  private readonly sqlite: Database.Database;

  constructor(context: PresetDelegateContext) {
    this.sqlite = context.sqlite;
  }

  getProjectPresets(projectId: string): TemplatePresetDto[] {
    const rawPresets = this.readProjectPresetsMap()[projectId] ?? [];

    const validatedPresets: TemplatePresetDto[] = [];
    for (const preset of rawPresets) {
      const result = TemplatePresetSchema.safeParse(preset);
      if (result.success) {
        validatedPresets.push(result.data);
      } else {
        logger.warn(
          { projectId, preset, issues: result.error.issues },
          'Invalid preset found in storage, filtering out',
        );
      }
    }

    return validatedPresets;
  }

  async setProjectPresets(projectId: string, presets: unknown[]): Promise<void> {
    const validatedPresets: TemplatePresetDto[] = [];
    const errors: string[] = [];

    for (let i = 0; i < presets.length; i++) {
      const preset = presets[i];
      const result = TemplatePresetSchema.safeParse(preset);

      if (result.success) {
        validatedPresets.push(result.data);
      } else {
        const errorIssues = result.error.issues
          .map((issue) => `[${issue.path.join('.')}] ${issue.message}`)
          .join('; ');
        errors.push(`Preset at index ${i}: ${errorIssues}`);
      }
    }

    if (errors.length > 0) {
      throw new ValidationError('Invalid preset data', {
        projectId,
        errors,
      });
    }

    this.writeInTransaction(() => {
      const existingPresets = this.readProjectPresetsMap();
      this.writeProjectPresetsMap({
        ...existingPresets,
        [projectId]: validatedPresets,
      });
    });

    logger.info({ projectId, presetCount: validatedPresets.length }, 'Project presets updated');
  }

  async clearProjectPresets(projectId: string): Promise<void> {
    this.writeInTransaction(() => {
      const existingPresets = this.readProjectPresetsMap();
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { [projectId]: _removed, ...remaining } = existingPresets;
      this.writeProjectPresetsMap(remaining);
    });

    logger.info({ projectId }, 'Project presets cleared');
  }

  getAllProjectPresetsMap(): Map<string, TemplatePresetDto[]> {
    const presets = this.readProjectPresetsMap();
    return new Map(Object.entries(presets));
  }

  async renameProviderConfigInProjectPresets(
    projectId: string,
    input: RenameProviderConfigInProjectPresetsInput,
  ): Promise<void> {
    const targetProfileId = input.profileId.trim();
    const oldName = input.oldName.trim();
    const newName = input.newName.trim();

    if (!targetProfileId) {
      throw new ValidationError('Profile id cannot be empty or whitespace only', { projectId });
    }
    if (!oldName) {
      throw new ValidationError('Old provider config name cannot be empty or whitespace only', {
        projectId,
        profileId: targetProfileId,
      });
    }
    if (!newName) {
      throw new ValidationError('New provider config name cannot be empty or whitespace only', {
        projectId,
        profileId: targetProfileId,
      });
    }

    const targetAgentNames = new Set(
      input.agents
        .filter((agent) => agent.profileId === targetProfileId)
        .map((agent) => this.normalizeName(agent.name))
        .filter((name) => name.length > 0),
    );

    if (targetAgentNames.size === 0) {
      logger.info(
        { projectId, profileId: targetProfileId, oldName, newName },
        'No matching agents for provider config preset rename',
      );
      return;
    }

    const normalizedOldName = this.normalizeName(oldName);

    this.writeInTransaction(() => {
      const existingPresets = this.getProjectPresets(projectId);
      let changed = false;

      const updatedPresets = existingPresets.map((preset) => {
        let presetChanged = false;
        const updatedAgentConfigs = preset.agentConfigs.map((agentConfig) => {
          const agentName = this.normalizeName(agentConfig.agentName);
          const providerConfigName = this.normalizeName(agentConfig.providerConfigName);
          const shouldRename =
            targetAgentNames.has(agentName) && providerConfigName === normalizedOldName;

          if (!shouldRename || agentConfig.providerConfigName === newName) {
            return agentConfig;
          }

          presetChanged = true;
          changed = true;
          return {
            ...agentConfig,
            providerConfigName: newName,
          };
        });

        if (!presetChanged) {
          return preset;
        }

        return {
          ...preset,
          agentConfigs: updatedAgentConfigs,
        };
      });

      if (!changed) {
        logger.info(
          { projectId, profileId: targetProfileId, oldName, newName },
          'No project preset provider config references needed rename',
        );
        return;
      }

      const existingPresetsMap = this.readProjectPresetsMap();
      this.writeProjectPresetsMap({
        ...existingPresetsMap,
        [projectId]: updatedPresets,
      });

      logger.info(
        { projectId, profileId: targetProfileId, oldName, newName },
        'Project preset provider config references renamed',
      );
    });
  }

  async createProjectPreset(projectId: string, preset: unknown): Promise<void> {
    const result = TemplatePresetSchema.safeParse(preset);
    if (!result.success) {
      const errorIssues = result.error.issues
        .map((issue) => `[${issue.path.join('.')}] ${issue.message}`)
        .join('; ');
      throw new ValidationError(`Invalid preset data: ${errorIssues}`, {
        projectId,
        issues: result.error.issues,
      });
    }

    const validatedPreset = result.data;
    const trimmedName = validatedPreset.name.trim();

    if (!trimmedName) {
      throw new ValidationError('Preset name cannot be empty or whitespace only', {
        projectId,
      });
    }

    this.writeInTransaction(() => {
      const existingPresets = this.getProjectPresets(projectId);
      const normalizedName = trimmedName.toLowerCase();
      const nameExists = existingPresets.some((p) => p.name.toLowerCase() === normalizedName);

      if (nameExists) {
        throw new ValidationError(
          `Preset with name "${trimmedName}" already exists (case-insensitive)`,
          {
            projectId,
            presetName: trimmedName,
            hint: 'Choose a different name or delete the existing preset first.',
          },
        );
      }

      const existingPresetsMap = this.readProjectPresetsMap();
      this.writeProjectPresetsMap({
        ...existingPresetsMap,
        [projectId]: [...existingPresets, { ...validatedPreset, name: trimmedName }],
      });
    });

    logger.info({ projectId, presetName: trimmedName }, 'Preset created');
  }

  async updateProjectPreset(
    projectId: string,
    presetName: string,
    updates: unknown,
  ): Promise<void> {
    this.writeInTransaction(() => {
      const existingPresets = this.getProjectPresets(projectId);

      const normalizedName = presetName.trim().toLowerCase();
      const presetIndex = existingPresets.findIndex((p) => p.name.toLowerCase() === normalizedName);

      if (presetIndex === -1) {
        throw new ValidationError(`Preset "${presetName.trim()}" not found`, {
          projectId,
          presetName: presetName.trim(),
        });
      }

      const existingPreset = existingPresets[presetIndex];

      const mergedPreset = { ...existingPreset };
      if (typeof updates === 'object' && updates !== null) {
        const updateObj = updates as Record<string, unknown>;
        if ('name' in updateObj) {
          if (typeof updateObj.name !== 'string') {
            throw new ValidationError(`Invalid preset update: name must be a string`, {
              projectId,
              presetName,
            });
          }
          mergedPreset.name = updateObj.name;
        }
        if ('description' in updateObj) {
          if (updateObj.description !== null && typeof updateObj.description !== 'string') {
            throw new ValidationError(
              `Invalid preset update: description must be a string or null`,
              {
                projectId,
                presetName,
              },
            );
          }
          mergedPreset.description = updateObj.description;
        }
        if ('agentConfigs' in updateObj) {
          if (!Array.isArray(updateObj.agentConfigs)) {
            throw new ValidationError(`Invalid preset update: agentConfigs must be an array`, {
              projectId,
              presetName,
            });
          }
          mergedPreset.agentConfigs = updateObj.agentConfigs;
        }
      }

      const result = TemplatePresetSchema.safeParse(mergedPreset);
      if (!result.success) {
        const errorIssues = result.error.issues
          .map((issue) => `[${issue.path.join('.')}] ${issue.message}`)
          .join('; ');
        throw new ValidationError(`Invalid preset update: ${errorIssues}`, {
          projectId,
          presetName,
          issues: result.error.issues,
        });
      }

      const validatedPreset = result.data;
      const trimmedName = validatedPreset.name.trim();

      validatedPreset.name = trimmedName;

      if (trimmedName.toLowerCase() !== normalizedName) {
        const nameExists = existingPresets.some(
          (p, idx) => idx !== presetIndex && p.name.toLowerCase() === trimmedName.toLowerCase(),
        );

        if (nameExists) {
          throw new ValidationError(
            `Preset with name "${trimmedName}" already exists (case-insensitive)`,
            {
              projectId,
              presetName: trimmedName,
              hint: 'Choose a different name.',
            },
          );
        }
      }

      const updatedPresets = [...existingPresets];
      updatedPresets.splice(presetIndex, 1);
      updatedPresets.push(validatedPreset);

      const existingPresetsMap = this.readProjectPresetsMap();
      const existingActivePresets = this.readActivePresetsMap();

      const updatePayload: {
        projectPresets: Record<string, TemplatePresetDto[]>;
        projectActivePresets?: Record<string, string | null>;
      } = {
        projectPresets: {
          ...existingPresetsMap,
          [projectId]: updatedPresets,
        },
      };

      if (trimmedName.toLowerCase() !== normalizedName) {
        const originalName = existingPreset.name;
        const currentActivePreset = existingActivePresets[projectId];

        if (
          currentActivePreset &&
          currentActivePreset.toLowerCase() === originalName.toLowerCase()
        ) {
          updatePayload.projectActivePresets = {
            ...existingActivePresets,
            [projectId]: trimmedName,
          };
          logger.info(
            { projectId, oldName: currentActivePreset, newName: trimmedName },
            'Active preset migrated after rename (case-insensitive)',
          );
        }
      }

      this.writeProjectPresetsMap(updatePayload.projectPresets);
      if (updatePayload.projectActivePresets !== undefined) {
        this.writeActivePresetsMap(updatePayload.projectActivePresets);
      }

      logger.info({ projectId, presetName: trimmedName }, 'Preset updated');
    });
  }

  async deleteProjectPreset(projectId: string, presetName: string): Promise<void> {
    this.writeInTransaction(() => {
      const existingPresets = this.getProjectPresets(projectId);

      const normalizedName = presetName.trim().toLowerCase();
      const presetIndex = existingPresets.findIndex((p) => p.name.toLowerCase() === normalizedName);

      if (presetIndex === -1) {
        throw new ValidationError(`Preset "${presetName.trim()}" not found`, {
          projectId,
          presetName: presetName.trim(),
        });
      }

      const deletedPreset = existingPresets[presetIndex];

      const updatedPresets = existingPresets.filter((_, idx) => idx !== presetIndex);

      const existingPresetsMap = this.readProjectPresetsMap();
      const existingActivePresets = this.readActivePresetsMap();

      const updatePayload: {
        projectPresets: Record<string, TemplatePresetDto[]>;
        projectActivePresets?: Record<string, string | null>;
      } = {
        projectPresets: {
          ...existingPresetsMap,
          [projectId]: updatedPresets,
        },
      };

      const currentActivePreset = existingActivePresets[projectId];
      if (
        currentActivePreset &&
        currentActivePreset.toLowerCase() === deletedPreset.name.toLowerCase()
      ) {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { [projectId]: _removed, ...remainingActivePresets } = existingActivePresets;
        updatePayload.projectActivePresets = remainingActivePresets;
        logger.info(
          { projectId, presetName: deletedPreset.name, activePreset: currentActivePreset },
          'Active preset cleared after preset deletion (case-insensitive)',
        );
      }

      this.writeProjectPresetsMap(updatePayload.projectPresets);
      if (updatePayload.projectActivePresets !== undefined) {
        this.writeActivePresetsMap(updatePayload.projectActivePresets);
      }

      logger.info({ projectId, presetName: deletedPreset.name }, 'Preset deleted');
    });
  }

  getProjectActivePreset(projectId: string): string | null {
    const map = this.readActivePresetsMap();
    return map[projectId] ?? null;
  }

  async setProjectActivePreset(projectId: string, presetName: string | null): Promise<void> {
    this.writeInTransaction(() => {
      const existingActivePresets = this.readActivePresetsMap();

      if (presetName === null) {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { [projectId]: _removed, ...remaining } = existingActivePresets;
        this.writeActivePresetsMap(remaining);
        logger.info({ projectId }, 'Project active preset cleared');
      } else {
        this.writeActivePresetsMap({
          ...existingActivePresets,
          [projectId]: presetName,
        });
        logger.info({ projectId, presetName }, 'Project active preset set');
      }
    });
  }

  private readProjectPresetsMap(): Record<string, TemplatePresetDto[]> {
    const raw = this.readRawSetting('projectPresets');
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, TemplatePresetDto[]>;
      }
      return {};
    } catch {
      logger.warn('Failed to parse projectPresets');
      return {};
    }
  }

  private readActivePresetsMap(): Record<string, string | null> {
    const raw = this.readRawSetting('projectActivePresets');
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, string | null>;
      }
      return {};
    } catch {
      logger.warn('Failed to parse projectActivePresets');
      return {};
    }
  }

  private readRawSetting(key: string): string | undefined {
    const row = this.sqlite.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  private writeInTransaction(fn: () => void): void {
    this.sqlite.transaction(fn)();
  }

  private normalizeName(name: string): string {
    return name.trim().toLowerCase();
  }

  private writeProjectPresetsMap(map: Record<string, TemplatePresetDto[]>): void {
    const now = new Date().toISOString();
    const stmt = this.sqlite.prepare(`
      INSERT INTO settings (id, key, value, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `);
    stmt.run(randomUUID(), 'projectPresets', JSON.stringify(map), now, now);
  }

  private writeActivePresetsMap(map: Record<string, string | null>): void {
    const now = new Date().toISOString();
    const stmt = this.sqlite.prepare(`
      INSERT INTO settings (id, key, value, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `);
    stmt.run(randomUUID(), 'projectActivePresets', JSON.stringify(map), now, now);
  }
}
