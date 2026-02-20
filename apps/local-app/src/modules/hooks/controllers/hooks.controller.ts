import { Controller, Post, Body, BadRequestException } from '@nestjs/common';
import { HooksService } from '../services/hooks.service';
import { HookEventSchema, type HookEventResponse } from '../dtos/hook-event.dto';
import { createLogger } from '../../../common/logging/logger';

const logger = createLogger('HooksController');

@Controller('api/hooks')
export class HooksController {
  constructor(private readonly hooksService: HooksService) {}

  /**
   * POST /api/hooks/events
   * Receives hook payloads from the relay script.
   * Validates with Zod (strict mode), delegates to HooksService.
   */
  @Post('events')
  async receiveHookEvent(@Body() body: unknown): Promise<HookEventResponse> {
    logger.info('POST /api/hooks/events');

    const parseResult = HookEventSchema.safeParse(body);
    if (!parseResult.success) {
      throw new BadRequestException({
        message: 'Validation failed',
        errors: parseResult.error.errors,
      });
    }

    return this.hooksService.handleHookEvent(parseResult.data);
  }
}
