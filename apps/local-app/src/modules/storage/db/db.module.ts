import { Module, Global } from '@nestjs/common';
import { dbProvider, DB_CONNECTION } from './db.provider';

@Global()
@Module({
  providers: [dbProvider],
  exports: [DB_CONNECTION],
})
export class DbModule {}
