import { renderHook, act } from '@testing-library/react';
import { useProjectPreconfigFlow } from '@/ui/hooks/useProjectPreconfigFlow';

describe('useProjectPreconfigFlow', () => {
  let originalFetch: typeof global.fetch | undefined;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    if (originalFetch) {
      global.fetch = originalFetch;
    } else {
      delete (global as Record<string, unknown>).fetch;
    }
  });

  it('0 teams: calls mutate directly without opening modal', async () => {
    const mutateMock = jest.fn();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ teams: [], profiles: [] }),
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useProjectPreconfigFlow({ mutate: mutateMock }));

    await act(async () => {
      await result.current.handleCreateWithPreconfig({
        name: 'Test',
        rootPath: '/tmp',
        templateId: 'empty-template',
      });
    });

    expect(result.current.preconfigOpen).toBe(false);
    expect(mutateMock).toHaveBeenCalledTimes(1);
    expect(mutateMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Test', templateId: 'empty-template' }),
    );
  });

  it('preview error: calls mutate directly as fallback', async () => {
    const mutateMock = jest.fn();
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useProjectPreconfigFlow({ mutate: mutateMock }));

    await act(async () => {
      await result.current.handleCreateWithPreconfig({
        name: 'Test',
        rootPath: '/tmp',
        templateId: 'missing-template',
      });
    });

    expect(result.current.preconfigOpen).toBe(false);
    expect(mutateMock).toHaveBeenCalledTimes(1);
  });

  it('teams present: opens modal instead of calling mutate', async () => {
    const mutateMock = jest.fn();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        teams: [{ name: 'Dev Team', memberAgentNames: ['Lead'], allowTeamLeadCreateAgents: true }],
        profiles: [],
      }),
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useProjectPreconfigFlow({ mutate: mutateMock }));

    await act(async () => {
      await result.current.handleCreateWithPreconfig({
        name: 'Test',
        rootPath: '/tmp',
        templateId: 'teams-template',
      });
    });

    expect(result.current.preconfigOpen).toBe(true);
    expect(result.current.preconfigTeams).toHaveLength(1);
    expect(mutateMock).not.toHaveBeenCalled();
  });
});
