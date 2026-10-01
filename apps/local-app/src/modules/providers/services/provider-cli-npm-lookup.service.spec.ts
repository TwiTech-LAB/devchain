import { ProviderCliNpmLookupService } from './provider-cli-npm-lookup.service';

const FAKE_REGISTRY = 'http://127.0.0.1:1';

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

/**
 * Unit layer is the cheapest reliable layer here: the lookup is a pure
 * request/parse contract against the npm registry HTTP shape, served by a
 * mocked fetch — no real network or HTTP server needed.
 */
describe('ProviderCliNpmLookupService', () => {
  let fetchCalls: FetchCall[];
  const fetchMock = jest.fn();

  beforeEach(() => {
    fetchCalls = [];
    fetchMock.mockReset();
    jest.spyOn(globalThis, 'fetch').mockImplementation(((url: URL | string, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init });
      return fetchMock(url, init);
    }) as typeof fetch);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function service(): ProviderCliNpmLookupService {
    return new ProviderCliNpmLookupService(FAKE_REGISTRY);
  }

  function okJson(body: unknown): { ok: true; json: () => Promise<unknown> } {
    return { ok: true, json: () => Promise.resolve(body) };
  }

  function packument(versions: Record<string, unknown>): { versions: Record<string, unknown> } {
    return { versions };
  }

  describe('fetchLatestVersion', () => {
    it('uses the latest dist-tag endpoint, not the highest published version', async () => {
      fetchMock.mockResolvedValueOnce(
        okJson({
          version: '2.0.0',
          versions: { '3.0.0-beta.1': {} },
        }),
      );

      await expect(service().fetchLatestVersion('@anthropic-ai/claude-code')).resolves.toBe(
        '2.0.0',
      );

      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0]?.url).toBe(`${FAKE_REGISTRY}/@anthropic-ai/claude-code/latest`);
    });

    it('throws when the registry responds without a version field', async () => {
      fetchMock.mockResolvedValueOnce(okJson({}));
      await expect(service().fetchLatestVersion('opencode-ai')).rejects.toThrow(
        /no version for opencode-ai/,
      );
    });

    it('throws on a non-2xx registry response', async () => {
      fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });
      await expect(service().fetchLatestVersion('opencode-ai')).rejects.toThrow(
        /Unexpected status 404/,
      );
    });
  });

  describe('fetchStableVersions', () => {
    it('returns the newest 15 stable versions, descending, excluding prereleases and builds', async () => {
      const versions: Record<string, unknown> = {};
      // 20 stable versions 1.0.0 .. 1.0.19, plus noise that must never appear.
      for (let i = 0; i < 20; i++) versions[`1.0.${i}`] = {};
      versions['2.0.0-beta.1'] = {};
      versions['0.9.9-rc.2'] = {};
      versions['2.0.0+build.7'] = {};
      fetchMock.mockResolvedValueOnce(okJson(packument(versions)));

      await expect(service().fetchStableVersions('@openai/codex')).resolves.toEqual([
        '1.0.19',
        '1.0.18',
        '1.0.17',
        '1.0.16',
        '1.0.15',
        '1.0.14',
        '1.0.13',
        '1.0.12',
        '1.0.11',
        '1.0.10',
        '1.0.9',
        '1.0.8',
        '1.0.7',
        '1.0.6',
        '1.0.5',
      ]);

      const call = fetchCalls[0];
      expect(call?.url).toBe(`${FAKE_REGISTRY}/@openai/codex`);
      expect(call?.init?.headers).toEqual({
        accept: 'application/vnd.npm.install-v1+json',
      });
    });

    it('sorts numerically rather than lexically', async () => {
      fetchMock.mockResolvedValueOnce(
        okJson(packument({ '1.9.0': {}, '1.10.0': {}, '1.2.0': {} })),
      );
      await expect(service().fetchStableVersions('opencode-ai')).resolves.toEqual([
        '1.10.0',
        '1.9.0',
        '1.2.0',
      ]);
    });

    it('honours a custom limit', async () => {
      fetchMock.mockResolvedValueOnce(okJson(packument({ '1.0.0': {}, '1.0.1': {}, '1.0.2': {} })));
      await expect(service().fetchStableVersions('@github/copilot', 2)).resolves.toEqual([
        '1.0.2',
        '1.0.1',
      ]);
    });

    it('throws when the packument carries no version list', async () => {
      fetchMock.mockResolvedValueOnce(okJson({}));
      await expect(service().fetchStableVersions('@github/copilot')).rejects.toThrow(
        /no version list/,
      );
    });
  });

  describe('network failures', () => {
    it('surfaces a fetch rejection as a plain error', async () => {
      fetchMock.mockRejectedValueOnce(new Error('ENOTFOUND registry'));
      await expect(service().fetchLatestVersion('opencode-ai')).rejects.toThrow('ENOTFOUND');
    });
  });
});
