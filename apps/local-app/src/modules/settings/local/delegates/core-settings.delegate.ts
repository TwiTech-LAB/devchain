import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import { randomUUID } from 'crypto';
import { access, constants } from 'fs/promises';
import { resolve } from 'path';
import { createLogger } from '../../../../common/logging/logger';
import { ValidationError } from '../../../../common/errors/error-types';
import { SettingsDto, TERMINAL_INPUT_MODES, TerminalInputMode } from '../../dtos/settings.dto';
import {
  DEFAULT_TERMINAL_SCROLLBACK,
  MIN_TERMINAL_SCROLLBACK,
  MAX_TERMINAL_SCROLLBACK,
} from '../../../../common/constants/terminal';
import {
  DEFAULT_TERMINAL_SEED_MAX_BYTES,
  MIN_TERMINAL_SEED_MAX_BYTES,
  MAX_TERMINAL_SEED_MAX_BYTES,
  DEFAULT_TERMINAL_INPUT_MODE,
  DEFAULT_MESSAGE_POOL_DELAY_MS,
  MIN_MESSAGE_POOL_DELAY_MS,
  MAX_MESSAGE_POOL_DELAY_MS,
  DEFAULT_MESSAGE_POOL_MAX_WAIT_MS,
  MIN_MESSAGE_POOL_MAX_WAIT_MS,
  MAX_MESSAGE_POOL_MAX_WAIT_MS,
  DEFAULT_MESSAGE_POOL_MAX_MESSAGES,
  MIN_MESSAGE_POOL_MAX_MESSAGES,
  MAX_MESSAGE_POOL_MAX_MESSAGES,
} from '../../services/settings.constants';
import { settingsTerminalChangedEvent } from '../../../events/catalog';

const logger = createLogger('CoreSettingsDelegate');

export interface CoreDelegateContext {
  sqlite: Database.Database;
  eventEmitter: EventEmitter2;
}

export class CoreSettingsDelegate {
  private readonly sqlite: Database.Database;
  private readonly eventEmitter: EventEmitter2;

  constructor(context: CoreDelegateContext) {
    this.sqlite = context.sqlite;
    this.eventEmitter = context.eventEmitter;
  }

  getSettings(): SettingsDto {
    const rows = this.sqlite.prepare('SELECT key, value FROM settings').all() as Array<{
      key: string;
      value: string;
    }>;

    const settings: SettingsDto = {};
    for (const row of rows) {
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
      } else if (row.key === 'skills.syncOnStartup') {
        const valueStr = this.decodeStringSetting(row.value);
        settings.skills = settings.skills ?? {};
        settings.skills.syncOnStartup = valueStr === 'true';
      } else if (row.key === 'skills.sources') {
        try {
          const parsed = JSON.parse(row.value);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            settings.skills = settings.skills ?? {};
            settings.skills.sources = this.normalizeSkillSourcesMap(
              parsed as Record<string, unknown>,
            );
          }
        } catch (error) {
          logger.warn({ error }, 'Failed to parse skills.sources');
        }
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
        // Legacy field - ignore
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
        // Legacy field - ignore
      } else if (row.key === 'terminal.inputMode') {
        const inputMode = this.decodeStringSetting(row.value) as TerminalInputMode;
        if (TERMINAL_INPUT_MODES.includes(inputMode)) {
          settings.terminal = settings.terminal ?? {};
          settings.terminal.inputMode = inputMode;
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
      } else if (row.key === 'projectPresets') {
        try {
          const map = JSON.parse(row.value);
          if (typeof map === 'object' && map !== null) {
            settings.projectPresets = map;
          }
        } catch (error) {
          logger.warn({ error }, 'Failed to parse projectPresets');
        }
      } else if (row.key === 'projectActivePresets') {
        try {
          const map = JSON.parse(row.value);
          if (typeof map === 'object' && map !== null) {
            settings.projectActivePresets = map;
          }
        } catch (error) {
          logger.warn({ error }, 'Failed to parse projectActivePresets');
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

  getSetting(key: string): string | undefined {
    const row = this.sqlite.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row ? this.decodeStringSetting(row.value) : undefined;
  }

  async updateSettings(settings: SettingsDto): Promise<SettingsDto> {
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

    this.sqlite.transaction(() => {
      if (settings.claudeBinaryPath !== undefined) {
        const normalizedPath =
          settings.claudeBinaryPath === '' ? '' : resolve(settings.claudeBinaryPath);
        stmt.run(randomUUID(), 'claudeBinaryPath', normalizedPath, now, now);
      }

      if (settings.codexBinaryPath !== undefined) {
        const normalizedPath =
          settings.codexBinaryPath === '' ? '' : resolve(settings.codexBinaryPath);
        stmt.run(randomUUID(), 'codexBinaryPath', normalizedPath, now, now);
      }

      if (settings.dbPath !== undefined) {
        stmt.run(randomUUID(), 'dbPath', settings.dbPath, now, now);
      }

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

      const inputMode = settings.terminal?.inputMode;
      if (inputMode !== undefined) {
        const inputModeToStore = TERMINAL_INPUT_MODES.includes(inputMode)
          ? inputMode
          : DEFAULT_TERMINAL_INPUT_MODE;
        stmt.run(randomUUID(), 'terminal.inputMode', inputModeToStore, now, now);
      }

      if (settings.autoClean?.statusIds !== undefined) {
        const encodedMap = JSON.stringify(settings.autoClean.statusIds);
        stmt.run(randomUUID(), 'autoClean.statusIds', encodedMap, now, now);
      }

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

      if (settings.skills !== undefined) {
        if (settings.skills.syncOnStartup !== undefined) {
          stmt.run(
            randomUUID(),
            'skills.syncOnStartup',
            String(settings.skills.syncOnStartup),
            now,
            now,
          );
        }
        if (settings.skills.sources !== undefined) {
          const encodedMap = JSON.stringify(this.normalizeSkillSourcesMap(settings.skills.sources));
          stmt.run(randomUUID(), 'skills.sources', encodedMap, now, now);
        }
      }

      if (settings.registryTemplates !== undefined) {
        const encodedMap = JSON.stringify(settings.registryTemplates);
        stmt.run(randomUUID(), 'registryTemplates', encodedMap, now, now);
      }

      if (settings.projectPresets !== undefined) {
        const encodedMap = JSON.stringify(settings.projectPresets);
        stmt.run(randomUUID(), 'projectPresets', encodedMap, now, now);
      }

      if (settings.projectActivePresets !== undefined) {
        const encodedMap = JSON.stringify(settings.projectActivePresets);
        stmt.run(randomUUID(), 'projectActivePresets', encodedMap, now, now);
      }
    })();

    logger.info('Settings updated');

    if (settings.terminal?.scrollbackLines !== undefined) {
      const clampedScrollback = Math.max(
        MIN_TERMINAL_SCROLLBACK,
        Math.min(settings.terminal.scrollbackLines, MAX_TERMINAL_SCROLLBACK),
      );
      const payload = { scrollbackLines: clampedScrollback };

      try {
        settingsTerminalChangedEvent.schema.parse(payload);
        this.eventEmitter.emit('settings.terminal.changed', payload);
        logger.debug(
          { scrollbackLines: clampedScrollback },
          'Emitted settings.terminal.changed event',
        );
      } catch (error) {
        logger.error(
          { scrollbackLines: clampedScrollback, error },
          'Failed to validate/emit settings.terminal.changed event',
        );
      }
    }

    return this.getSettings();
  }

  getScrollbackLines(): number {
    const value = this.getSetting('terminal.scrollback.lines');
    const parsed = value ? parseInt(value, 10) : DEFAULT_TERMINAL_SCROLLBACK;
    if (!Number.isFinite(parsed)) {
      return DEFAULT_TERMINAL_SCROLLBACK;
    }
    return Math.max(MIN_TERMINAL_SCROLLBACK, Math.min(MAX_TERMINAL_SCROLLBACK, parsed));
  }

  private async validateBinaryPath(binaryPath: string, providerName: string): Promise<void> {
    if (process.platform === 'win32') {
      logger.warn({ binaryPath, providerName }, 'Binary validation skipped on Windows');
      return;
    }

    const absolutePath = resolve(binaryPath);

    try {
      await access(absolutePath, constants.F_OK | constants.R_OK);
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

  normalizeSkillSourcesMap(rawMap: Record<string, unknown>): Record<string, boolean> {
    const normalized: Record<string, boolean> = {};
    for (const [rawKey, rawValue] of Object.entries(rawMap)) {
      if (typeof rawValue !== 'boolean') {
        continue;
      }
      const normalizedKey = rawKey.trim().toLowerCase();
      if (!normalizedKey) {
        continue;
      }
      normalized[normalizedKey] = rawValue;
    }
    return normalized;
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
}
