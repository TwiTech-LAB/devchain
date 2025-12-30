import { Module } from '@nestjs/common';
import { UiController } from './ui.controller';

@Module({
  controllers: [UiController],
  providers: [],
  exports: [],
})
export class UiModule {}
