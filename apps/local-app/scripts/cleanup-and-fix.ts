import Database from 'better-sqlite3';
import { getDbConfig } from '../src/modules/storage/db/db.config';

const config = getDbConfig();
const db = new Database(config.dbPath);

console.log('Cleaning up and fixing agent_profiles schema...\n');

// Step 0: Check for leftover tables and clean up
console.log('Step 0: Checking for leftover tables...');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'agent_profiles%'").all() as any[];
console.log('  Found tables:', tables.map((t: any) => t.name).join(', '));

if (tables.some((t: any) => t.name === 'agent_profiles_new')) {
  console.log('  Dropping leftover agent_profiles_new...');
  db.exec('DROP TABLE IF EXISTS agent_profiles_new');
  console.log('  ✅ Cleaned up');
}

// Disable foreign keys for the operation
console.log('\nStep 1: Disabling foreign key constraints...');
db.exec('PRAGMA foreign_keys = OFF');
console.log('  ✅ Foreign keys disabled');

console.log('\nStep 2: Starting transaction...');
db.exec('BEGIN TRANSACTION');

try {
  console.log('\nStep 3: Creating new agent_profiles table...');
  db.exec(`
    CREATE TABLE agent_profiles_new (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      model TEXT NOT NULL,
      system_prompt TEXT,
      temperature INTEGER,
      max_tokens INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE RESTRICT
    )
  `);
  console.log('  ✅ New table created');

  console.log('\nStep 4: Copying data...');
  const result = db.prepare(`
    INSERT INTO agent_profiles_new (
      id, name, provider_id, model, system_prompt, temperature, max_tokens, created_at, updated_at
    )
    SELECT
      id, name, provider_id, model, system_prompt, temperature, max_tokens, created_at, updated_at
    FROM agent_profiles
  `).run();
  console.log(`  ✅ Copied ${result.changes} rows`);

  console.log('\nStep 5: Dropping old table...');
  db.exec('DROP TABLE agent_profiles');
  console.log('  ✅ Old table dropped');

  console.log('\nStep 6: Renaming new table...');
  db.exec('ALTER TABLE agent_profiles_new RENAME TO agent_profiles');
  console.log('  ✅ Table renamed');

  console.log('\nStep 7: Committing transaction...');
  db.exec('COMMIT');
  console.log('  ✅ Transaction committed');

} catch (error: any) {
  console.error('\n❌ Error:', error.message);
  db.exec('ROLLBACK');
  db.exec('PRAGMA foreign_keys = ON');
  db.close();
  throw error;
}

// Re-enable foreign keys
console.log('\nStep 8: Re-enabling foreign keys...');
db.exec('PRAGMA foreign_keys = ON');
console.log('  ✅ Foreign keys re-enabled');

// Verify
console.log('\nStep 9: Verifying schema...');
const columns = db.prepare('PRAGMA table_info(agent_profiles)').all() as any[];
const hasOldProvider = columns.some((c: any) => c.name === 'provider');
const providerIdCol = columns.find((c: any) => c.name === 'provider_id');

console.log('  Columns:');
columns.forEach((col: any) => {
  console.log(`    - ${col.name}: ${col.type}${col.notnull ? ' NOT NULL' : ''}`);
});

console.log('\n' + '='.repeat(60));
if (!hasOldProvider && providerIdCol?.notnull) {
  console.log('✅ SUCCESS! Schema is fixed:');
  console.log('   ✓ Old "provider" column removed');
  console.log('   ✓ "provider_id" is NOT NULL');
  console.log('   ✓ Future migrations will work correctly');
} else {
  console.log('⚠️  Issues found:');
  if (hasOldProvider) console.log('   - Old provider column still exists');
  if (!providerIdCol?.notnull) console.log('   - provider_id is nullable');
}

db.close();
