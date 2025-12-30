import Database from 'better-sqlite3';
import { getDbConfig } from '../src/modules/storage/db/db.config';
import { readFileSync } from 'fs';
import { join } from 'path';

const config = getDbConfig();
const db = new Database(config.dbPath);

console.log('Reading migration file...');
const migrationSQL = readFileSync(
  join(__dirname, '../drizzle/0001_shiny_snowbird.sql'),
  'utf-8'
);

console.log('\nApplying migration 0001_shiny_snowbird...');

// Split by statement breakpoints and execute each statement
const statements = migrationSQL
  .split('--> statement-breakpoint')
  .map(s => s.trim())
  .filter(s => s.length > 0 && !s.startsWith('--'));

let successCount = 0;
let failCount = 0;

for (let i = 0; i < statements.length; i++) {
  const statement = statements[i];
  // Skip comments
  if (statement.startsWith('--')) continue;

  try {
    console.log(`\nExecuting statement ${i + 1}/${statements.length}...`);
    console.log(statement.substring(0, 100) + (statement.length > 100 ? '...' : ''));

    db.exec(statement);
    console.log('  ✅ Success');
    successCount++;
  } catch (error: any) {
    console.error(`  ❌ Failed: ${error.message}`);
    failCount++;

    // Continue on some errors, but stop on critical ones
    if (error.message.includes('no such column') || error.message.includes('syntax error')) {
      throw error;
    }
  }
}

// Record migration as applied
console.log('\nRecording migration as applied...');
db.prepare(`
  INSERT INTO __drizzle_migrations (hash, created_at)
  VALUES (?, ?)
`).run('0001_shiny_snowbird', Date.now());

console.log(`\n✅ Migration complete: ${successCount} succeeded, ${failCount} failed`);

db.close();
