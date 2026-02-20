import { Module } from '@nestjs/common';
import { CoreCommonModule } from './core-common.module';
import { CoreNormalModule } from './core-normal.module';

@Module({
  imports: [CoreCommonModule, CoreNormalModule],
  exports: [CoreCommonModule, CoreNormalModule],
})
export class CoreModule {}
