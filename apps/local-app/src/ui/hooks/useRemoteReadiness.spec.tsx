import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useRemoteReadiness } from './useRemoteReadiness';

const mockApiFetch = jest.fn();
jest.mock('@/ui/lib/api-transport', () => {
  const actual = jest.requireActual('@/ui/lib/api-transport');
  return { ...actual, apiFetch: (...args: unknown[]) => mockApiFetch(...args) };
});

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

// Hook unit: the checklist renders only a complete answer, so the hook owns the shape check.
describe('useRemoteReadiness', () => {
  it('returns a complete answer', async () => {
    const readiness = {
      syncthing: { ok: true, version: 'v2.1.5', message: null },
      identity: { ok: true, user: 'dev', homePath: '/home/dev', message: null },
      docker: { ok: false, message: 'Docker Engine is not installed on this PC.' },
    };
    mockApiFetch.mockResolvedValue({ ok: true, status: 200, json: async () => readiness });
    const { result } = renderHook(() => useRemoteReadiness(), { wrapper });
    await waitFor(() => expect(result.current.readiness).toEqual(readiness));
  });

  it('turns an incomplete answer into an error', async () => {
    mockApiFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    const { result } = renderHook(() => useRemoteReadiness(), { wrapper });
    await waitFor(() =>
      expect(result.current.error?.message).toBe(
        'Could not check this PC: the answer was incomplete.',
      ),
    );
    expect(result.current.readiness).toBeNull();
  });
});
