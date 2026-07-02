import { mapAgyModelToPricing } from './antigravity-model-pricing';

describe('mapAgyModelToPricing', () => {
  // The 8 `agy models` display names → expected pricing key (or free).
  it.each([
    ['Gemini 3.5 Flash (Medium)', 'gemini-3.5-flash'],
    ['Gemini 3.5 Flash (High)', 'gemini-3.5-flash'],
    ['Gemini 3.5 Flash (Low)', 'gemini-3.5-flash'],
    ['Gemini 3.1 Pro (Low)', 'gemini-3.1-pro-preview'],
    ['Gemini 3.1 Pro (High)', 'gemini-3.1-pro-preview'],
    ['Claude Sonnet 4.6 (Thinking)', 'claude-sonnet-4-6'],
    ['Claude Opus 4.6 (Thinking)', 'claude-opus-4-6'],
  ])('maps display name "%s" → %s', (display, key) => {
    const m = mapAgyModelToPricing(display);
    expect(m).not.toBeNull();
    expect(m!.isFree).toBe(false);
    expect(m!.pricingKey).toBe(key);
  });

  it('maps GPT-OSS 120B to the free open-weight model ($0, 131072 window)', () => {
    const m = mapAgyModelToPricing('GPT-OSS 120B (Medium)', 'gpt-oss-120b-medium');
    expect(m).not.toBeNull();
    expect(m!.isFree).toBe(true);
    expect(m!.pricingKey).toBeNull();
    expect(m!.freeContextWindow).toBe(131_072);
  });

  it('maps by model id when display name is absent', () => {
    expect(mapAgyModelToPricing(undefined, 'gemini-3-flash-a')?.pricingKey).toBe(
      'gemini-3.5-flash',
    );
  });

  it('does NOT use the bare gemini-3.1-pro key (data only has the -preview variant)', () => {
    expect(mapAgyModelToPricing('Gemini 3.1 Pro (High)')?.pricingKey).toBe(
      'gemini-3.1-pro-preview',
    );
  });

  it('returns null for an unknown model (fail-loud, not silently free)', () => {
    expect(mapAgyModelToPricing('Some Future Model X')).toBeNull();
    expect(mapAgyModelToPricing(undefined, undefined)).toBeNull();
  });

  // Per-INTERNAL-id forms (cost-correctness lock). agy records two `1.19` id shapes in the
  // `.db` across versions: a family alias (`gemini-3-flash-a`) AND a per-variant form
  // (`gemini-3.5-flash-low|medium|high`, `gpt-oss-120b-medium`). The metrics reader hands
  // the decoded id to mapAgyModelToPricing(undefined, modelId); lock BOTH so cost never
  // silently misses on a version that emits either shape.
  it.each<[modelId: string, expectedKey: string | null, free: boolean]>([
    ['gemini-3-flash-a', 'gemini-3.5-flash', false],
    ['gemini-3.5-flash-low', 'gemini-3.5-flash', false],
    ['gemini-3.5-flash-medium', 'gemini-3.5-flash', false],
    ['gemini-3.5-flash-high', 'gemini-3.5-flash', false],
    ['gemini-3.1-pro-low', 'gemini-3.1-pro-preview', false],
    ['gemini-3.1-pro-high', 'gemini-3.1-pro-preview', false],
    ['claude-sonnet-4-6', 'claude-sonnet-4-6', false],
    ['claude-opus-4-6', 'claude-opus-4-6', false],
    ['gpt-oss-120b-medium', null, true],
  ])('locks internal id "%s" → %s (free=%s)', (modelId, expectedKey, free) => {
    const m = mapAgyModelToPricing(undefined, modelId);
    expect(m).not.toBeNull();
    expect(m!.isFree).toBe(free);
    expect(m!.pricingKey).toBe(expectedKey);
  });
});
