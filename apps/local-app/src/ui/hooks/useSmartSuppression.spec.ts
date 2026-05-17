import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useSmartSuppression } from './useSmartSuppression';

function makeWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
}

describe('useSmartSuppression', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('returns fetched smart suppression config', async () => {
    const config = { enabled: false, windowMinutes: 15 };
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ smartSuppression: config }),
    } as Response);

    const { result } = renderHook(() => useSmartSuppression(), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.smartSuppression).toEqual(config);
  });

  it('returns default config when server returns null smartSuppression', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ smartSuppression: null }),
    } as Response);

    const { result } = renderHook(() => useSmartSuppression(), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.smartSuppression).toEqual({ enabled: true, windowMinutes: 5 });
  });

  it('updates cache after successful upsert', async () => {
    const initial = { enabled: true, windowMinutes: 5 };
    fetchSpy.mockImplementation((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ smartSuppression: initial }),
      } as Response);
    });

    const { result } = renderHook(() => useSmartSuppression(), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.upsert.mutateAsync({ enabled: false, windowMinutes: 30 });
    });

    await waitFor(() =>
      expect(result.current.smartSuppression).toEqual({ enabled: false, windowMinutes: 30 }),
    );
    expect(fetchSpy).toHaveBeenCalledWith('/api/cloud/preferences/smart-suppression', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false, windowMinutes: 30 }),
    });
  });

  it('surfaces mutation error when upsert fails', async () => {
    const initial = { enabled: true, windowMinutes: 5 };
    fetchSpy.mockImplementation((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        return Promise.resolve({ ok: false, status: 500, json: async () => ({}) } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ smartSuppression: initial }),
      } as Response);
    });

    const { result } = renderHook(() => useSmartSuppression(), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await expect(
        result.current.upsert.mutateAsync({ enabled: false, windowMinutes: 10 }),
      ).rejects.toThrow('smart-suppression-upsert:500');
    });

    await waitFor(() => expect(result.current.upsert.isError).toBe(true));
    expect(result.current.smartSuppression).toEqual(initial);
  });
});
