import { CreateWatcherSchema, UpdateWatcherSchema } from './watcher.dto';

describe('Watcher DTO schemas', () => {
  const validUuid = '00000000-0000-0000-0000-000000000000';

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
      expect(result.idleAfterSeconds).toBe(0);
      expect(result.cooldownMs).toBe(60000);
      expect(result.cooldownMode).toBe('time');
    });

    it.each([
      [['123starts-with-number', 'has spaces', 'has@special#chars'], false],
      [
        ['simple', 'with.dots', 'with_underscores', 'with-hyphens', 'Mixed.Case_Event-name123'],
        true,
      ],
    ])('validates eventName formats %j', (eventNames, valid) => {
      for (const eventName of eventNames)
        expect(CreateWatcherSchema.safeParse({ ...minValidData, eventName }).success).toBe(valid);
    });

    it.each([
      ['agent', undefined, false],
      ['agent', validUuid, true],
      ['all', null, true],
    ])('validates scope %s with filter %s', (scope, scopeFilterId, valid) => {
      expect(CreateWatcherSchema.safeParse({ ...minValidData, scope, scopeFilterId }).success).toBe(
        valid,
      );
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
  });

  describe('UpdateWatcherSchema', () => {
    it('does not apply defaults', () => {
      const result = UpdateWatcherSchema.parse({});
      expect(result.enabled).toBeUndefined();
      expect(result.scope).toBeUndefined();
      expect(result.pollIntervalMs).toBeUndefined();
      expect(result.idleAfterSeconds).toBeUndefined();
    });
  });
});
