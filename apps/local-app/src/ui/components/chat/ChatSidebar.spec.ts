import { normalizeModelOverrideSelection } from './ChatSidebar';

describe('normalizeModelOverrideSelection', () => {
  it('returns undefined for the none-selected sentinel', () => {
    expect(normalizeModelOverrideSelection('__none_selected__')).toBeUndefined();
  });

  it('returns null for default model override option', () => {
    expect(normalizeModelOverrideSelection('__default_no_override__')).toBeNull();
  });

  it('passes through explicit model values', () => {
    expect(normalizeModelOverrideSelection('openai/gpt-4.1')).toBe('openai/gpt-4.1');
  });
});
