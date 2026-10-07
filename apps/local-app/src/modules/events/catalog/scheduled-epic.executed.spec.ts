import { scheduledEpicExecutedEvent } from './scheduled-epic.executed';

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
  });
});
