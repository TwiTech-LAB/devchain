import { Injectable, Inject } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createLogger } from '../../../common/logging/logger';
import { ValidationError } from '../../../common/errors/error-types';
import {
  SettingsDto,
  MessagePoolSettingsDto,
  TERMINAL_INPUT_MODES,
  TerminalInputMode,
  RegistryTemplateMetadataDto,
  RegistryConfigDto,
} from '../dtos/settings.dto';
import { DB_CONNECTION } from '../../storage/db/db.provider';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import { getRawSqliteClient } from '../../storage/db/sqlite-raw';
import { randomUUID } from 'crypto';
import { access, constants } from 'fs/promises';
import { resolve } from 'path';
import {
  DEFAULT_TERMINAL_SCROLLBACK,
  MIN_TERMINAL_SCROLLBACK,
  MAX_TERMINAL_SCROLLBACK,
} from '../../../common/constants/terminal';
import { settingsTerminalChangedEvent } from '../../events/catalog';

// Re-export scrollback constants for backward compatibility
export { DEFAULT_TERMINAL_SCROLLBACK, MIN_TERMINAL_SCROLLBACK, MAX_TERMINAL_SCROLLBACK };

const logger = createLogger('SettingsService');
export const DEFAULT_TERMINAL_SEED_MAX_BYTES = 1024 * 1024; // 1MB
export const MIN_TERMINAL_SEED_MAX_BYTES = 64 * 1024; // 64KB
export const MAX_TERMINAL_SEED_MAX_BYTES = 4 * 1024 * 1024; // 4MB
export const DEFAULT_TERMINAL_INPUT_MODE: TerminalInputMode = 'tty';

// Message pool defaults
export const DEFAULT_MESSAGE_POOL_ENABLED = true;
export const DEFAULT_MESSAGE_POOL_DELAY_MS = 10000; // 10 seconds debounce
export const MIN_MESSAGE_POOL_DELAY_MS = 1000;
export const MAX_MESSAGE_POOL_DELAY_MS = 60000;
export const DEFAULT_MESSAGE_POOL_MAX_WAIT_MS = 30000; // 30 seconds max wait
export const MIN_MESSAGE_POOL_MAX_WAIT_MS = 5000;
export const MAX_MESSAGE_POOL_MAX_WAIT_MS = 120000;
export const DEFAULT_MESSAGE_POOL_MAX_MESSAGES = 10;
export const MIN_MESSAGE_POOL_MAX_MESSAGES = 1;
export const MAX_MESSAGE_POOL_MAX_MESSAGES = 100;
export const DEFAULT_MESSAGE_POOL_SEPARATOR = '\n---\n';

/**
 * Per-project message pool settings
 */
export interface ProjectPoolSettings {
  enabled?: boolean;
  delayMs?: number;
  maxWaitMs?: number;
  maxMessages?: number;
  separator?: string;
}

/**
 * Project-specific settings for bulk read/write operations
 */
export interface ProjectSettings {
  initialSessionPromptId?: string | null;
  autoCleanStatusIds?: string[];
  epicAssignedTemplate?: string;
  messagePoolSettings?: ProjectPoolSettings;
}

/**
 * Settings service for managing instance configuration
 */
@Injectable()
export class SettingsService {
  private sqlite: Database.Database;

  constructor(
    @Inject(DB_CONNECTION) private readonly db: BetterSQLite3Database,
    private readonly eventEmitter: EventEmitter2,
  ) {
    // Encapsulated raw client access
    this.sqlite = getRawSqliteClient(this.db);
    logger.info('SettingsService initialized');
  }

  /**
   * Get all settings
   */
  getSettings(): SettingsDto {
    const rows = this.sqlite.prepare('SELECT key, value FROM settings').all() as Array<{
      key: string;
      value: string;
    }>;

    const settings: SettingsDto = {};
    for (const row of rows) {
      // Ignore legacy instanceMode and apiKey fields
      if (row.key === 'instanceMode' || row.key === 'apiKey') {
        // Skip - no longer used
      } else if (row.key === 'registry.url') {
        const valueStr = this.decodeStringSetting(row.value);
        settings.registry = settings.registry ?? {};
        settings.registry.url = valueStr || undefined;
      } else if (row.key === 'registry.cacheDir') {
        const valueStr = this.decodeStringSetting(row.value);
        settings.registry = settings.registry ?? {};
        settings.registry.cacheDir = valueStr || undefined;
      } else if (row.key === 'registry.checkUpdatesOnStartup') {
        const valueStr = this.decodeStringSetting(row.value);
        settings.registry = settings.registry ?? {};
        settings.registry.checkUpdatesOnStartup = valueStr === 'true';
      } else if (row.key === 'claudeBinaryPath') {
        settings.claudeBinaryPath = row.value;
      } else if (row.key === 'codexBinaryPath') {
        settings.codexBinaryPath = row.value;
      } else if (row.key === 'dbPath') {
        settings.dbPath = row.value;
      } else if (row.key === 'initialSessionPromptId') {
        const promptId = this.extractPromptId(row.value);
        settings.initialSessionPromptId = promptId ?? null;
      } else if (row.key === 'initialSessionPromptIds') {
        try {
          const map = JSON.parse(row.value);
          if (typeof map === 'object' && map !== null) {
            settings.initialSessionPromptIds = map;
          }
        } catch (error) {
          logger.warn({ error }, 'Failed to parse initialSessionPromptIds');
        }
      } else if (row.key === 'terminal.seeding.mode') {
        // Legacy field - ignore (tmux-based seeding is implicit)
      } else if (row.key === 'terminal.scrollback.lines') {
        const valueStr = this.decodeStringSetting(row.value);
        const parsed = Number(valueStr);
        if (Number.isFinite(parsed)) {
          const clamped = Math.max(
            MIN_TERMINAL_SCROLLBACK,
            Math.min(parsed, MAX_TERMINAL_SCROLLBACK),
          );
          settings.terminal = settings.terminal ?? {};
          settings.terminal.scrollbackLines = clamped;
        } else {
          logger.warn({ stored: valueStr }, 'Ignoring invalid terminal scrollback value');
        }
      } else if (row.key === 'terminal.seeding.maxBytes') {
        const valueStr = this.decodeStringSetting(row.value);
        const parsed = Number(valueStr);
        if (Number.isFinite(parsed)) {
          const clamped = Math.max(
            MIN_TERMINAL_SEED_MAX_BYTES,
            Math.min(parsed, MAX_TERMINAL_SEED_MAX_BYTES),
          );
          settings.terminal = settings.terminal ?? {};
          settings.terminal.seedingMaxBytes = clamped;
        } else {
          logger.warn({ stored: valueStr }, 'Ignoring invalid terminal seed max bytes value');
        }
      } else if (row.key === 'events.epicAssigned.template') {
        const template = this.decodeStringSetting(row.value);
        settings.events = settings.events ?? {};
        const currentEpicAssigned = settings.events.epicAssigned ?? {};
        settings.events.epicAssigned = {
          ...currentEpicAssigned,
          template,
        };
      } else if (row.key === 'terminal.engine') {
        // Legacy field - ignore (Chat Mode only now)
      } else if (row.key === 'terminal.inputMode') {
        const inputMode = this.decodeStringSetting(row.value) as TerminalInputMode;
        if (TERMINAL_INPUT_MODES.includes(inputMode)) {
          settings.terminal = settings.terminal ?? {};
          settings.terminal.inputMode = inputMode;
        } else {
          // ignore unknown values
        }
      } else if (row.key === 'activity.idleTimeoutMs') {
        const valueStr = this.decodeStringSetting(row.value);
        const parsed = Number(valueStr);
        const idleTimeoutMs = Number.isFinite(parsed) && parsed > 0 ? parsed : 30000;
        settings.activity = settings.activity ?? {};
        settings.activity.idleTimeoutMs = idleTimeoutMs;
      } else if (row.key === 'autoClean.statusIds') {
        try {
          const map = JSON.parse(row.value);
          if (typeof map === 'object' && map !== null) {
            settings.autoClean = settings.autoClean ?? {};
            settings.autoClean.statusIds = map;
          }
        } catch (error) {
          logger.warn({ error }, 'Failed to parse autoClean.statusIds');
        }
      } else if (row.key === 'messagePool.enabled') {
        const valueStr = this.decodeStringSetting(row.value);
        settings.messagePool = settings.messagePool ?? {};
        settings.messagePool.enabled = valueStr === 'true';
      } else if (row.key === 'messagePool.delayMs') {
        const valueStr = this.decodeStringSetting(row.value);
        const parsed = Number(valueStr);
        if (Number.isFinite(parsed) && parsed > 0) {
          settings.messagePool = settings.messagePool ?? {};
          settings.messagePool.delayMs = Math.max(
            MIN_MESSAGE_POOL_DELAY_MS,
            Math.min(parsed, MAX_MESSAGE_POOL_DELAY_MS),
          );
        }
      } else if (row.key === 'messagePool.maxWaitMs') {
        const valueStr = this.decodeStringSetting(row.value);
        const parsed = Number(valueStr);
        if (Number.isFinite(parsed) && parsed > 0) {
          settings.messagePool = settings.messagePool ?? {};
          settings.messagePool.maxWaitMs = Math.max(
            MIN_MESSAGE_POOL_MAX_WAIT_MS,
            Math.min(parsed, MAX_MESSAGE_POOL_MAX_WAIT_MS),
          );
        }
      } else if (row.key === 'messagePool.maxMessages') {
        const valueStr = this.decodeStringSetting(row.value);
        const parsed = Number(valueStr);
        if (Number.isFinite(parsed) && parsed > 0) {
          settings.messagePool = settings.messagePool ?? {};
          settings.messagePool.maxMessages = Math.max(
            MIN_MESSAGE_POOL_MAX_MESSAGES,
            Math.min(parsed, MAX_MESSAGE_POOL_MAX_MESSAGES),
          );
        }
      } else if (row.key === 'messagePool.separator') {
        const valueStr = this.decodeStringSetting(row.value);
        settings.messagePool = settings.messagePool ?? {};
        settings.messagePool.separator = valueStr;
      } else if (row.key === 'messagePool.projects') {
        try {
          const map = JSON.parse(row.value);
          if (typeof map === 'object' && map !== null) {
            settings.messagePool = settings.messagePool ?? {};
            settings.messagePool.projects = map;
          }
        } catch (error) {
          logger.warn({ error }, 'Failed to parse messagePool.projects');
        }
      } else if (row.key === 'registryTemplates') {
        try {
          const map = JSON.parse(row.value);
          if (typeof map === 'object' && map !== null) {
            settings.registryTemplates = map;
          }
        } catch (error) {
          logger.warn({ error }, 'Failed to parse registryTemplates');
        }
      }
    }

    const terminalSettings = settings.terminal ?? {};
    const storedScrollback = terminalSettings.scrollbackLines ?? DEFAULT_TERMINAL_SCROLLBACK;
    const storedSeedMaxBytes = terminalSettings.seedingMaxBytes ?? DEFAULT_TERMINAL_SEED_MAX_BYTES;
    const effectiveScrollback = Math.max(
      MIN_TERMINAL_SCROLLBACK,
      Math.min(storedScrollback, MAX_TERMINAL_SCROLLBACK),
    );
    const effectiveSeedMaxBytes = Math.max(
      MIN_TERMINAL_SEED_MAX_BYTES,
      Math.min(storedSeedMaxBytes, MAX_TERMINAL_SEED_MAX_BYTES),
    );

    const storedInputMode = terminalSettings.inputMode ?? DEFAULT_TERMINAL_INPUT_MODE;
    const inputMode: TerminalInputMode = TERMINAL_INPUT_MODES.includes(
      storedInputMode as TerminalInputMode,
    )
      ? (storedInputMode as TerminalInputMode)
      : DEFAULT_TERMINAL_INPUT_MODE;

    settings.terminal = {
      scrollbackLines: effectiveScrollback,
      seedingMaxBytes: effectiveSeedMaxBytes,
      inputMode,
    };

    logger.debug({ settings }, 'Retrieved settings');
    return settings;
  }

  /**
   * Update settings (with validation)
   */
  async updateSettings(settings: SettingsDto): Promise<SettingsDto> {
    // Validate binary paths before saving
    if (settings.claudeBinaryPath !== undefined && settings.claudeBinaryPath !== '') {
      await this.validateBinaryPath(settings.claudeBinaryPath, 'claude');
    }

    if (settings.codexBinaryPath !== undefined && settings.codexBinaryPath !== '') {
      await this.validateBinaryPath(settings.codexBinaryPath, 'codex');
    }

    const now = new Date().toISOString();
    const stmt = this.sqlite.prepare(`
      INSERT INTO settings (id, key, value, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `);

    // Note: instanceMode and apiKey are no longer persisted (legacy fields ignored)

    // Execute all upserts atomically to avoid partial writes
    this.sqlite.transaction(() => {
      if (settings.claudeBinaryPath !== undefined) {
        // Store normalized absolute path
        const normalizedPath =
          settings.claudeBinaryPath === '' ? '' : resolve(settings.claudeBinaryPath);
        stmt.run(randomUUID(), 'claudeBinaryPath', normalizedPath, now, now);
      }

      if (settings.codexBinaryPath !== undefined) {
        // Store normalized absolute path
        const normalizedPath =
          settings.codexBinaryPath === '' ? '' : resolve(settings.codexBinaryPath);
        stmt.run(randomUUID(), 'codexBinaryPath', normalizedPath, now, now);
      }

      if (settings.dbPath !== undefined) {
        stmt.run(randomUUID(), 'dbPath', settings.dbPath, now, now);
      }

      // Upsert mapping if provided directly
      if (settings.initialSessionPromptIds) {
        const encodedMap = JSON.stringify(settings.initialSessionPromptIds);
        stmt.run(randomUUID(), 'initialSessionPromptIds', encodedMap, now, now);
      }

      if (settings.initialSessionPromptId !== undefined) {
        const normalized =
          settings.initialSessionPromptId && settings.initialSessionPromptId.trim().length > 0
            ? settings.initialSessionPromptId.trim()
            : '';

        if (settings.projectId) {
          // Update per-project mapping
          const existing = this.getSetting('initialSessionPromptIds');
          let map: Record<string, string | null> = {};
          try {
            if (existing) map = JSON.parse(existing);
          } catch {
            map = {};
          }
          map[settings.projectId] = normalized || null;
          const encodedMap = JSON.stringify(map);
          stmt.run(randomUUID(), 'initialSessionPromptIds', encodedMap, now, now);
        } else {
          // Back-compat: update global default
          const encoded = JSON.stringify(normalized);
          stmt.run(randomUUID(), 'initialSessionPromptId', encoded, now, now);
        }
      }

      const eventTemplate = settings.events?.epicAssigned?.template;
      if (eventTemplate !== undefined) {
        const normalized = eventTemplate ?? '';
        const encoded = JSON.stringify(normalized);
        stmt.run(randomUUID(), 'events.epicAssigned.template', encoded, now, now);
      }

      const idleTimeoutMs = settings.activity?.idleTimeoutMs;
      if (idleTimeoutMs !== undefined) {
        const coerced = Math.max(1000, Math.min(idleTimeoutMs, 24 * 60 * 60 * 1000));
        stmt.run(randomUUID(), 'activity.idleTimeoutMs', String(coerced), now, now);
      }

      // Note: seedingMode is no longer exposed in API/UI (tmux-based seeding is implicit)
      const scrollbackLines = settings.terminal?.scrollbackLines;
      if (scrollbackLines !== undefined) {
        const numeric = Math.max(
          MIN_TERMINAL_SCROLLBACK,
          Math.min(scrollbackLines, MAX_TERMINAL_SCROLLBACK),
        );
        stmt.run(randomUUID(), 'terminal.scrollback.lines', String(numeric), now, now);
      }

      const seedingMaxBytes = settings.terminal?.seedingMaxBytes;
      if (seedingMaxBytes !== undefined) {
        const numeric = Math.max(
          MIN_TERMINAL_SEED_MAX_BYTES,
          Math.min(seedingMaxBytes, MAX_TERMINAL_SEED_MAX_BYTES),
        );
        stmt.run(randomUUID(), 'terminal.seeding.maxBytes', String(numeric), now, now);
      }

      // Note: engine field removed (Chat Mode only)
      const inputMode = settings.terminal?.inputMode;
      if (inputMode !== undefined) {
        const inputModeToStore = TERMINAL_INPUT_MODES.includes(inputMode)
          ? inputMode
          : DEFAULT_TERMINAL_INPUT_MODE;
        stmt.run(randomUUID(), 'terminal.inputMode', inputModeToStore, now, now);
      }

      // Auto-clean status IDs (per-project mapping)
      if (settings.autoClean?.statusIds !== undefined) {
        const encodedMap = JSON.stringify(settings.autoClean.statusIds);
        stmt.run(randomUUID(), 'autoClean.statusIds', encodedMap, now, now);
      }

      // Message pool settings
      if (settings.messagePool !== undefined) {
        if (settings.messagePool.enabled !== undefined) {
          stmt.run(
            randomUUID(),
            'messagePool.enabled',
            String(settings.messagePool.enabled),
            now,
            now,
          );
        }
        if (settings.messagePool.delayMs !== undefined) {
          const clamped = Math.max(
            MIN_MESSAGE_POOL_DELAY_MS,
            Math.min(settings.messagePool.delayMs, MAX_MESSAGE_POOL_DELAY_MS),
          );
          stmt.run(randomUUID(), 'messagePool.delayMs', String(clamped), now, now);
        }
        if (settings.messagePool.maxWaitMs !== undefined) {
          const clamped = Math.max(
            MIN_MESSAGE_POOL_MAX_WAIT_MS,
            Math.min(settings.messagePool.maxWaitMs, MAX_MESSAGE_POOL_MAX_WAIT_MS),
          );
          stmt.run(randomUUID(), 'messagePool.maxWaitMs', String(clamped), now, now);
        }
        if (settings.messagePool.maxMessages !== undefined) {
          const clamped = Math.max(
            MIN_MESSAGE_POOL_MAX_MESSAGES,
            Math.min(settings.messagePool.maxMessages, MAX_MESSAGE_POOL_MAX_MESSAGES),
          );
          stmt.run(randomUUID(), 'messagePool.maxMessages', String(clamped), now, now);
        }
        if (settings.messagePool.separator !== undefined) {
          stmt.run(
            randomUUID(),
            'messagePool.separator',
            JSON.stringify(settings.messagePool.separator),
            now,
            now,
          );
        }
        if (settings.messagePool.projects !== undefined) {
          const encodedMap = JSON.stringify(settings.messagePool.projects);
          stmt.run(randomUUID(), 'messagePool.projects', encodedMap, now, now);
        }
      }

      // Registry settings
      if (settings.registry !== undefined) {
        if (settings.registry.url !== undefined) {
          stmt.run(randomUUID(), 'registry.url', JSON.stringify(settings.registry.url), now, now);
        }
        if (settings.registry.cacheDir !== undefined) {
          stmt.run(
            randomUUID(),
            'registry.cacheDir',
            JSON.stringify(settings.registry.cacheDir),
            now,
            now,
          );
        }
        if (settings.registry.checkUpdatesOnStartup !== undefined) {
          stmt.run(
            randomUUID(),
            'registry.checkUpdatesOnStartup',
            String(settings.registry.checkUpdatesOnStartup),
            now,
            now,
          );
        }
      }

      // Registry templates (per-project template tracking)
      if (settings.registryTemplates !== undefined) {
        const encodedMap = JSON.stringify(settings.registryTemplates);
        stmt.run(randomUUID(), 'registryTemplates', encodedMap, now, now);
      }
    })();

    logger.info('Settings updated');

    // Emit settings.terminal.changed event if terminal scrollback was updated
    // Uses EventEmitter2 directly to avoid circular dependency with EventsModule
    // Wrapped in try-catch to prevent event handler exceptions from failing the API
    if (settings.terminal?.scrollbackLines !== undefined) {
      const clampedScrollback = Math.max(
        MIN_TERMINAL_SCROLLBACK,
        Math.min(settings.terminal.scrollbackLines, MAX_TERMINAL_SCROLLBACK),
      );
      const payload = { scrollbackLines: clampedScrollback };

      try {
        // Validate payload against event catalog schema before emission
        settingsTerminalChangedEvent.schema.parse(payload);
        this.eventEmitter.emit('settings.terminal.changed', payload);
        logger.debug(
          { scrollbackLines: clampedScrollback },
          'Emitted settings.terminal.changed event',
        );
      } catch (error) {
        // Log but don't throw - settings are already persisted, event will be missed
        logger.error(
          { scrollbackLines: clampedScrollback, error },
          'Failed to validate/emit settings.terminal.changed event',
        );
      }
    }

    return this.getSettings();
  }

  /**
   * Get a specific setting
   */
  getSetting(key: string): string | undefined {
    const row = this.sqlite.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row ? this.decodeStringSetting(row.value) : undefined;
  }

  /**
   * Get terminal scrollback lines setting, clamped to valid range.
   * Returns DEFAULT_TERMINAL_SCROLLBACK if not set or invalid.
   */
  getScrollbackLines(): number {
    const value = this.getSetting('terminal.scrollback.lines');
    const parsed = value ? parseInt(value, 10) : DEFAULT_TERMINAL_SCROLLBACK;
    if (!Number.isFinite(parsed)) {
      return DEFAULT_TERMINAL_SCROLLBACK;
    }
    return Math.max(MIN_TERMINAL_SCROLLBACK, Math.min(MAX_TERMINAL_SCROLLBACK, parsed));
  }

  /**
   * Get auto-clean status IDs for a specific project
   * @param projectId The project ID to get auto-clean statuses for
   * @returns Array of status IDs that trigger auto-clean, or empty array if none configured
   */
  getAutoCleanStatusIds(projectId: string): string[] {
    const raw = this.getSetting('autoClean.statusIds');
    if (!raw) {
      return [];
    }
    try {
      const map = JSON.parse(raw) as Record<string, string[]>;
      return map[projectId] ?? [];
    } catch {
      logger.warn('Failed to parse autoClean.statusIds');
      return [];
    }
  }

  /**
   * Get message pool configuration with defaults applied (global)
   * @returns Complete message pool configuration
   */
  getMessagePoolConfig(): Required<Omit<MessagePoolSettingsDto, 'projects'>> {
    const settings = this.getSettings();
    const pool = settings.messagePool ?? {};

    return {
      enabled: pool.enabled ?? DEFAULT_MESSAGE_POOL_ENABLED,
      delayMs: pool.delayMs ?? DEFAULT_MESSAGE_POOL_DELAY_MS,
      maxWaitMs: pool.maxWaitMs ?? DEFAULT_MESSAGE_POOL_MAX_WAIT_MS,
      maxMessages: pool.maxMessages ?? DEFAULT_MESSAGE_POOL_MAX_MESSAGES,
      separator: pool.separator ?? DEFAULT_MESSAGE_POOL_SEPARATOR,
    };
  }

  /**
   * Get message pool configuration for a specific project
   * Uses project-specific overrides if defined, otherwise falls back to global defaults
   * @param projectId The project ID to get configuration for
   * @returns Complete message pool configuration with project overrides applied
   */
  getMessagePoolConfigForProject(
    projectId: string,
  ): Required<Omit<MessagePoolSettingsDto, 'projects'>> {
    const globalConfig = this.getMessagePoolConfig();
    const settings = this.getSettings();
    const projectOverrides = settings.messagePool?.projects?.[projectId];

    if (!projectOverrides) {
      return globalConfig;
    }

    // Apply project overrides on top of global defaults
    return {
      enabled: projectOverrides.enabled ?? globalConfig.enabled,
      delayMs: projectOverrides.delayMs ?? globalConfig.delayMs,
      maxWaitMs: projectOverrides.maxWaitMs ?? globalConfig.maxWaitMs,
      maxMessages: projectOverrides.maxMessages ?? globalConfig.maxMessages,
      separator: projectOverrides.separator ?? globalConfig.separator,
    };
  }

  /**
   * Get raw per-project pool settings (without global fallbacks)
   * @param projectId The project ID
   * @returns Per-project settings or undefined if not set
   */
  getProjectPoolSettings(projectId: string):
    | {
        enabled?: boolean;
        delayMs?: number;
        maxWaitMs?: number;
        maxMessages?: number;
        separator?: string;
      }
    | undefined {
    const settings = this.getSettings();
    return settings.messagePool?.projects?.[projectId];
  }

  /**
   * Set per-project pool settings
   * @param projectId The project ID
   * @param poolSettings The pool settings to apply (pass undefined to clear)
   */
  async setProjectPoolSettings(
    projectId: string,
    poolSettings: {
      enabled?: boolean;
      delayMs?: number;
      maxWaitMs?: number;
      maxMessages?: number;
      separator?: string;
    } | null,
  ): Promise<void> {
    const currentSettings = this.getSettings();
    const existingProjects = currentSettings.messagePool?.projects ?? {};

    if (poolSettings === null) {
      // Remove project-specific settings
      const remaining = { ...existingProjects };
      delete remaining[projectId];
      await this.updateSettings({
        messagePool: {
          projects: remaining,
        },
      });
    } else {
      // Update project-specific settings
      await this.updateSettings({
        messagePool: {
          projects: {
            ...existingProjects,
            [projectId]: poolSettings,
          },
        },
      });
    }

    logger.info({ projectId, poolSettings }, 'Project pool settings updated');
  }

  /**
   * Get all project-specific settings at once
   * @param projectId The project ID to get settings for
   * @returns ProjectSettings object with all project-specific settings
   */
  getProjectSettings(projectId: string): ProjectSettings {
    const settings = this.getSettings();
    const result: ProjectSettings = {};

    // Get initialSessionPromptId for this project
    const promptId = settings.initialSessionPromptIds?.[projectId];
    if (promptId !== undefined) {
      result.initialSessionPromptId = promptId;
    }

    // Get autoClean statusIds for this project
    const autoCleanIds = settings.autoClean?.statusIds?.[projectId];
    if (autoCleanIds && autoCleanIds.length > 0) {
      result.autoCleanStatusIds = autoCleanIds;
    }

    // Get epicAssigned template (global, not per-project)
    const epicTemplate = settings.events?.epicAssigned?.template;
    if (epicTemplate) {
      result.epicAssignedTemplate = epicTemplate;
    }

    // Get per-project message pool settings
    const poolSettings = settings.messagePool?.projects?.[projectId];
    if (poolSettings) {
      result.messagePoolSettings = poolSettings;
    }

    return result;
  }

  /**
   * Set multiple project-specific settings atomically
   * @param projectId The project ID to set settings for
   * @param projectSettings The settings to apply
   */
  async setProjectSettings(projectId: string, projectSettings: ProjectSettings): Promise<void> {
    const updates: SettingsDto = {};

    // Set initialSessionPromptId if provided
    if (projectSettings.initialSessionPromptId !== undefined) {
      updates.projectId = projectId;
      updates.initialSessionPromptId = projectSettings.initialSessionPromptId;
    }

    // Set autoClean statusIds if provided
    if (projectSettings.autoCleanStatusIds !== undefined) {
      const currentSettings = this.getSettings();
      const existingMap = currentSettings.autoClean?.statusIds ?? {};
      updates.autoClean = {
        statusIds: {
          ...existingMap,
          [projectId]: projectSettings.autoCleanStatusIds,
        },
      };
    }

    // Set epicAssigned template if provided
    if (projectSettings.epicAssignedTemplate !== undefined) {
      updates.events = {
        epicAssigned: { template: projectSettings.epicAssignedTemplate },
      };
    }

    // Set per-project message pool settings if provided
    if (projectSettings.messagePoolSettings !== undefined) {
      const currentSettings = this.getSettings();
      const existingProjects = currentSettings.messagePool?.projects ?? {};
      updates.messagePool = {
        projects: {
          ...existingProjects,
          [projectId]: projectSettings.messagePoolSettings,
        },
      };
    }

    // Apply all updates atomically
    if (Object.keys(updates).length > 0) {
      await this.updateSettings(updates);
      logger.info({ projectId, updates: Object.keys(updates) }, 'Project settings updated');
    }
  }

  /**
   * Validate binary path exists and is executable (Unix-specific)
   * Note: Windows compatibility is out of scope for Phase 1
   */
  private async validateBinaryPath(binaryPath: string, providerName: string): Promise<void> {
    if (process.platform === 'win32') {
      logger.warn({ binaryPath, providerName }, 'Binary validation skipped on Windows');
      return;
    }

    const absolutePath = resolve(binaryPath);

    try {
      // Check if file exists and is readable
      await access(absolutePath, constants.F_OK | constants.R_OK);

      // Check if file is executable
      await access(absolutePath, constants.X_OK);

      logger.info({ binaryPath, absolutePath, providerName }, 'Binary path validated successfully');
    } catch (error) {
      const errorMsg =
        error instanceof Error && 'code' in error && error.code === 'ENOENT'
          ? `Binary not found: ${absolutePath}`
          : `Binary not executable: ${absolutePath}`;

      logger.error({ binaryPath, absolutePath, providerName, error }, 'Binary validation failed');

      throw new ValidationError(errorMsg, {
        provider: providerName,
        path: absolutePath,
        hint: `The ${providerName} binary path must point to an existing executable file. Please check the path and file permissions.`,
      });
    }
  }

  private decodeStringSetting(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) {
      return '';
    }

    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'string') {
        return parsed;
      }
    } catch {
      // Not JSON encoded; fall back to raw string
    }

    return trimmed;
  }

  private extractPromptId(value: unknown): string | null {
    if (value === undefined || value === null) {
      return null;
    }

    if (typeof value === 'object') {
      if ('initialSessionPromptId' in (value as Record<string, unknown>)) {
        return this.extractPromptId(
          (value as { initialSessionPromptId?: unknown }).initialSessionPromptId,
        );
      }
      if ('value' in (value as Record<string, unknown>)) {
        return this.extractPromptId((value as { value?: unknown }).value);
      }
      return null;
    }

    const stringValue =
      typeof value === 'number' || typeof value === 'boolean' ? String(value) : (value as string);

    let candidate = stringValue.trim();
    if (!candidate) {
      return null;
    }

    try {
      const parsed = JSON.parse(candidate);
      if (typeof parsed === 'string' && parsed.trim().length > 0) {
        candidate = parsed.trim();
      } else if (parsed && typeof parsed === 'object') {
        return this.extractPromptId(parsed);
      }
    } catch {
      // not JSON encoded
    }

    if (candidate.startsWith('"') && candidate.endsWith('"') && candidate.length >= 2) {
      candidate = candidate.slice(1, -1).trim();
    }

    return candidate.length > 0 ? candidate : null;
  }

  // ============================================
  // Registry Settings Methods
  // ============================================

  /**
   * Default registry URL
   */
  private readonly DEFAULT_REGISTRY_URL = 'https://a1-devchain.twitechlab.com';

  /**
   * Get registry configuration with fallback chain applied
   * Priority: Settings (DB) → Environment Variable → Default
   */
  getRegistryConfig(): Required<RegistryConfigDto> {
    const settings = this.getSettings();
    const registry = settings.registry ?? {};

    // Fallback chain for URL: Settings → Env → Default
    const url = registry.url || process.env.REGISTRY_URL || this.DEFAULT_REGISTRY_URL;

    return {
      url,
      cacheDir: registry.cacheDir ?? '',
      checkUpdatesOnStartup: registry.checkUpdatesOnStartup ?? true,
    };
  }

  /**
   * Update registry configuration
   */
  async setRegistryConfig(config: Partial<RegistryConfigDto>): Promise<void> {
    const currentSettings = this.getSettings();
    const existingRegistry = currentSettings.registry ?? {};

    await this.updateSettings({
      registry: {
        ...existingRegistry,
        ...config,
      },
    });

    logger.info({ config }, 'Registry config updated');
  }

  /**
   * Get template metadata for a specific project
   * @param projectId The project ID
   * @returns Template metadata or null if not tracked
   */
  getProjectTemplateMetadata(projectId: string): RegistryTemplateMetadataDto | null {
    const settings = this.getSettings();
    return settings.registryTemplates?.[projectId] ?? null;
  }

  /**
   * Set template metadata for a project
   * @param projectId The project ID
   * @param metadata The template metadata to store
   */
  async setProjectTemplateMetadata(
    projectId: string,
    metadata: RegistryTemplateMetadataDto,
  ): Promise<void> {
    const currentSettings = this.getSettings();
    const existingTemplates = currentSettings.registryTemplates ?? {};

    await this.updateSettings({
      registryTemplates: {
        ...existingTemplates,
        [projectId]: metadata,
      },
    });

    logger.info(
      { projectId, templateSlug: metadata.templateSlug, version: metadata.installedVersion },
      'Project template metadata updated',
    );
  }

  /**
   * Clear template metadata for a project (unlink from registry)
   * @param projectId The project ID
   */
  async clearProjectTemplateMetadata(projectId: string): Promise<void> {
    const currentSettings = this.getSettings();
    const existingTemplates = currentSettings.registryTemplates ?? {};

    // Remove the project from the map
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { [projectId]: _removed, ...remaining } = existingTemplates;

    await this.updateSettings({
      registryTemplates: remaining,
    });

    logger.info({ projectId }, 'Project template metadata cleared');
  }

  /**
   * Get all projects with template metadata (for batch update checking)
   * @returns Array of projects with their template metadata
   */
  getAllTrackedProjects(): Array<{ projectId: string; metadata: RegistryTemplateMetadataDto }> {
    const settings = this.getSettings();
    const templates = settings.registryTemplates ?? {};

    return Object.entries(templates).map(([projectId, metadata]) => ({
      projectId,
      metadata,
    }));
  }

  /**
   * Get all project template metadata as a Map (for efficient batch lookups)
   * Use this instead of calling getProjectTemplateMetadata() in a loop to avoid N+1 queries.
   * @returns Map of projectId to template metadata
   */
  getAllProjectTemplateMetadataMap(): Map<string, RegistryTemplateMetadataDto> {
    const settings = this.getSettings();
    const templates = settings.registryTemplates ?? {};
    return new Map(Object.entries(templates));
  }

  /**
   * Update the lastUpdateCheckAt timestamp for a project
   * @param projectId The project ID
   */
  async updateLastUpdateCheck(projectId: string): Promise<void> {
    const existing = this.getProjectTemplateMetadata(projectId);
    if (!existing) {
      logger.warn({ projectId }, 'Cannot update lastUpdateCheckAt: project not tracked');
      return;
    }

    await this.setProjectTemplateMetadata(projectId, {
      ...existing,
      lastUpdateCheckAt: new Date().toISOString(),
    });
  }
}
