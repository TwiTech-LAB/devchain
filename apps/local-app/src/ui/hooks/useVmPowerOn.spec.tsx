import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useVmPowerOn } from './useVmPowerOn';

const mockApiFetch = jest.fn();
jest.mock('@/ui/lib/api-transport', () => {
  const actual = jest.requireActual('@/ui/lib/api-transport');
  return { ...actual, apiFetch: (...args: unknown[]) => mockApiFetch(...args) };
});

const toastSpy = jest.fn();
jest.mock('@/ui/hooks/use-toast', () => ({ useToast: () => ({ toast: toastSpy }) }));

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
}

// Hook unit: the refusal path has no page state to show besides the toast.
describe('useVmPowerOn', () => {
  it('shows the server refusal and starts no "Starting" period', async () => {
    mockApiFetch.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        message: 'A host lifecycle operation is already open for this remote.',
      }),
    });
    const { result } = renderHook(() => useVmPowerOn(), { wrapper });

    await act(async () => result.current.powerOn({ id: 'r1', name: 'lab-vm' }));

    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Could not power on lab-vm',
        description: 'A host lifecycle operation is already open for this remote.',
        variant: 'destructive',
      }),
    );
    expect(result.current.poweredOnAt.size).toBe(0);
    expect(result.current.pending.size).toBe(0);
  });
});
