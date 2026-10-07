import { ZodError } from 'zod';
import type { EpicTimeService } from '../services/epic-time.service';
import { EpicTimeController } from './epic-time.controller';

// Layer: backend unit. Controller tests prove bounded transport validation and
// exact service projection without booting the complete application.
describe('EpicTimeController', () => {
  let service: { getDetail: jest.Mock; getBatch: jest.Mock };
  let controller: EpicTimeController;

  beforeEach(() => {
    service = {
      getDetail: jest.fn().mockReturnValue({
        isRoot: true,
        directMinutes: 1,
        totalMinutes: 2,
        includesRelatedTime: false,
        items: [],
        taskItems: [],
      }),
      getBatch: jest.fn().mockReturnValue({ items: [] }),
    };
    controller = new EpicTimeController(service as unknown as EpicTimeService);
  });

  it.each([
    [
      'duplicates',
      ['11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111'],
    ],
    ['empty', []],
    [
      'over limit',
      Array.from(
        { length: 1_001 },
        (_, index) => `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`,
      ),
    ],
  ])('rejects %s batch IDs', (_label, epicIds) => {
    expect(() => controller.getTimeSummaryBatch({ epicIds, timeZone: 'UTC' })).toThrow(ZodError);
    expect(service.getBatch).not.toHaveBeenCalled();
  });
});
