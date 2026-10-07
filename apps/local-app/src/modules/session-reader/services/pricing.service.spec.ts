import { PricingService } from './pricing.service';

describe('PricingService', () => {
  let service: PricingService;

  beforeAll(() => {
    service = new PricingService();
  });

  describe('getPricing', () => {
    it('should return null for unknown model', () => {
      expect(service.getPricing('nonexistent-model-xyz')).toBeNull();
    });

    it('should be case-insensitive', () => {
      // Find any model that exists in the data
      const sonnet = service.getPricing('claude-sonnet-4-5');
      expect(sonnet).not.toBeNull();
      expect(service.getPricing('CLAUDE-SONNET-4-5')).toEqual(sonnet);
    });

    it.each([
      {
        family: 'Claude',
        candidates: [
          'claude-3-5-sonnet-20241022',
          'claude-3-5-haiku-20241022',
          'claude-3-opus-20240229',
          'claude-sonnet-4-20250514',
          'claude-sonnet-4-5',
        ],
      },
      { family: 'OpenAI', candidates: ['gpt-4o', 'o3', 'o4-mini', 'gpt-4.1', 'codex-mini-latest'] },
      {
        family: 'Gemini',
        candidates: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'],
      },
    ])('finds pricing fields for the $family family', ({ candidates }) => {
      const found = candidates.map((name) => service.getPricing(name)).find(Boolean);
      expect(found).toEqual(
        expect.objectContaining({
          input_cost_per_token: expect.any(Number),
          output_cost_per_token: expect.any(Number),
        }),
      );
    });

    // LiteLLM drops retired direct-API models; pricing:update keeps them so old
    // transcripts still get a cost.
    it.each(['claude-sonnet-4-20250514', 'claude-opus-4-1', 'gpt-5.1-codex-max', 'gpt-5.2-codex'])(
      'keeps pricing for retired model %s',
      (model) => {
        expect(service.getPricing(model)).not.toBeNull();
      },
    );
  });

  describe('calculateMessageCost', () => {
    it('should return 0 for unknown model', () => {
      const cost = service.calculateMessageCost('unknown-model', 100, 50, 0, 0);
      expect(cost).toBe(0);
    });

    it('should calculate cost for a known model with tokens', () => {
      expect.hasAssertions();
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
      throw new Error('No candidate model has pricing for cost calculation');
    });

    it('should include cache read and creation costs', () => {
      expect.hasAssertions();
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
      expect.hasAssertions();
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
      expect.hasAssertions();
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
    it('should handle OpenAI models without cache_creation_input_token_cost', () => {
      expect.hasAssertions();
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

  describe('getContextWindowSize', () => {
    it('should return default 200000 for unknown model', () => {
      expect(service.getContextWindowSize('unknown-model')).toBe(200_000);
      expect(service.getCatalogContextWindowSize('unknown-model')).toBeNull();
    });

    it('should return max_input_tokens for known model', () => {
      const candidates = [
        'claude-3-5-sonnet-20241022',
        'claude-3-5-haiku-20241022',
        'claude-sonnet-4-20250514',
        'claude-sonnet-4-5',
      ];

      for (const name of candidates) {
        const pricing = service.getPricing(name);
        if (!pricing || !pricing.max_input_tokens) continue;

        const contextWindow = service.getContextWindowSize(name);
        expect(contextWindow).toBe(pricing.max_input_tokens);
        return;
      }
      throw new Error('No candidate model has max_input_tokens in pricing.json');
    });

    it.each([
      ['claude-opus-4-6', 1_000_000],
      ['claude-opus-4-6-20260205', 1_000_000],
      ['claude-sonnet-4-6', 1_000_000],
      ['claude-sonnet-4-5', 200_000],
      ['claude-sonnet-4-5-20250929', 200_000],
    ])('returns the documented direct-Claude window for %s', (model, expected) => {
      expect(service.getCatalogContextWindowSize(model)).toBe(expected);
      expect(service.getContextWindowSize(model)).toBe(expected);
    });
  });
});
