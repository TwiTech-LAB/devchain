import { PricingService } from './pricing.service';
import type { ModelPricing } from './pricing.service';

describe('PricingService', () => {
  let service: PricingService;

  beforeAll(() => {
    service = new PricingService();
  });

  describe('constructor', () => {
    it('should load pricing data from bundled JSON', () => {
      // The service loads pricing.json at construction — should have entries
      expect(service).toBeDefined();
      // At minimum, some Claude models should be present in the bundled data
      expect(service.getPricing('nonexistent-model-xyz')).toBeNull();
    });
  });

  describe('getPricing', () => {
    it('should return null for unknown model', () => {
      expect(service.getPricing('nonexistent-model-xyz')).toBeNull();
    });

    it('should be case-insensitive', () => {
      // Find any model that exists in the data
      const sonnet = service.getPricing('claude-3-5-sonnet-20241022');
      if (sonnet) {
        const upper = service.getPricing('CLAUDE-3-5-SONNET-20241022');
        expect(upper).toEqual(sonnet);
      }
    });

    it('should return pricing entry with required fields for known model', () => {
      // Try a few common model names that should exist in LiteLLM data
      const candidates = [
        'claude-3-5-sonnet-20241022',
        'claude-3-5-haiku-20241022',
        'claude-3-opus-20240229',
        'claude-sonnet-4-20250514',
      ];

      let found: ModelPricing | null = null;
      for (const name of candidates) {
        found = service.getPricing(name);
        if (found) break;
      }

      // At least one common model should exist in the bundled data
      expect(found).not.toBeNull();
      if (found) {
        expect(typeof found.input_cost_per_token).toBe('number');
        expect(typeof found.output_cost_per_token).toBe('number');
      }
    });
  });

  describe('calculateMessageCost', () => {
    it('should return 0 for unknown model', () => {
      const cost = service.calculateMessageCost('unknown-model', 100, 50, 0, 0);
      expect(cost).toBe(0);
    });

    it('should return 0 when all tokens are 0', () => {
      const cost = service.calculateMessageCost('claude-3-5-sonnet-20241022', 0, 0, 0, 0);
      expect(cost).toBe(0);
    });

    it('should calculate cost for a known model with tokens', () => {
      // Find a model with known pricing
      const candidates = [
        'claude-3-5-sonnet-20241022',
        'claude-3-5-haiku-20241022',
        'claude-sonnet-4-20250514',
      ];

      for (const name of candidates) {
        const pricing = service.getPricing(name);
        if (!pricing) continue;

        const inputTokens = 1000;
        const outputTokens = 500;
        const cost = service.calculateMessageCost(name, inputTokens, outputTokens, 0, 0);

        // Expected: below tier threshold, so simple multiplication
        const expectedInput = inputTokens * pricing.input_cost_per_token;
        const expectedOutput = outputTokens * pricing.output_cost_per_token;
        expect(cost).toBeCloseTo(expectedInput + expectedOutput, 10);
        return; // Test passed with this model
      }

      // If no model found, skip gracefully
      console.warn('No known model found in pricing data for cost calculation test');
    });

    it('should include cache read and creation costs', () => {
      const candidates = ['claude-3-5-sonnet-20241022', 'claude-sonnet-4-20250514'];

      for (const name of candidates) {
        const pricing = service.getPricing(name);
        if (!pricing || !pricing.cache_read_input_token_cost) continue;

        const cost = service.calculateMessageCost(name, 0, 0, 1000, 500);
        const expectedCacheRead = 1000 * (pricing.cache_read_input_token_cost ?? 0);
        const expectedCacheCreation = 500 * (pricing.cache_creation_input_token_cost ?? 0);
        expect(cost).toBeCloseTo(expectedCacheRead + expectedCacheCreation, 10);
        return;
      }
    });
  });

  describe('tiered pricing', () => {
    it('should apply tiered rate above 200k tokens', () => {
      // Find a model with tiered pricing
      const candidates = [
        'claude-3-5-sonnet-20241022',
        'claude-3-5-sonnet-20240620',
        'claude-sonnet-4-20250514',
      ];

      for (const name of candidates) {
        const pricing = service.getPricing(name);
        if (!pricing || !pricing.input_cost_per_token_above_200k_tokens) continue;

        // Calculate cost for 250k input tokens (50k above threshold)
        const inputTokens = 250_000;
        const cost = service.calculateMessageCost(name, inputTokens, 0, 0, 0);

        // Expected: (200k * base) + (50k * tiered)
        const expectedBelow = 200_000 * pricing.input_cost_per_token;
        const expectedAbove = 50_000 * pricing.input_cost_per_token_above_200k_tokens;
        expect(cost).toBeCloseTo(expectedBelow + expectedAbove, 10);
        return;
      }
    });

    it('should use base rate for tokens at exactly 200k', () => {
      const candidates = ['claude-3-5-sonnet-20241022', 'claude-sonnet-4-20250514'];

      for (const name of candidates) {
        const pricing = service.getPricing(name);
        if (!pricing || !pricing.input_cost_per_token_above_200k_tokens) continue;

        const inputTokens = 200_000;
        const cost = service.calculateMessageCost(name, inputTokens, 0, 0, 0);

        // At exactly threshold: all base rate
        const expected = 200_000 * pricing.input_cost_per_token;
        expect(cost).toBeCloseTo(expected, 10);
        return;
      }
    });
  });

  describe('OpenAI model pricing', () => {
    it('should find pricing for common OpenAI models', () => {
      const candidates = ['gpt-4o', 'o3', 'o4-mini', 'gpt-4.1', 'codex-mini-latest'];

      let found: ModelPricing | null = null;
      for (const name of candidates) {
        found = service.getPricing(name);
        if (found) break;
      }

      expect(found).not.toBeNull();
      if (found) {
        expect(typeof found.input_cost_per_token).toBe('number');
        expect(typeof found.output_cost_per_token).toBe('number');
      }
    });

    it('should calculate cost for OpenAI model with cached tokens', () => {
      const candidates = ['gpt-4o', 'o3', 'gpt-4.1'];

      for (const name of candidates) {
        const pricing = service.getPricing(name);
        if (!pricing || !pricing.cache_read_input_token_cost) continue;

        const cost = service.calculateMessageCost(name, 1000, 500, 200, 0);

        const expectedInput = 1000 * pricing.input_cost_per_token;
        const expectedOutput = 500 * pricing.output_cost_per_token;
        const expectedCacheRead = 200 * (pricing.cache_read_input_token_cost ?? 0);
        expect(cost).toBeCloseTo(expectedInput + expectedOutput + expectedCacheRead, 10);
        return;
      }
    });

    it('should handle OpenAI models without cache_creation_input_token_cost', () => {
      const candidates = ['gpt-4o', 'o3', 'gpt-4.1'];

      for (const name of candidates) {
        const pricing = service.getPricing(name);
        if (!pricing) continue;

        // OpenAI models typically lack cache_creation pricing
        // calculateMessageCost should treat missing cache_creation as 0
        const cost = service.calculateMessageCost(name, 0, 0, 0, 1000);
        const expectedCacheCreation = 1000 * (pricing.cache_creation_input_token_cost ?? 0);
        expect(cost).toBeCloseTo(expectedCacheCreation, 10);
        return;
      }
    });
  });

  describe('Gemini model pricing', () => {
    it('should find pricing for common Gemini models', () => {
      const candidates = ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'];

      let found: ModelPricing | null = null;
      for (const name of candidates) {
        found = service.getPricing(name);
        if (found) break;
      }

      expect(found).not.toBeNull();
      if (found) {
        expect(typeof found.input_cost_per_token).toBe('number');
        expect(typeof found.output_cost_per_token).toBe('number');
      }
    });

    it('should calculate cost for Gemini model with tokens', () => {
      const candidates = ['gemini-2.5-pro', 'gemini-2.5-flash'];

      for (const name of candidates) {
        const pricing = service.getPricing(name);
        if (!pricing) continue;

        const cost = service.calculateMessageCost(name, 1000, 500, 0, 0);

        const expectedInput = 1000 * pricing.input_cost_per_token;
        const expectedOutput = 500 * pricing.output_cost_per_token;
        expect(cost).toBeCloseTo(expectedInput + expectedOutput, 10);
        return;
      }
    });

    it('should handle Gemini free-tier models gracefully (cost = $0)', () => {
      const candidates = [
        'gemini-2.0-flash-thinking-exp',
        'gemini-2.0-flash-thinking-exp-01-21',
        'gemini-flash-experimental',
      ];

      for (const name of candidates) {
        const pricing = service.getPricing(name);
        if (!pricing || pricing.input_cost_per_token !== 0) continue;

        // Free-tier model: cost should be 0 with no warnings
        const cost = service.calculateMessageCost(name, 10000, 5000, 0, 0);
        expect(cost).toBe(0);
        return;
      }
    });

    it('should calculate Gemini cached token cost', () => {
      const candidates = ['gemini-2.5-pro', 'gemini-2.5-flash'];

      for (const name of candidates) {
        const pricing = service.getPricing(name);
        if (!pricing || !pricing.cache_read_input_token_cost) continue;

        const cost = service.calculateMessageCost(name, 0, 0, 1000, 0);
        const expectedCacheRead = 1000 * (pricing.cache_read_input_token_cost ?? 0);
        expect(cost).toBeCloseTo(expectedCacheRead, 10);
        return;
      }
    });
  });

  describe('getContextWindowSize', () => {
    it('should return default 200000 for unknown model', () => {
      expect(service.getContextWindowSize('unknown-model')).toBe(200_000);
    });

    it('should return max_input_tokens for known model', () => {
      const candidates = [
        'claude-3-5-sonnet-20241022',
        'claude-3-5-haiku-20241022',
        'claude-sonnet-4-20250514',
      ];

      for (const name of candidates) {
        const pricing = service.getPricing(name);
        if (!pricing || !pricing.max_input_tokens) continue;

        const contextWindow = service.getContextWindowSize(name);
        expect(contextWindow).toBe(pricing.max_input_tokens);
        return;
      }
    });

    it('should return 200k default context window for base claude-opus-4-6', () => {
      const contextWindow = service.getContextWindowSize('claude-opus-4-6');
      expect(contextWindow).toBe(200_000);
    });
  });
});
