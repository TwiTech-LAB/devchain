import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ProfilesPage } from './ProfilesPage';

const useSelectedProjectMock = jest.fn();

jest.mock('@/ui/hooks/useProjectSelection', () => ({
  useSelectedProject: () => useSelectedProjectMock(),
}));

jest.mock('@/ui/hooks/use-toast', () => ({
  useToast: () => ({ toast: jest.fn() }),
}));

jest.mock('@/ui/components/shared/ConfirmDialog', () => ({
  ConfirmDialog: ({
    open,
    title,
    description,
    confirmText,
    cancelText,
    onConfirm,
    onOpenChange,
  }: {
    open: boolean;
    title: string;
    description: React.ReactNode;
    confirmText: string;
    cancelText: string;
    onConfirm: () => void;
    onOpenChange: (open: boolean) => void;
  }) =>
    open ? (
      <div role="dialog" aria-label={title}>
        <p>{description}</p>
        <button type="button" onClick={() => onOpenChange(false)}>
          {cancelText}
        </button>
        <button type="button" onClick={onConfirm}>
          {confirmText}
        </button>
      </div>
    ) : null,
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  return { Wrapper, queryClient };
}

describe('ProfilesPage prompts fetch by project', () => {
  const originalFetch = global.fetch;
  const fetchMock = jest.fn();

  beforeEach(() => {
    useSelectedProjectMock.mockReturnValue({
      selectedProjectId: 'project-1',
      selectedProject: { id: 'project-1', name: 'Demo' },
    });

    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.startsWith('/api/profiles?projectId=project-1')) {
        return {
          ok: true,
          json: async () => ({ items: [], total: 0, limit: 0, offset: 0 }),
        } as Response;
      }

      if (url.startsWith('/api/providers')) {
        return {
          ok: true,
          json: async () => ({ items: [], total: 0, limit: 0, offset: 0 }),
        } as Response;
      }

      if (url.startsWith('/api/prompts?projectId=project-1')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              { id: 'p1', title: 'First Prompt', content: '...' },
              { id: 'p2', title: 'Second Prompt', content: '...' },
            ],
            total: 2,
            limit: 1000,
            offset: 0,
          }),
        } as Response;
      }

      return { ok: true, json: async () => ({}) } as Response;
    });

    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    fetchMock.mockReset();
  });

  it('shows available prompts in profile editor when a project is selected', async () => {
    const { Wrapper } = createWrapper();

    await act(async () => {
      render(
        <Wrapper>
          <ProfilesPage />
        </Wrapper>,
      );
    });

    const createButton = await screen.findByRole('button', { name: /create profile/i });
    await act(async () => {
      fireEvent.click(createButton);
    });

    expect(await screen.findByText('Add Prompts')).toBeInTheDocument();
    expect(screen.getByText('First Prompt')).toBeInTheDocument();
    expect(screen.getByText('Second Prompt')).toBeInTheDocument();
  });

  it('cancels profile delete without calling the delete endpoint', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.startsWith('/api/profiles?projectId=project-1')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              {
                id: 'profile-1',
                name: 'Runner',
                provider: null,
                prompts: [],
                agentCount: 0,
                createdAt: '',
                updatedAt: '',
              },
            ],
            total: 1,
            limit: 1,
            offset: 0,
          }),
        } as Response;
      }

      if (url.startsWith('/api/providers')) {
        return {
          ok: true,
          json: async () => ({ items: [], total: 0, limit: 0, offset: 0 }),
        } as Response;
      }

      if (url.startsWith('/api/prompts?projectId=project-1')) {
        return {
          ok: true,
          json: async () => ({ items: [], total: 0, limit: 0, offset: 0 }),
        } as Response;
      }

      return { ok: true, json: async () => ({}) } as Response;
    });

    const { Wrapper } = createWrapper();
    render(
      <Wrapper>
        <ProfilesPage />
      </Wrapper>,
    );

    const deleteButton = await screen.findByRole('button', { name: /delete profile runner/i });
    fireEvent.click(deleteButton);
    expect(await screen.findByRole('dialog', { name: /delete profile/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(fetchMock).not.toHaveBeenCalledWith('/api/profiles/profile-1', expect.anything());
  });

  it('confirms profile delete through the delete endpoint', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method || 'GET').toUpperCase();

      if (url.startsWith('/api/profiles?projectId=project-1')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              {
                id: 'profile-1',
                name: 'Runner',
                provider: null,
                prompts: [],
                agentCount: 0,
                createdAt: '',
                updatedAt: '',
              },
            ],
            total: 1,
            limit: 1,
            offset: 0,
          }),
        } as Response;
      }

      if (url.startsWith('/api/providers')) {
        return {
          ok: true,
          json: async () => ({ items: [], total: 0, limit: 0, offset: 0 }),
        } as Response;
      }

      if (url.startsWith('/api/prompts?projectId=project-1')) {
        return {
          ok: true,
          json: async () => ({ items: [], total: 0, limit: 0, offset: 0 }),
        } as Response;
      }

      if (url === '/api/profiles/profile-1' && method === 'DELETE') {
        return { ok: true, json: async () => ({}) } as Response;
      }

      return { ok: true, json: async () => ({}) } as Response;
    });

    const { Wrapper } = createWrapper();
    render(
      <Wrapper>
        <ProfilesPage />
      </Wrapper>,
    );

    const deleteButton = await screen.findByRole('button', { name: /delete profile runner/i });
    fireEvent.click(deleteButton);
    fireEvent.click(await screen.findByRole('button', { name: /^delete$/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/profiles/profile-1', { method: 'DELETE' });
    });
  });

  it('cancels provider configuration delete without calling the delete endpoint', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method || 'GET').toUpperCase();

      if (url.startsWith('/api/profiles?projectId=project-1')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              {
                id: 'profile-1',
                name: 'Runner',
                provider: null,
                prompts: [],
                agentCount: 0,
                createdAt: '',
                updatedAt: '',
              },
            ],
            total: 1,
            limit: 1,
            offset: 0,
          }),
        } as Response;
      }

      if (url.startsWith('/api/providers')) {
        return {
          ok: true,
          json: async () => ({ items: [{ id: 'provider-1', name: 'codex', binPath: null }] }),
        } as Response;
      }

      if (url.startsWith('/api/prompts?projectId=project-1')) {
        return {
          ok: true,
          json: async () => ({ items: [], total: 0, limit: 0, offset: 0 }),
        } as Response;
      }

      if (url === '/api/profiles/profile-1/provider-configs' && method === 'GET') {
        return {
          ok: true,
          json: async () => [
            {
              id: 'config-1',
              profileId: 'profile-1',
              providerId: 'provider-1',
              name: 'codex-default',
              description: null,
              options: null,
              env: null,
              createdAt: '',
              updatedAt: '',
            },
          ],
        } as Response;
      }

      return { ok: true, json: async () => ({}) } as Response;
    });

    const { Wrapper } = createWrapper();
    render(
      <Wrapper>
        <ProfilesPage />
      </Wrapper>,
    );

    fireEvent.click(await screen.findByRole('button', { name: /^edit$/i }));
    const deleteConfigButton = await screen.findByRole('button', {
      name: /delete configuration codex-default/i,
    });
    fireEvent.click(deleteConfigButton);
    const dialog = await screen.findByRole('dialog', { name: /delete configuration/i });
    expect(dialog).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: /cancel/i }));

    expect(fetchMock).not.toHaveBeenCalledWith('/api/provider-configs/config-1', expect.anything());
  });

  it('confirms provider configuration delete through the delete endpoint', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method || 'GET').toUpperCase();

      if (url.startsWith('/api/profiles?projectId=project-1')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              {
                id: 'profile-1',
                name: 'Runner',
                provider: null,
                prompts: [],
                agentCount: 0,
                createdAt: '',
                updatedAt: '',
              },
            ],
            total: 1,
            limit: 1,
            offset: 0,
          }),
        } as Response;
      }

      if (url.startsWith('/api/providers')) {
        return {
          ok: true,
          json: async () => ({ items: [{ id: 'provider-1', name: 'codex', binPath: null }] }),
        } as Response;
      }

      if (url.startsWith('/api/prompts?projectId=project-1')) {
        return {
          ok: true,
          json: async () => ({ items: [], total: 0, limit: 0, offset: 0 }),
        } as Response;
      }

      if (url === '/api/profiles/profile-1/provider-configs' && method === 'GET') {
        return {
          ok: true,
          json: async () => [
            {
              id: 'config-1',
              profileId: 'profile-1',
              providerId: 'provider-1',
              name: 'codex-default',
              description: null,
              options: null,
              env: null,
              createdAt: '',
              updatedAt: '',
            },
          ],
        } as Response;
      }

      if (url === '/api/provider-configs/config-1' && method === 'DELETE') {
        return { ok: true, json: async () => ({}) } as Response;
      }

      return { ok: true, json: async () => ({}) } as Response;
    });

    const { Wrapper } = createWrapper();
    render(
      <Wrapper>
        <ProfilesPage />
      </Wrapper>,
    );

    fireEvent.click(await screen.findByRole('button', { name: /^edit$/i }));
    fireEvent.click(
      await screen.findByRole('button', { name: /delete configuration codex-default/i }),
    );
    const dialog = await screen.findByRole('dialog', { name: /delete configuration/i });
    fireEvent.click(within(dialog).getByRole('button', { name: /^delete$/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/provider-configs/config-1', {
        method: 'DELETE',
      });
    });
  });
});
