import { describe, expect, it } from 'vitest';
import {
  CLAUDE_LAUNCH_SETTINGS_MAX_BYTES,
  DEFAULT_CLAUDE_LAUNCH_SETTINGS_JSON,
  validateClaudeLaunchSettingsJson,
} from './claude-launch-settings.js';

describe('validateClaudeLaunchSettingsJson', () => {
  it('accepts null and preserves unknown valid object settings', () => {
    expect(validateClaudeLaunchSettingsJson(null)).toEqual({ valid: true, parsed: null });

    const text = '{"futureSetting":{"enabled":true},"items":[1,{"name":"value"}]}';
    expect(validateClaudeLaunchSettingsJson(text)).toEqual({
      valid: true,
      parsed: {
        futureSetting: { enabled: true },
        items: [1, { name: 'value' }],
      },
    });
  });

  it('ships a valid formatted default with the canonical status-line command', () => {
    const result = validateClaudeLaunchSettingsJson(DEFAULT_CLAUDE_LAUNCH_SETTINGS_JSON);

    expect(result).toEqual({
      valid: true,
      parsed: {
        tui: 'default',
        statusLine: {
          type: 'command',
          command: '"${CLAUDE_PROJECT_DIR}/.claude/hooks/devchain-statusline.sh"',
        },
      },
    });
  });

  it.each(['', '[]', 'null', '"text"', '42'])('rejects invalid or non-object JSON %j', (text) => {
    expect(validateClaudeLaunchSettingsJson(text).valid).toBe(false);
  });

  it('measures the limit in UTF-8 bytes', () => {
    const withinLimit = `{"value":"${'a'.repeat(CLAUDE_LAUNCH_SETTINGS_MAX_BYTES - 12)}"}`;
    const overLimit = `{"value":"${'€'.repeat(CLAUDE_LAUNCH_SETTINGS_MAX_BYTES)}"}`;

    expect(validateClaudeLaunchSettingsJson(withinLimit).valid).toBe(true);
    expect(validateClaudeLaunchSettingsJson(overLimit)).toMatchObject({
      valid: false,
      message: expect.stringContaining('UTF-8 bytes'),
    });
  });

  it.each([
    '{"__proto__":{"polluted":true}}',
    '{"nested":{"constructor":{"polluted":true}}}',
    '{"nested":[{"prototype":{"polluted":true}}]}',
  ])('rejects unsafe object keys at any depth', (text) => {
    expect(validateClaudeLaunchSettingsJson(text)).toMatchObject({
      valid: false,
      message: expect.stringContaining('unsafe object key'),
    });
  });

  it.each(['DEVCHAIN_CONTEXT_WINDOW_TOKENS', 'ANTHROPIC_BASE_URL'])(
    'rejects reserved env key %s with its JSON pointer',
    (key) => {
      expect(validateClaudeLaunchSettingsJson(`{"env":{"${key}":"value"}}`)).toMatchObject({
        valid: false,
        path: `/env/${key}`,
        message: expect.stringContaining(`/env/${key}`),
      });
    },
  );
});
