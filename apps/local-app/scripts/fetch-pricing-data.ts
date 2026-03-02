/**
 * Build-time script: Fetch model pricing from LiteLLM and bundle as static JSON.
 *
 * Fetches https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json
 * Filters to Claude, OpenAI, and Gemini models, validates entries, writes to session-reader/data/pricing.json.
 *
 * On failure: logs warning, keeps existing pricing.json — build continues.
 * Usage: ts-node scripts/fetch-pricing-data.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const LITELLM_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

const OUTPUT_PATH = path.join(
  __dirname,
  '..',
  'src',
  'modules',
  'session-reader',
  'data',
  'pricing.json',
);

const FETCH_TIMEOUT_MS = 10_000;

interface LiteLLMEntry {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
  input_cost_per_token_above_200k_tokens?: number;
  output_cost_per_token_above_200k_tokens?: number;
  cache_read_input_token_cost_above_200k_tokens?: number;
  cache_creation_input_token_cost_above_200k_tokens?: number;
  max_input_tokens?: number;
  max_output_tokens?: number;
  max_tokens?: number;
  litellm_provider?: string;
  mode?: string;
}

function isClaudeModel(name: string): boolean {
  return name.toLowerCase().includes('claude');
}

function isOpenAIModel(name: string): boolean {
  const lower = name.toLowerCase();
  return /(?:^|\/)(?:gpt|o[134]-|o[134]$|chatgpt|codex)/.test(lower) || lower.includes('openai/');
}

function isGeminiModel(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.includes('gemini') || lower.includes('google/');
}

function isSupportedModel(name: string): boolean {
  return isClaudeModel(name) || isOpenAIModel(name) || isGeminiModel(name);
}

/**
 * Pattern-based context window overrides for models where LiteLLM reports the
 * API-level maximum (e.g. 1M) instead of the default context window (200k).
 *
 * Each pattern matches the base model name (e.g. "claude-opus-4-6") and also
 * matches dated variants (e.g. "claude-opus-4-6-20260205") automatically.
 * A synthetic "[1m]" variant is created for each patched entry so users of the
 * extended-context mode get the correct value.
 */
const CONTEXT_WINDOW_OVERRIDE_PATTERNS: { pattern: RegExp; defaultWindow: number }[] = [
  { pattern: /^claude-opus-4-6(-\d{8})?$/, defaultWindow: 200_000 },
];

/**
 * Apply context window overrides and create extended-context variant entries.
 * E.g. "claude-opus-4-6" gets patched to 200k and "claude-opus-4-6[1m]" is
 * created with the original 1M value.
 */
function applyContextWindowOverrides(models: Record<string, LiteLLMEntry>): void {
  for (const key of Object.keys(models)) {
    const rule = CONTEXT_WINDOW_OVERRIDE_PATTERNS.find((r) => r.pattern.test(key));
    if (!rule) continue;

    const entry = models[key];
    if (!entry || entry.max_input_tokens == null) continue;

    const originalWindow = entry.max_input_tokens;
    if (originalWindow <= rule.defaultWindow) continue;

    // Create extended-context variant with original value
    const extendedKey = `${key}[1m]`;
    if (!models[extendedKey]) {
      models[extendedKey] = { ...entry, max_input_tokens: originalWindow };
    }

    // Patch base model to default context window
    entry.max_input_tokens = rule.defaultWindow;
  }
}

function isValidPricing(entry: unknown): entry is LiteLLMEntry {
  if (!entry || typeof entry !== 'object') return false;
  const e = entry as Record<string, unknown>;
  return (
    typeof e.input_cost_per_token === 'number' &&
    typeof e.output_cost_per_token === 'number'
  );
}

async function main(): Promise<void> {
  console.log('[fetch-pricing] Fetching LiteLLM pricing data...');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(LITELLM_URL, { signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const rawData = (await response.json()) as Record<string, unknown>;

    // Filter and validate
    const filtered: Record<string, LiteLLMEntry> = {};
    let total = 0;
    let accepted = 0;

    for (const [key, entry] of Object.entries(rawData)) {
      total++;
      if (!isSupportedModel(key)) continue;
      if (!isValidPricing(entry)) continue;

      // Keep only pricing-relevant fields
      const valid = entry as LiteLLMEntry;
      filtered[key] = {
        input_cost_per_token: valid.input_cost_per_token,
        output_cost_per_token: valid.output_cost_per_token,
        ...(valid.cache_read_input_token_cost != null && {
          cache_read_input_token_cost: valid.cache_read_input_token_cost,
        }),
        ...(valid.cache_creation_input_token_cost != null && {
          cache_creation_input_token_cost: valid.cache_creation_input_token_cost,
        }),
        ...(valid.input_cost_per_token_above_200k_tokens != null && {
          input_cost_per_token_above_200k_tokens: valid.input_cost_per_token_above_200k_tokens,
        }),
        ...(valid.output_cost_per_token_above_200k_tokens != null && {
          output_cost_per_token_above_200k_tokens: valid.output_cost_per_token_above_200k_tokens,
        }),
        ...(valid.cache_read_input_token_cost_above_200k_tokens != null && {
          cache_read_input_token_cost_above_200k_tokens:
            valid.cache_read_input_token_cost_above_200k_tokens,
        }),
        ...(valid.cache_creation_input_token_cost_above_200k_tokens != null && {
          cache_creation_input_token_cost_above_200k_tokens:
            valid.cache_creation_input_token_cost_above_200k_tokens,
        }),
        ...(valid.max_input_tokens != null && { max_input_tokens: valid.max_input_tokens }),
        ...(valid.max_output_tokens != null && { max_output_tokens: valid.max_output_tokens }),
      };
      accepted++;
    }

    // Apply context window overrides (e.g. claude-opus-4-6: 1M → 200k default)
    applyContextWindowOverrides(filtered);

    // Ensure output directory exists
    const outputDir = path.dirname(OUTPUT_PATH);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(filtered, null, 2) + '\n', 'utf8');
    console.log(
      `[fetch-pricing] Done: ${accepted} models (Claude/OpenAI/Gemini) from ${total} total entries → ${OUTPUT_PATH}`,
    );
  } catch (error) {
    clearTimeout(timeout);
    const message = error instanceof Error ? error.message : String(error);

    if (message.includes('abort')) {
      console.warn(`[fetch-pricing] Fetch timed out after ${FETCH_TIMEOUT_MS}ms`);
    } else {
      console.warn(`[fetch-pricing] Fetch failed: ${message}`);
    }

    if (fs.existsSync(OUTPUT_PATH)) {
      console.warn('[fetch-pricing] Keeping existing pricing.json — build continues');
    } else {
      console.warn('[fetch-pricing] No existing pricing.json — writing empty fallback');
      const outputDir = path.dirname(OUTPUT_PATH);
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }
      fs.writeFileSync(OUTPUT_PATH, '{}\n', 'utf8');
    }
  }
}

main().catch((err) => {
  console.error('[fetch-pricing] Unexpected error:', err);
  process.exit(0); // Exit 0 so build continues
});
