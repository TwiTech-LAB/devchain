import { ZodError } from 'zod';
import { TriggerConditionSchema, CreateWatcherSchema, UpdateWatcherSchema } from './watcher.dto';

describe('Watcher DTO schemas', () => {
  const validUuid = '00000000-0000-0000-0000-000000000000';

  describe('TriggerConditionSchema', () => {
    it('validates valid condition with contains type', () => {
      expect(() =>
        TriggerConditionSchema.parse({
          type: 'contains',
          pattern: 'context window',
        }),
      ).not.toThrow();
    });

    it('validates valid regex condition with flags', () => {
      expect(() =>
        TriggerConditionSchema.parse({
          type: 'regex',
          pattern: 'error|warning',
          flags: 'i',
        }),
      ).not.toThrow();
    });

    it('validates not_contains type', () => {
      expect(() =>
        TriggerConditionSchema.parse({
          type: 'not_contains',
          pattern: 'success',
        }),
      ).not.toThrow();
    });

    it('rejects invalid condition type', () => {
      expect(() =>
        TriggerConditionSchema.parse({
          type: 'invalid',
          pattern: 'test',
        }),
      ).toThrow(ZodError);
    });

    it('rejects empty pattern', () => {
      expect(() =>
        TriggerConditionSchema.parse({
          type: 'contains',
          pattern: '',
        }),
      ).toThrow(ZodError);
    });

    it('rejects pattern exceeding 1000 chars', () => {
      expect(() =>
        TriggerConditionSchema.parse({
          type: 'contains',
          pattern: 'a'.repeat(1001),
        }),
      ).toThrow(ZodError);
    });

    it('rejects flags exceeding 10 chars', () => {
      expect(() =>
        TriggerConditionSchema.parse({
          type: 'regex',
          pattern: 'test',
          flags: 'a'.repeat(11),
        }),
      ).toThrow(ZodError);
    });
  });

  describe('CreateWatcherSchema', () => {
    const minValidData = {
      projectId: validUuid,
      name: 'My Watcher',
      condition: { type: 'contains' as const, pattern: 'test' },
      eventName: 'my.event',
    };

    it('validates minimal valid data with defaults', () => {
      const result = CreateWatcherSchema.parse(minValidData);
      expect(result.projectId).toBe(validUuid);
      expect(result.name).toBe('My Watcher');
      expect(result.enabled).toBe(true);
      expect(result.scope).toBe('all');
      expect(result.pollIntervalMs).toBe(5000);
      expect(result.viewportLines).toBe(50);
      expect(result.cooldownMs).toBe(60000);
      expect(result.cooldownMode).toBe('time');
    });

    it('validates full data with all fields', () => {
      const fullData = {
        projectId: validUuid,
        name: 'Full Watcher',
        description: 'A test watcher',
        enabled: false,
        scope: 'agent' as const,
        scopeFilterId: validUuid,
        pollIntervalMs: 10000,
        viewportLines: 100,
        condition: { type: 'regex' as const, pattern: 'error.*', flags: 'i' },
        cooldownMs: 120000,
        cooldownMode: 'until_clear' as const,
        eventName: 'agent.error_detected',
      };
      expect(() => CreateWatcherSchema.parse(fullData)).not.toThrow();
    });

    it('rejects missing required fields', () => {
      expect(() => CreateWatcherSchema.parse({})).toThrow(ZodError);
      expect(() => CreateWatcherSchema.parse({ projectId: validUuid })).toThrow(ZodError);
    });

    it('rejects invalid projectId', () => {
      expect(() =>
        CreateWatcherSchema.parse({
          ...minValidData,
          projectId: 'not-a-uuid',
        }),
      ).toThrow(ZodError);
    });

    it('rejects name exceeding 100 chars', () => {
      expect(() =>
        CreateWatcherSchema.parse({
          ...minValidData,
          name: 'a'.repeat(101),
        }),
      ).toThrow(ZodError);
    });

    it('rejects empty name', () => {
      expect(() =>
        CreateWatcherSchema.parse({
          ...minValidData,
          name: '',
        }),
      ).toThrow(ZodError);
    });

    it('rejects invalid eventName format', () => {
      expect(() =>
        CreateWatcherSchema.parse({
          ...minValidData,
          eventName: '123starts-with-number',
        }),
      ).toThrow(ZodError);

      expect(() =>
        CreateWatcherSchema.parse({
          ...minValidData,
          eventName: 'has spaces',
        }),
      ).toThrow(ZodError);

      expect(() =>
        CreateWatcherSchema.parse({
          ...minValidData,
          eventName: 'has@special#chars',
        }),
      ).toThrow(ZodError);
    });

    it('accepts valid eventName formats', () => {
      const validEventNames = [
        'simple',
        'with.dots',
        'with_underscores',
        'with-hyphens',
        'Mixed.Case_Event-name123',
      ];

      for (const eventName of validEventNames) {
        expect(() =>
          CreateWatcherSchema.parse({
            ...minValidData,
            eventName,
          }),
        ).not.toThrow();
      }
    });

    it('rejects pollIntervalMs outside range', () => {
      expect(() =>
        CreateWatcherSchema.parse({
          ...minValidData,
          pollIntervalMs: 999,
        }),
      ).toThrow(ZodError);

      expect(() =>
        CreateWatcherSchema.parse({
          ...minValidData,
          pollIntervalMs: 60001,
        }),
      ).toThrow(ZodError);
    });

    it('rejects viewportLines outside range', () => {
      expect(() =>
        CreateWatcherSchema.parse({
          ...minValidData,
          viewportLines: 9,
        }),
      ).toThrow(ZodError);

      expect(() =>
        CreateWatcherSchema.parse({
          ...minValidData,
          viewportLines: 201,
        }),
      ).toThrow(ZodError);
    });

    it('requires scopeFilterId when scope is not "all"', () => {
      expect(() =>
        CreateWatcherSchema.parse({
          ...minValidData,
          scope: 'agent',
        }),
      ).toThrow(ZodError);

      expect(() =>
        CreateWatcherSchema.parse({
          ...minValidData,
          scope: 'agent',
          scopeFilterId: validUuid,
        }),
      ).not.toThrow();
    });

    it('accepts non-UUID scopeFilterId values (seeded IDs)', () => {
      expect(() =>
        CreateWatcherSchema.parse({
          ...minValidData,
          scope: 'provider',
          scopeFilterId: 'provider-claude',
        }),
      ).not.toThrow();
    });

    it('allows null scopeFilterId when scope is "all"', () => {
      expect(() =>
        CreateWatcherSchema.parse({
          ...minValidData,
          scope: 'all',
          scopeFilterId: null,
        }),
      ).not.toThrow();
    });
  });

  describe('UpdateWatcherSchema', () => {
    it('allows empty object (no updates)', () => {
      expect(() => UpdateWatcherSchema.parse({})).not.toThrow();
    });

    it('validates partial updates', () => {
      expect(() =>
        UpdateWatcherSchema.parse({
          name: 'Updated Name',
        }),
      ).not.toThrow();

      expect(() =>
        UpdateWatcherSchema.parse({
          enabled: false,
          cooldownMs: 30000,
        }),
      ).not.toThrow();
    });

    it('allows nullable description', () => {
      expect(() =>
        UpdateWatcherSchema.parse({
          description: null,
        }),
      ).not.toThrow();

      expect(() =>
        UpdateWatcherSchema.parse({
          description: 'New description',
        }),
      ).not.toThrow();
    });

    it('allows nullable scopeFilterId', () => {
      expect(() =>
        UpdateWatcherSchema.parse({
          scopeFilterId: null,
        }),
      ).not.toThrow();
    });

    it('does not apply defaults', () => {
      const result = UpdateWatcherSchema.parse({});
      expect(result.enabled).toBeUndefined();
      expect(result.scope).toBeUndefined();
      expect(result.pollIntervalMs).toBeUndefined();
    });

    it('still validates field constraints', () => {
      expect(() =>
        UpdateWatcherSchema.parse({
          name: '',
        }),
      ).toThrow(ZodError);

      expect(() =>
        UpdateWatcherSchema.parse({
          pollIntervalMs: 500,
        }),
      ).toThrow(ZodError);

      expect(() =>
        UpdateWatcherSchema.parse({
          eventName: '123invalid',
        }),
      ).toThrow(ZodError);
    });

    it('validates condition when provided', () => {
      expect(() =>
        UpdateWatcherSchema.parse({
          condition: { type: 'contains', pattern: 'valid' },
        }),
      ).not.toThrow();

      expect(() =>
        UpdateWatcherSchema.parse({
          condition: { type: 'invalid', pattern: 'test' },
        }),
      ).toThrow(ZodError);
    });
  });
});
