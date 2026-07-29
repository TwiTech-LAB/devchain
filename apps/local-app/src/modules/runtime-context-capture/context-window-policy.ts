import { MAX_RUNTIME_CONTEXT_WINDOW_TOKENS } from './runtime-context-capture.types';

export const CONTEXT_WINDOW_ENV_KEY = 'DEVCHAIN_CONTEXT_WINDOW_TOKENS';
export const UNKNOWN_MODEL_CONTEXT_WINDOW_TOKENS = 200_000;

export type ContextWindowEnvParseResult =
  | { readonly kind: 'absent' }
  | { readonly kind: 'valid'; readonly contextWindowTokens: number }
  | {
      readonly kind: 'invalid';
      readonly reason: 'not-positive-integer' | 'out-of-range';
    };

export interface ModelBoundContextWindow {
  readonly modelId: string;
  readonly contextWindowTokens: number;
}

export interface ContextWindowResolutionInput {
  readonly primaryModel: string;
  readonly configuredOverride: ModelBoundContextWindow | null;
  readonly claudeCapture: ModelBoundContextWindow | null;
  readonly providerReportedContextWindowTokens: number | null;
  readonly catalogContextWindowTokens: number | null;
}

export type ContextWindowResolution =
  | {
      readonly source: 'configured';
      readonly contextWindowTokens: number;
    }
  | {
      readonly source: 'claude-capture';
      readonly contextWindowTokens: number;
    }
  | {
      readonly source: 'provider-reported';
      readonly contextWindowTokens: number;
    }
  | {
      readonly source: 'catalog';
      readonly contextWindowTokens: number;
    }
  | {
      readonly source: 'unknown-fallback';
      readonly contextWindowTokens: typeof UNKNOWN_MODEL_CONTEXT_WINDOW_TOKENS;
    };

const CLAUDE_MODEL_ALIASES = new Set(['opus', 'sonnet', 'haiku']);

function normalizeModelSelector(model: string): string {
  const normalized = model.trim().toLowerCase();
  const providerSeparator = normalized.lastIndexOf('/');
  return providerSeparator >= 0 ? normalized.slice(providerSeparator + 1) : normalized;
}

/**
 * Provider configurations may use a native model selector while transcripts
 * report the provider's resolved canonical model ID. Keep exact matching for
 * arbitrary models, but recognize the stable Claude family aliases that the
 * Claude CLI resolves at runtime (for example `opus` -> `claude-opus-5`).
 */
function configuredModelMatchesPrimaryModel(
  configuredModel: string,
  primaryModel: string,
): boolean {
  const configured = normalizeModelSelector(configuredModel);
  const primary = normalizeModelSelector(primaryModel);
  if (configured === primary) {
    return true;
  }

  const claudeAlias = configured.match(/^(opus|sonnet|haiku)(?:\[1m\])?$/)?.[1];
  return (
    claudeAlias !== undefined &&
    CLAUDE_MODEL_ALIASES.has(claudeAlias) &&
    primary.startsWith(`claude-${claudeAlias}-`)
  );
}

export function parseContextWindowEnv(
  value: string | null | undefined,
): ContextWindowEnvParseResult {
  if (value === null || value === undefined) {
    return { kind: 'absent' };
  }

  if (!/^\d+$/.test(value)) {
    return { kind: 'invalid', reason: 'not-positive-integer' };
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return { kind: 'invalid', reason: 'not-positive-integer' };
  }
  if (parsed > MAX_RUNTIME_CONTEXT_WINDOW_TOKENS) {
    return { kind: 'invalid', reason: 'out-of-range' };
  }

  return { kind: 'valid', contextWindowTokens: parsed };
}

export function resolveContextWindow(input: ContextWindowResolutionInput): ContextWindowResolution {
  if (
    input.configuredOverride &&
    configuredModelMatchesPrimaryModel(input.configuredOverride.modelId, input.primaryModel)
  ) {
    return {
      source: 'configured',
      contextWindowTokens: input.configuredOverride.contextWindowTokens,
    };
  }

  if (input.claudeCapture?.modelId === input.primaryModel) {
    return {
      source: 'claude-capture',
      contextWindowTokens: input.claudeCapture.contextWindowTokens,
    };
  }

  if (input.providerReportedContextWindowTokens !== null) {
    return {
      source: 'provider-reported',
      contextWindowTokens: input.providerReportedContextWindowTokens,
    };
  }

  if (input.catalogContextWindowTokens !== null) {
    return {
      source: 'catalog',
      contextWindowTokens: input.catalogContextWindowTokens,
    };
  }

  return {
    source: 'unknown-fallback',
    contextWindowTokens: UNKNOWN_MODEL_CONTEXT_WINDOW_TOKENS,
  };
}
