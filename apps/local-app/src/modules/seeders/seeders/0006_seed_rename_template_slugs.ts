import { getRawSqliteClient } from '../../storage/db/sqlite-raw';
import type { DataSeeder, SeederContext } from '../services/data-seeder.service';

const SEEDER_NAME = '0006_seed_rename_template_slugs';
const SEEDER_VERSION = 1;

const SLUG_RENAMES: Record<string, string> = {
  'dev-loop': '5-agents-dev',
};

interface SettingsRow {
  value: string;
}

interface TemplateEntry {
  templateSlug: string;
  [key: string]: unknown;
}

export async function runSeedRenameTemplateSlugs(ctx: SeederContext): Promise<void> {
  const sqlite = getRawSqliteClient(ctx.db);
  const row = sqlite
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get('registryTemplates') as SettingsRow | undefined;

  if (!row || !row.value) {
    ctx.logger.info({ seederName: SEEDER_NAME }, 'No registryTemplates row found; skipping');
    return;
  }

  let entries: Record<string, TemplateEntry>;
  try {
    entries = JSON.parse(row.value) as Record<string, TemplateEntry>;
  } catch {
    ctx.logger.warn(
      { seederName: SEEDER_NAME },
      'Invalid JSON in registryTemplates; skipping to avoid data corruption',
    );
    return;
  }

  if (!entries || typeof entries !== 'object' || Object.keys(entries).length === 0) {
    ctx.logger.info({ seederName: SEEDER_NAME }, 'Empty registryTemplates map; skipping');
    return;
  }

  let renamed = 0;
  let skipped = 0;
  const total = Object.keys(entries).length;

  for (const [projectId, entry] of Object.entries(entries)) {
    const newSlug = SLUG_RENAMES[entry.templateSlug];
    if (newSlug) {
      entries[projectId] = { ...entry, templateSlug: newSlug };
      renamed++;
    } else {
      skipped++;
    }
  }

  if (renamed === 0) {
    ctx.logger.info(
      { seederName: SEEDER_NAME, total, skipped },
      'No entries with old slug found; already migrated',
    );
    return;
  }

  const now = new Date().toISOString();
  sqlite
    .prepare('UPDATE settings SET value = ?, updated_at = ? WHERE key = ?')
    .run(JSON.stringify(entries), now, 'registryTemplates');

  ctx.logger.info(
    { seederName: SEEDER_NAME, seederVersion: SEEDER_VERSION, total, renamed, skipped },
    'Rename-template-slugs seeder completed',
  );
}

export const seedRenameTemplateSlugsSeeder: DataSeeder = {
  name: SEEDER_NAME,
  version: SEEDER_VERSION,
  run: runSeedRenameTemplateSlugs,
};
