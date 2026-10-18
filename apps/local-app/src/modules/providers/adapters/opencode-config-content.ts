import { EnvBuilderError } from '../utils/env-builder';

/** Env var opencode reads as a per-process JSON config overlay (highest layer). */
const OPENCODE_CONFIG_CONTENT_ENV = 'OPENCODE_CONFIG_CONTENT';

/**
 * env-builder rejects values >32KB; mirror that ceiling here so the failure is an
 * actionable OpenCode-specific message rather than a generic env error downstream.
 */
const MAX_CONFIG_CONTENT_BYTES = 32768;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Recursively merge `source` onto `target`, both PLAIN JSON objects. Nested plain
 * objects merge key-by-key; any non-object source value (scalar/array) replaces the
 * target value. Keys present only on `target` are preserved untouched — this is
 * what keeps unrelated pre-existing OPENCODE_CONFIG_CONTENT keys intact.
 */
function deepMergePlainObjects(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };
  for (const [key, sourceValue] of Object.entries(source)) {
    const targetValue = result[key];
    result[key] =
      isPlainObject(targetValue) && isPlainObject(sourceValue)
        ? deepMergePlainObjects(targetValue, sourceValue)
        : sourceValue;
  }
  return result;
}

/**
 * Deep-merge `overlay` onto the env's existing OPENCODE_CONFIG_CONTENT (already
 * resolved by providerEnv < configEnv upstream) and return the env with the merged
 * value. `purpose` names the overlay in error messages.
 */
export function mergeOpencodeConfigContent(
  env: Readonly<Record<string, string>>,
  overlay: Record<string, unknown>,
  purpose: string,
): Record<string, string> {
  const existing = env[OPENCODE_CONFIG_CONTENT_ENV];
  let base: Record<string, unknown> = {};
  if (existing != null && existing !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing);
    } catch {
      throw new EnvBuilderError(
        `${OPENCODE_CONFIG_CONTENT_ENV} is not valid JSON — cannot merge the OpenCode ${purpose}`,
      );
    }
    if (!isPlainObject(parsed)) {
      throw new EnvBuilderError(
        `${OPENCODE_CONFIG_CONTENT_ENV} must be a JSON object to merge the OpenCode ${purpose}`,
      );
    }
    base = parsed;
  }

  // Compact serialization only — env-builder rejects newlines/control chars.
  const serialized = JSON.stringify(deepMergePlainObjects(base, overlay));
  if (serialized.length > MAX_CONFIG_CONTENT_BYTES) {
    throw new EnvBuilderError(
      `Merged ${OPENCODE_CONFIG_CONTENT_ENV} exceeds 32KB — reduce the pre-existing config content`,
    );
  }

  return { ...env, [OPENCODE_CONFIG_CONTENT_ENV]: serialized };
}
