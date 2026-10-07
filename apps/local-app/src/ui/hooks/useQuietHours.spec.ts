import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useQuietHours } from './useQuietHours';

function makeWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
}

describe('useQuietHours', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it.each([
    {
      label: 'configured hours',
      qh: { enabled: true, startMinutes: 1320, endMinutes: 420, timezone: 'America/New_York' },
    },
    { label: 'no hours', qh: null },
  ] as const)('returns $label', async ({ qh }) => {
    fetchSpy.mockResolvedValue({ ok: true, json: async () => ({ quietHours: qh }) } as Response);
    const { result } = renderHook(() => useQuietHours(), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.quietHours).toEqual(qh);
  });
});
