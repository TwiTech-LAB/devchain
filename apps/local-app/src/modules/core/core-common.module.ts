import { Module } from '@nestjs/common';
import { HealthController } from './controllers/health.controller';
import { RuntimeController } from './controllers/runtime.controller';
import { HealthService } from './services/health.service';

@Module({
  controllers: [HealthController, RuntimeController],
  providers: [HealthService],
  exports: [HealthService],
})
export class CoreCommonModule {}
