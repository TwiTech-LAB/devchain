import { CreateScheduledEpicDtoSchema, UpdateScheduledEpicDtoSchema } from './scheduled-epic.dto';

const validBase = {
  projectId: 'a0000000-0000-0000-0000-000000000001',
  name: 'Weekly sync',
  cronExpression: '0 9 * * 1',
  timezone: 'UTC',
  titleTemplate: 'Weekly sync {{date}}',
};

describe('CreateScheduledEpicDtoSchema', () => {
  it('accepts a minimal valid payload', () => {
    const result = CreateScheduledEpicDtoSchema.safeParse(validBase);
    expect(result.success).toBe(true);
  });

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

  it('accepts null for nullable optional fields', () => {
    const result = CreateScheduledEpicDtoSchema.safeParse({
      ...validBase,
      descriptionTemplate: null,
      templateStatusId: null,
      templateParentEpicId: null,
      templateAgentId: null,
      nextRunAt: null,
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown extra fields (strict mode)', () => {
    const result = CreateScheduledEpicDtoSchema.safeParse({
      ...validBase,
      unknownField: 'oops',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid missedRunPolicy', () => {
    const result = CreateScheduledEpicDtoSchema.safeParse({
      ...validBase,
      missedRunPolicy: 'invalid_policy',
    });
    expect(result.success).toBe(false);
  });

  it('rejects templateAgentId that is not a UUID', () => {
    const result = CreateScheduledEpicDtoSchema.safeParse({
      ...validBase,
      templateAgentId: 'not-a-uuid',
    });
    expect(result.success).toBe(false);
  });
});

describe('UpdateScheduledEpicDtoSchema', () => {
  it('accepts an empty update (all fields optional)', () => {
    const result = UpdateScheduledEpicDtoSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('validates cronExpression when provided', () => {
    const result = UpdateScheduledEpicDtoSchema.safeParse({ cronExpression: 'bad' });
    expect(result.success).toBe(false);
  });

  it('validates timezone when provided', () => {
    const result = UpdateScheduledEpicDtoSchema.safeParse({ timezone: 'Not/Real' });
    expect(result.success).toBe(false);
  });

  it('validates titleTemplate when provided', () => {
    const result = UpdateScheduledEpicDtoSchema.safeParse({
      titleTemplate: '{{#if x}}unclosed',
    });
    expect(result.success).toBe(false);
  });

  it('accepts a partial valid update', () => {
    const result = UpdateScheduledEpicDtoSchema.safeParse({
      name: 'Updated name',
      enabled: false,
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown extra fields (strict mode)', () => {
    const result = UpdateScheduledEpicDtoSchema.safeParse({ extraField: 'nope' });
    expect(result.success).toBe(false);
  });
});
