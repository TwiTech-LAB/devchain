import { homedir } from 'os';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';

export interface DbConfig {
  dbPath: string;
  busyTimeout: number;
}

export function getDbConfig(): DbConfig {
  const dbDir = process.env.DB_PATH || join(homedir(), '.devchain');
  const dbFilename = process.env.DB_FILENAME || 'devchain.db';
  const dbPath = join(dbDir, dbFilename);

  // Ensure directory exists
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
  }

  return {
    dbPath,
    busyTimeout: 5000, // 5 seconds
  };
}
