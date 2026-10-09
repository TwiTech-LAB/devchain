import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { apiFetch } from './api-transport';
import {
  fetchHealth,
  healthQueries,
  healthQueryKeys,
  isVersionCompatible,
  selectAppVersion,
  type HealthResponse,
} from './health';

jest.mock('./api-transport', () => ({
  ...jest.requireActual('./api-transport'),
  apiFetch: jest.fn(),
}));

const health: HealthResponse = {
  status: 'ok',
  timestamp: '2026-10-08T00:00:00.000Z',
  environment: 'test',
  version: '0.4.0',
};
const apiFetchMock = jest.mocked(apiFetch);

describe('health resource', () => {
  beforeEach(() => apiFetchMock.mockReset());

  // A real cache and observer reproduce the shared Layout/Registry shape conflict without React.
  it('projects the Layout health object into a version that rejects newer template requirements', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    try {
      queryClient.setQueryData(healthQueryKeys.check(), health);
      const registry = new QueryObserver(queryClient, {
        ...healthQueries.check(),
        select: selectAppVersion,
      });

      const currentVersion = registry.getCurrentResult().data;
      expect(currentVersion).toBe('0.4.0');
      expect(isVersionCompatible('0.5.0', currentVersion ?? null)).toBe(false);
      expect(queryClient.getQueryData(healthQueryKeys.check())).toEqual(health);
    } finally {
      queryClient.clear();
    }
  });

  // The fetcher boundary is the cheapest layer that verifies backend routing and the stored shape.
  it('fetches the full health response from home', async () => {
    apiFetchMock.mockResolvedValue({ ok: true, json: async () => health } as Response);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    try {
      expect(await queryClient.fetchQuery(healthQueries.check())).toEqual(health);
      expect(apiFetchMock).toHaveBeenCalledWith('/health', undefined, { backend: 'home' });
      expect(healthQueries.check().staleTime).toBe(Infinity);
    } finally {
      queryClient.clear();
    }
  });

  it('throws on an unsuccessful health response', async () => {
    apiFetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ message: 'Health unavailable' }),
    } as Response);

    await expect(fetchHealth()).rejects.toMatchObject({
      message: 'Health unavailable',
      status: 503,
    });
  });

  // Pure functions own compatibility and unknown-version policy; no query or component is needed.
  it.each([
    [null, '0.4.0', true],
    ['0.5.0', null, true],
    ['0.5.0', 'unknown', true],
    ['invalid', '0.4.0', true],
    ['0.4.0', '0.4.0', true],
    ['0.4.0', '0.5.0', true],
  ])('keeps compatibility policy for minimum %s and current %s', (minimum, current, expected) => {
    expect(isVersionCompatible(minimum, current)).toBe(expected);
  });

  it.each([undefined, { ...health, version: '' }])(
    'projects an unknown version to null',
    (data) => {
      expect(selectAppVersion(data)).toBeNull();
    },
  );
});
