/**
 * ScheduledEpics codec unit tests — verifies refs resolve through the ImportContext maps
 * (agentNameToId, templateLabelToStatusId) and live storage (parent epic titles), the
 * nextRunAt + refresh hook fire, and the legacy empty-section short-circuit is preserved.
 */
import type { StorageService } from '../../../storage/interfaces/storage.interface';
import { ImportContext, type ImportContextValues } from '../import-context';
import type { CodecApplyRuntime } from '../template-section-codec';
import { scheduledEpicsCodec } from './scheduled-epics.codec';

function seedCtx(): ImportContext {
  const ctx = new ImportContext({} as Partial<ImportContextValues>);
  ctx.set('agentNameToId', { 'builder agent': 'agent-9' });
  ctx.set('templateLabelToStatusId', new Map([['to do', 'status-3']]));
  return ctx;
}

const section = (
  schedules: Array<Record<string, unknown>>,
): Parameters<typeof scheduledEpicsCodec.apply>[0] =>
  schedules as unknown as Parameters<typeof scheduledEpicsCodec.apply>[0];

function makeStorage(existingEpics: Array<{ id: string; title: string }>) {
  return {
    listEpics: jest.fn().mockResolvedValue({ items: existingEpics }),
    createScheduledEpic: jest.fn().mockResolvedValue(undefined),
  } as unknown as StorageService;
}

describe('scheduledEpics codec — apply', () => {
  it('resolves agent/status/parent-epic refs and seeds nextRunAt + refresh', async () => {
    const storage = makeStorage([{ id: 'epic-1', title: 'Standup Parent' }]);
    const computeNextRunAt = jest.fn(() => new Date('2026-07-04T09:00:00Z'));
    const refresh = jest.fn();
    const rt = {
      projectId: 'project-1',
      storage,
      computeNextRunAt,
      scheduledEpicsRefresh: { refreshScheduleWindow: refresh },
    } as unknown as CodecApplyRuntime;

    const result = await scheduledEpicsCodec.apply(
      section([
        {
          name: 'daily-standup',
          cronExpression: '0 9 * * *',
          timezone: 'UTC',
          enabled: true,
          titleTemplate: 'Standup {date}',
          templateStatusLabel: 'To Do',
          templateAgentName: 'Builder Agent',
          templateParentEpicTitle: 'Standup Parent',
          templateTags: ['auto'],
          allowOverlap: false,
          missedRunPolicy: 'skip',
        },
      ]),
      seedCtx(),
      'replace',
      rt,
    );

    expect(result.log).toEqual({ scheduledEpics: 1 });
    expect(storage.createScheduledEpic).toHaveBeenCalledWith(
      expect.objectContaining({
        templateAgentId: 'agent-9',
        templateStatusId: 'status-3',
        templateParentEpicId: 'epic-1',
        nextRunAt: '2026-07-04T09:00:00.000Z',
      }),
    );
    expect(computeNextRunAt).toHaveBeenCalledWith('0 9 * * *', 'UTC');
    expect(refresh).toHaveBeenCalled();
  });

  it('short-circuits on an empty section without querying epics', async () => {
    const storage = makeStorage([]);
    const result = await scheduledEpicsCodec.apply(section([]), seedCtx(), 'replace', {
      projectId: 'project-1',
      storage,
    } as CodecApplyRuntime);
    expect(storage.listEpics).not.toHaveBeenCalled();
    expect(storage.createScheduledEpic).not.toHaveBeenCalled();
    expect(result.log).toEqual({ scheduledEpics: 0 });
  });
});
