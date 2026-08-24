import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import type { EpicTimeBatchSummary, EpicTimeDetailSummary } from '../models/epic-time.models';
import { EpicTimeService } from '../services/epic-time.service';

const EpicIdSchema = z.string().uuid();
const TimeZoneSchema = z.string().trim().min(1).max(128);
const BatchTimeSummarySchema = z
  .object({
    epicIds: z.array(EpicIdSchema).min(1).max(1_000),
    timeZone: TimeZoneSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.epicIds).size !== value.epicIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['epicIds'],
        message: 'Epic IDs must be unique.',
      });
    }
  });

@Controller('api/epics')
export class EpicTimeController {
  constructor(private readonly epicTimeService: EpicTimeService) {}

  @Get(':id/time-logs')
  getTimeLogs(
    @Param('id') id: string,
    @Query('timeZone') timeZone: string | undefined,
  ): EpicTimeDetailSummary {
    return this.epicTimeService.getDetail(EpicIdSchema.parse(id), TimeZoneSchema.parse(timeZone));
  }

  @Post('time-summary/batch')
  @HttpCode(HttpStatus.OK)
  getTimeSummaryBatch(@Body() body: unknown): EpicTimeBatchSummary {
    const parsed = BatchTimeSummarySchema.parse(body);
    return this.epicTimeService.getBatch(parsed.epicIds, parsed.timeZone);
  }
}
