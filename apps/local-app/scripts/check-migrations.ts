import Database from 'better-sqlite3';
import { getDbConfig } from '../src/modules/storage/db/db.config';

const config = getDbConfig();
const db = new Database(config.dbPath);

console.log('Database path:', config.dbPath);
console.log('\nTables in database:');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
tables.forEach((table: any) => console.log(`  - ${table.name}`));

console.log('\nChecking for __drizzle_migrations table:');
const hasMigrationsTable = tables.some((t: any) => t.name === '__drizzle_migrations');

if (hasMigrationsTable) {
  console.log('  ✅ Found __drizzle_migrations table');
  const migrations = db.prepare('SELECT * FROM __drizzle_migrations').all();
  console.log('\nApplied migrations:');
  migrations.forEach((m: any) => console.log(`  - ${m.hash} (created: ${m.created_at})`));
} else {
  console.log('  ❌ No __drizzle_migrations table found');
  console.log('  This means migrations have never been run on this database');
}

db.close();
