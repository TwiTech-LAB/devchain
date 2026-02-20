import { Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import { EventLogService } from '../services/event-log.service';
import type { EventLogListResult, EventHandlerStatus } from '../dtos/event-log.dto';
import { createLogger } from '../../../common/logging/logger';

const logger = createLogger('EventLogController');

const StatusSchema = z.enum(['success', 'failure']);

function parseOptionalInt(value?: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    return undefined;
  }
  return parsed;
}

@Controller('api/events')
export class EventLogController {
  constructor(private readonly eventLogService: EventLogService) {}

  @Get()
  async listEvents(
    @Query('name') name?: string,
    @Query('ownerProjectId') ownerProjectId?: string,
    @Query('handler') handler?: string,
    @Query('status') statusParam?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limitParam?: string,
    @Query('offset') offsetParam?: string,
  ): Promise<EventLogListResult> {
    logger.info(
      { name, ownerProjectId, handler, statusParam, from, to, limitParam, offsetParam },
      'GET /api/events',
    );

    let status: EventHandlerStatus | undefined;
    if (statusParam) {
      status = StatusSchema.parse(statusParam);
    }

    const requestedLimit = parseOptionalInt(limitParam);
    const limit = requestedLimit && requestedLimit > 0 ? Math.min(requestedLimit, 500) : 50;

    const requestedOffset = parseOptionalInt(offsetParam);
    const offset = requestedOffset && requestedOffset > 0 ? requestedOffset : 0;

    return this.eventLogService.listEvents({
      name: name?.trim() || undefined,
      ownerProjectId: ownerProjectId?.trim() || undefined,
      handler: handler?.trim() || undefined,
      status,
      from: from?.trim() || undefined,
      to: to?.trim() || undefined,
      limit,
      offset,
    });
  }
}
