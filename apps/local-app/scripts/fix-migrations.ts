import Database from 'better-sqlite3';
import { getDbConfig } from '../src/modules/storage/db/db.config';

const config = getDbConfig();
const db = new Database(config.dbPath);

console.log('Checking __drizzle_migrations table structure...');
const tableInfo = db.prepare('PRAGMA table_info(__drizzle_migrations)').all();
console.log('Columns:', tableInfo);

console.log('\nCurrent migrations:');
const currentMigrations = db.prepare('SELECT * FROM __drizzle_migrations').all();
console.log(currentMigrations.length > 0 ? currentMigrations : 'No migrations recorded');

// Check if migration 0000 is already recorded
const migration0000 = currentMigrations.find((m: any) =>
  m.hash === '0000_flippant_the_spike' || m.hash?.includes('flippant')
);

if (!migration0000) {
  console.log('\n❗ Migration 0000 is not recorded. Marking it as applied...');

  // Insert migration 0000 record
  db.prepare(`
    INSERT INTO __drizzle_migrations (hash, created_at)
    VALUES (?, ?)
  `).run('0000_flippant_the_spike', Date.now());

  console.log('✅ Marked migration 0000 as applied');
} else {
  console.log('\n✅ Migration 0000 is already recorded');
}

console.log('\nUpdated migrations:');
const updatedMigrations = db.prepare('SELECT * FROM __drizzle_migrations').all();
console.log(updatedMigrations);

db.close();
