import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PromptsPage } from './PromptsPage';
const useSelectedProjectMock = jest.fn();

const toastSpy = jest.fn();

jest.mock('@/ui/hooks/use-toast', () => ({
  useToast: () => ({ toast: toastSpy }),
}));

jest.mock('@/ui/hooks/useProjectSelection', () => ({
  useSelectedProject: () => useSelectedProjectMock(),
}));

jest.mock('@/ui/components/shared/ConfirmDialog', () => ({
  ConfirmDialog: ({
    open,
    title,
    confirmText,
    cancelText,
    onConfirm,
    onOpenChange,
  }: {
    open: boolean;
    title: string;
    confirmText: string;
    cancelText: string;
    onConfirm: () => void;
    onOpenChange: (open: boolean) => void;
  }) =>
    open ? (
      <div>
        <p>{title}</p>
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
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  return { Wrapper, queryClient };
}

describe('PromptsPage variable helper', () => {
  const originalFetch = global.fetch;
  const fetchMock = jest.fn();
  let promptTags: string[];

  beforeEach(() => {
    promptTags = ['ops', 'type:custom'];
    useSelectedProjectMock.mockReturnValue({
      selectedProjectId: 'project-1',
      selectedProject: { id: 'project-1', name: 'Demo' },
    });
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.startsWith('/api/prompts?projectId=project-1')) {
        return {
          ok: true,
          json: async () => ({
            items: [
              {
                id: 'prompt-1',
                projectId: 'project-1',
                title: 'Prompt A',
                contentPreview: 'Preview A',
                version: 1,
                tags: promptTags,
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-02T00:00:00.000Z',
              },
            ],
            total: 1,
            limit: 50,
            offset: 0,
          }),
        } as Response;
      }

      if (url === '/api/prompts/prompt-1') {
        return {
          ok: true,
          json: async () => ({
            id: 'prompt-1',
            projectId: 'project-1',
            title: 'Prompt A',
            content: 'Prompt content',
            contentPreview: 'Preview A',
            version: 1,
            tags: promptTags,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-02T00:00:00.000Z',
          }),
        } as Response;
      }

      return {
        ok: true,
        json: async () => ({}),
      } as Response;
    });

    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    fetchMock.mockReset();
    toastSpy.mockReset();
  });

  it('displays the available variables helper panel in the prompt dialog', async () => {
    const { Wrapper } = createWrapper();

    await act(async () => {
      render(
        <Wrapper>
          <PromptsPage />
        </Wrapper>,
      );
    });

    const createButton = await screen.findByRole('button', { name: /create prompt/i });
    await act(async () => {
      fireEvent.click(createButton);
    });

    expect(await screen.findByText('Available Variables')).toBeInTheDocument();
    expect(screen.getByText('{agent_name}')).toBeInTheDocument();
    expect(screen.getByText('{project_name}')).toBeInTheDocument();
    expect(screen.getByText('{epic_title}')).toBeInTheDocument();
    expect(screen.getByText('{provider_name}')).toBeInTheDocument();
    expect(screen.getByText('{profile_name}')).toBeInTheDocument();
    expect(screen.getByText('{session_id}')).toBeInTheDocument();
    expect(screen.getByText('{session_id_short}')).toBeInTheDocument();
  });

  it('defaults create to accessible Custom type and submits one canonical type tag', async () => {
    const { Wrapper } = createWrapper();
    render(
      <Wrapper>
        <PromptsPage />
      </Wrapper>,
    );

    fireEvent.click(await screen.findByRole('button', { name: /create prompt/i }));

    const typeSelect = screen.getByLabelText('Type');
    expect(typeSelect).toHaveAttribute('role', 'combobox');
    expect(typeSelect).toHaveTextContent('Custom');

    fireEvent.change(screen.getByLabelText('Title *'), { target: { value: 'New Prompt' } });
    fireEvent.change(screen.getByLabelText('Content *'), { target: { value: 'New content' } });
    fireEvent.change(screen.getByLabelText('Tags'), { target: { value: 'type:system' } });
    fireEvent.keyDown(screen.getByLabelText('Tags'), { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
      expect(postCall).toBeDefined();
      expect(JSON.parse(postCall?.[1]?.body as string)).toEqual({
        projectId: 'project-1',
        title: 'New Prompt',
        content: 'New content',
        tags: ['type:custom'],
      });
    });
  });

  it('supports keyboard selection of System and submits the selected canonical type', async () => {
    const { Wrapper } = createWrapper();
    render(
      <Wrapper>
        <PromptsPage />
      </Wrapper>,
    );

    fireEvent.click(await screen.findByRole('button', { name: /create prompt/i }));
    const typeSelect = screen.getByLabelText('Type');
    fireEvent.keyDown(typeSelect, { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name: 'System' }));

    fireEvent.change(screen.getByLabelText('Title *'), { target: { value: 'System Prompt' } });
    fireEvent.change(screen.getByLabelText('Content *'), { target: { value: 'Instructions' } });
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
      expect(JSON.parse(postCall?.[1]?.body as string).tags).toEqual(['type:system']);
    });
  });

  it.each([
    {
      name: 'System with ambiguous tags',
      tags: ['ops', 'type:custom', 'type:future', ' TYPE : SYSTEM '],
      expectedType: 'System',
      expectedTag: 'type:system',
    },
    {
      name: 'Custom',
      tags: ['ops', 'type:custom'],
      expectedType: 'Custom',
      expectedTag: 'type:custom',
    },
    {
      name: 'unknown explicit type',
      tags: ['ops', 'type:future'],
      expectedType: 'Custom',
      expectedTag: 'type:custom',
    },
    {
      name: 'untyped legacy prompt',
      tags: ['ops'],
      expectedType: 'System',
      expectedTag: 'type:system',
    },
  ])(
    'hydrates and canonicalizes $name while preserving unrelated tags',
    async ({ tags, expectedType, expectedTag }) => {
      promptTags = tags;
      const { Wrapper } = createWrapper();
      render(
        <Wrapper>
          <PromptsPage />
        </Wrapper>,
      );

      expect(await screen.findByText(`Type: ${expectedType}`)).toBeInTheDocument();
      fireEvent.click(await screen.findByRole('button', { name: /^edit$/i }));

      await waitFor(() => {
        expect(screen.getByLabelText('Type')).toHaveTextContent(expectedType);
      });
      expect(screen.getAllByText('ops')).not.toHaveLength(0);
      expect(screen.queryByText('type:future')).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /^update$/i }));

      await waitFor(() => {
        const putCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
        expect(JSON.parse(putCall?.[1]?.body as string)).toEqual({
          title: 'Prompt A',
          content: 'Prompt content',
          tags: ['ops', expectedTag],
          version: 1,
        });
      });
    },
  );

  it('keeps reserved type tags out of cards, suggestions, and tag filtering', async () => {
    promptTags = ['ops', 'type:system', 'TYPE:future'];
    const { Wrapper } = createWrapper();
    render(
      <Wrapper>
        <PromptsPage />
      </Wrapper>,
    );

    expect(await screen.findByText('Type: System')).toBeInTheDocument();
    expect(screen.queryByText('type:system')).not.toBeInTheDocument();
    expect(screen.queryByText('TYPE:future')).not.toBeInTheDocument();

    const filter = screen.getByLabelText('Filter by tag:');
    expect(Array.from((filter as HTMLSelectElement).options).map((option) => option.value)).toEqual(
      ['', 'ops'],
    );

    fireEvent.click(screen.getByRole('button', { name: /create prompt/i }));
    fireEvent.change(screen.getByLabelText('Tags'), { target: { value: 'type' } });
    expect(screen.queryByRole('button', { name: /type:(system|future)/i })).not.toBeInTheDocument();
  });

  it('opens delete confirm and cancels without deleting', async () => {
    const { Wrapper } = createWrapper();

    await act(async () => {
      render(
        <Wrapper>
          <PromptsPage />
        </Wrapper>,
      );
    });

    const deleteButton = await screen.findByRole('button', { name: /^delete$/i });
    await act(async () => {
      fireEvent.click(deleteButton);
    });

    expect(screen.getByText('Delete prompt?')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    });

    await waitFor(() => {
      const deleteCalls = fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE');
      expect(deleteCalls).toHaveLength(0);
    });
  });

  it('deletes prompt after confirming dialog action', async () => {
    const { Wrapper } = createWrapper();

    await act(async () => {
      render(
        <Wrapper>
          <PromptsPage />
        </Wrapper>,
      );
    });

    const deleteButton = await screen.findByRole('button', { name: /^delete$/i });
    await act(async () => {
      fireEvent.click(deleteButton);
    });

    await act(async () => {
      const deleteButtons = screen.getAllByRole('button', { name: /^delete$/i });
      fireEvent.click(deleteButtons[deleteButtons.length - 1]);
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/prompts/prompt-1', { method: 'DELETE' });
    });
  });
});
