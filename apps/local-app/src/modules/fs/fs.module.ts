import { Module } from '@nestjs/common';
import { FsController } from './fs.controller';

@Module({
  controllers: [FsController],
})
export class FsModule {}
