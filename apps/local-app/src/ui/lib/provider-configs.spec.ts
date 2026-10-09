import { fetchProviderConfigs } from './provider-configs';

const okJson = (data: unknown) => ({ ok: true, json: async () => data });

describe('provider configs resource', () => {
  it('the shared provider-config fetcher GETs and returns json; throws on !ok', async () => {
    const apiFetch = jest
      .fn()
      .mockResolvedValueOnce(okJson([{ id: 'c1' }]))
      .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) });
    await expect(fetchProviderConfigs(apiFetch, 'prof1')).resolves.toEqual([{ id: 'c1' }]);
    expect(apiFetch).toHaveBeenCalledWith('/api/profiles/prof1/provider-configs', {});
    await expect(fetchProviderConfigs(apiFetch, 'prof1')).rejects.toThrow(
      'Failed to fetch provider configs',
    );
  });
});
