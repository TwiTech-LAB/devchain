import { createMockEpic } from '../../../../../test/factories';
import { mapEpicSummary } from './dto-mappers';

describe('mapEpicSummary', () => {
  it.each([
    ['an agent snapshot', 'Creator Agent'],
    ['null attribution', null],
  ])('maps createdBy for %s', (_label, createdBy) => {
    const summary = mapEpicSummary(createMockEpic({ createdBy }));

    expect(summary.createdBy).toBe(createdBy);
  });
});
