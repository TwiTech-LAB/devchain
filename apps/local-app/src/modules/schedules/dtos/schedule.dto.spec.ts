import {
  CreateScheduledEpicSchema,
  UpdateScheduledEpicSchema,
  ToggleScheduledEpicSchema,
} from './schedule.dto';
import { ZodError } from 'zod';

describe('ScheduledEpic DTO schemas', () => {
  const validProjectId = '550e8400-e29b-41d4-a716-446655440000';

  describe('CreateScheduledEpicSchema', () => {
    it('validates minimal valid data with defaults', () => {
      const result = CreateScheduledEpicSchema.parse({
        projectId: validProjectId,
        name: 'Daily Standup',
        cronExpression: '0 9 * * *',
        templateTitle: 'Daily standup',
      });

      expect(result.projectId).toBe(validProjectId);
      expect(result.name).toBe('Daily Standup');
      expect(result.enabled).toBe(true);
      expect(result.timezone).toBe('UTC');
      expect(result.cooldownMs).toBe(0);
      expect(result.position).toBe(0);
    });

    it('validates full data with all fields', () => {
      const result = CreateScheduledEpicSchema.parse({
        projectId: validProjectId,
        name: 'Full Schedule',
        description: 'A test schedule',
        enabled: false,
        cronExpression: '0 */6 * * *',
        timezone: 'America/New_York',
        templateTitle: 'Task {{sequence}}',
        templateDescription: 'Description',
        templateStatusId: '550e8400-e29b-41d4-a716-446655440001',
        templateAgentId: '550e8400-e29b-41d4-a716-446655440002',
        templateParentId: '550e8400-e29b-41d4-a716-446655440003',
        templateTags: ['tag-1', 'tag-2'],
        templateSkillsRequired: ['skill-1'],
        templateData: { key: 'value' },
        maxOccurrences: 10,
        cooldownMs: 5000,
        position: 1,
      });

      expect(result.enabled).toBe(false);
      expect(result.timezone).toBe('America/New_York');
      expect(result.maxOccurrences).toBe(10);
    });

    it('rejects missing projectId', () => {
      expect(() =>
        CreateScheduledEpicSchema.parse({
          name: 'Test',
          cronExpression: '0 * * * *',
          templateTitle: 'T',
        }),
      ).toThrow(ZodError);
    });

    it('rejects missing name', () => {
      expect(() =>
        CreateScheduledEpicSchema.parse({
          projectId: validProjectId,
          cronExpression: '0 * * * *',
          templateTitle: 'T',
        }),
      ).toThrow(ZodError);
    });

    it('rejects missing cronExpression', () => {
      expect(() =>
        CreateScheduledEpicSchema.parse({
          projectId: validProjectId,
          name: 'Test',
          templateTitle: 'T',
        }),
      ).toThrow(ZodError);
    });

    it('rejects missing templateTitle', () => {
      expect(() =>
        CreateScheduledEpicSchema.parse({
          projectId: validProjectId,
          name: 'Test',
          cronExpression: '0 * * * *',
        }),
      ).toThrow(ZodError);
    });

    it('rejects name exceeding 100 characters', () => {
      expect(() =>
        CreateScheduledEpicSchema.parse({
          projectId: validProjectId,
          name: 'x'.repeat(101),
          cronExpression: '0 * * * *',
          templateTitle: 'T',
        }),
      ).toThrow(ZodError);
    });

    it('rejects cronExpression too short', () => {
      expect(() =>
        CreateScheduledEpicSchema.parse({
          projectId: validProjectId,
          name: 'Test',
          cronExpression: '* *',
          templateTitle: 'T',
        }),
      ).toThrow(ZodError);
    });

    it('rejects invalid projectId (non-UUID)', () => {
      expect(() =>
        CreateScheduledEpicSchema.parse({
          projectId: 'not-a-uuid',
          name: 'Test',
          cronExpression: '0 * * * *',
          templateTitle: 'T',
        }),
      ).toThrow(ZodError);
    });

    it('rejects maxOccurrences less than 1', () => {
      expect(() =>
        CreateScheduledEpicSchema.parse({
          projectId: validProjectId,
          name: 'Test',
          cronExpression: '0 * * * *',
          templateTitle: 'T',
          maxOccurrences: 0,
        }),
      ).toThrow(ZodError);
    });

    it('rejects negative cooldownMs', () => {
      expect(() =>
        CreateScheduledEpicSchema.parse({
          projectId: validProjectId,
          name: 'Test',
          cronExpression: '0 * * * *',
          templateTitle: 'T',
          cooldownMs: -1,
        }),
      ).toThrow(ZodError);
    });

    it('allows nullable optional fields', () => {
      const result = CreateScheduledEpicSchema.parse({
        projectId: validProjectId,
        name: 'Test',
        cronExpression: '0 * * * *',
        templateTitle: 'T',
        templateDescription: null,
        templateStatusId: null,
        templateAgentId: null,
        templateParentId: null,
        templateTags: null,
        templateSkillsRequired: null,
        templateData: null,
        maxOccurrences: null,
      });

      expect(result.templateDescription).toBeNull();
      expect(result.maxOccurrences).toBeNull();
    });
  });

  describe('UpdateScheduledEpicSchema', () => {
    it('allows empty object (no updates)', () => {
      const result = UpdateScheduledEpicSchema.parse({});
      expect(result).toEqual({});
    });

    it('allows partial updates', () => {
      const result = UpdateScheduledEpicSchema.parse({ name: 'Updated' });
      expect(result).toEqual({ name: 'Updated' });
    });

    it('does not apply defaults', () => {
      const result = UpdateScheduledEpicSchema.parse({ name: 'Test' });
      expect(result).not.toHaveProperty('enabled');
      expect(result).not.toHaveProperty('cooldownMs');
    });

    it('rejects empty name', () => {
      expect(() => UpdateScheduledEpicSchema.parse({ name: '' })).toThrow(ZodError);
    });

    it('allows nullable fields', () => {
      const result = UpdateScheduledEpicSchema.parse({
        templateDescription: null,
        maxOccurrences: null,
      });
      expect(result.templateDescription).toBeNull();
      expect(result.maxOccurrences).toBeNull();
    });
  });

  describe('ToggleScheduledEpicSchema', () => {
    it('validates enabled: true', () => {
      const result = ToggleScheduledEpicSchema.parse({ enabled: true });
      expect(result.enabled).toBe(true);
    });

    it('validates enabled: false', () => {
      const result = ToggleScheduledEpicSchema.parse({ enabled: false });
      expect(result.enabled).toBe(false);
    });

    it('rejects missing enabled', () => {
      expect(() => ToggleScheduledEpicSchema.parse({})).toThrow(ZodError);
    });

    it('rejects non-boolean enabled', () => {
      expect(() => ToggleScheduledEpicSchema.parse({ enabled: 'yes' })).toThrow(ZodError);
    });
  });
});
