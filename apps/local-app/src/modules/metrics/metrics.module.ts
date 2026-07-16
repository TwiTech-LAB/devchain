import { Module } from '@nestjs/common';
import { MetricsService } from './services/metrics.service';
import { MetricsController } from './controllers/metrics.controller';

@Module({
  providers: [MetricsService],
  controllers: [MetricsController],
  exports: [MetricsService],
})
export class MetricsModule {}
