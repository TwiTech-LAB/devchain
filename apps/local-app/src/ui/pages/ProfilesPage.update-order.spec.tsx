import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ProfilesPage } from './ProfilesPage';

const useSelectedProjectMock = jest.fn();

jest.mock('@/ui/hooks/useProjectSelection', () => ({
  useSelectedProject: () => useSelectedProjectMock(),
}));

jest.mock('@/ui/hooks/use-toast', () => ({
  useToast: () => ({ toast: jest.fn() }),
}));

function createWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { Wrapper, queryClient };
}

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
