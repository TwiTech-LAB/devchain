import type { ProviderUsageAccount } from '../provider-usage.types';
import { ClaudeTokenChecker } from './claude-token.checker';

const mockLogCalls: unknown[][] = [];
jest.mock('../../../common/logging/logger', () => {
  const record = (...args: unknown[]) => void mockLogCalls.push(args);
  return {
    createLogger: () => ({ debug: record, info: record, warn: record, error: record }),
  };
});

const TOKEN = 'sk-ant-oat01-fake-token-value-for-tests';
const account: ProviderUsageAccount = {
  key: 'claude:token:abc',
  provider: 'claude',
  kind: 'claude-token',
  label: 'Claude token abc',
};
const env = { CLAUDE_CODE_OAUTH_TOKEN: TOKEN };

const FULL_HEADERS = {
  'anthropic-ratelimit-unified-5h-utilization': '0.52',
  'anthropic-ratelimit-unified-5h-reset': '1792000000',
  'anthropic-ratelimit-unified-7d-utilization': '0.11',
  'anthropic-ratelimit-unified-7d-reset': '1792500000',
};

describe('ClaudeTokenChecker', () => {
  let fetchMock: jest.SpyInstance;
  const checker = new ClaudeTokenChecker();

  const answer = (status: number, headers: Record<string, string> = {}) =>
    fetchMock.mockResolvedValue(new Response('{"secret":"body"}', { status, headers }));

  beforeEach(() => {
    mockLogCalls.length = 0;
    fetchMock = jest.spyOn(global, 'fetch');
  });

  afterEach(() => jest.restoreAllMocks());

  it('maps the 5h and 7d headers to two windows', async () => {
    answer(200, FULL_HEADERS);

    await expect(checker.check(account, env)).resolves.toEqual({
      kind: 'ok',
      source: 'headers',
      plan: null,
      extras: [],
      windows: [
        { id: '5h', label: '5-hour limit', kind: '5h', usedPercent: 52, resetsAt: 1792000000 },
        {
          id: 'weekly',
          label: 'Weekly limit',
          kind: 'weekly',
          usedPercent: 11,
          resetsAt: 1792500000,
        },
      ],
    });
  });

  it('sends exactly the verified request', async () => {
    answer(200, FULL_HEADERS);

    await checker.check(account, env);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      authorization: `Bearer ${TOKEN}`,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'oauth-2025-04-20',
      'content-type': 'application/json',
    });
    expect(JSON.parse(init.body)).toEqual({
      model: 'claude-haiku-4-5',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('returns one window when only the 7d headers are present', async () => {
    answer(200, {
      'anthropic-ratelimit-unified-7d-utilization': '0.5',
      'anthropic-ratelimit-unified-7d-reset': '1792500000',
    });

    const result = await checker.check(account, env);

    expect(result).toMatchObject({
      kind: 'ok',
      windows: [{ id: 'weekly', usedPercent: 50, resetsAt: 1792500000 }],
    });
  });

  it('drops a window with a missing reset or an unreadable value, and keeps utilization above 100%', async () => {
    answer(200, {
      'anthropic-ratelimit-unified-5h-utilization': '0.3',
      'anthropic-ratelimit-unified-7d-utilization': '1.25',
      'anthropic-ratelimit-unified-7d-reset': '1792500000',
    });
    await expect(checker.check(account, env)).resolves.toMatchObject({
      windows: [{ id: 'weekly', usedPercent: 125 }],
    });

    answer(200, {
      ...FULL_HEADERS,
      'anthropic-ratelimit-unified-5h-utilization': 'lots',
    });
    await expect(checker.check(account, env)).resolves.toMatchObject({
      windows: [{ id: 'weekly' }],
    });
  });

  it('reads the headers of a rate-limited answer', async () => {
    answer(429, FULL_HEADERS);

    await expect(checker.check(account, env)).resolves.toMatchObject({
      kind: 'ok',
      windows: [{ id: '5h' }, { id: 'weekly' }],
    });
  });

  it.each([
    [401, 'token rejected (401)'],
    [403, 'token rejected (403)'],
    [400, 'check request rejected (400)'],
    [404, 'check request rejected (404)'],
    [500, 'no usage headers'],
    [200, 'no usage headers'],
  ])('answers %i without limit headers as "%s"', async (status, message) => {
    answer(status);

    await expect(checker.check(account, env)).rejects.toThrow(new Error(message));
  });

  it('reports a network error and a timeout as "check failed"', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError(`fetch failed for ${TOKEN}`));
    await expect(checker.check(account, env)).rejects.toThrow(new Error('check failed'));

    fetchMock.mockRejectedValueOnce(new DOMException('The operation timed out', 'TimeoutError'));
    await expect(checker.check(account, env)).rejects.toThrow(new Error('check failed'));
  });

  it('refuses to run without a token', async () => {
    await expect(checker.check(account, {})).rejects.toThrow('token missing');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the token and the response body out of the result, errors and logs', async () => {
    const outputs: string[] = [];
    answer(200, FULL_HEADERS);
    outputs.push(JSON.stringify(await checker.check(account, env)));
    for (const status of [401, 400]) {
      answer(status);
      await checker.check(account, env).catch((error: Error) => outputs.push(error.message));
    }
    fetchMock.mockRejectedValueOnce(new Error(`boom ${TOKEN}`));
    await checker.check(account, env).catch((error: Error) => outputs.push(error.message));

    expect(mockLogCalls.length).toBeGreaterThan(0);
    const everything = outputs.join('\n') + JSON.stringify(mockLogCalls);
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain('secret');
    expect(JSON.stringify(mockLogCalls)).toContain('"status":401');
  });
});
