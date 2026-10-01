import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { createLogger } from '../../../../common/logging/logger';
import { ValidationError } from '../../../../common/errors/error-types';
import {
  PROVIDER_CLI_NAMES,
  ProviderCliVersionEntrySchema,
  type ProviderCliName,
  type ProviderCliVersionEntry,
  type ProviderCliVersionSettingsMap,
} from '@devchain/shared';

const logger = createLogger('ProviderCliSettingsDelegate');

export const PROVIDER_CLI_VERSIONS_SETTING_KEY = 'providers.cliVersions';

/**
 * Default entry for every allowlisted provider. A machine that never pinned
 * anything tracks `latest` with its own install (home) semantics.
 */
export function defaultProviderCliEntry(): ProviderCliVersionEntry {
  return { version: 'latest', homeManaged: false };
}

export interface ProviderCliDelegateContext {
  sqlite: Database.Database;
}

/**
 * Owns the raw `providers.cliVersions` settings row. The row is deliberately
 * outside `SettingsSchema` and the generic `PUT /api/settings` path so a
 * Settings page save can never overwrite provider version pins; it changes
 * only through `PUT /api/provider-clis/:provider`.
 */
export class ProviderCliSettingsDelegate {
  private readonly sqlite: Database.Database;

  constructor(context: ProviderCliDelegateContext) {
    this.sqlite = context.sqlite;
  }

  /** Every allowlisted provider, with defaults filled in for missing or invalid entries. */
  getProviderCliVersions(): ProviderCliVersionSettingsMap {
    const stored = this.readStoredMap();
    const result = {} as ProviderCliVersionSettingsMap;
    for (const provider of PROVIDER_CLI_NAMES) {
      result[provider] = stored[provider] ?? defaultProviderCliEntry();
    }
    return result;
  }

  /**
   * Validates and persists one provider's entry, leaving other providers
   * untouched.
   */
  setProviderCliVersion(provider: string, entry: ProviderCliVersionEntry): ProviderCliVersionEntry {
    if (!this.isKnownProvider(provider)) {
      throw new ValidationError(`Unknown provider "${provider}" for CLI version management.`, {
        provider,
        allowed: [...PROVIDER_CLI_NAMES],
      });
    }

    const parsed = ProviderCliVersionEntrySchema.safeParse(entry);
    if (!parsed.success) {
      throw new ValidationError(
        'Invalid provider CLI version entry. version must be "latest" or an exact x.y.z stable release; homeManaged must be a boolean.',
        { provider, issues: parsed.error.issues },
      );
    }

    const current = this.getProviderCliVersions();
    current[provider] = parsed.data;
    this.writeRawSetting(PROVIDER_CLI_VERSIONS_SETTING_KEY, JSON.stringify(current));

    logger.info({ provider, entry: parsed.data }, 'Provider CLI version setting updated');
    return parsed.data;
  }

  /** Reads and normalizes the stored map, dropping unknown providers and invalid entries. */
  private readStoredMap(): Partial<ProviderCliVersionSettingsMap> {
    const raw = this.readRawSetting(PROVIDER_CLI_VERSIONS_SETTING_KEY);
    if (!raw || raw.trim().length === 0) return {};

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      logger.warn({ error }, 'Failed to parse providers.cliVersions setting');
      return {};
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

    const result: Partial<ProviderCliVersionSettingsMap> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!this.isKnownProvider(key)) continue;
      const entry = ProviderCliVersionEntrySchema.safeParse(value);
      if (entry.success) result[key as ProviderCliName] = entry.data;
    }
    return result;
  }

  private isKnownProvider(provider: string): provider is ProviderCliName {
    return (PROVIDER_CLI_NAMES as readonly string[]).includes(provider);
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
}
