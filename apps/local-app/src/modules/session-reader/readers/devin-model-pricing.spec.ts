import { mapDevinModelToPricing, calculateDevinMessageCost } from './devin-model-pricing';
import type { PricingServiceInterface } from '../services/pricing.interface';

const silent = { warn: jest.fn() };
const pricing: PricingServiceInterface = {
  calculateMessageCost: jest.fn().mockReturnValue(0.42),
  getCatalogContextWindowSize: jest.fn().mockReturnValue(null),
  getContextWindowSize: jest.fn().mockReturnValue(200_000),
  hasPricing: jest.fn((m: string) => m.startsWith('claude-')),
};

describe('mapDevinModelToPricing', () => {
  it.each([
    ['claude-fable-5-1-xhigh', 'claude-fable-5-1'],
    ['claude-fable-5-1-high', 'claude-fable-5-1'],
    ['claude-fable-5-1-medium', 'claude-fable-5-1'],
    ['claude-fable-5-1-low', 'claude-fable-5-1'],
    ['claude-fable-5-1-none', 'claude-fable-5-1'],
    ['claude-fable-5-1-1m', 'claude-fable-5-1'],
    ['swe-2-max', 'swe-2'],
    ['claude-fable-5-1', 'claude-fable-5-1'],
  ])('maps %s → %s', (uid, expected) => {
    expect(mapDevinModelToPricing(uid)).toBe(expected);
  });

  it.each([undefined, null, '', '   '])('returns null for %j', (uid) => {
    expect(mapDevinModelToPricing(uid)).toBeNull();
  });
});

describe('calculateDevinMessageCost', () => {
  const usage = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4 };

  it('prices a known family via the stripped pricing key', () => {
    expect(calculateDevinMessageCost('claude-fable-5-1-xhigh', usage, pricing, silent)).toBe(0.42);
    expect(pricing.calculateMessageCost).toHaveBeenCalledWith('claude-fable-5-1', 1, 2, 3, 4);
  });

  it('returns $0 + warning for an unpriced family (swe-*) — warned only once per model id', () => {
    (pricing.calculateMessageCost as jest.Mock).mockClear();
    expect(calculateDevinMessageCost('swe-2-max', usage, pricing, silent)).toBe(0);
    expect(silent.warn).toHaveBeenCalledTimes(1);
    expect(pricing.calculateMessageCost).not.toHaveBeenCalled();
    // Repeat calls for the same model id stay $0 but do not re-warn…
    expect(calculateDevinMessageCost('swe-2-max', usage, pricing, silent)).toBe(0);
    expect(silent.warn).toHaveBeenCalledTimes(1);
    // …but a DIFFERENT unpriced model id warns once of its own.
    expect(calculateDevinMessageCost('swe-2-low', usage, pricing, silent)).toBe(0);
    expect(silent.warn).toHaveBeenCalledTimes(2);
  });

  it('returns $0 + warning for a missing model id', () => {
    expect(calculateDevinMessageCost(undefined, usage, pricing, silent)).toBe(0);
    expect(silent.warn).toHaveBeenCalled();
  });
});
