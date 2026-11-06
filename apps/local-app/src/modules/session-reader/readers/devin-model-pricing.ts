import { Logger } from '@nestjs/common';
import type { PricingServiceInterface } from '../services/pricing.interface';

/**
 * Devin model → `pricing.json` key mapping (USD cost parity).
 *
 * Devin's ATIF `model_name` / `extra.generation_model` uids encode the effort
 * variant IN the id (`claude-fable-5-1-xhigh`, `swe-2-max`). Stripping the
 * trailing effort/variant suffix yields the model FAMILY id, which already IS
 * the bare LiteLLM key format `pricing.json` uses (e.g. `claude-fable-5-1`).
 *
 * Devin-native families (`swe-*`) have no LiteLLM pricing — they map to a key
 * that `hasPricing` reports absent, so their cost reads $0 with a warning
 * (fail-loud, never folded into parity or invented).
 */

const logger = new Logger('DevinModelPricing');

/**
 * Trailing effort/variant suffixes Devin appends to the family uid
 * (`-none|-low|-medium|-high|-xhigh|-max|-1m`). Longest-first so `-medium` wins
 * over `-m`-style fragments; the `-1m` context-tier variant strips identically.
 */
const VARIANT_SUFFIX_RE = /-(none|medium|xhigh|high|low|max|1m)$/;

/**
 * Resolve the `pricing.json` key candidate for a Devin model uid: the family
 * id after stripping ONE trailing effort/variant suffix. The caller decides
 * whether the key is priced (`PricingService.hasPricing`) — returning the
 * family id keeps the mapping honest even for unpriced families.
 */
export function mapDevinModelToPricing(modelId?: string | null): string | null {
  if (!modelId) return null;
  const base = modelId.trim().toLowerCase();
  if (base.length === 0) return null;
  return base.replace(VARIANT_SUFFIX_RE, '') || null;
}

/** Per-message token usage for Devin cost calculation. */
export interface DevinPricingUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/**
 * Compute USD cost for a Devin agent step by mapping its model uid to a
 * `pricing.json` key and delegating to `PricingService`. An UNKNOWN model —
 * no uid, or a family the catalog does not price (Devin's own `swe-*`) — is
 * fail-loud: it logs a WARNING and returns `$0`, never silently free.
 */
/**
 * Model ids already warned about this process. The parser calls this once per
 * agent step per parse, and the watcher re-parses on every export rewrite —
 * without dedup, an unpriced `swe-*` session would log the same warning each
 * tick. Warn at most once per model id per process.
 */
const warnedModelIds = new Set<string>();

export function calculateDevinMessageCost(
  modelId: string | null | undefined,
  usage: DevinPricingUsage,
  pricingService: PricingServiceInterface,
  log: Pick<Logger, 'warn'> = logger,
): number {
  const warnOnce = (message: string): void => {
    const key = modelId ?? '';
    if (warnedModelIds.has(key)) return;
    warnedModelIds.add(key);
    log.warn(message);
  };
  const pricingKey = mapDevinModelToPricing(modelId);
  if (!pricingKey) {
    warnOnce(
      `No USD pricing mapping for Devin model "${modelId ?? ''}" — cost reported as $0 ` +
        `(not folded into parity). Extend devin-model-pricing.ts.`,
    );
    return 0;
  }
  // When the catalog can say "not priced", honor it — swe-* and other
  // Devin-native families land here and must not invent a rate.
  if (pricingService.hasPricing?.(pricingKey) === false) {
    warnOnce(
      `Devin model "${modelId}" (family "${pricingKey}") has no USD pricing — ` +
        `cost reported as $0 (not folded into parity).`,
    );
    return 0;
  }
  return pricingService.calculateMessageCost(
    pricingKey,
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheReadTokens,
    usage.cacheCreationTokens,
  );
}
