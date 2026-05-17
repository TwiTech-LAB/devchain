import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { createLogger } from '../../../../common/logging/logger';
import { ValidationError } from '../../../../common/errors/error-types';

const logger = createLogger('SkillsSettingsDelegate');

export const DEFAULT_SKILLS_SYNC_ON_STARTUP = true;

export interface SkillsDelegateContext {
  sqlite: Database.Database;
}

export class SkillsSettingsDelegate {
  private readonly sqlite: Database.Database;

  constructor(context: SkillsDelegateContext) {
    this.sqlite = context.sqlite;
  }

  getSkillsSyncOnStartup(): boolean {
    const value = this.readRawSetting('skills.syncOnStartup');
    const decoded = this.decodeStringSetting(value);
    if (decoded === undefined || decoded.trim().length === 0) {
      return DEFAULT_SKILLS_SYNC_ON_STARTUP;
    }
    return decoded === 'true';
  }

  setSkillsSyncOnStartup(enabled: boolean): void {
    const now = new Date().toISOString();
    this.sqlite
      .prepare(
        `INSERT INTO settings (id, key, value, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`,
      )
      .run(randomUUID(), 'skills.syncOnStartup', String(enabled), now, now);
    logger.info({ enabled }, 'Skills syncOnStartup updated');
  }

  getSkillSourcesEnabled(): Record<string, boolean> {
    const raw = this.readRawSetting('skills.sources');
    if (!raw || raw.trim().length === 0) {
      return {};
    }

    const decoded = this.decodeStringSetting(raw);
    if (!decoded || decoded.trim().length === 0) {
      return {};
    }

    try {
      const parsed = JSON.parse(decoded);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {};
      }
      return this.normalizeSkillSourcesMap(parsed as Record<string, unknown>);
    } catch (error) {
      logger.warn({ error }, 'Failed to parse skills.sources setting');
      return {};
    }
  }

  async setSkillSourceEnabled(sourceName: string, enabled: boolean): Promise<void> {
    const normalizedSourceName = sourceName.trim().toLowerCase();
    if (!normalizedSourceName) {
      throw new ValidationError('sourceName is required.', { fieldName: 'sourceName' });
    }

    const current = this.getSkillSourcesEnabled();
    current[normalizedSourceName] = enabled;

    const now = new Date().toISOString();
    const encodedMap = JSON.stringify(current);
    this.sqlite
      .prepare(
        `INSERT INTO settings (id, key, value, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`,
      )
      .run(randomUUID(), 'skills.sources', encodedMap, now, now);

    logger.info({ sourceName: normalizedSourceName, enabled }, 'Skill source enablement updated');
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

  private readRawSetting(key: string): string | undefined {
    const row = this.sqlite.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row ? row.value : undefined;
  }

  private decodeStringSetting(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    const trimmed = value.trim();
    if (!trimmed) return '';

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
}
