import { QueryClient, QueryObserver } from '@tanstack/react-query';
import {
  providerEffortQueries,
  providerEffortQueryKeys,
  selectProviderEffortNames,
  selectProviderEffortOptions,
  type ProviderEffortsResponse,
} from './provider-efforts';

const catalog: ProviderEffortsResponse = {
  efforts: ['low', ' high ', ' '].map((name, index) => ({
    id: `row-${index}`,
    providerId: 'provider/one',
    name,
    position: index,
    createdAt: '2026-10-08T00:00:00.000Z',
    updatedAt: '2026-10-08T00:00:00.000Z',
  })),
  supportsEffort: true,
  requiresModelForEffort: true,
};

describe('provider efforts resource', () => {
  // Real observers reproduce consumer-specific views of one cache entry without mounting dialogs.
  it('loads through Preset options and serves wizard names while retaining raw management row IDs', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const fetchFn = jest.fn(async () => ({ ok: true, json: async () => catalog }) as Response);
    const options = providerEffortQueries.catalog(fetchFn, 'provider/one');
    const preset = new QueryObserver(queryClient, {
      ...options,
      staleTime: 5 * 60 * 1000,
      select: selectProviderEffortOptions,
    });
    try {
      expect((await preset.refetch()).data).toEqual({
        efforts: [
          { id: 'provider/one:low:0', name: 'low' },
          { id: 'provider/one:high:1', name: 'high' },
        ],
        supportsEffort: true,
        requiresModelForEffort: true,
      });
      const wizard = new QueryObserver(queryClient, {
        ...options,
        staleTime: 5 * 60 * 1000,
        select: selectProviderEffortNames,
      });
      expect(wizard.getCurrentResult().data).toEqual({
        efforts: ['low', 'high'],
        supportsEffort: true,
        requiresModelForEffort: true,
      });
      expect(queryClient.getQueryData(options.queryKey)).toEqual(catalog);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(fetchFn).toHaveBeenCalledWith('/api/providers/provider%2Fone/efforts', {});
    } finally {
      preset.destroy();
      queryClient.clear();
    }
  });

  // Query-cache error handling is verified here; components only choose an empty fallback.
  it.each([undefined, catalog])(
    'throws fetch failures without discarding existing data: %p',
    async (existing) => {
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const fetchFn = jest.fn(
        async () =>
          ({
            ok: false,
            status: 404,
            json: async () => ({ message: 'Provider not found' }),
          }) as Response,
      );
      const options = providerEffortQueries.catalog(fetchFn, 'provider/one');
      try {
        if (existing) queryClient.setQueryData(options.queryKey, existing);
        await expect(queryClient.fetchQuery({ ...options, staleTime: 0 })).rejects.toMatchObject({
          message: 'Provider not found',
          status: 404,
        });
        const consumer = new QueryObserver(queryClient, {
          ...options,
          select: selectProviderEffortNames,
        });
        expect(consumer.getCurrentResult().data?.efforts ?? []).toEqual(
          existing ? ['low', 'high'] : [],
        );
        expect(queryClient.getQueryData(options.queryKey)).toEqual(existing);
      } finally {
        queryClient.clear();
      }
    },
  );

  it('invalidates every provider catalog with the shared root', async () => {
    const queryClient = new QueryClient();
    const keys = ['provider/one', 'provider-two'].map(providerEffortQueryKeys.catalog);
    try {
      keys.forEach((key) => queryClient.setQueryData(key, catalog));
      await queryClient.invalidateQueries({ queryKey: providerEffortQueryKeys.all });
      expect(keys.map((key) => queryClient.getQueryState(key)?.isInvalidated)).toEqual([
        true,
        true,
      ]);
    } finally {
      queryClient.clear();
    }
  });
});
