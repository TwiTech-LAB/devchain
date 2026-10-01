import { describe, expect, it } from 'vitest';
import {
  NPM_PUBLIC_REGISTRY_URL,
  PROVIDER_CLI_NAMES,
  PROVIDER_CLI_NPM_PACKAGES,
  ProviderCliInstallStatusSchema,
  ProviderCliVersionEntrySchema,
  ProviderCliVersionSettingsMapSchema,
  isExactStableSemver,
} from './provider-clis.js';

describe('PROVIDER_CLI_NPM_PACKAGES', () => {
  it('maps the four managed providers to their npm packages', () => {
    expect(PROVIDER_CLI_NPM_PACKAGES).toEqual({
      claude: '@anthropic-ai/claude-code',
      codex: '@openai/codex',
      copilot: '@github/copilot',
      opencode: 'opencode-ai',
    });
    expect([...PROVIDER_CLI_NAMES]).toEqual(['claude', 'codex', 'copilot', 'opencode']);
  });

  it('points at the public npm registry, not a DevChain-internal one', () => {
    expect(NPM_PUBLIC_REGISTRY_URL).toBe('https://registry.npmjs.org/');
  });
});

describe('isExactStableSemver', () => {
  it.each(['0.0.1', '1.2.3', '0.156.1', '2.1.281', '10.20.30'])('accepts %s', (version) => {
    expect(isExactStableSemver(version)).toBe(true);
  });

  it.each([
    'latest',
    '1.2',
    '1.2.3.4',
    '1.2.3-beta.1',
    '1.2.3-rc1',
    '1.2.3+build.5',
    'v1.2.3',
    '01.2.3',
    '1.02.3',
    '1.2.03',
    '',
    '1.2.x',
  ])('rejects %s', (version) => {
    expect(isExactStableSemver(version)).toBe(false);
  });
});

describe('ProviderCliVersionEntrySchema', () => {
  it('accepts latest and an exact stable pin', () => {
    expect(ProviderCliVersionEntrySchema.parse({ version: 'latest', homeManaged: false })).toEqual({
      version: 'latest',
      homeManaged: false,
    });
    expect(ProviderCliVersionEntrySchema.parse({ version: '2.1.281', homeManaged: true })).toEqual({
      version: '2.1.281',
      homeManaged: true,
    });
  });

  it.each([
    { version: '2.1.281-beta.1', homeManaged: false },
    { version: 'v2.1.281', homeManaged: false },
    { version: 'latest', homeManaged: 'yes' },
    { version: 'latest' },
    { version: 'latest', homeManaged: false, extra: 1 },
  ])('rejects %j', (entry) => {
    expect(() => ProviderCliVersionEntrySchema.parse(entry)).toThrow();
  });
});

describe('ProviderCliVersionSettingsMapSchema', () => {
  it('accepts a map keyed by allowlisted providers only', () => {
    expect(
      ProviderCliVersionSettingsMapSchema.parse({
        claude: { version: 'latest', homeManaged: false },
        opencode: { version: '1.18.32', homeManaged: true },
      }),
    ).toEqual({
      claude: { version: 'latest', homeManaged: false },
      opencode: { version: '1.18.32', homeManaged: true },
    });

    expect(() =>
      ProviderCliVersionSettingsMapSchema.parse({
        agy: { version: 'latest', homeManaged: false },
      }),
    ).toThrow();
  });
});

describe('ProviderCliInstallStatusSchema', () => {
  it('accepts the idle baseline and rejects unknown states', () => {
    expect(
      ProviderCliInstallStatusSchema.parse({
        desiredVersion: 'latest',
        installedVersion: null,
        state: 'idle',
        error: null,
        checkedAt: null,
      }),
    ).toEqual({
      desiredVersion: 'latest',
      installedVersion: null,
      state: 'idle',
      error: null,
      checkedAt: null,
    });

    expect(() =>
      ProviderCliInstallStatusSchema.parse({
        desiredVersion: 'latest',
        installedVersion: null,
        state: 'downloading',
        error: null,
        checkedAt: null,
      }),
    ).toThrow();
  });
});
