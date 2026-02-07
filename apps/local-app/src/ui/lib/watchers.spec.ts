import {
  CONDITION_TYPE_DESCRIPTIONS,
  CONDITION_TYPE_LABELS,
  getConditionTypeDescription,
  getConditionTypeLabel,
} from './watchers';

describe('watchers condition type helpers', () => {
  it('keeps condition labels unchanged', () => {
    expect(getConditionTypeLabel('contains')).toBe('Contains');
    expect(getConditionTypeLabel('regex')).toBe('Regex');
    expect(getConditionTypeLabel('not_contains')).toBe('Not Contains');
  });

  it('keeps condition descriptions unchanged for supported types', () => {
    expect(getConditionTypeDescription('contains')).toBe(
      'Triggers when terminal output contains the pattern',
    );
    expect(getConditionTypeDescription('regex')).toBe(
      'Triggers when terminal output matches a regular expression',
    );
    expect(getConditionTypeDescription('not_contains')).toBe(
      'Triggers when terminal output does not contain the pattern',
    );
  });

  it('contains no idle entries in labels/descriptions', () => {
    expect(Object.hasOwn(CONDITION_TYPE_LABELS, 'idle')).toBe(false);
    expect(Object.hasOwn(CONDITION_TYPE_DESCRIPTIONS, 'idle')).toBe(false);
  });
});
