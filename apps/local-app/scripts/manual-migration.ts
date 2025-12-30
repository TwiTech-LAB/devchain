import Database from 'better-sqlite3';
import { getDbConfig } from '../src/modules/storage/db/db.config';

const config = getDbConfig();
const db = new Database(config.dbPath);

console.log('Starting manual migration...\n');

// Step 1: Create providers table
console.log('Step 1: Creating providers table...');
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL UNIQUE,
      bin_path TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  console.log('  ✅ providers table created');
} catch (error: any) {
  console.log(`  ⚠️  ${error.message}`);
}

// Step 2: Add provider_id column to agent_profiles (if it doesn't exist)
console.log('\nStep 2: Adding provider_id column to agent_profiles...');
try {
  // Check if column exists
  const columns = db.prepare('PRAGMA table_info(agent_profiles)').all() as any[];
  const hasProviderId = columns.some((col: any) => col.name === 'provider_id');

  if (!hasProviderId) {
    db.exec('ALTER TABLE agent_profiles ADD COLUMN provider_id TEXT REFERENCES providers(id)');
    console.log('  ✅ provider_id column added');
  } else {
    console.log('  ℹ️  provider_id column already exists');
  }
} catch (error: any) {
  console.log(`  ⚠️  ${error.message}`);
}

// Step 3: Backfill providers from existing agent_profiles.provider values
console.log('\nStep 3: Backfilling providers from agent_profiles...');
try {
  const existingProviders = db.prepare(`
    SELECT DISTINCT provider FROM agent_profiles WHERE provider IS NOT NULL
  `).all() as any[];

  console.log(`  Found ${existingProviders.length} distinct provider values`);

  for (const row of existingProviders) {
    const providerId = `provider-${row.provider.toLowerCase()}`;
    const now = new Date().toISOString();

    // Insert provider if it doesn't exist
    db.prepare(`
      INSERT OR IGNORE INTO providers (id, name, bin_path, created_at, updated_at)
      VALUES (?, ?, NULL, ?, ?)
    `).run(providerId, row.provider, now, now);

    console.log(`  ✅ Created/verified provider: ${row.provider}`);
  }
} catch (error: any) {
  console.log(`  ⚠️  ${error.message}`);
}

// Step 4: Update agent_profiles.provider_id to reference providers
console.log('\nStep 4: Updating agent_profiles.provider_id...');
try {
  const result = db.prepare(`
    UPDATE agent_profiles
    SET provider_id = (
      SELECT id FROM providers WHERE providers.name = agent_profiles.provider
    )
    WHERE provider IS NOT NULL AND provider_id IS NULL
  `).run();

  console.log(`  ✅ Updated ${result.changes} rows`);
} catch (error: any) {
  console.log(`  ⚠️  ${error.message}`);
}

// Step 5: Check the state
console.log('\n Step 5: Verifying migration...');
const providersCount = db.prepare('SELECT COUNT(*) as count FROM providers').get() as { count: number };
console.log(`  - Providers table has ${providersCount.count} rows`);

const profilesWithProvider = db.prepare('SELECT COUNT(*) as count FROM agent_profiles WHERE provider_id IS NOT NULL').get() as { count: number };
console.log(`  - agent_profiles with provider_id: ${profilesWithProvider.count}`);

// Record migration
console.log('\nRecording migration as applied...');
try {
  db.prepare(`
    INSERT OR IGNORE INTO __drizzle_migrations (hash, created_at)
    VALUES (?, ?)
  `).run('0001_shiny_snowbird', Date.now());
  console.log('  ✅ Migration recorded');
} catch (error: any) {
  console.log(`  ⚠️  ${error.message}`);
}

console.log('\n✅ Migration complete!');

db.close();
