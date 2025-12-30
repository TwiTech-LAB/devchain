import Database from 'better-sqlite3';
import { getDbConfig } from '../src/modules/storage/db/db.config';

const config = getDbConfig();
const db = new Database(config.dbPath);

// Check if providers table exists
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='providers'").all();

if (tables.length > 0) {
  console.log('✅ providers table exists');

  // Get table schema
  const schema = db.prepare('PRAGMA table_info(providers)').all();
  console.log('\nTable schema:');
  schema.forEach((col: any) => {
    console.log(`  - ${col.name}: ${col.type}${col.notnull ? ' NOT NULL' : ''}${col.pk ? ' PRIMARY KEY' : ''}`);
  });

  // Get row count
  const count = db.prepare('SELECT COUNT(*) as count FROM providers').get() as { count: number };
  console.log(`\nRow count: ${count.count}`);

  // Get all providers
  if (count.count > 0) {
    const providers = db.prepare('SELECT * FROM providers').all();
    console.log('\nProviders:');
    providers.forEach((p: any) => console.log(`  - ${p.name} (id: ${p.id})`));
  }
} else {
  console.log('❌ providers table does NOT exist');

  // Check if agent_profiles has provider or provider_id
  console.log('\nChecking agent_profiles columns:');
  const apSchema = db.prepare('PRAGMA table_info(agent_profiles)').all();
  apSchema.forEach((col: any) => {
    if (col.name === 'provider' || col.name === 'provider_id') {
      console.log(`  - ${col.name}: ${col.type}${col.notnull ? ' NOT NULL' : ''}`);
    }
  });
}

// Check applied migrations
console.log('\nApplied migrations:');
const migrations = db.prepare('SELECT * FROM __drizzle_migrations ORDER BY id').all();
migrations.forEach((m: any) => console.log(`  - ${m.hash} (id: ${m.id}, created: ${new Date(m.created_at).toISOString()})`));

db.close();
