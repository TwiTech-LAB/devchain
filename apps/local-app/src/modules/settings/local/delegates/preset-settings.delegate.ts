import type { ProjectWriteGate } from '../../../storage/write-gate/project-write-gate';
import { TransactionRunner } from '../../../storage/db/transaction-runner';
import { presetNameKey } from '@devchain/shared';
import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { createLogger } from '../../../../common/logging/logger';
import { ValidationError } from '../../../../common/errors/error-types';
import {
  PresetInputSchema,
  TemplatePresetDto,
  TemplatePresetSchema,
} from '../../dtos/settings.dto';

const logger = createLogger('PresetSettingsDelegate');

export interface PresetDelegateContext {
  gate?: ProjectWriteGate;
  sqlite: Database.Database;
}

export interface RenameProviderConfigPresetAgentContext {
  name: string;
  profileId: string;
}

export interface RenameProviderConfigInProjectPresetsInput {
  profileId: string;
  profileName?: string;
  oldName: string;
  newName: string;
  agents: readonly RenameProviderConfigPresetAgentContext[];
}

type PresetProfileSelection = NonNullable<
  TemplatePresetDto['teamConfigs']
>[number]['profileSelections'][number];

export class PresetSettingsDelegate {
  private readonly sqlite: Database.Database;
  private readonly txRunner: TransactionRunner;
  private readonly gate?: ProjectWriteGate;

  constructor(context: PresetDelegateContext) {
    this.sqlite = context.sqlite;
    this.txRunner = new TransactionRunner(context.sqlite);
    this.gate = context.gate;
  }

  getProjectPresets(projectId: string): TemplatePresetDto[] {
    const rawPresets = this.readProjectPresetsMap()[projectId] ?? [];
    return this.validateStoredPresets(projectId, rawPresets);
  }

  private validateStoredPresets(projectId: string, rawPresets: unknown[]): TemplatePresetDto[] {
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
    const validatedPresets = this.validatePresets(projectId, presets, TemplatePresetSchema);
    await this.writeInTransaction(() => {
      const existingPresets = this.readProjectPresetsMap();
      this.writeProjectPresetsMap({ ...existingPresets, [projectId]: validatedPresets }, projectId);
    });

    logger.info({ projectId, presetCount: validatedPresets.length }, 'Project presets updated');
  }

  async mergeProjectTemplatePresets(
    projectId: string,
    presets: readonly unknown[],
    agentNames: readonly string[],
    teamNames?: readonly string[],
  ): Promise<void> {
    const incoming = this.validatePresets(projectId, presets, PresetInputSchema);
    const incomingNames = new Set(incoming.map(({ name }) => this.normalizeName(name)));
    const agents = new Set(agentNames.map((name) => this.normalizeName(name)));
    const teams = teamNames && new Set(teamNames.map((name) => this.normalizeName(name)));

    await this.writeInTransaction(() => {
      const existingPresets = this.readProjectPresetsMap();
      const stored = existingPresets[projectId];
      const kept: TemplatePresetDto[] = [];
      const userPresets = this.validateStoredPresets(
        projectId,
        (Array.isArray(stored) ? stored : []).filter((preset) => preset?.origin === 'user'),
      );

      for (const preset of userPresets) {
        if (incomingNames.has(this.normalizeName(preset.name))) continue;

        const agentConfigs = preset.agentConfigs.filter(({ agentName }) =>
          agents.has(this.normalizeName(agentName)),
        );
        const teamConfigs = teams
          ? preset.teamConfigs?.filter(({ teamName }) => teams.has(this.normalizeName(teamName)))
          : preset.teamConfigs;

        if (agentConfigs.length === 0 && !teamConfigs?.length) {
          logger.info(
            { projectId, presetName: preset.name },
            'Removed user preset with no remaining entries',
          );
          continue;
        }

        kept.push({
          ...preset,
          agentConfigs,
          ...(teamConfigs === undefined ? {} : { teamConfigs }),
        });
      }

      const merged = [...incoming, ...kept];
      if (merged.length > 0) {
        this.writeProjectPresetsMap({ ...existingPresets, [projectId]: merged }, projectId);
      } else {
        delete existingPresets[projectId];
        this.writeProjectPresetsMap(existingPresets, projectId);
      }
    });
  }

  private validatePresets(
    projectId: string,
    presets: readonly unknown[],
    schema: typeof TemplatePresetSchema | typeof PresetInputSchema,
  ): TemplatePresetDto[] {
    const validatedPresets: TemplatePresetDto[] = [];
    const errors: string[] = [];

    for (let i = 0; i < presets.length; i++) {
      const preset = presets[i];
      const result = schema.safeParse(preset);

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

    return validatedPresets;
  }

  async clearProjectPresets(projectId: string): Promise<void> {
    await this.writeInTransaction(() => {
      const existingPresets = this.readProjectPresetsMap();
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { [projectId]: _removed, ...remaining } = existingPresets;
      this.writeProjectPresetsMap(remaining, projectId);
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

    if (targetAgentNames.size === 0 && input.profileName === undefined) {
      logger.info(
        { projectId, profileId: targetProfileId, oldName, newName },
        'No matching agents for provider config preset rename',
      );
      return;
    }

    const normalizedOldName = this.normalizeName(oldName);
    const normalizedProfileName =
      input.profileName === undefined ? undefined : this.normalizeName(input.profileName);

    const changed = await this.updateProjectPresetReferences(projectId, (preset) => {
      const agentConfigs = preset.agentConfigs.map((agentConfig) =>
        targetAgentNames.has(this.normalizeName(agentConfig.agentName)) &&
        this.normalizeName(agentConfig.providerConfigName) === normalizedOldName
          ? { ...agentConfig, providerConfigName: newName }
          : agentConfig,
      );

      const updatedPreset = this.mapTeamProfileSelections(preset, (selection) => {
        if (this.normalizeName(selection.profileName) !== normalizedProfileName) {
          return selection;
        }
        const configNames = selection.configNames.map((name) =>
          this.normalizeName(name) === normalizedOldName ? newName : name,
        );
        return { ...selection, configNames };
      });

      return { ...updatedPreset, agentConfigs };
    });

    logger.info(
      { projectId, profileId: targetProfileId, oldName, newName },
      changed
        ? 'Project preset provider config references renamed'
        : 'No project preset provider config references needed rename',
    );
  }

  async renameTeamInProjectPresets(projectId: string, oldName: string, newName: string) {
    const normalizedOldName = this.normalizeName(oldName);
    const normalizedNewName = this.normalizeName(newName);
    await this.updateProjectPresetReferences(projectId, (preset) => {
      const entries = preset.teamConfigs;
      if (!entries) return preset;

      const sourceIndex = entries.findIndex(
        (entry) => this.normalizeName(entry.teamName) === normalizedOldName,
      );
      if (sourceIndex === -1) return preset;

      const teamConfigs = entries.flatMap((entry, index) => {
        if (index === sourceIndex) {
          return [{ ...entry, teamName: newName }];
        }
        const name = this.normalizeName(entry.teamName);
        return name === normalizedOldName || name === normalizedNewName ? [] : [entry];
      });
      return { ...preset, teamConfigs };
    });
  }

  async removeTeamFromProjectPresets(projectId: string, teamName: string) {
    const normalizedTeamName = this.normalizeName(teamName);
    await this.updateProjectPresetReferences(projectId, (preset) => {
      if (!preset.teamConfigs) return preset;
      const teamConfigs = preset.teamConfigs.filter(
        (entry) => this.normalizeName(entry.teamName) !== normalizedTeamName,
      );
      return { ...preset, teamConfigs };
    });
  }

  async renameProfileInProjectPresets(projectId: string, oldName: string, newName: string) {
    const normalizedOldName = this.normalizeName(oldName);
    await this.updateProjectPresetReferences(projectId, (preset) =>
      this.mapTeamProfileSelections(preset, (selection) =>
        this.normalizeName(selection.profileName) === normalizedOldName
          ? { ...selection, profileName: newName }
          : selection,
      ),
    );
  }

  async removeAgentFromProjectPresets(projectId: string, agentName: string): Promise<void> {
    const trimmedAgentName = agentName.trim();

    if (!trimmedAgentName) {
      throw new ValidationError('Agent name cannot be empty or whitespace only', { projectId });
    }

    const normalizedAgentName = this.normalizeName(trimmedAgentName);

    await this.writeInTransaction(() => {
      const existingPresets = this.getProjectPresets(projectId);
      let changed = false;

      const updatedPresets = existingPresets.map((preset) => {
        const updatedAgentConfigs = preset.agentConfigs.filter((agentConfig) => {
          const matches = this.normalizeName(agentConfig.agentName) === normalizedAgentName;
          if (matches) changed = true;
          return !matches;
        });

        if (updatedAgentConfigs.length === preset.agentConfigs.length) {
          return preset;
        }

        return {
          ...preset,
          agentConfigs: updatedAgentConfigs,
        };
      });

      if (!changed) {
        logger.info(
          { projectId, agentName: trimmedAgentName },
          'No project preset agent references needed removal',
        );
        return;
      }

      const existingPresetsMap = this.readProjectPresetsMap();
      this.writeProjectPresetsMap(
        {
          ...existingPresetsMap,
          [projectId]: updatedPresets,
        },
        projectId,
      );

      logger.info(
        { projectId, agentName: trimmedAgentName },
        'Project preset agent references removed',
      );
    });
  }

  async createProjectPreset(projectId: string, preset: unknown): Promise<TemplatePresetDto> {
    const result = PresetInputSchema.safeParse(preset);
    if (!result.success) {
      const errorIssues = result.error.issues
        .map((issue) => `[${issue.path.join('.')}] ${issue.message}`)
        .join('; ');
      throw new ValidationError(`Invalid preset data: ${errorIssues}`, {
        projectId,
        issues: result.error.issues,
      });
    }

    const trimmedName = result.data.name.trim();

    if (!trimmedName) {
      throw new ValidationError('Preset name cannot be empty or whitespace only', {
        projectId,
      });
    }

    const validatedPreset: TemplatePresetDto = {
      ...result.data,
      name: trimmedName,
      origin: 'user',
    };
    this.assertUniquePresetTeams(projectId, validatedPreset);

    await this.writeInTransaction(() => {
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
      this.writeProjectPresetsMap(
        {
          ...existingPresetsMap,
          [projectId]: [...existingPresets, validatedPreset],
        },
        projectId,
      );
    });

    logger.info({ projectId, presetName: trimmedName }, 'Preset created');
    return validatedPreset;
  }

  async updateProjectPreset(
    projectId: string,
    presetName: string,
    updates: unknown,
  ): Promise<void> {
    await this.writeInTransaction(() => {
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
        if ('teamConfigs' in updateObj) {
          if (!Array.isArray(updateObj.teamConfigs)) {
            throw new ValidationError('Invalid preset update: teamConfigs must be an array', {
              projectId,
              presetName,
            });
          }
          mergedPreset.teamConfigs = updateObj.teamConfigs;
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
      const nameChanged = trimmedName.toLowerCase() !== normalizedName;

      validatedPreset.name = trimmedName;
      this.assertUniquePresetTeams(projectId, validatedPreset);

      if (nameChanged) {
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
        validatedPreset.origin = 'user';
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

      if (nameChanged) {
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

      this.writeProjectPresetsMap(updatePayload.projectPresets, projectId);
      if (updatePayload.projectActivePresets !== undefined) {
        this.writeActivePresetsMap(updatePayload.projectActivePresets, projectId);
      }

      logger.info({ projectId, presetName: trimmedName }, 'Preset updated');
    });
  }

  async deleteProjectPreset(projectId: string, presetName: string): Promise<void> {
    await this.writeInTransaction(() => {
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

      this.writeProjectPresetsMap(updatePayload.projectPresets, projectId);
      if (updatePayload.projectActivePresets !== undefined) {
        this.writeActivePresetsMap(updatePayload.projectActivePresets, projectId);
      }

      logger.info({ projectId, presetName: deletedPreset.name }, 'Preset deleted');
    });
  }

  getProjectActivePreset(projectId: string): string | null {
    const map = this.readActivePresetsMap();
    return map[projectId] ?? null;
  }

  async setProjectActivePreset(projectId: string, presetName: string | null): Promise<void> {
    await this.writeInTransaction(() => {
      const existingActivePresets = this.readActivePresetsMap();

      if (presetName === null) {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { [projectId]: _removed, ...remaining } = existingActivePresets;
        this.writeActivePresetsMap(remaining, projectId);
        logger.info({ projectId }, 'Project active preset cleared');
      } else {
        this.writeActivePresetsMap(
          {
            ...existingActivePresets,
            [projectId]: presetName,
          },
          projectId,
        );
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

  private async writeInTransaction(fn: () => void): Promise<void> {
    await this.txRunner.runImmediateQueuedOrJoin(fn);
  }

  private async updateProjectPresetReferences(
    projectId: string,
    update: (preset: TemplatePresetDto) => TemplatePresetDto,
  ): Promise<boolean> {
    return this.txRunner.runImmediateQueuedOrJoin(() => {
      const presetsMap = this.readProjectPresetsMap();
      const existingPresets = this.validateStoredPresets(projectId, presetsMap[projectId] ?? []);
      const updatedPresets = existingPresets.map(update);
      // Compare content, so an update can return a new object when nothing changed.
      if (JSON.stringify(updatedPresets) === JSON.stringify(existingPresets)) {
        return false;
      }

      this.writeProjectPresetsMap({ ...presetsMap, [projectId]: updatedPresets }, projectId);
      return true;
    });
  }

  private mapTeamProfileSelections(
    preset: TemplatePresetDto,
    update: (selection: PresetProfileSelection) => PresetProfileSelection,
  ): TemplatePresetDto {
    if (!preset.teamConfigs) return preset;

    const teamConfigs = preset.teamConfigs.map((entry) => ({
      ...entry,
      profileSelections: entry.profileSelections.map(update),
    }));
    return { ...preset, teamConfigs };
  }

  private normalizeName(name: string): string {
    return presetNameKey(name);
  }

  private assertUniquePresetTeams(projectId: string, preset: TemplatePresetDto): void {
    const names = new Set<string>();
    for (const { teamName } of preset.teamConfigs ?? []) {
      const normalizedName = this.normalizeName(teamName);
      if (names.has(normalizedName)) {
        throw new ValidationError('Preset cannot contain multiple entries for the same team', {
          projectId,
          presetName: preset.name,
          teamName,
        });
      }
      names.add(normalizedName);
    }
  }

  private writeProjectPresetsMap(
    map: Record<string, TemplatePresetDto[]>,
    projectId: string,
  ): void {
    this.gate?.assertWritable(projectId);
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

  private writeActivePresetsMap(map: Record<string, string | null>, projectId: string): void {
    this.gate?.assertWritable(projectId);
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
