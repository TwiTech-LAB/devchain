import { CONDITION_TYPE_LABELS } from './watchers';

describe('watchers condition type helpers', () => {
  it('contains no idle entries in labels', () => {
    expect(Object.hasOwn(CONDITION_TYPE_LABELS, 'idle')).toBe(false);
  });
});
