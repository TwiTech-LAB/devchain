import { Injectable, Inject } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createLogger } from '../../../common/logging/logger';
import type {
  SettingsDto,
  MessagePoolSettingsDto,
  RegistryTemplateMetadataDto,
  RegistryConfigDto,
  TemplatePresetDto,
} from '../dtos/settings.dto';
import { DB_CONNECTION } from '../../storage/db/db.provider';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { getRawSqliteClient } from '../../storage/db/sqlite-raw';
import {
  PresetSettingsDelegate,
  type RenameProviderConfigInProjectPresetsInput,
} from '../local/delegates/preset-settings.delegate';
import { CoreSettingsDelegate } from '../local/delegates/core-settings.delegate';
import { MessagePoolSettingsDelegate } from '../local/delegates/message-pool-settings.delegate';
import { RegistrySettingsDelegate } from '../local/delegates/registry-settings.delegate';
import { SkillsSettingsDelegate } from '../local/delegates/skills-settings.delegate';
import type { ProjectPoolSettings, ProjectSettings } from './settings.constants';

export {
  DEFAULT_TERMINAL_SCROLLBACK,
  MIN_TERMINAL_SCROLLBACK,
  MAX_TERMINAL_SCROLLBACK,
  DEFAULT_TERMINAL_SEED_MAX_BYTES,
  MIN_TERMINAL_SEED_MAX_BYTES,
  MAX_TERMINAL_SEED_MAX_BYTES,
  DEFAULT_TERMINAL_INPUT_MODE,
  DEFAULT_MESSAGE_POOL_ENABLED,
  DEFAULT_MESSAGE_POOL_DELAY_MS,
  MIN_MESSAGE_POOL_DELAY_MS,
  MAX_MESSAGE_POOL_DELAY_MS,
  DEFAULT_MESSAGE_POOL_MAX_WAIT_MS,
  MIN_MESSAGE_POOL_MAX_WAIT_MS,
  MAX_MESSAGE_POOL_MAX_WAIT_MS,
  DEFAULT_MESSAGE_POOL_MAX_MESSAGES,
  MIN_MESSAGE_POOL_MAX_MESSAGES,
  MAX_MESSAGE_POOL_MAX_MESSAGES,
  DEFAULT_MESSAGE_POOL_SEPARATOR,
  DEFAULT_SKILLS_SYNC_ON_STARTUP,
} from './settings.constants';
export type { ProjectPoolSettings, ProjectSettings } from './settings.constants';

const logger = createLogger('SettingsService');

@Injectable()
export class SettingsService {
  private readonly presetDelegate: PresetSettingsDelegate;
  private readonly coreDelegate: CoreSettingsDelegate;
  private readonly messagePoolDelegate: MessagePoolSettingsDelegate;
  private readonly registryDelegate: RegistrySettingsDelegate;
  private readonly skillsDelegate: SkillsSettingsDelegate;

  constructor(
    @Inject(DB_CONNECTION) private readonly db: BetterSQLite3Database,
    private readonly eventEmitter: EventEmitter2,
  ) {
    const sqlite = getRawSqliteClient(this.db);
    this.coreDelegate = new CoreSettingsDelegate({ sqlite, eventEmitter });
    this.presetDelegate = new PresetSettingsDelegate({ sqlite });
    this.skillsDelegate = new SkillsSettingsDelegate({ sqlite });
    this.messagePoolDelegate = new MessagePoolSettingsDelegate({
      getSettings: () => this.getSettings(),
      updateSettings: (s) => this.updateSettings(s),
    });
    this.registryDelegate = new RegistrySettingsDelegate({
      getSettings: () => this.getSettings(),
      updateSettings: (s) => this.updateSettings(s),
    });
    logger.info('SettingsService initialized');
  }

  // --- Core ---
  getSettings(): SettingsDto {
    return this.coreDelegate.getSettings();
  }
  async updateSettings(settings: SettingsDto): Promise<SettingsDto> {
    return this.coreDelegate.updateSettings(settings);
  }
  getSetting(key: string): string | undefined {
    return this.coreDelegate.getSetting(key);
  }
  getScrollbackLines(): number {
    return this.coreDelegate.getScrollbackLines();
  }

  // --- Skills ---
  getSkillsSyncOnStartup(): boolean {
    return this.skillsDelegate.getSkillsSyncOnStartup();
  }
  getSkillSourcesEnabled(): Record<string, boolean> {
    return this.skillsDelegate.getSkillSourcesEnabled();
  }
  async setSkillSourceEnabled(sourceName: string, enabled: boolean): Promise<void> {
    return this.skillsDelegate.setSkillSourceEnabled(sourceName, enabled);
  }

  // --- Auto-clean ---
  getAutoCleanStatusIds(projectId: string): string[] {
    const raw = this.getSetting('autoClean.statusIds');
    if (!raw) return [];
    try {
      const map = JSON.parse(raw) as Record<string, string[]>;
      return map[projectId] ?? [];
    } catch {
      logger.warn('Failed to parse autoClean.statusIds');
      return [];
    }
  }

  // --- Message pool ---
  getMessagePoolConfig(): Required<Omit<MessagePoolSettingsDto, 'projects'>> {
    return this.messagePoolDelegate.getMessagePoolConfig();
  }
  getMessagePoolConfigForProject(
    projectId: string,
  ): Required<Omit<MessagePoolSettingsDto, 'projects'>> {
    return this.messagePoolDelegate.getMessagePoolConfigForProject(projectId);
  }
  getProjectPoolSettings(projectId: string): ProjectPoolSettings | undefined {
    return this.messagePoolDelegate.getProjectPoolSettings(projectId);
  }
  async setProjectPoolSettings(
    projectId: string,
    poolSettings: ProjectPoolSettings | null,
  ): Promise<void> {
    return this.messagePoolDelegate.setProjectPoolSettings(projectId, poolSettings);
  }

  // --- Project settings (composite) ---
  getProjectSettings(projectId: string): ProjectSettings {
    const settings = this.getSettings();
    const result: ProjectSettings = {};
    const promptId = settings.initialSessionPromptIds?.[projectId];
    if (promptId !== undefined) result.initialSessionPromptId = promptId;
    const autoCleanIds = settings.autoClean?.statusIds?.[projectId];
    if (autoCleanIds && autoCleanIds.length > 0) result.autoCleanStatusIds = autoCleanIds;
    const epicTemplate = settings.events?.epicAssigned?.template;
    if (epicTemplate) result.epicAssignedTemplate = epicTemplate;
    const poolSettings = settings.messagePool?.projects?.[projectId];
    if (poolSettings) result.messagePoolSettings = poolSettings;
    return result;
  }

  async setProjectSettings(projectId: string, ps: ProjectSettings): Promise<void> {
    const updates: SettingsDto = {};
    if (ps.initialSessionPromptId !== undefined) {
      updates.projectId = projectId;
      updates.initialSessionPromptId = ps.initialSessionPromptId;
    }
    if (ps.autoCleanStatusIds !== undefined) {
      const existing = this.getSettings().autoClean?.statusIds ?? {};
      updates.autoClean = { statusIds: { ...existing, [projectId]: ps.autoCleanStatusIds } };
    }
    if (ps.epicAssignedTemplate !== undefined) {
      updates.events = { epicAssigned: { template: ps.epicAssignedTemplate } };
    }
    if (ps.messagePoolSettings !== undefined) {
      const existing = this.getSettings().messagePool?.projects ?? {};
      updates.messagePool = { projects: { ...existing, [projectId]: ps.messagePoolSettings } };
    }
    if (Object.keys(updates).length > 0) {
      await this.updateSettings(updates);
      logger.info({ projectId, updates: Object.keys(updates) }, 'Project settings updated');
    }
  }

  // --- Registry ---
  getRegistryConfig(): Required<RegistryConfigDto> {
    return this.registryDelegate.getRegistryConfig();
  }
  async setRegistryConfig(config: Partial<RegistryConfigDto>): Promise<void> {
    return this.registryDelegate.setRegistryConfig(config);
  }
  getProjectTemplateMetadata(projectId: string): RegistryTemplateMetadataDto | null {
    return this.registryDelegate.getProjectTemplateMetadata(projectId);
  }
  async setProjectTemplateMetadata(
    projectId: string,
    metadata: RegistryTemplateMetadataDto,
  ): Promise<void> {
    return this.registryDelegate.setProjectTemplateMetadata(projectId, metadata);
  }
  async clearProjectTemplateMetadata(projectId: string): Promise<void> {
    return this.registryDelegate.clearProjectTemplateMetadata(projectId);
  }
  getAllTrackedProjects(): Array<{ projectId: string; metadata: RegistryTemplateMetadataDto }> {
    return this.registryDelegate.getAllTrackedProjects();
  }
  getAllProjectTemplateMetadataMap(): Map<string, RegistryTemplateMetadataDto> {
    return this.registryDelegate.getAllProjectTemplateMetadataMap();
  }
  async updateLastUpdateCheck(projectId: string): Promise<void> {
    return this.registryDelegate.updateLastUpdateCheck(projectId);
  }

  // --- Presets ---
  getProjectPresets(projectId: string): TemplatePresetDto[] {
    return this.presetDelegate.getProjectPresets(projectId);
  }
  async setProjectPresets(projectId: string, presets: unknown[]): Promise<void> {
    return this.presetDelegate.setProjectPresets(projectId, presets);
  }
  async clearProjectPresets(projectId: string): Promise<void> {
    return this.presetDelegate.clearProjectPresets(projectId);
  }
  getAllProjectPresetsMap(): Map<string, TemplatePresetDto[]> {
    return this.presetDelegate.getAllProjectPresetsMap();
  }
  async renameProviderConfigInProjectPresets(
    projectId: string,
    input: RenameProviderConfigInProjectPresetsInput,
  ): Promise<void> {
    return this.presetDelegate.renameProviderConfigInProjectPresets(projectId, input);
  }
  async createProjectPreset(projectId: string, preset: unknown): Promise<void> {
    return this.presetDelegate.createProjectPreset(projectId, preset);
  }
  async updateProjectPreset(
    projectId: string,
    presetName: string,
    updates: unknown,
  ): Promise<void> {
    return this.presetDelegate.updateProjectPreset(projectId, presetName, updates);
  }
  async deleteProjectPreset(projectId: string, presetName: string): Promise<void> {
    return this.presetDelegate.deleteProjectPreset(projectId, presetName);
  }
  getProjectActivePreset(projectId: string): string | null {
    return this.presetDelegate.getProjectActivePreset(projectId);
  }
  async setProjectActivePreset(projectId: string, presetName: string | null): Promise<void> {
    return this.presetDelegate.setProjectActivePreset(projectId, presetName);
  }
}
