import { mergeSourceSwitches } from '../../../storage/local/helpers/skill-source-switches';
import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { createLogger } from '../../../../common/logging/logger';
import { ValidationError } from '../../../../common/errors/error-types';
import { isAlwaysEnabledSkillSource } from '../../../../common/constants/built-in-skill-sources';

const logger = createLogger('SkillsSettingsDelegate');

export const DEFAULT_SKILLS_SYNC_ON_STARTUP = true;

export interface CompletedSkillSync {
  commit: string;
  skillCount: number;
}

export type HomePushedSkillSource =
  | { name: string; kind: 'community' }
  | { name: string; kind: 'local'; homeFolderPath: string; contentHash: string };

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
    this.writeRawSetting('skills.syncOnStartup', String(enabled));
    logger.info({ enabled }, 'Skills syncOnStartup updated');
  }

  getSkillsCompletedSyncs(): Record<string, CompletedSkillSync> {
    const raw = this.decodeStringSetting(this.readRawSetting('skills.completedSyncs'));
    if (!raw) return {};
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      return Object.fromEntries(
        Object.entries(parsed).filter(
          ([, entry]) =>
            entry &&
            typeof entry === 'object' &&
            typeof entry.commit === 'string' &&
            Number.isSafeInteger(entry.skillCount) &&
            entry.skillCount >= 0,
        ),
      );
    } catch (error) {
      logger.warn({ error }, 'Failed to parse skills.completedSyncs setting');
      return {};
    }
  }

  setSkillCompletedSync(sourceName: string, entry: CompletedSkillSync): void {
    const current = this.getSkillsCompletedSyncs();
    this.writeRawSetting(
      'skills.completedSyncs',
      JSON.stringify({
        ...current,
        [sourceName.trim().toLowerCase()]: entry,
      }),
    );
  }

  /** Switch map every reader uses: an always-enabled source never appears, so it reads as on. */
  getSkillSourcesEnabled(): Record<string, boolean> {
    return this.readSkillSourcesMap(false);
  }

  /**
   * The stored switch map with legacy values of always-enabled sources kept.
   * Not for deciding enablement: only for writes that must see those values,
   * e.g. a baseline that turns a legacy "off" into a sync.
   */
  getStoredSkillSourcesEnabled(): Record<string, boolean> {
    return this.readSkillSourcesMap(true);
  }

  private readSkillSourcesMap(keepAlwaysEnabled: boolean): Record<string, boolean> {
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
      return this.normalizeSkillSourcesMap(parsed as Record<string, unknown>, keepAlwaysEnabled);
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
    if (!isAlwaysEnabledSkillSource(normalizedSourceName)) {
      current[normalizedSourceName] = enabled;
    }

    this.writeRawSetting('skills.sources', JSON.stringify(current));

    logger.info({ sourceName: normalizedSourceName, enabled }, 'Skill source enablement updated');
  }

  /** Compares against the stored map so a legacy "off" of an always-enabled source gets rewritten. */
  mergeSkillSourcesEnabled(homeEffective: Record<string, boolean>): Record<string, boolean> {
    const current = this.getStoredSkillSourcesEnabled();
    const merged = mergeSourceSwitches(homeEffective, current);
    for (const key of Object.keys(merged)) {
      if (isAlwaysEnabledSkillSource(key)) merged[key] = true;
    }
    if (
      Object.keys(merged).length === Object.keys(current).length &&
      Object.entries(merged).every(([key, value]) => current[key] === value)
    )
      return merged;
    this.writeRawSetting('skills.sources', JSON.stringify(merged));
    return merged;
  }

  getHomePushedSkillSources(): HomePushedSkillSource[] {
    const raw = this.readRawSetting('host.homeSkillSources');
    return raw ? JSON.parse(raw) : [];
  }

  setHomePushedSkillSources(sources: HomePushedSkillSource[]): void {
    const value = JSON.stringify(sources);
    if (this.readRawSetting('host.homeSkillSources') === value) return;
    this.writeRawSetting('host.homeSkillSources', value);
  }

  normalizeSkillSourcesMap(
    rawMap: Record<string, unknown>,
    keepAlwaysEnabled = false,
  ): Record<string, boolean> {
    const normalized: Record<string, boolean> = {};
    for (const [rawKey, rawValue] of Object.entries(rawMap)) {
      if (typeof rawValue !== 'boolean') {
        continue;
      }
      const normalizedKey = rawKey.trim().toLowerCase();
      if (!normalizedKey) {
        continue;
      }
      if (!keepAlwaysEnabled && isAlwaysEnabledSkillSource(normalizedKey)) {
        continue;
      }
      normalized[normalizedKey] = rawValue;
    }
    return normalized;
  }

  private writeRawSetting(key: string, value: string): void {
    const now = new Date().toISOString();
    this.sqlite
      .prepare(
        `INSERT INTO settings (id, key, value, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`,
      )
      .run(randomUUID(), key, value, now, now);
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
