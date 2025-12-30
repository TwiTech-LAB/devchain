import Database from 'better-sqlite3';
import { getDbConfig } from '../src/modules/storage/db/db.config';

const config = getDbConfig();
const db = new Database(config.dbPath);

console.log('Fixing agent_profiles schema (removing old provider column)...\n');

// SQLite doesn't support DROP COLUMN directly, so we need to recreate the table
// Reference: https://www.sqlite.org/lang_altertable.html

console.log('Step 1: Creating new agent_profiles table...');
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

console.log('\nStep 2: Copying data to new table...');
const result = db.prepare(`
  INSERT INTO agent_profiles_new (
    id, name, provider_id, model, system_prompt, temperature, max_tokens, created_at, updated_at
  )
  SELECT
    id, name, provider_id, model, system_prompt, temperature, max_tokens, created_at, updated_at
  FROM agent_profiles
`).run();
console.log(`  ✅ Copied ${result.changes} rows`);

console.log('\nStep 3: Dropping old table...');
db.exec('DROP TABLE agent_profiles');
console.log('  ✅ Old table dropped');

console.log('\nStep 4: Renaming new table...');
db.exec('ALTER TABLE agent_profiles_new RENAME TO agent_profiles');
console.log('  ✅ Table renamed');

// Recreate indexes if any existed
console.log('\nStep 5: Verifying schema...');
const columns = db.prepare('PRAGMA table_info(agent_profiles)').all() as any[];
console.log('  New agent_profiles columns:');
columns.forEach((col: any) => {
  const constraints = [];
  if (col.notnull) constraints.push('NOT NULL');
  if (col.pk) constraints.push('PRIMARY KEY');
  console.log(`    - ${col.name}: ${col.type} ${constraints.join(' ')}`);
});

const hasOldProvider = columns.some((c: any) => c.name === 'provider');
const hasProviderId = columns.some((c: any) => c.name === 'provider_id');
const providerIdNotNull = columns.find((c: any) => c.name === 'provider_id')?.notnull;

console.log('\n' + '='.repeat(60));
if (hasOldProvider) {
  console.log('❌ FAILED: Old provider column still exists!');
} else if (hasProviderId && providerIdNotNull) {
  console.log('✅ SUCCESS: Schema is correctly fixed!');
  console.log('   - Old "provider" column removed');
  console.log('   - New "provider_id" column is NOT NULL');
} else {
  console.log('⚠️  Partial success - check output above');
}

db.close();
