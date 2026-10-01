import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { RemoteListItemDto } from '@/modules/remotes/dtos/remote.dto';
import { useHomeSocket } from './useHomeSocket';
import { useRemotes } from './useRemotes';

jest.mock('./useHomeSocket', () => ({ useHomeSocket: jest.fn() }));
jest.mock('./useProjectSelection', () => ({
  useSelectedProject: () => ({ projects: [], projectsLoading: false }),
}));

const mockApiFetch = jest.fn();
jest.mock('@/ui/lib/api-transport', () => {
  const actual = jest.requireActual('@/ui/lib/api-transport');
  return {
    ...actual,
    apiFetch: (...args: unknown[]) => mockApiFetch(...args),
  };
});

const remote: RemoteListItemDto = {
  id: 'r1',
  name: 'lab-vm',
  baseUrl: 'http://10.0.0.5:4000',
  kind: 'address',
  vmProviderConnectionId: null,
  vmIdentity: null,
  vmSpec: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  online: true,
  version: '1.0.0',
  versionMatches: true,
  uid: 1000,
  gid: 1000,
  stats: null,
  lastSeenAt: '2026-01-01T00:00:00.000Z',
  homePath: '/home/alice',
  homePathMatches: true,
  lastOperation: null,
  userName: null,
  logins: null,
};

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function emit(payload: Record<string, unknown>) {
  const [handlers] = jest.mocked(useHomeSocket).mock.calls.at(-1)!;
  const message = (handlers as { message: (envelope: unknown) => void }).message;
  act(() => message({ topic: 'remotes', type: 'state', payload, ts: '' }));
}

// Layer: UI hook unit (Jest). The cache patch is hook-owned logic; the socket
// boundary is mocked so the test can deliver the exact server payload.
describe('useRemotes remotes/state patch', () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
    mockApiFetch.mockImplementation(async (path: string) => ({
      ok: true,
      json: async () => ({ items: path === '/api/remotes' ? [remote] : [] }),
    }));
  });

  it('patches rejection and clears it on an accepted poll', async () => {
    const { result } = renderHook(() => useRemotes(), { wrapper });
    await waitFor(() => expect(result.current.remotes).toHaveLength(1));
    emit({ remoteId: 'r1', online: true, apiKeyRejected: true, stats: null });
    await waitFor(() =>
      expect(result.current.remotes[0]).toMatchObject({
        apiKeyRejected: true,
        online: true,
        stats: null,
      }),
    );
    emit({ remoteId: 'r1', apiKeyRejected: false });
    await waitFor(() => expect(result.current.remotes[0].apiKeyRejected).toBe(false));
  });

  it('sends an add-by-address key without retaining it in mutation variables', async () => {
    const key = `dck_${'a'.repeat(43)}`;
    mockApiFetch.mockImplementation(async (_path: string, init?: RequestInit) => ({
      ok: true,
      json: async () => (init?.method === 'POST' ? remote : { items: [] }),
    }));
    const { result } = renderHook(() => useRemotes(), { wrapper });
    await act(async () => {
      await result.current.createRemote.mutateAsync({
        name: 'vm',
        baseUrl: 'http://vm',
        apiKey: key,
      });
    });
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/remotes',
      expect.objectContaining({
        body: JSON.stringify({ name: 'vm', baseUrl: 'http://vm', apiKey: key }),
      }),
      expect.anything(),
    );
    expect(result.current.createRemote.variables).toEqual({ name: 'vm', baseUrl: 'http://vm' });
    expect(JSON.stringify(result.current.createRemote.data)).not.toContain(key);
  });

  it('carries the home folder and whether it matches', async () => {
    const { result } = renderHook(() => useRemotes(), { wrapper });
    await waitFor(() => expect(result.current.remotes).toHaveLength(1));

    emit({ remoteId: 'r1', online: true, homePath: '/home/bob', homePathMatches: false });

    await waitFor(() =>
      expect(result.current.remotes[0]).toMatchObject({
        homePath: '/home/bob',
        homePathMatches: false,
      }),
    );
  });

  it('clears both when the VM stops reporting a home folder', async () => {
    const { result } = renderHook(() => useRemotes(), { wrapper });
    await waitFor(() => expect(result.current.remotes).toHaveLength(1));

    emit({ remoteId: 'r1', online: false, homePath: null, homePathMatches: null });

    await waitFor(() =>
      expect(result.current.remotes[0]).toMatchObject({
        online: false,
        homePath: null,
        homePathMatches: null,
      }),
    );
  });

  it('keeps both when the event does not carry them', async () => {
    const { result } = renderHook(() => useRemotes(), { wrapper });
    await waitFor(() => expect(result.current.remotes).toHaveLength(1));

    emit({ remoteId: 'r1', online: false });

    await waitFor(() => expect(result.current.remotes[0].online).toBe(false));
    expect(result.current.remotes[0]).toMatchObject({
      homePath: '/home/alice',
      homePathMatches: true,
    });
  });
  it('patches CLI reports, retains them while offline, and respects an explicit null', async () => {
    const { result } = renderHook(() => useRemotes(), { wrapper });
    await waitFor(() => expect(result.current.remotes).toHaveLength(1));
    const providerClis = {
      claude: {
        installedVersion: '2.0.0',
        desiredVersion: 'latest',
        state: 'idle',
        error: null,
        checkedAt: null,
      },
    };
    emit({ remoteId: 'r1', online: true, providerClis, cliVersions: { agy: '1.0.0' } });
    await waitFor(() => expect(result.current.remotes[0].providerClis).toEqual(providerClis));
    emit({ remoteId: 'r1', online: false });
    await waitFor(() => expect(result.current.remotes[0].online).toBe(false));
    expect(result.current.remotes[0].providerClis).toEqual(providerClis);
    expect(result.current.remotes[0].cliVersions).toEqual({ agy: '1.0.0' });
    emit({ remoteId: 'r1', online: true, providerClis: null, cliVersions: null });
    await waitFor(() => expect(result.current.remotes[0].providerClis).toBeNull());
    expect(result.current.remotes[0].cliVersions).toBeNull();
  });
});
