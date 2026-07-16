import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { MetricsService } from '../services/metrics.service';

@ApiTags('debug')
@Controller('api/debug')
export class MetricsController {
  constructor(private readonly metricsService: MetricsService) {}

  @Get('metrics')
  @ApiOperation({ summary: 'Backend memory and cache counters snapshot' })
  @ApiResponse({ status: 200, description: 'Current metrics snapshot' })
  getMetrics() {
    return this.metricsService.getMetrics();
  }
}
