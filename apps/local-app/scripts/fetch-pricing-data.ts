/**
 * Maintainer script: Refresh the committed model-pricing snapshot from LiteLLM.
 *
 * Fetches https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json
 * Filters to Claude, OpenAI, and Gemini models, validates entries, writes to session-reader/data/pricing.json.
 *
 * Entries already in pricing.json that LiteLLM no longer lists are kept: LiteLLM drops
 * retired direct-API models, and old transcripts still need their prices. Upstream
 * values win for models LiteLLM still lists. CONTEXT_WINDOW_OVERRIDES apply last.
 *
 * On failure: logs a warning and keeps the existing pricing.json when present.
 * Usage: pnpm --filter local-app pricing:update
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

/**
 * Documented default windows where LiteLLM records the opt-in extended-context maximum.
 * Sonnet 4.5 reaches 1M only with a beta header; without one, the API window is 200K.
 */
const CONTEXT_WINDOW_OVERRIDES: Record<string, number> = {
  'claude-sonnet-4-5': 200_000,
  'claude-sonnet-4-5-20250929': 200_000,
};

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

function isValidPricing(entry: unknown): entry is LiteLLMEntry {
  if (!entry || typeof entry !== 'object') return false;
  const e = entry as Record<string, unknown>;
  return typeof e.input_cost_per_token === 'number' && typeof e.output_cost_per_token === 'number';
}

function readExistingSnapshot(): Record<string, LiteLLMEntry> {
  if (!fs.existsSync(OUTPUT_PATH)) return {};
  const data = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8')) as Record<string, unknown>;
  const existing: Record<string, LiteLLMEntry> = {};
  for (const [key, entry] of Object.entries(data)) {
    if (isValidPricing(entry)) existing[key] = entry;
  }
  return existing;
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

    let retained = 0;
    for (const [key, entry] of Object.entries(readExistingSnapshot())) {
      if (key in filtered) continue;
      filtered[key] = entry;
      retained++;
    }

    for (const [key, maxInputTokens] of Object.entries(CONTEXT_WINDOW_OVERRIDES)) {
      if (filtered[key]) filtered[key].max_input_tokens = maxInputTokens;
    }

    // Ensure output directory exists
    const outputDir = path.dirname(OUTPUT_PATH);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(filtered, null, 2) + '\n', 'utf8');
    console.log(
      `[fetch-pricing] Done: ${accepted} models (Claude/OpenAI/Gemini) from ${total} total entries, ${retained} retired models kept → ${OUTPUT_PATH}`,
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
      console.warn('[fetch-pricing] Keeping existing pricing.json — refresh not applied');
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
  process.exit(0); // Preserve the existing non-blocking refresh behavior
});
