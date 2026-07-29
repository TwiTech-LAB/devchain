import { Injectable } from '@nestjs/common';

export const PRICING_SERVICE = 'PRICING_SERVICE';

/**
 * Interface for session cost calculation and context window lookup.
 * Concrete implementation provided by PricingService (P1·Task:10).
 */
export interface PricingServiceInterface {
  calculateMessageCost(
    model: string,
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens: number,
    cacheCreationTokens: number,
  ): number;
  getCatalogContextWindowSize(model: string): number | null;
  getContextWindowSize(model: string): number;
}

/**
 * Stub implementation used until PricingService (Task:10) is available.
 * Returns $0 cost and 200k default context window.
 */
@Injectable()
export class StubPricingService implements PricingServiceInterface {
  calculateMessageCost(): number {
    return 0;
  }
  getContextWindowSize(): number {
    return 200_000;
  }
  getCatalogContextWindowSize(): number | null {
    return null;
  }
}
