import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useTeamQuickEdit } from './useTeamQuickEdit';

const toast = jest.fn();
const showError = jest.fn();
jest.mock('@/ui/lib/toast-helpers', () => ({
  useToastHelpers: () => ({ toast, showError, showSuccess: jest.fn() }),
  getErrorMessage: (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback),
}));

const updateTeam = jest.fn();
jest.mock('@/ui/lib/teams', () => ({
  updateTeam: (...args: unknown[]) => updateTeam(...args),
  teamsQueryKeys: {
    teams: (pid: string) => ['teams', pid],
    detail: (id: string) => ['teams', 'detail', id],
  },
}));

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

const target = {
  teamId: 't1',
  teamName: 'Core',
  maxMembers: 8,
  maxConcurrentTasks: 3,
  allowTeamLeadCreateAgents: true,
};

describe('useTeamQuickEdit', () => {
  beforeEach(() => jest.clearAllMocks());

  it('openEditTeam seeds the target and form fields; closeEditTeam clears', () => {
    const client = new QueryClient();
    const { result } = renderHook(() => useTeamQuickEdit({ projectId: 'p1' }), {
      wrapper: wrapper(client),
    });

    act(() => result.current.openEditTeam(target));
    expect(result.current.quickEditTeam).toEqual(target);
    expect(result.current.maxMembers).toBe(8);
    expect(result.current.maxConcurrentTasks).toBe(3);
    expect(result.current.allowTeamLeadCreateAgents).toBe(true);

    act(() => result.current.closeEditTeam());
    expect(result.current.quickEditTeam).toBeNull();
  });

  it('submit mutates with current form values, toasts, invalidates list + detail, and closes', async () => {
    updateTeam.mockResolvedValue({});
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const invalidate = jest.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useTeamQuickEdit({ projectId: 'p1' }), {
      wrapper: wrapper(client),
    });

    act(() => result.current.openEditTeam(target));
    act(() => result.current.setMaxMembers(6));
    act(() => result.current.submit());

    await waitFor(() => expect(result.current.quickEditTeam).toBeNull());
    expect(updateTeam).toHaveBeenCalledWith('t1', {
      maxMembers: 6,
      maxConcurrentTasks: 3,
      allowTeamLeadCreateAgents: true,
    });
    expect(toast).toHaveBeenCalledWith({ title: "Team 'Core' updated" });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['teams', 'p1'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['teams', 'detail', 't1'] });
  });

  it('submit is a no-op when nothing is open', () => {
    const client = new QueryClient();
    const { result } = renderHook(() => useTeamQuickEdit({ projectId: 'p1' }), {
      wrapper: wrapper(client),
    });
    act(() => result.current.submit());
    expect(updateTeam).not.toHaveBeenCalled();
  });

  it('surfaces a destructive error toast on failure', async () => {
    updateTeam.mockRejectedValue(new Error('nope'));
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const { result } = renderHook(() => useTeamQuickEdit({ projectId: 'p1' }), {
      wrapper: wrapper(client),
    });

    act(() => result.current.openEditTeam(target));
    act(() => result.current.submit());

    await waitFor(() =>
      expect(showError).toHaveBeenCalledWith({
        title: 'Failed to update team',
        description: 'nope',
      }),
    );
  });
});
