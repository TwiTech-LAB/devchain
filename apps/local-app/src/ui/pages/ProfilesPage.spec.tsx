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

  it('cancels then confirms profile delete through the delete endpoint', async () => {
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
    expect(await screen.findByRole('dialog', { name: /delete profile/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(fetchMock).not.toHaveBeenCalledWith('/api/profiles/profile-1', expect.anything());

    fireEvent.click(deleteButton);

    fireEvent.click(await screen.findByRole('button', { name: /^delete$/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/profiles/profile-1', { method: 'DELETE' });
    });
  });

  it('cancels then confirms provider configuration delete through the delete endpoint', async () => {
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
    const cancelDialog = await screen.findByRole('dialog', { name: /delete configuration/i });
    expect(cancelDialog).toBeInTheDocument();
    fireEvent.click(within(cancelDialog).getByRole('button', { name: /cancel/i }));
    expect(fetchMock).not.toHaveBeenCalledWith('/api/provider-configs/config-1', expect.anything());
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

describe('ProfilesPage persist prompt ordering', () => {
  const originalFetch = global.fetch;
  const fetchMock = jest.fn();

  beforeEach(() => {
    useSelectedProjectMock.mockReturnValue({
      selectedProjectId: 'project-1',
      selectedProject: { id: 'project-1', name: 'Demo' },
    });

    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method || 'GET').toUpperCase();

      if (url.startsWith('/api/profiles?projectId=project-1')) {
        return {
          ok: true,
          json: async () => ({ items: [], total: 0, limit: 0, offset: 0 }),
        } as Response;
      }

      if (url.startsWith('/api/providers')) {
        return {
          ok: true,
          json: async () => ({ items: [{ id: 'prov-1', name: 'codex', binPath: null }] }),
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

      if (url === '/api/profiles' && method === 'POST') {
        return {
          ok: true,
          json: async () => ({ id: 'prof-1', name: 'X' }),
        } as Response;
      }

      if (url === '/api/profiles/prof-1/prompts' && method === 'PUT') {
        return {
          ok: true,
          json: async () => ({ profileId: 'prof-1', prompts: [] }),
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

  it('calls prompts replace endpoint after creating a profile with ordered prompts', async () => {
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

    // Fill required fields
    const nameInput = screen.getByLabelText(/name \*/i) as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'Runner' } });

    // Add two prompts
    await screen.findByText('Add Prompts');
    fireEvent.click(screen.getByText('First Prompt'));
    fireEvent.click(screen.getByText('Second Prompt'));

    const submitBtn = screen.getByRole('button', { name: /^create$/i });
    await act(async () => {
      fireEvent.click(submitBtn);
    });

    // Assert replace endpoint called with ordered promptIds
    const calls = fetchMock.mock.calls.map(([u, init]) => ({
      url: typeof u === 'string' ? u : u.toString(),
      method: (init?.method || 'GET').toUpperCase(),
      body: init?.body as string | undefined,
    }));
    const replaceCall = calls.find(
      (c) => c.url === '/api/profiles/prof-1/prompts' && c.method === 'PUT',
    );
    expect(replaceCall).toBeTruthy();
    const parsed = JSON.parse(replaceCall!.body || '{}');
    expect(parsed.promptIds).toEqual(['p1', 'p2']);
  });
});

describe('ProfilesPage update flow persists order', () => {
  const originalFetch = global.fetch;
  const fetchMock = jest.fn();

  beforeEach(() => {
    useSelectedProjectMock.mockReturnValue({
      selectedProjectId: 'project-1',
      selectedProject: { id: 'project-1', name: 'Demo' },
    });

    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method || 'GET').toUpperCase();

      if (url.startsWith('/api/profiles?projectId=project-1')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              {
                id: 'prof-1',
                name: 'Runner',
                providerId: 'prov-1',
                provider: { id: 'prov-1', name: 'codex', binPath: null },
                options: null,
                instructions: null,
                prompts: [
                  { promptId: 'p1', order: 1, prompt: { id: 'p1', title: 'First Prompt' } },
                  { promptId: 'p2', order: 2, prompt: { id: 'p2', title: 'Second Prompt' } },
                ],
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
          json: async () => ({ items: [{ id: 'prov-1', name: 'codex' }] }),
        } as Response;
      }

      if (url.startsWith('/api/prompts?projectId=project-1')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              { id: 'p1', title: 'First Prompt', content: '' },
              { id: 'p2', title: 'Second Prompt', content: '' },
            ],
          }),
        } as Response;
      }

      if (url === '/api/profiles/prof-1' && method === 'PUT') {
        return { ok: true, json: async () => ({ id: 'prof-1' }) } as Response;
      }

      if (url === '/api/profiles/prof-1/prompts' && method === 'PUT') {
        return { ok: true, json: async () => ({ profileId: 'prof-1', prompts: [] }) } as Response;
      }

      // Provider configs endpoint - return empty array
      if (url.match(/\/api\/profiles\/[^/]+\/provider-configs/)) {
        return { ok: true, json: async () => [] } as Response;
      }

      return { ok: true, json: async () => ({}) } as Response;
    });

    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    fetchMock.mockReset();
  });

  it('reorders via UI and sends ordered promptIds on update', async () => {
    const { Wrapper } = createWrapper();

    await act(async () => {
      render(
        <Wrapper>
          <ProfilesPage />
        </Wrapper>,
      );
    });

    // Open editor for existing profile
    const editBtn = await screen.findByRole('button', { name: /edit/i });
    await act(async () => {
      fireEvent.click(editBtn);
    });

    // In the assigned list, move the first prompt down using control button
    const downButtons = await screen.findAllByRole('button', { name: /move down/i });
    fireEvent.click(downButtons[0]);

    const submitBtn = screen.getByRole('button', { name: /^update$/i });
    await act(async () => {
      fireEvent.click(submitBtn);
    });

    // Expect replace call with reversed order
    const calls = fetchMock.mock.calls.map(([u, init]) => ({
      url: typeof u === 'string' ? u : u.toString(),
      method: (init?.method || 'GET').toUpperCase(),
      body: init?.body as string | undefined,
    }));
    const replaceCall = calls.find(
      (c) => c.url === '/api/profiles/prof-1/prompts' && c.method === 'PUT',
    );
    expect(replaceCall).toBeTruthy();
    const parsed = JSON.parse(replaceCall!.body || '{}');
    expect(parsed.promptIds).toEqual(['p2', 'p1']);
  });
});
