import { Injectable, Logger } from '@nestjs/common';
import type { PricingServiceInterface } from './pricing.interface';

// Import bundled pricing data (generated at build time by scripts/fetch-pricing-data.ts)
import * as pricingData from '../data/pricing.json';

const logger = new Logger('PricingService');

/** Tiered pricing threshold in tokens (same as claude-devtools) */
const TIER_THRESHOLD = 200_000;

/** Default context window when model not found */
const DEFAULT_CONTEXT_WINDOW = 200_000;

/** Fields from LiteLLM pricing entry */
export interface ModelPricing {
  input_cost_per_token: number;
  output_cost_per_token: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
  input_cost_per_token_above_200k_tokens?: number;
  output_cost_per_token_above_200k_tokens?: number;
  cache_read_input_token_cost_above_200k_tokens?: number;
  cache_creation_input_token_cost_above_200k_tokens?: number;
  max_input_tokens?: number;
  max_output_tokens?: number;
}

/**
 * Calculate cost with optional two-tier pricing at 200k token threshold.
 */
function calculateTieredCost(tokens: number, baseRate: number, tieredRate?: number): number {
  if (tokens <= 0) return 0;
  if (tieredRate == null || tokens <= TIER_THRESHOLD) {
    return tokens * baseRate;
  }
  const costBelow = TIER_THRESHOLD * baseRate;
  const costAbove = (tokens - TIER_THRESHOLD) * tieredRate;
  return costBelow + costAbove;
}

/**
 * PricingService — loads bundled LiteLLM pricing data at construction time
 * and provides O(1) per-model cost calculation.
 *
 * Pricing data is fetched at build time by scripts/fetch-pricing-data.ts
 * and committed as data/pricing.json.
 */
@Injectable()
export class PricingService implements PricingServiceInterface {
  private readonly pricingMap: Map<string, ModelPricing>;

  constructor() {
    this.pricingMap = new Map();
    const data = pricingData as Record<string, unknown>;

    for (const [key, entry] of Object.entries(data)) {
      if (this.isValidPricing(entry)) {
        this.pricingMap.set(key.toLowerCase(), entry as ModelPricing);
      }
    }

    logger.log(`Loaded pricing data for ${this.pricingMap.size} models`);
  }

  /**
   * Look up pricing for a model (case-insensitive, O(1)).
   * Returns null if model not found.
   */
  getPricing(modelName: string): ModelPricing | null {
    return this.pricingMap.get(modelName.toLowerCase()) ?? null;
  }

  /**
   * Calculate cost for a single message using tiered pricing at 200k boundary.
   */
  calculateMessageCost(
    modelName: string,
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens: number,
    cacheCreationTokens: number,
  ): number {
    const pricing = this.getPricing(modelName);
    if (!pricing) {
      const hasTokens =
        inputTokens > 0 || outputTokens > 0 || cacheReadTokens > 0 || cacheCreationTokens > 0;
      if (hasTokens) {
        logger.warn(`No pricing data for model "${modelName}", cost will be $0`);
      }
      return 0;
    }

    const inputCost = calculateTieredCost(
      inputTokens,
      pricing.input_cost_per_token,
      pricing.input_cost_per_token_above_200k_tokens,
    );

    const outputCost = calculateTieredCost(
      outputTokens,
      pricing.output_cost_per_token,
      pricing.output_cost_per_token_above_200k_tokens,
    );

    const cacheReadCost = calculateTieredCost(
      cacheReadTokens,
      pricing.cache_read_input_token_cost ?? 0,
      pricing.cache_read_input_token_cost_above_200k_tokens,
    );

    const cacheCreationCost = calculateTieredCost(
      cacheCreationTokens,
      pricing.cache_creation_input_token_cost ?? 0,
      pricing.cache_creation_input_token_cost_above_200k_tokens,
    );

    return inputCost + outputCost + cacheReadCost + cacheCreationCost;
  }

  /**
   * Get model's context window size.
   * Returns max_input_tokens from pricing data, or 200_000 as fallback.
   */
  getContextWindowSize(modelName: string): number {
    const pricing = this.getPricing(modelName);
    return pricing?.max_input_tokens ?? DEFAULT_CONTEXT_WINDOW;
  }

  private isValidPricing(entry: unknown): boolean {
    if (!entry || typeof entry !== 'object') return false;
    const e = entry as Record<string, unknown>;
    return (
      typeof e.input_cost_per_token === 'number' && typeof e.output_cost_per_token === 'number'
    );
  }
}
