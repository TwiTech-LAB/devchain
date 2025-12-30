import Database from 'better-sqlite3';
import { getDbConfig } from '../src/modules/storage/db/db.config';

const config = getDbConfig();
const db = new Database(config.dbPath);

console.log('Verifying database schema...\n');

// Check agent_profiles columns
console.log('agent_profiles columns:');
const apColumns = db.prepare('PRAGMA table_info(agent_profiles)').all() as any[];
apColumns.forEach((col: any) => {
  console.log(`  - ${col.name}: ${col.type}${col.notnull ? ' NOT NULL' : ''}${col.pk ? ' PRIMARY KEY' : ''}`);
});

const hasOldProvider = apColumns.some(c => c.name === 'provider');
const hasProviderId = apColumns.some(c => c.name === 'provider_id');

console.log('\nSchema check:');
console.log(`  - Has old 'provider' column: ${hasOldProvider ? '⚠️  YES (should be removed)' : '✅ NO'}`);
console.log(`  - Has new 'provider_id' column: ${hasProviderId ? '✅ YES' : '❌ NO'}`);

// Check providers table
console.log('\nproviders table:');
const providerColumns = db.prepare('PRAGMA table_info(providers)').all() as any[];
providerColumns.forEach((col: any) => {
  console.log(`  - ${col.name}: ${col.type}${col.notnull ? ' NOT NULL' : ''}${col.pk ? ' PRIMARY KEY' : ''}`);
});

// Check if provider_id has NOT NULL constraint
const providerIdCol = apColumns.find(c => c.name === 'provider_id');
if (providerIdCol) {
  console.log(`\nprovider_id constraints:`);
  console.log(`  - NOT NULL: ${providerIdCol.notnull ? '✅ YES' : '⚠️  NO (should be NOT NULL)'}`);
}

// Check for orphaned profiles (provider_id is null)
const orphaned = db.prepare('SELECT COUNT(*) as count FROM agent_profiles WHERE provider_id IS NULL').get() as { count: number };
console.log(`\nOrphaned profiles (provider_id IS NULL): ${orphaned.count}`);

// Check migration tracking
console.log('\nMigration tracking:');
const migrations = db.prepare('SELECT hash, created_at FROM __drizzle_migrations ORDER BY id').all();
migrations.forEach((m: any) => {
  console.log(`  ✅ ${m.hash}`);
});

db.close();

// Summary
console.log('\n' + '='.repeat(60));
if (hasOldProvider) {
  console.log('⚠️  WARNING: Old "provider" column still exists!');
  console.log('   This may cause issues. Consider removing it manually.');
}
if (!providerIdCol?.notnull) {
  console.log('⚠️  WARNING: provider_id is nullable!');
  console.log('   SQLite ALTER limitations prevent changing this.');
  console.log('   Ensure all new profiles have provider_id set.');
}
if (!hasOldProvider && hasProviderId && migrations.length === 2) {
  console.log('✅ Schema is correctly migrated!');
  console.log('✅ Future migrations should work properly.');
}
