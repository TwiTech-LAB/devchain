import {
  mapCopilotModelToPricing,
  calculateCopilotMessageCost,
  type CopilotPricingUsage,
} from './copilot-model-pricing';
import { PricingService } from '../services/pricing.service';
import type { PricingServiceInterface } from '../services/pricing.interface';

describe('mapCopilotModelToPricing', () => {
  it.each([
    // [copilot model id (dot-form), expected pricing.json key (claude = dash-form)]
    ['claude-haiku-4.5', 'claude-haiku-4-5'],
    ['claude-haiku-4-5', 'claude-haiku-4-5'],
    ['claude-sonnet-4.5', 'claude-sonnet-4-5'],
    ['claude-sonnet-4-5', 'claude-sonnet-4-5'],
    ['claude-opus-4.5', 'claude-opus-4-5'],
    ['gpt-5-mini', 'gpt-5-mini'],
    ['gpt5mini', 'gpt-5-mini'],
    ['gpt-5', 'gpt-5'],
    ['gemini-2.5-pro', 'gemini-2.5-pro'],
    ['gemini-2.5-flash', 'gemini-2.5-flash'],
  ])('maps %s → %s', (modelId, expected) => {
    expect(mapCopilotModelToPricing(modelId)).toBe(expected);
  });

  it('is case-insensitive', () => {
    expect(mapCopilotModelToPricing('Claude-Haiku-4.5')).toBe('claude-haiku-4-5');
    expect(mapCopilotModelToPricing('GPT-5-MINI')).toBe('gpt-5-mini');
  });

  it('maps gpt-5-mini to the mini key, NOT the gpt-5 base key (rule order)', () => {
    expect(mapCopilotModelToPricing('gpt-5-mini')).toBe('gpt-5-mini');
    expect(mapCopilotModelToPricing('gpt-5-mini')).not.toBe('gpt-5');
  });

  it('returns null for the `auto` selector (not a billable model)', () => {
    expect(mapCopilotModelToPricing('auto')).toBeNull();
    expect(mapCopilotModelToPricing('AUTO')).toBeNull();
  });

  it('returns null for empty / undefined / null', () => {
    expect(mapCopilotModelToPricing(undefined)).toBeNull();
    expect(mapCopilotModelToPricing(null)).toBeNull();
    expect(mapCopilotModelToPricing('')).toBeNull();
    expect(mapCopilotModelToPricing('   ')).toBeNull();
  });

  it('returns null for an unknown model family', () => {
    expect(mapCopilotModelToPricing('llama-3-70b')).toBeNull();
    expect(mapCopilotModelToPricing('mistral-large')).toBeNull();
  });
});

describe('calculateCopilotMessageCost', () => {
  const usage: CopilotPricingUsage = {
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 200,
    cacheCreationTokens: 100,
  };

  it('delegates to PricingService with the mapped key and token buckets', () => {
    const mock: PricingServiceInterface = {
      calculateMessageCost: jest.fn().mockReturnValue(0.0042),
      getContextWindowSize: jest.fn().mockReturnValue(200_000),
    };

    const cost = calculateCopilotMessageCost('claude-haiku-4.5', usage, mock);

    expect(cost).toBe(0.0042);
    // copilot's dot-form id is translated to the dash-form pricing.json key.
    expect(mock.calculateMessageCost).toHaveBeenCalledWith('claude-haiku-4-5', 1000, 500, 200, 100);
  });

  it('UNKNOWN model → loud warning + $0 (never folded into parity)', () => {
    const mock: PricingServiceInterface = {
      calculateMessageCost: jest.fn().mockReturnValue(99),
      getContextWindowSize: jest.fn(),
    };
    const warn = jest.fn();

    const cost = calculateCopilotMessageCost('llama-3-70b', usage, mock, { warn });

    expect(cost).toBe(0);
    expect(mock.calculateMessageCost).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('llama-3-70b'));
  });

  it('`auto` → loud warning + $0 (caller must resolve to the concrete model first)', () => {
    const mock: PricingServiceInterface = {
      calculateMessageCost: jest.fn(),
      getContextWindowSize: jest.fn(),
    };
    const warn = jest.fn();

    expect(calculateCopilotMessageCost('auto', usage, mock, { warn })).toBe(0);
    expect(warn).toHaveBeenCalled();
  });

  // Guards against pricing.json drift: every mapped family key MUST resolve to a
  // real entry in the bundled pricing data (else cost would silently be $0).
  describe('mapped keys exist in the real PricingService (no silent $0)', () => {
    const pricing = new PricingService();

    it.each([
      'claude-haiku-4.5',
      'claude-sonnet-4.5',
      'claude-opus-4.5',
      'gpt-5-mini',
      'gpt-5',
      'gemini-2.5-pro',
      'gemini-2.5-flash',
    ])('produces a non-zero USD cost for copilot model %s', (modelId) => {
      const cost = calculateCopilotMessageCost(modelId, usage, pricing);
      expect(cost).toBeGreaterThan(0);
    });
  });
});
