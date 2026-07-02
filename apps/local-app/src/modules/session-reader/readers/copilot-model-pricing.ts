import { Logger } from '@nestjs/common';
import type { PricingServiceInterface } from '../services/pricing.interface';

/**
 * GitHub Copilot model → `pricing.json` key mapping (USD cost parity).
 *
 * Copilot proxies third-party models (Claude / GPT / Gemini) and records the
 * underlying model id in `assistant.message.model`, `session.shutdown.modelMetrics`
 * keys, and `currentModel`. Per spike S3 (epic 02db5306, APPROVED), the observed
 * id convention is `<family>-<variant>-<version>` (captured exactly:
 * `claude-haiku-4.5`, `gpt-5-mini`) — matching the LiteLLM / `pricing.json` key
 * style. Only two families were capturable on this host (the GitHub account is
 * entitlement-limited; backlog 829f9fd9 tracks validating more), so — exactly
 * like `antigravity-model-pricing.ts` — this maps on the model FAMILY via regex
 * to an EXACT `pricing.json` key rather than enumerating every id. Extend the
 * rules as new ids are observed; all target keys are already present in
 * `data/pricing.json` (verified), so no pricing-data regeneration is required.
 *
 * `auto` is a SELECTOR, not a billable model (`session.model_change.newModel`):
 * it returns `null`. Callers must resolve `auto` to the concrete per-message
 * `assistant.message.model` before pricing.
 *
 * UNKNOWN model → `null`. Cost callers MUST treat this as fail-loud ($0 + a
 * warning) and never silently fold an unpriced model into parity or invent a
 * rate (see `calculateCopilotMessageCost`).
 */

const logger = new Logger('CopilotModelPricing');

/**
 * Family matchers, checked in order against the lower-cased model id. ORDER
 * MATTERS: more specific variants precede their base (e.g. `gpt-5-mini` before
 * `gpt-5`). Each `pricingKey` is an EXACT key present in `data/pricing.json`.
 */
const FAMILY_RULES: Array<{ test: RegExp; pricingKey: string }> = [
  // Copilot emits dot-form ids (e.g. `claude-haiku-4.5`); the Claude keys in
  // pricing.json are the DASH form (`claude-haiku-4-5`), so the map translates.
  { test: /claude.*haiku.*4[.\-]?5|haiku-4-5/, pricingKey: 'claude-haiku-4-5' },
  { test: /claude.*sonnet.*4[.\-]?5|sonnet-4-5/, pricingKey: 'claude-sonnet-4-5' },
  { test: /claude.*opus.*4[.\-]?5|opus-4-5/, pricingKey: 'claude-opus-4-5' },
  { test: /gpt-?5-?mini/, pricingKey: 'gpt-5-mini' },
  { test: /gpt-?5/, pricingKey: 'gpt-5' },
  { test: /gemini.*2[.\-]?5.*pro/, pricingKey: 'gemini-2.5-pro' },
  { test: /gemini.*2[.\-]?5.*flash/, pricingKey: 'gemini-2.5-flash' },
];

/**
 * Resolve the exact `pricing.json` key for a Copilot underlying model id, or
 * `null` when the id is empty, `auto`, or matches no known family (the caller
 * treats `null` as a fail-loud "unknown model" signal, never silently free).
 */
export function mapCopilotModelToPricing(modelId?: string | null): string | null {
  if (!modelId) return null;
  const haystack = modelId.trim().toLowerCase();
  if (haystack.length === 0 || haystack === 'auto') return null;
  for (const rule of FAMILY_RULES) {
    if (rule.test.test(haystack)) return rule.pricingKey;
  }
  return null;
}

/** Per-message token usage for Copilot cost calculation. */
export interface CopilotPricingUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/**
 * Compute USD cost for a Copilot message by mapping its underlying model id to a
 * `pricing.json` key and delegating to `PricingService`. An UNKNOWN model (no
 * family match) is fail-loud: it logs a WARNING and returns `$0` — it never
 * folds into parity or invents a rate. (Copilot's own `session.shutdown`
 * `requests.cost` AI-Credits figure is a separate native metric, not this USD map.)
 */
export function calculateCopilotMessageCost(
  modelId: string | null | undefined,
  usage: CopilotPricingUsage,
  pricingService: PricingServiceInterface,
  log: Pick<Logger, 'warn'> = logger,
): number {
  const pricingKey = mapCopilotModelToPricing(modelId);
  if (!pricingKey) {
    log.warn(
      `No USD pricing mapping for Copilot model "${modelId ?? ''}" — cost reported as $0 ` +
        `(not folded into parity). Add a family rule in copilot-model-pricing.ts.`,
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
