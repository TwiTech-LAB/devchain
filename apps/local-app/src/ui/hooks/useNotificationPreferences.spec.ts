import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import {
  STATIC_NOTIFICATION_CATALOG,
  useNotificationPreferences,
} from './useNotificationPreferences';

function makeWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
}

describe('useNotificationPreferences', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function mockPreferencesAndCatalog(
    preferences: Array<{ category: string; channel: string; enabled: boolean }>,
  ) {
    fetchSpy.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/cloud/preferences/catalog') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            version: 'v1',
            categories: [
              {
                id: 'epic.assigned',
                label: 'Epic assigned',
                group: 'epic',
                critical: false,
                locked: false,
                defaultChannels: { inbox: true, push: true },
                color: '#38BDF8',
                sortOrder: 10,
              },
            ],
          }),
        } as Response);
      }
      if (url === '/api/cloud/preferences') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ preferences }),
        } as Response);
      }
      return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
    });
  }

  it('returns fetched preferences', async () => {
    const prefs = [{ category: 'epic.assigned', channel: 'push', enabled: true }];
    mockPreferencesAndCatalog(prefs);

    const { result } = renderHook(() => useNotificationPreferences(), {
      wrapper: makeWrapper(),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.preferences).toEqual(prefs);
  });

  it('returns fetched catalog metadata', async () => {
    mockPreferencesAndCatalog([]);

    const { result } = renderHook(() => useNotificationPreferences(), {
      wrapper: makeWrapper(),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.catalog).toEqual([
      expect.objectContaining({ id: 'epic.assigned', group: 'epic', label: 'Epic assigned' }),
    ]);
  });

  it('falls back to static catalog when the catalog request fails', async () => {
    fetchSpy.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/cloud/preferences/catalog') {
        return Promise.resolve({ ok: false, status: 503, json: async () => ({}) } as Response);
      }
      return Promise.resolve({ ok: true, json: async () => ({ preferences: [] }) } as Response);
    });

    const { result } = renderHook(() => useNotificationPreferences(), {
      wrapper: makeWrapper(),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.catalog).toEqual(STATIC_NOTIFICATION_CATALOG);
  });

  it('applies optimistic update on upsert mutate', async () => {
    const prefs = [{ category: 'epic.assigned', channel: 'push', enabled: true }];
    fetchSpy.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'PUT') {
        return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
      }
      if (url === '/api/cloud/preferences/catalog') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ version: 'v1', categories: STATIC_NOTIFICATION_CATALOG }),
        } as Response);
      }
      return Promise.resolve({ ok: true, json: async () => ({ preferences: prefs }) } as Response);
    });

    const { result } = renderHook(() => useNotificationPreferences(), {
      wrapper: makeWrapper(),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      result.current.upsert.mutate({ category: 'epic.assigned', enabled: false });
    });

    await waitFor(() => {
      const pref = result.current.preferences.find((p) => p.category === 'epic.assigned');
      expect(pref?.enabled).toBe(false);
    });
  });

  it('rolls back optimistic update when server returns PREFERENCE_LOCKED', async () => {
    const prefs = [{ category: 'security.session_revoked', channel: 'push', enabled: true }];
    fetchSpy.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'PUT') {
        return Promise.resolve({
          ok: false,
          status: 400,
          json: async () => ({ code: 'PREFERENCE_LOCKED' }),
        } as unknown as Response);
      }
      if (url === '/api/cloud/preferences/catalog') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ version: 'v1', categories: STATIC_NOTIFICATION_CATALOG }),
        } as Response);
      }
      return Promise.resolve({ ok: true, json: async () => ({ preferences: prefs }) } as Response);
    });

    const { result } = renderHook(() => useNotificationPreferences(), {
      wrapper: makeWrapper(),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      result.current.upsert.mutate({ category: 'security.session_revoked', enabled: false });
    });

    await waitFor(() => result.current.upsert.isError);

    const pref = result.current.preferences.find((p) => p.category === 'security.session_revoked');
    expect(pref?.enabled).toBe(true);
  });
});
