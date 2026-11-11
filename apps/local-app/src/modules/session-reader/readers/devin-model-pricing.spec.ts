import {
  mapDevinModelToPricing,
  calculateDevinMessageCost,
  resolveDevinPricingKey,
} from './devin-model-pricing';
import type { PricingServiceInterface } from '../services/pricing.interface';
import { PricingService } from '../services/pricing.service';

const silent = { warn: jest.fn() };
const pricing: PricingServiceInterface = {
  calculateMessageCost: jest.fn().mockReturnValue(0.42),
  getCatalogContextWindowSize: jest.fn().mockReturnValue(null),
  getContextWindowSize: jest.fn().mockReturnValue(200_000),
  hasPricing: jest.fn((m: string) => m === 'claude-fable-5-1'),
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

// Real bundled catalog: guards the hand-added swe-* entries in pricing.json.
describe('Devin models against the bundled pricing.json', () => {
  const catalog = new PricingService();
  const steps = {
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 500,
    cacheCreationTokens: 0,
  };

  it('prices a swe-1-6 step at the Devin list price', () => {
    const warn = jest.fn();
    expect(calculateDevinMessageCost('swe-1-6', steps, catalog, { warn })).toBeCloseTo(
      1000 * 5e-7 + 500 * 2e-7 + 200 * 2.5e-6,
      12,
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('prices swe-2-flash-medium at $0 without a warning, with Devin context size', () => {
    const warn = jest.fn();
    expect(calculateDevinMessageCost('swe-2-flash-medium', steps, catalog, { warn })).toBe(0);
    expect(warn).not.toHaveBeenCalled();
    expect(resolveDevinPricingKey('swe-2-flash-medium', catalog)).toBe('swe-2-flash-medium');
    expect(catalog.getContextWindowSize('swe-2-flash-medium')).toBe(262_144);
  });

  it('keeps swe-2-high at $0 with one warning per process', () => {
    const warn = jest.fn();
    expect(calculateDevinMessageCost('swe-2-high', steps, catalog, { warn })).toBe(0);
    expect(calculateDevinMessageCost('swe-2-high', steps, catalog, { warn })).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does not price swe-2-flash-high as swe-2-flash-medium', () => {
    const warn = jest.fn();
    expect(resolveDevinPricingKey('swe-2-flash-high', catalog)).toBe('swe-2-flash');
    expect(catalog.hasPricing('swe-2-flash')).toBe(false);
    expect(calculateDevinMessageCost('swe-2-flash-high', steps, catalog, { warn })).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['claude-fable-5-1-xhigh', 'claude-fable-5-1'],
    ['SWE-1-7-Medium', 'swe-1-7-medium'],
  ])('resolves %s to %s', (uid, key) => {
    expect(resolveDevinPricingKey(uid, catalog)).toBe(key);
  });
});
