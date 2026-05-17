import {
  scheduledEpicExecutedEvent,
  ScheduledEpicErrorCodeSchema,
} from './scheduled-epic.executed';

const basePayload = {
  scheduleId: 'sched-1',
  runId: 'run-1',
  projectId: 'proj-1',
  scheduleName: 'Weekly sync',
  triggerSource: 'scheduler' as const,
  plannedFor: '2025-01-06T09:00:00.000Z',
  finishedAt: '2025-01-06T09:00:01.500Z',
  lagMs: 1500,
  createdEpicId: 'epic-1',
  createdEpicTitle: 'Weekly sync 2025-01-06',
  errorCode: null,
  errorMessage: null,
};

describe('scheduledEpicExecutedEvent schema', () => {
  describe('success payload', () => {
    it('accepts a completed run with all fields', () => {
      const result = scheduledEpicExecutedEvent.schema.safeParse({
        ...basePayload,
        status: 'completed',
      });
      expect(result.success).toBe(true);
    });

    it('accepts a manual trigger source', () => {
      const result = scheduledEpicExecutedEvent.schema.safeParse({
        ...basePayload,
        status: 'completed',
        triggerSource: 'manual',
      });
      expect(result.success).toBe(true);
    });

    it('accepts null lagMs', () => {
      const result = scheduledEpicExecutedEvent.schema.safeParse({
        ...basePayload,
        status: 'completed',
        lagMs: null,
      });
      expect(result.success).toBe(true);
    });
  });

  describe('failure payload', () => {
    it('accepts a failed run with errorCode and errorMessage', () => {
      const result = scheduledEpicExecutedEvent.schema.safeParse({
        ...basePayload,
        status: 'failed',
        createdEpicId: null,
        createdEpicTitle: null,
        errorCode: 'EPIC_CREATE_FAILED',
        errorMessage: 'Storage write failed',
      });
      expect(result.success).toBe(true);
    });

    it('accepts TEMPLATE_RENDER_FAILED error code', () => {
      const result = scheduledEpicExecutedEvent.schema.safeParse({
        ...basePayload,
        status: 'failed',
        createdEpicId: null,
        createdEpicTitle: null,
        errorCode: 'TEMPLATE_RENDER_FAILED',
        errorMessage: 'Parse error in Handlebars',
      });
      expect(result.success).toBe(true);
    });

    it('accepts STALE_RUNNING_RECOVERED error code', () => {
      const result = scheduledEpicExecutedEvent.schema.safeParse({
        ...basePayload,
        status: 'failed',
        createdEpicId: null,
        createdEpicTitle: null,
        errorCode: 'STALE_RUNNING_RECOVERED',
        errorMessage: 'STALE_RUNNING_RECOVERED',
      });
      expect(result.success).toBe(true);
    });

    it('accepts UNKNOWN error code', () => {
      const result = scheduledEpicExecutedEvent.schema.safeParse({
        ...basePayload,
        status: 'failed',
        createdEpicId: null,
        createdEpicTitle: null,
        errorCode: 'UNKNOWN',
        errorMessage: 'Unexpected error',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('skipped payload', () => {
    it('accepts a skipped run with SCHEDULE_DISABLED code', () => {
      const result = scheduledEpicExecutedEvent.schema.safeParse({
        ...basePayload,
        status: 'skipped',
        createdEpicId: null,
        createdEpicTitle: null,
        errorCode: 'SCHEDULE_DISABLED',
        errorMessage: 'Schedule disabled',
      });
      expect(result.success).toBe(true);
    });

    it('accepts a skipped run with DUPLICATE_CLAIM code', () => {
      const result = scheduledEpicExecutedEvent.schema.safeParse({
        ...basePayload,
        status: 'skipped',
        createdEpicId: null,
        createdEpicTitle: null,
        errorCode: 'DUPLICATE_CLAIM',
        errorMessage: 'Overlap not allowed',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('schema rejections', () => {
    it('rejects an unknown status value', () => {
      const result = scheduledEpicExecutedEvent.schema.safeParse({
        ...basePayload,
        status: 'running',
      });
      expect(result.success).toBe(false);
    });

    it('rejects an unknown errorCode value', () => {
      const result = scheduledEpicExecutedEvent.schema.safeParse({
        ...basePayload,
        status: 'failed',
        errorCode: 'NOT_A_CODE',
        errorMessage: 'some error',
        createdEpicId: null,
        createdEpicTitle: null,
      });
      expect(result.success).toBe(false);
    });

    it('rejects missing required fields', () => {
      const { scheduleId: _, ...withoutScheduleId } = basePayload;
      const result = scheduledEpicExecutedEvent.schema.safeParse({
        ...withoutScheduleId,
        status: 'completed',
      });
      expect(result.success).toBe(false);
    });

    it('rejects an unknown triggerSource', () => {
      const result = scheduledEpicExecutedEvent.schema.safeParse({
        ...basePayload,
        status: 'completed',
        triggerSource: 'cron',
      });
      expect(result.success).toBe(false);
    });
  });
});

describe('ScheduledEpicErrorCodeSchema', () => {
  const validCodes = [
    'CRON_INVALID',
    'TIMEZONE_INVALID',
    'TEMPLATE_RENDER_FAILED',
    'EPIC_CREATE_FAILED',
    'DUPLICATE_CLAIM',
    'STALE_RUNNING_RECOVERED',
    'SCHEDULE_DISABLED',
    'UNKNOWN',
  ] as const;

  it.each(validCodes)('accepts error code %s', (code) => {
    expect(ScheduledEpicErrorCodeSchema.safeParse(code).success).toBe(true);
  });

  it('rejects unknown error codes', () => {
    expect(ScheduledEpicErrorCodeSchema.safeParse('NOT_A_CODE').success).toBe(false);
  });
});
