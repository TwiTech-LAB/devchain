import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { getRawSqliteClient } from '../../storage/db/sqlite-raw';
import { TransactionRunner } from '../../storage/db/transaction-runner';
import type { DataSeeder, SeederContext } from '../types/seeder.types';

const SEEDER_NAME = '0014_seed_preserve_project_egress_defaults';
const SEEDER_VERSION = 1;
const ENABLED_PROJECTS_KEY = 'cloud.egress.enabledProjects';
const NEW_PROJECTS_DEFAULT_ENABLED_KEY = 'cloud.egress.newProjectsDefaultEnabled';

interface SettingRow {
  value: unknown;
}

interface ProjectIdRow {
  id: string;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function parseEnabledProjects(value: unknown): Map<string, boolean> {
  const parsed = parseJson(value);
  const enabledProjects = new Map<string, boolean>();
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return enabledProjects;
  }

  for (const [projectId, enabled] of Object.entries(parsed)) {
    if (typeof enabled === 'boolean') {
      enabledProjects.set(projectId, enabled);
    }
  }

  return enabledProjects;
}

function readSetting(sqlite: Database.Database, key: string): SettingRow | undefined {
  return sqlite.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | SettingRow
    | undefined;
}

function upsertSetting(sqlite: Database.Database, key: string, value: unknown, now: string): void {
  sqlite
    .prepare(
      `INSERT INTO settings (id, key, value, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`,
    )
    .run(randomUUID(), key, JSON.stringify(value), now, now);
}

export async function runSeedPreserveProjectEgressDefaults(ctx: SeederContext): Promise<void> {
  const sqlite = getRawSqliteClient(ctx.db);
  const result = new TransactionRunner(sqlite).runImmediate(() => {
    const marker = readSetting(sqlite, NEW_PROJECTS_DEFAULT_ENABLED_KEY);
    if (parseJson(marker?.value) === true) {
      return { skipped: true, baselinedProjects: 0 };
    }

    const existingSetting = readSetting(sqlite, ENABLED_PROJECTS_KEY);
    const enabledProjects = parseEnabledProjects(existingSetting?.value);
    const projectIds = sqlite.prepare('SELECT id FROM projects').all() as ProjectIdRow[];
    let baselinedProjects = 0;

    for (const { id } of projectIds) {
      if (!enabledProjects.has(id)) {
        enabledProjects.set(id, false);
        baselinedProjects += 1;
      }
    }

    const now = new Date().toISOString();
    upsertSetting(sqlite, ENABLED_PROJECTS_KEY, Object.fromEntries(enabledProjects), now);
    upsertSetting(sqlite, NEW_PROJECTS_DEFAULT_ENABLED_KEY, true, now);

    return { skipped: false, baselinedProjects };
  });

  if (result.skipped) {
    ctx.logger.debug(
      { seederName: SEEDER_NAME, seederVersion: SEEDER_VERSION },
      'Project egress defaults were already preserved; skipping',
    );
    return;
  }

  ctx.logger.info(
    {
      seederName: SEEDER_NAME,
      seederVersion: SEEDER_VERSION,
      baselinedProjects: result.baselinedProjects,
    },
    'Preserved existing project egress defaults',
  );
}

export const seedPreserveProjectEgressDefaultsSeeder: DataSeeder = {
  name: SEEDER_NAME,
  version: SEEDER_VERSION,
  run: runSeedPreserveProjectEgressDefaults,
};
