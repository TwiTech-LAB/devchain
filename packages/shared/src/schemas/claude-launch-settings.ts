export const CLAUDE_LAUNCH_SETTINGS_MAX_BYTES = 32 * 1024;

export const DEFAULT_CLAUDE_LAUNCH_SETTINGS_JSON = [
  '{',
  '  "tui": "default",',
  '  "statusLine": {',
  '    "type": "command",',
  '    "command": "\\"${CLAUDE_PROJECT_DIR}/.claude/hooks/devchain-statusline.sh\\""',
  '  }',
  '}',
].join('\n');

const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const RESERVED_ENV_KEYS = new Map([
  [
    'DEVCHAIN_CONTEXT_WINDOW_TOKENS',
    'Configure DEVCHAIN_CONTEXT_WINDOW_TOKENS in the provider configuration environment instead.',
  ],
  [
    'ANTHROPIC_BASE_URL',
    'Configure ANTHROPIC_BASE_URL in the provider or provider configuration environment instead.',
  ],
]);

export type ClaudeLaunchSettingsValidationResult =
  | { valid: true; parsed: Record<string, unknown> | null }
  | { valid: false; message: string; path?: string };

function escapeJsonPointerSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

function findUnsafeObjectKey(value: unknown, path = ''): string | null {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const unsafePath = findUnsafeObjectKey(value[index], `${path}/${index}`);
      if (unsafePath) return unsafePath;
    }
    return null;
  }

  if (value === null || typeof value !== 'object') {
    return null;
  }

  for (const [key, child] of Object.entries(value)) {
    const keyPath = `${path}/${escapeJsonPointerSegment(key)}`;
    if (UNSAFE_OBJECT_KEYS.has(key)) {
      return keyPath;
    }
    const unsafePath = findUnsafeObjectKey(child, keyPath);
    if (unsafePath) return unsafePath;
  }

  return null;
}

export function validateClaudeLaunchSettingsJson(
  value: string | null,
): ClaudeLaunchSettingsValidationResult {
  if (value === null) {
    return { valid: true, parsed: null };
  }

  if (new TextEncoder().encode(value).byteLength > CLAUDE_LAUNCH_SETTINGS_MAX_BYTES) {
    return {
      valid: false,
      message: `Claude launch settings JSON must be no larger than ${CLAUDE_LAUNCH_SETTINGS_MAX_BYTES} UTF-8 bytes.`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { valid: false, message: 'Claude launch settings must be valid JSON.' };
  }

  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    Object.getPrototypeOf(parsed) !== Object.prototype
  ) {
    return {
      valid: false,
      message: 'Claude launch settings JSON must have a plain object at its root.',
    };
  }

  const unsafePath = findUnsafeObjectKey(parsed);
  if (unsafePath) {
    return {
      valid: false,
      message: `Claude launch settings JSON contains an unsafe object key at ${unsafePath}.`,
      path: unsafePath,
    };
  }

  const env = (parsed as Record<string, unknown>).env;
  if (env !== null && typeof env === 'object' && !Array.isArray(env)) {
    for (const [key, explanation] of RESERVED_ENV_KEYS) {
      if (Object.prototype.hasOwnProperty.call(env, key)) {
        const path = `/env/${key}`;
        return {
          valid: false,
          message: `Claude launch settings cannot set ${path}. ${explanation}`,
          path,
        };
      }
    }
  }

  return { valid: true, parsed: parsed as Record<string, unknown> };
}
