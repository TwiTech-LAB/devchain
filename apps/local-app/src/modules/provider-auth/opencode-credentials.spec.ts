import {
  fromOpencodeV2Credential,
  opencodeOauthMethodId,
  toOpencodeV2Credential,
} from './opencode-credentials';

describe('OpenCode credential conversion', () => {
  it.each([
    [
      'api',
      { type: 'api', key: 'sk-1', metadata: { org: 'o' } },
      { type: 'key', key: 'sk-1', metadata: { org: 'o' } },
      { type: 'api', key: 'sk-1', metadata: { org: 'o' } },
    ],
    [
      'wellknown (comes back as api: v2 has no wellknown type)',
      { type: 'wellknown', key: 'GITHUB_TOKEN', token: 'gh-1' },
      { type: 'key', key: 'gh-1' },
      { type: 'api', key: 'gh-1' },
    ],
    [
      'oauth',
      { type: 'oauth', refresh: 'r', access: 'a', expires: 1 },
      { type: 'oauth', methodID: 'device', refresh: 'r', access: 'a', expires: 1 },
      { type: 'oauth', refresh: 'r', access: 'a', expires: 1 },
    ],
  ])('converts %s to v2 and back', (_name, v1, v2, back) => {
    expect(toOpencodeV2Credential('github-copilot', v1)).toEqual(v2);
    expect(fromOpencodeV2Credential('github-copilot', v2)).toEqual(back);
  });

  it('round-trips an oauth entry with its metadata byte for byte', () => {
    const v1 = {
      type: 'oauth',
      refresh: 'r',
      access: 'a',
      expires: 1,
      accountId: 'acct',
      enterpriseUrl: 'https://ghe.example',
    };
    const v2 = toOpencodeV2Credential('openai', v1);

    expect(v2).toMatchObject({ metadata: { accountID: 'acct', enterpriseUrl: v1.enterpriseUrl } });
    expect(JSON.stringify(fromOpencodeV2Credential('openai', v2))).toBe(JSON.stringify(v1));
  });

  it('keeps a v2-only method, its metadata and an empty refresh through v1 and back', () => {
    const v2 = {
      type: 'oauth',
      methodID: 'chatgpt-token-sharing',
      refresh: '',
      access: 'a',
      expires: 1,
      metadata: { clientID: 'client', scopes: ['openid'], accountID: 'acct' },
    };
    const v1 = fromOpencodeV2Credential('openai', v2);

    expect(v1).toEqual({
      type: 'oauth',
      refresh: '',
      access: 'a',
      expires: 1,
      accountId: 'acct',
      methodID: 'chatgpt-token-sharing',
      metadata: { clientID: 'client', scopes: ['openid'] },
    });
    expect(toOpencodeV2Credential('openai', v1)).toEqual(v2);
  });

  it.each([
    ['openai', 'chatgpt-browser'],
    ['github-copilot', 'device'],
    ['opencode', 'device'],
    ['xai', 'device'],
    ['anthropic', 'oauth'],
  ])('gives a %s oauth login the method %s', (integrationId, methodId) => {
    expect(opencodeOauthMethodId(integrationId)).toBe(methodId);
  });

  it('refuses a v1 entry type OpenCode 2 cannot hold', () => {
    expect(() => toOpencodeV2Credential('x', { type: 'deviceflow' })).toThrow(
      'unsupported type deviceflow',
    );
  });
});
