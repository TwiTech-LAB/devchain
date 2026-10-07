/**
 * Test layer: pure unit.
 * Zod and TypeScript contract validation needs no dependency injection or I/O, so this is the
 * cheapest reliable layer that proves the subscriber DTO shapes.
 */

import {
  ActionInputSchema,
  CreateSubscriberSchema,
  UpdateSubscriberSchema,
} from './subscriber.dto';

describe('Subscriber DTO schemas', () => {
  const validUuid = '00000000-0000-0000-0000-000000000000';

  describe('ActionInputSchema', () => {
    it.each([
      [{ source: 'event_field', eventField: 'sessionId' }, true],
      [{ source: 'custom', customValue: '/compact' }, true],
      [{ source: 'custom', customValue: '' }, true],
      [{ source: 'event_field' }, false],
      [{ source: 'custom' }, false],
    ])('validates action input %j', (input, valid) => {
      const result = ActionInputSchema.safeParse(input);
      expect(result.success).toBe(valid);
      if (result.success) expect(result.data).toEqual(input);
    });
  });

  describe('CreateSubscriberSchema', () => {
    const minValidData = {
      projectId: validUuid,
      name: 'My Subscriber',
      eventName: 'claude.context_full',
      actionType: 'SendAgentMessage',
      actionInputs: {
        text: { source: 'custom' as const, customValue: '/compact' },
      },
    };

    it('validates minimal valid data with defaults', () => {
      const result = CreateSubscriberSchema.parse(minValidData);
      expect(result.projectId).toBe(validUuid);
      expect(result.name).toBe('My Subscriber');
      expect(result.enabled).toBe(true);
      expect(result.delayMs).toBe(0);
      expect(result.cooldownMs).toBe(5000);
      expect(result.retryOnError).toBe(false);
    });
  });

  describe('UpdateSubscriberSchema', () => {
    it('does not apply defaults', () => {
      const result = UpdateSubscriberSchema.parse({});
      expect(result.enabled).toBeUndefined();
      expect(result.delayMs).toBeUndefined();
      expect(result.cooldownMs).toBeUndefined();
      expect(result.retryOnError).toBeUndefined();
    });
  });
});
