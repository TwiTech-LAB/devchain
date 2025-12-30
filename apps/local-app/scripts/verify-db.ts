import Database from 'better-sqlite3';
import { getDbConfig } from '../src/modules/storage/db/db.config';

const config = getDbConfig();

console.log('Database path:', config.dbPath);

const sqlite = new Database(config.dbPath);

// Enable WAL mode
sqlite.pragma('journal_mode = WAL');
sqlite.pragma(`busy_timeout = ${config.busyTimeout}`);
sqlite.pragma('foreign_keys = ON');

// Check settings
const journalMode = sqlite.pragma('journal_mode', { simple: true });
const foreignKeys = sqlite.pragma('foreign_keys', { simple: true });

console.log('Journal mode:', journalMode);
console.log('Foreign keys:', foreignKeys);
console.log('Database initialized successfully!');

sqlite.close();
