import { Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import { PROVIDER_USAGE_INTERVAL_LIMITS, type ProviderUsageResponse } from '@devchain/shared';
import { ProviderUsageService } from '../services/provider-usage.service';

const ProviderUsageQuerySchema = z.object({
  projectId: z.string().min(1),
  /** From the shortest hover age to the longest open-project age. */
  maxAgeSec: z.coerce
    .number()
    .int()
    .min(PROVIDER_USAGE_INTERVAL_LIMITS.hoverMaxAgeSec.min)
    .max(PROVIDER_USAGE_INTERVAL_LIMITS.openProjectMaxAgeMin.max * 60)
    .optional(),
});

@Controller('api/provider-usage')
export class ProviderUsageController {
  constructor(private readonly usage: ProviderUsageService) {}

  @Get()
  async get(@Query() query: unknown): Promise<ProviderUsageResponse> {
    const { projectId, maxAgeSec } = ProviderUsageQuerySchema.parse(query);
    return this.usage.getProjectUsage(projectId, maxAgeSec);
  }
}
