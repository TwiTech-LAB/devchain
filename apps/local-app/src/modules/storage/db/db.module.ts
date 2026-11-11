import { Module, Global } from '@nestjs/common';
import { dbProvider, DB_CONNECTION } from './db.provider';
import { DB_FILE_PATH, dbFilePathProvider } from './db-file-path.provider';

@Global()
@Module({
  providers: [dbProvider, dbFilePathProvider],
  exports: [DB_CONNECTION, DB_FILE_PATH],
})
export class DbModule {}
