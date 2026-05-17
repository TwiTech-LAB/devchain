import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { EpicDetailPage } from './EpicDetailPage';

const mockNavigate = jest.fn();
const mockUseSelectedProject = jest.fn();
const mockApiFetch = jest.fn();

jest.mock('@/ui/hooks/useProjectSelection', () => ({
  useSelectedProject: () => mockUseSelectedProject(),
}));

jest.mock('@/ui/hooks/use-toast', () => ({
  useToast: () => ({ toast: jest.fn() }),
}));

jest.mock('@/ui/hooks/useFetchFactory', () => ({
  useFetchFactory: () => mockApiFetch,
}));

jest.mock('@/ui/terminal-windows', () => ({
  useTerminalWindowManager: () => jest.fn(),
}));

jest.mock('@/ui/components/skills/SkillDetailDrawer', () => ({
  SkillDetailDrawer: () => null,
}));

jest.mock('@/ui/components/shared/SubEpicsBoard', () => ({
  SubEpicsBoard: ({ onDeleteSubEpic }: { onDeleteSubEpic?: (subEpicId: string) => void }) => (
    <button type="button" onClick={() => onDeleteSubEpic?.('sub-epic-1')}>
      Delete child work item
    </button>
  ),
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

jest.mock('react-router-dom', () => {
  const actual = jest.requireActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/epics/epic-1']}>
        <Routes>
          <Route path="/epics/:id" element={children} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );

  return { Wrapper, queryClient };
}

function jsonResponse(data: unknown): Response {
  return {
    ok: true,
    json: async () => data,
  } as Response;
}

function mockEpicFetches() {
  mockApiFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method || 'GET').toUpperCase();

    if (url === '/api/epics/epic-1' && method === 'GET') {
      return jsonResponse({
        id: 'epic-1',
        projectId: 'project-1',
        title: 'Parent Epic',
        description: null,
        statusId: 'status-1',
        version: 7,
        parentId: null,
        agentId: null,
        tags: [],
        skillsRequired: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
    }

    if (url === '/api/statuses?projectId=project-1') {
      return jsonResponse({
        items: [
          {
            id: 'status-1',
            projectId: 'project-1',
            label: 'New',
            color: '#2563eb',
            position: 1,
            createdAt: '',
            updatedAt: '',
          },
        ],
      });
    }

    if (url === '/api/agents?projectId=project-1') {
      return jsonResponse({ items: [] });
    }

    if (url.startsWith('/api/sessions')) {
      return jsonResponse([]);
    }

    if (url === '/api/epics?parentId=epic-1') {
      return jsonResponse({
        items: [
          {
            id: 'sub-epic-1',
            projectId: 'project-1',
            title: 'Child Epic',
            description: null,
            statusId: 'status-1',
            version: 3,
            parentId: 'epic-1',
            agentId: null,
            tags: [],
            skillsRequired: [],
            createdAt: '',
            updatedAt: '',
          },
        ],
      });
    }

    if (url === '/api/epics/epic-1/comments') {
      return jsonResponse({ items: [] });
    }

    if (url.startsWith('/api/preflight?')) {
      return jsonResponse({ overall: 'pass', checks: [], providers: [] });
    }

    if (url === '/api/epics/sub-epic-1' && method === 'DELETE') {
      return jsonResponse({});
    }

    if (url === '/api/epics/epic-1' && method === 'DELETE') {
      return jsonResponse({});
    }

    return jsonResponse({});
  });
}

describe('EpicDetailPage confirm dialogs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseSelectedProject.mockReturnValue({
      selectedProject: {
        id: 'project-1',
        name: 'Demo Project',
        rootPath: '/workspace/project',
      },
    });
    mockEpicFetches();
  });

  it('cancels sub-epic delete without calling the delete endpoint', async () => {
    const { Wrapper } = createWrapper();
    render(
      <Wrapper>
        <EpicDetailPage />
      </Wrapper>,
    );

    fireEvent.click(await screen.findByRole('button', { name: /delete child work item/i }));
    expect(await screen.findByRole('dialog', { name: /delete sub-epic/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(mockApiFetch).not.toHaveBeenCalledWith('/api/epics/sub-epic-1', expect.anything());
  });

  it('confirms sub-epic delete through the delete endpoint', async () => {
    const { Wrapper } = createWrapper();
    render(
      <Wrapper>
        <EpicDetailPage />
      </Wrapper>,
    );

    fireEvent.click(await screen.findByRole('button', { name: /delete child work item/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^delete$/i }));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/api/epics/sub-epic-1', { method: 'DELETE' });
    });
  });

  it('cancels main epic delete without calling the delete endpoint', async () => {
    const { Wrapper } = createWrapper();
    render(
      <Wrapper>
        <EpicDetailPage />
      </Wrapper>,
    );

    fireEvent.click(await screen.findByRole('button', { name: /delete epic/i }));
    expect(await screen.findByRole('dialog', { name: /delete epic/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(mockApiFetch).not.toHaveBeenCalledWith('/api/epics/epic-1', { method: 'DELETE' });
  });

  it('confirms main epic delete through the delete endpoint and keeps navigation behavior', async () => {
    const { Wrapper } = createWrapper();
    render(
      <Wrapper>
        <EpicDetailPage />
      </Wrapper>,
    );

    fireEvent.click(await screen.findByRole('button', { name: /delete epic/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^delete$/i }));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/api/epics/epic-1', { method: 'DELETE' });
      expect(mockNavigate).toHaveBeenCalledWith('/board');
    });
  });
});
