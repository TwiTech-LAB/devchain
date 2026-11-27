import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { useAppSocket } from '@/ui/hooks/useAppSocket';
import type { WsEnvelope } from '@/ui/lib/socket';
import { EpicDetailPage } from './EpicDetailPage';

jest.mock('@/ui/hooks/useAppSocket', () => ({ useAppSocket: jest.fn() }));
const useAppSocketMock = jest.mocked(useAppSocket);

jest.mock('@/ui/hooks/useIntegrationAvailability', () => ({
  useIntegrationAvailability: () => ({
    canUseIntegrations: true,
    runtimeResolved: true,
    reason: null,
  }),
}));

const mockNavigate = jest.fn();
const mockUseSelectedProject = jest.fn();
const mockApiFetch = jest.fn();
let epicCreatedBy: string | null = null;
let externalSources: unknown[] = [];
let epicVersion = 7;
let epicDescription: string | null = null;
let epicTitle = 'Parent Epic';

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

function createWrapper({ withEpicSwitch = false }: { withEpicSwitch?: boolean } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/epics/epic-1']}>
        {withEpicSwitch && <Link to="/epics/epic-2">Open another epic</Link>}
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

    const epicRead = /^\/api\/epics\/(epic-[12])$/.exec(url);
    if (epicRead && method === 'GET') {
      return jsonResponse({
        id: epicRead[1],
        projectId: 'project-1',
        title: epicRead[1] === 'epic-2' ? 'Other Epic' : epicTitle,
        description: epicRead[1] === 'epic-1' ? epicDescription : null,
        statusId: 'status-1',
        version: epicVersion,
        parentId: null,
        agentId: null,
        createdBy: epicCreatedBy,
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

    if (url === '/api/epics/epic-1/external-sources' && method === 'GET') {
      return jsonResponse({ items: externalSources });
    }

    if (url === '/api/epics/epic-1/external-sources/link-jira' && method === 'DELETE') {
      externalSources = externalSources.filter(
        (source) => (source as { id: string }).id !== 'link-jira',
      );
      return { ok: true, status: 204, json: async () => ({}) } as Response;
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
    epicCreatedBy = null;
    externalSources = [];
    epicVersion = 7;
    epicDescription = null;
    epicTitle = 'Parent Epic';
    mockEpicFetches();
  });

  it.each(['Creator Agent', null])('renders creator attribution %s', async (createdBy) => {
    epicCreatedBy = createdBy;
    const { Wrapper } = createWrapper();
    render(
      <Wrapper>
        <EpicDetailPage />
      </Wrapper>,
    );
    await screen.findByText('Metadata');
    if (createdBy) {
      expect(screen.getByText('Created by')).toBeInTheDocument();
      expect(screen.getByText(createdBy)).toBeInTheDocument();
    } else expect(screen.queryByText('Created by')).not.toBeInTheDocument();
  });

  it('cancels then confirms sub-epic delete through the delete endpoint', async () => {
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

    fireEvent.click(await screen.findByRole('button', { name: /delete child work item/i }));

    fireEvent.click(await screen.findByRole('button', { name: /^delete$/i }));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/api/epics/sub-epic-1', { method: 'DELETE' });
    });
  });

  it('cancels then confirms main epic delete through the delete endpoint and keeps navigation behavior', async () => {
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

    fireEvent.click(await screen.findByRole('button', { name: /delete epic/i }));

    fireEvent.click(await screen.findByRole('button', { name: /^delete$/i }));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/api/epics/epic-1', { method: 'DELETE' });
      expect(mockNavigate).toHaveBeenCalledWith('/board');
    });
  });

  it('unlinks only an ordinary link, by its exact id, after a confirm that keeps remote subtasks', async () => {
    const source = {
      provider: 'jira',
      remoteTaskId: 'ENG-1',
      title: 'Remote task',
      workAreaName: 'Sprint',
      statusName: 'In Progress',
      webUrl: 'https://acme.atlassian.net/browse/ENG-1',
      linkedAt: '2026-08-01T10:00:00.000Z',
    };
    externalSources = [
      { ...source, id: 'link-jira', managed: false, remoteKey: 'ENG-1' },
      { ...source, id: 'link-managed', managed: true, remoteKey: 'ENG-2' },
    ];
    const { Wrapper } = createWrapper();
    render(
      <Wrapper>
        <EpicDetailPage />
      </Wrapper>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Unlink Jira ENG-1' }));
    expect(screen.getByText('Synced subtask')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Unlink Jira ENG-2' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Unlink task?' })).toHaveTextContent(
      'Unlink Jira ENG-1? Remote subtasks stay in Jira and DevChain stops updating them.',
    );

    fireEvent.click(screen.getByRole('button', { name: /^unlink$/i }));

    await waitFor(() => {
      expect(mockApiFetch).toHaveBeenCalledWith('/api/epics/epic-1/external-sources/link-jira', {
        method: 'DELETE',
      });
    });
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Unlink Jira ENG-1' })).not.toBeInTheDocument();
    });
    expect(mockApiFetch).not.toHaveBeenCalledWith(
      expect.stringContaining('link-managed'),
      expect.anything(),
    );
  });

  it('drops an open unlink confirmation when the epic route changes', async () => {
    externalSources = [
      {
        id: 'link-jira',
        managed: false,
        provider: 'jira',
        remoteTaskId: 'ENG-1',
        remoteKey: 'ENG-1',
        title: 'Remote task',
        workAreaName: 'Sprint',
        statusName: 'In Progress',
        webUrl: 'https://acme.atlassian.net/browse/ENG-1',
        linkedAt: '2026-08-01T10:00:00.000Z',
      },
    ];
    const { Wrapper } = createWrapper({ withEpicSwitch: true });
    render(
      <Wrapper>
        <EpicDetailPage />
      </Wrapper>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Unlink Jira ENG-1' }));
    expect(screen.getByRole('dialog', { name: 'Unlink task?' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('link', { name: 'Open another epic' }));

    expect((await screen.findAllByText('Other Epic')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('dialog', { name: 'Unlink task?' })).not.toBeInTheDocument();
    expect(mockApiFetch).not.toHaveBeenCalledWith(expect.anything(), { method: 'DELETE' });
  });

  it('saves the title with the version an agent link change committed while the page was open', async () => {
    const { Wrapper } = createWrapper();
    render(
      <Wrapper>
        <EpicDetailPage />
      </Wrapper>,
    );
    await screen.findByRole('button', { name: 'Parent Epic' });

    epicVersion = 8;
    const linkChange: WsEnvelope = {
      topic: 'project/project-1/epics',
      type: 'updated',
      payload: { epicId: 'epic-1', projectId: 'project-1', version: 8 },
      ts: '2026-11-23T00:00:00.000Z',
    };
    const epicReads = () =>
      mockApiFetch.mock.calls.filter(([url]) => url === '/api/epics/epic-1').length;
    const readsBefore = epicReads();
    act(() => useAppSocketMock.mock.lastCall![0].message?.(linkChange));
    await waitFor(() => expect(epicReads()).toBeGreaterThan(readsBefore));

    fireEvent.click(screen.getByRole('button', { name: 'Parent Epic' }));
    const input = await screen.findByDisplayValue('Parent Epic');
    fireEvent.change(input, { target: { value: 'Renamed' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      const put = mockApiFetch.mock.calls.find(
        ([url, init]) => url === '/api/epics/epic-1' && init?.method === 'PUT',
      );
      expect(JSON.parse(put![1].body)).toMatchObject({ title: 'Renamed', version: 8 });
    });
  });

  it('keeps an unsaved title edit when another change refreshes the epic', async () => {
    const { Wrapper } = createWrapper();
    render(
      <Wrapper>
        <EpicDetailPage />
      </Wrapper>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Parent Epic' }));
    const input = await screen.findByDisplayValue('Parent Epic');
    fireEvent.change(input, { target: { value: 'Typed title' } });

    epicVersion = 8;
    epicDescription = 'Written by an agent';
    act(() =>
      useAppSocketMock.mock.lastCall![0].message?.({
        topic: 'project/project-1/epics',
        type: 'updated',
        payload: { epicId: 'epic-1', projectId: 'project-1', version: 8 },
        ts: '2026-11-23T00:00:00.000Z',
      }),
    );

    expect(await screen.findByDisplayValue('Written by an agent')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Typed title')).toBeInTheDocument();
    expect(
      mockApiFetch.mock.calls.some(
        ([, init]) => (init as RequestInit | undefined)?.method === 'PUT',
      ),
    ).toBe(false);
  });

  it.each([
    ['title', 'mine'],
    ['title', 'theirs'],
    ['description', 'mine'],
    ['description', 'theirs'],
  ] as const)(
    'holds a %s draft that another editor changed, then keeps %s on request',
    async (field, keep) => {
      const label = field === 'title' ? 'Title' : 'Description';
      const { Wrapper } = createWrapper();
      render(
        <Wrapper>
          <EpicDetailPage />
        </Wrapper>,
      );
      let editor: HTMLElement;
      if (field === 'title') {
        fireEvent.click(await screen.findByRole('button', { name: 'Parent Epic' }));
        editor = await screen.findByDisplayValue('Parent Epic');
      } else {
        editor = await screen.findByPlaceholderText('Add a description');
      }
      fireEvent.change(editor, { target: { value: `My ${field}` } });
      const save = () => {
        if (field === 'title') {
          fireEvent.blur(editor);
          fireEvent.keyDown(editor, { key: 'Enter' });
        } else {
          fireEvent.click(screen.getByRole('button', { name: /save description/i }));
        }
      };
      const puts = () =>
        mockApiFetch.mock.calls.filter(([, init]) => (init as RequestInit)?.method === 'PUT');

      epicVersion = 8;
      if (field === 'title') epicTitle = 'Their title';
      else epicDescription = 'Their description';
      act(() =>
        useAppSocketMock.mock.lastCall![0].message?.({
          topic: 'project/project-1/epics',
          type: 'updated',
          payload: { epicId: 'epic-1', projectId: 'project-1', version: 8 },
          ts: '2026-11-23T00:00:00.000Z',
        }),
      );
      const notice = await screen.findByText(`${label} was changed by someone else.`);

      save();
      expect(puts()).toEqual([]);
      expect(screen.getByDisplayValue(`My ${field}`)).toBe(editor);
      expect(notice).toBeInTheDocument();

      if (keep === 'theirs') {
        fireEvent.click(screen.getByRole('button', { name: 'Use theirs' }));
        expect(await screen.findByDisplayValue(`Their ${field}`)).toBe(editor);
        expect(screen.queryByText(`${label} was changed by someone else.`)).toBeNull();
        save();
        expect(puts()).toEqual([]);
        return;
      }
      fireEvent.click(screen.getByRole('button', { name: 'Keep mine' }));
      expect(screen.queryByText(`${label} was changed by someone else.`)).toBeNull();
      if (field === 'title') {
        // Keeping a draft over someone else's title needs a deliberate save.
        fireEvent.blur(editor);
        expect(puts()).toEqual([]);
        expect(screen.getByDisplayValue('My title')).toBe(editor);
        fireEvent.click(screen.getByRole('button', { name: 'Save title' }));
      } else {
        save();
      }
      await waitFor(() => expect(puts()).toHaveLength(1));
      expect(JSON.parse(puts()[0][1].body)).toEqual({ [field]: `My ${field}`, version: 8 });
    },
  );

  it('keeps the draft and shows the conflict when the server refuses a stale version', async () => {
    const serve = mockApiFetch.getMockImplementation()!;
    mockApiFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input === '/api/epics/epic-1' && init?.method === 'PUT') {
        epicVersion = 8;
        epicTitle = 'Their title';
        return {
          ok: false,
          status: 409,
          json: async () => ({ statusCode: 409, code: 'optimistic_lock_error', message: 'Stale' }),
        } as Response;
      }
      return serve(input, init);
    });
    const { Wrapper } = createWrapper();
    render(
      <Wrapper>
        <EpicDetailPage />
      </Wrapper>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Parent Epic' }));
    const input = await screen.findByDisplayValue('Parent Epic');
    fireEvent.change(input, { target: { value: 'My title' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(await screen.findByText('Title was changed by someone else.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep mine' }));
    expect(screen.getByDisplayValue('My title')).toBeInTheDocument();
  });
});
