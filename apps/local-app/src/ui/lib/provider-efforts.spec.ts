import { QueryClient, QueryObserver } from '@tanstack/react-query';
import {
  launchModelOf,
  providerEffortQueries,
  providerEffortQueryKeys,
  selectProviderEffortNames,
  selectProviderEffortOptions,
  type ProviderEffortsResponse,
} from './provider-efforts';
import { providerModelQueryKeys } from './provider-model-query-keys';

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
    const options = providerEffortQueries.catalog(fetchFn, 'provider/one', 'home');
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
      const options = providerEffortQueries.catalog(fetchFn, 'provider/one', 'home');
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

  it('keys each catalog by backend and invalidates every backend with the shared roots', async () => {
    const queryClient = new QueryClient();
    const effortKeys = [
      providerEffortQueryKeys.catalog('provider/one', 'home'),
      providerEffortQueryKeys.catalog('provider/one', 'remote-1'),
      providerEffortQueryKeys.catalog('provider-two', 'home'),
    ];
    const modelKeys = [
      providerModelQueryKeys.main('provider/one', 'home'),
      providerModelQueryKeys.main('provider/one', 'remote-1'),
    ];
    try {
      expect(effortKeys[1]).toEqual(['provider-efforts', 'provider/one', 'remote-1']);
      expect(modelKeys[1]).toEqual(['provider-models', 'main', 'provider/one', 'remote-1']);
      [...effortKeys, ...modelKeys].forEach((key) => queryClient.setQueryData(key, catalog));
      await queryClient.invalidateQueries({ queryKey: providerEffortQueryKeys.all });
      await queryClient.invalidateQueries({ queryKey: providerModelQueryKeys.all });
      expect(
        [...effortKeys, ...modelKeys].map((key) => queryClient.getQueryState(key)?.isInvalidated),
      ).toEqual([true, true, true, true, true]);
    } finally {
      queryClient.clear();
    }
  });
});

describe('launchModelOf', () => {
  it.each([
    [
      'the agent override first',
      'a/agent',
      { model: 'a/config', options: '--model a/raw' },
      'a/agent',
    ],
    ['the config model next', null, { model: 'a/config', options: '--model a/raw' }, 'a/config'],
    ['the raw --model last', null, { model: null, options: '--yolo --model a/raw' }, 'a/raw'],
    ['the raw -m= form', undefined, { options: '-m=a/raw' }, 'a/raw'],
    ['null for unparsable options', null, { model: null, options: '--model "a/raw' }, null],
    ['null for an empty --model=', null, { model: null, options: '--model=' }, null],
    ['null with no source', null, { model: null, options: '--yolo' }, null],
    ['null with no config', null, undefined, null],
  ])('returns %s', (_case, override, config, expected) => {
    expect(launchModelOf(override, config)).toBe(expected);
  });
});
