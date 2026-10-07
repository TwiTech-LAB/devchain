import { CreateScheduledEpicDtoSchema, UpdateScheduledEpicDtoSchema } from './scheduled-epic.dto';

const validBase = {
  projectId: 'a0000000-0000-0000-0000-000000000001',
  name: 'Weekly sync',
  cronExpression: '0 9 * * 1',
  timezone: 'UTC',
  titleTemplate: 'Weekly sync {{date}}',
};

describe('CreateScheduledEpicDtoSchema', () => {
  it('applies sensible defaults for optional fields', () => {
    const result = CreateScheduledEpicDtoSchema.safeParse(validBase);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(true);
      expect(result.data.allowOverlap).toBe(false);
      expect(result.data.missedRunPolicy).toBe('skip');
      expect(result.data.templateTags).toEqual([]);
    }
  });

  it('rejects an invalid cron expression', () => {
    const result = CreateScheduledEpicDtoSchema.safeParse({
      ...validBase,
      cronExpression: 'not-a-cron',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown timezone', () => {
    const result = CreateScheduledEpicDtoSchema.safeParse({
      ...validBase,
      timezone: 'Mars/Olympus',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a malformed titleTemplate', () => {
    const result = CreateScheduledEpicDtoSchema.safeParse({
      ...validBase,
      titleTemplate: '{{#if foo}}unclosed',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a malformed descriptionTemplate', () => {
    const result = CreateScheduledEpicDtoSchema.safeParse({
      ...validBase,
      descriptionTemplate: '{{#each items}}no close',
    });
    expect(result.success).toBe(false);
  });
});

describe('UpdateScheduledEpicDtoSchema', () => {
  it('validates titleTemplate when provided', () => {
    const result = UpdateScheduledEpicDtoSchema.safeParse({
      titleTemplate: '{{#if x}}unclosed',
    });
    expect(result.success).toBe(false);
  });
});
