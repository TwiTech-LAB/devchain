import { createHash } from 'crypto';
import { buildEffectiveEnv, resolveUsageAccount } from './provider-usage-accounts';

// Layer: pure unit. The account rules are a function of the provider name and the
// effective env, so a table over plain objects proves each rule without storage.
const HOME = '/home/dev';
const FAKE_TOKEN = 'sk-ant-oat01-FAKE-TOKEN-VALUE';
const prefix = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 12);

describe('resolveUsageAccount', () => {
  it.each([
    ['claude', {}, `claude:login:${HOME}/.claude`, 'Claude'],
    [
      'claude',
      { CLAUDE_CONFIG_DIR: '/data/work-claude' },
      'claude:login:/data/work-claude',
      'Claude (work-claude)',
    ],
    [
      'claude',
      { CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN },
      `claude:token:${prefix(FAKE_TOKEN)}`,
      `Claude token ${prefix(FAKE_TOKEN).slice(0, 6)}`,
    ],
    ['Claude', { CLAUDE_CODE_OAUTH_TOKEN: '' }, `claude:login:${HOME}/.claude`, 'Claude'],
    ['codex', {}, `codex:${HOME}/.codex:none`, 'Codex'],
    [
      'codex',
      { OPENAI_API_KEY: 'sk-fake-openai' },
      `codex:${HOME}/.codex:${prefix('OPENAI_API_KEY=sk-fake-openai')}`,
      `Codex (key ${prefix('OPENAI_API_KEY=sk-fake-openai').slice(0, 6)})`,
    ],
    ['codex', { CODEX_HOME: '/data/codex-b' }, 'codex:/data/codex-b:none', 'Codex (codex-b)'],
    ['agy', {}, `agy:${HOME}`, 'agy'],
  ])('maps %s with %j to %s', (provider, extraEnv, key, label) => {
    expect(resolveUsageAccount(provider, { HOME, ...extraEnv })).toMatchObject({ key, label });
  });

  it.each([
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
  ])('gives Claude no account when %s is set, even with a token', (key) => {
    expect(
      resolveUsageAccount('claude', { HOME, CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN, [key]: '1' }),
    ).toBeNull();
  });

  it('gives other providers no account', () => {
    expect(resolveUsageAccount('opencode', { HOME })).toBeNull();
  });

  it('keeps the token value out of the account', () => {
    const account = resolveUsageAccount('claude', { HOME, CLAUDE_CODE_OAUTH_TOKEN: FAKE_TOKEN });
    expect(JSON.stringify(account)).not.toContain(FAKE_TOKEN);
  });
});

describe('buildEffectiveEnv', () => {
  it('lets the config env win over the provider env, and both over the process env', () => {
    const env = buildEffectiveEnv(
      { HOME, CLAUDE_CONFIG_DIR: '/process', KEEP: 'process' },
      { CLAUDE_CONFIG_DIR: '/provider', CODEX_HOME: '/provider-codex' },
      { CLAUDE_CONFIG_DIR: '/config' },
    );
    expect(env).toMatchObject({
      HOME,
      KEEP: 'process',
      CLAUDE_CONFIG_DIR: '/config',
      CODEX_HOME: '/provider-codex',
    });
  });
});
