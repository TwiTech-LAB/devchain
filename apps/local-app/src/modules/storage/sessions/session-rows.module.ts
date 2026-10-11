import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { SessionRowStore } from './session-row.store';

@Module({ imports: [DbModule], providers: [SessionRowStore], exports: [SessionRowStore] })
export class SessionRowsModule {}
