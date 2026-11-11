/**
 * Name and value rules of Vault entries. Test layer: unit — pure functions; the
 * REST spec checks once that the service applies them.
 */
import { createRequire } from 'node:module';
import type { ProviderAdapter } from '../providers/adapters/provider-adapter.interface';
import {
  VAULT_FILE_MAX_BYTES,
  VAULT_SECRET_MAX_CHARS,
  assertVaultEntryName,
  assertVaultEntryValue,
  reservedVaultEntryNames,
} from './vault-entry-rules';

const reserved = reservedVaultEntryNames([
  {
    launchEnv: { DISABLE_AUTOUPDATER: '1' },
    launchUnsetEnv: ['TMUX'],
    launchRejectEnv: ['COPILOT_HOME'],
  } as unknown as ProviderAdapter,
]);

const bootstrapValidation = createRequire(__filename)(
  '../../../../host-bootstrap/lib/validate.js',
) as { RESERVED_ENV_KEYS: ReadonlySet<string> };

const code = (run: () => void) => {
  try {
    run();
    return null;
  } catch (error) {
    return (error as { details?: { code?: string } }).details?.code;
  }
};

describe('Vault entry rules', () => {
  it.each([
    ['OPENAI_API_KEY', null],
    ['_private', null],
    ['', 'VAULT_ENTRY_NAME_INVALID'],
    ['1KEY', 'VAULT_ENTRY_NAME_INVALID'],
    ['MY-KEY', 'VAULT_ENTRY_NAME_INVALID'],
    ['A'.repeat(256), 'VAULT_ENTRY_NAME_INVALID'],
    ['DEVCHAIN_ANYTHING', 'VAULT_ENTRY_NAME_RESERVED'],
    ['devchain_context_window_tokens', 'VAULT_ENTRY_NAME_RESERVED'],
    ['PATH', 'VAULT_ENTRY_NAME_RESERVED'],
    ['Path', 'VAULT_ENTRY_NAME_RESERVED'],
    ['HOME', 'VAULT_ENTRY_NAME_RESERVED'],
    ['LD_PRELOAD', 'VAULT_ENTRY_NAME_RESERVED'],
    ['ld_preload', 'VAULT_ENTRY_NAME_RESERVED'],
    ['NODE_OPTIONS', 'VAULT_ENTRY_NAME_RESERVED'],
    ['XDG_RUNTIME_DIR', 'VAULT_ENTRY_NAME_RESERVED'],
    ['DBUS_SESSION_BUS_ADDRESS', 'VAULT_ENTRY_NAME_RESERVED'],
    ['GITHUB_TOKEN', null],
    ['CLAUDE_CODE_OAUTH_TOKEN', 'VAULT_ENTRY_NAME_RESERVED'],
    ['COPILOT_GITHUB_TOKEN', 'VAULT_ENTRY_NAME_RESERVED'],
    ['DISABLE_AUTOUPDATER', 'VAULT_ENTRY_NAME_RESERVED'],
    ['TMUX', 'VAULT_ENTRY_NAME_RESERVED'],
    ['COPILOT_HOME', 'VAULT_ENTRY_NAME_RESERVED'],
  ])('name %s -> %s', (name, expected) => {
    expect(code(() => assertVaultEntryName(name, reserved))).toBe(expected);
  });

  it('refuses every env key the host bootstrap reserves', () => {
    const keys = [...bootstrapValidation.RESERVED_ENV_KEYS];
    expect(keys).toContain('LD_PRELOAD');
    const accepted = keys.filter((key) => code(() => assertVaultEntryName(key, reserved)) === null);
    expect(accepted).toEqual([]);
  });

  it.each([
    ['secret', 'sk-123', null],
    ['secret', 'x'.repeat(VAULT_SECRET_MAX_CHARS), null],
    ['secret', 'x'.repeat(VAULT_SECRET_MAX_CHARS + 1), 'VAULT_ENTRY_VALUE_INVALID'],
    ['secret', 'line1\nline2', 'VAULT_ENTRY_VALUE_INVALID'],
    ['secret', '', 'VAULT_ENTRY_VALUE_INVALID'],
    ['file', '-----BEGIN KEY-----\nabc\n-----END KEY-----\n', null],
    ['file', 'é'.repeat(VAULT_FILE_MAX_BYTES / 2), null],
    ['file', 'é'.repeat(VAULT_FILE_MAX_BYTES / 2 + 1), 'VAULT_ENTRY_VALUE_INVALID'],
  ] as const)('%s value %#', (kind, value, expected) => {
    expect(code(() => assertVaultEntryValue(kind, value))).toBe(expected);
  });
});
