/**
 * Antigravity (`agy`) model → pricing-key mapping.
 *
 * `agy models` lists 8 selectable models by DISPLAY name; the per-conversation
 * `.db` records both a model id (protobuf field `1.19`) and the display name
 * (`1.21`, e.g. `Gemini 3.5 Flash (High)`). Two `1.19` id shapes occur across agy
 * versions: a family alias (e.g. `gemini-3-flash-a`) AND a per-variant form
 * (e.g. `gemini-3.5-flash-low|medium|high`, `gpt-oss-120b-medium`); the family rules
 * below match BOTH. The reasoning suffix `(Low|Medium|High|Thinking)` does not change
 * per-token price, so we map on the model FAMILY.
 *
 * The mapping targets EXACT keys already present in `data/pricing.json` (verified
 * — `PricingService` does an exact, case-insensitive lookup). Note `gemini-3.1-pro`
 * is keyed `gemini-3.1-pro-preview` in the data. GPT-OSS 120B is the free
 * open-weight model agy hosts at no cost; no LiteLLM key represents that free
 * hosting, so it is mapped as `isFree` (cost $0) rather than to a paid vendor key.
 *
 * Keep this table in sync with P1-7 (Models: display-name↔id mapping).
 */

/** GPT-OSS 120B context window (tokens) — used for the free model's window. */
const GPT_OSS_CONTEXT_WINDOW = 131_072;

export interface AgyPricingMapping {
  /** Exact `pricing.json` key, or `null` for the free model. */
  pricingKey: string | null;
  /** Whether agy runs this model at no cost (open-weight). */
  isFree: boolean;
  /** Context window override when the model is free (else read from pricing). */
  freeContextWindow?: number;
}

/** Family matchers, checked in order against the normalized display/id. */
const FAMILY_RULES: Array<{ test: RegExp; mapping: AgyPricingMapping }> = [
  {
    test: /gemini.*3\.5.*flash|gemini-3-flash/,
    mapping: { pricingKey: 'gemini-3.5-flash', isFree: false },
  },
  {
    test: /gemini.*3\.1.*pro|gemini-3-pro/,
    mapping: { pricingKey: 'gemini-3.1-pro-preview', isFree: false },
  },
  {
    test: /claude.*sonnet.*4\.6|sonnet-4-6/,
    mapping: { pricingKey: 'claude-sonnet-4-6', isFree: false },
  },
  {
    test: /claude.*opus.*4\.6|opus-4-6/,
    mapping: { pricingKey: 'claude-opus-4-6', isFree: false },
  },
  {
    test: /gpt-?oss.*120b/,
    mapping: { pricingKey: null, isFree: true, freeContextWindow: GPT_OSS_CONTEXT_WINDOW },
  },
];

/**
 * Resolve a pricing mapping from an agy model display name and/or id. Returns
 * `null` when neither matches a known family (caller treats this as a fail-loud
 * "unknown model" signal rather than silently free).
 */
export function mapAgyModelToPricing(
  displayName?: string,
  modelId?: string,
): AgyPricingMapping | null {
  const haystack = `${displayName ?? ''} ${modelId ?? ''}`.toLowerCase();
  for (const rule of FAMILY_RULES) {
    if (rule.test.test(haystack)) return rule.mapping;
  }
  return null;
}
