import { defineConfig } from 'drizzle-kit';
import { getDbConfig } from './src/modules/storage/db/db.config';

const config = getDbConfig();

export default defineConfig({
  schema: './src/modules/storage/db/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    url: config.dbPath,
  },
  verbose: true,
  strict: true,
});
