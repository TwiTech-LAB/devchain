import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { SourcesPopover } from './SourcesPopover';

const toastSpy = jest.fn();
const useSelectedProjectMock = jest.fn();
const useOptionalBackendMock = jest.fn();

const hostFetchMock = jest.fn();
const homeFetchMock = jest.fn();

const fetchSourcesMock = jest.fn();
const fetchCommunitySourcesMock = jest.fn();
const fetchLocalSourcesMock = jest.fn();
const addCommunitySourceMock = jest.fn();
const addLocalSourceMock = jest.fn();
const removeCommunitySourceMock = jest.fn();
const removeLocalSourceMock = jest.fn();
const enableSourceMock = jest.fn();
const disableSourceMock = jest.fn();
const enableSourceForProjectMock = jest.fn();
const disableSourceForProjectMock = jest.fn();

jest.mock('@/ui/hooks/use-toast', () => ({
  useToast: () => ({ toast: toastSpy }),
}));

jest.mock('@/ui/hooks/useProjectSelection', () => ({
  useSelectedProject: () => useSelectedProjectMock(),
}));

jest.mock('@/ui/lib/backend-context', () => ({
  useOptionalBackend: () => useOptionalBackendMock(),
}));

jest.mock('@/ui/hooks/useFetchFactory', () => ({
  useFetchFactory: () => hostFetchMock,
  useHomeFetch: () => homeFetchMock,
}));

jest.mock('@/ui/components/ui/popover', () => ({
  Popover: ({
    children,
    open,
    onOpenChange,
  }: {
    children: ReactElement;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
  }) => (
    <div>
      <button type="button" onClick={() => onOpenChange?.(!open)}>
        toggle-popover
      </button>
      {children}
    </div>
  ),
  PopoverTrigger: ({ children }: { children: ReactElement }) => <>{children}</>,
  PopoverContent: ({ children }: { children: ReactElement }) => <div>{children}</div>,
}));

jest.mock('@/ui/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: ReactElement }) => <>{children}</>,
  Tooltip: ({ children }: { children: ReactElement }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactElement }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactElement }) => <>{children}</>,
}));

jest.mock('@/ui/components/shared/ConfirmDialog', () => ({
  ConfirmDialog: ({
    open,
    title,
    confirmText,
    onConfirm,
  }: {
    open: boolean;
    title: string;
    confirmText: string;
    onConfirm: () => void;
  }) =>
    open ? (
      <div>
        <p>{title}</p>
        <button type="button" onClick={onConfirm}>
          {confirmText}
        </button>
      </div>
    ) : null,
}));

let dialogSubmitPayload: {
  type: 'local';
  name: string;
  folderPath: string;
  existingProjects: { mode: 'none' } | { mode: 'all' } | { mode: 'selected'; projectIds: string[] };
};

jest.mock('./AddCommunitySourceDialog', () => ({
  AddCommunitySourceDialog: ({
    open,
    onSubmit,
  }: {
    open: boolean;
    onSubmit: (input: unknown) => Promise<void>;
  }) =>
    open ? (
      <button
        type="button"
        onClick={() => {
          void onSubmit(dialogSubmitPayload);
        }}
      >
        Submit Local Source
      </button>
    ) : null,
}));

jest.mock('@/ui/lib/skills', () => {
  const actual = jest.requireActual('@/ui/lib/skills');
  return {
    ...actual,
    fetchSources: (...args: unknown[]) => fetchSourcesMock(...args),
    fetchCommunitySources: (...args: unknown[]) => fetchCommunitySourcesMock(...args),
    fetchLocalSources: (...args: unknown[]) => fetchLocalSourcesMock(...args),
    addCommunitySource: (...args: unknown[]) => addCommunitySourceMock(...args),
    addLocalSource: (...args: unknown[]) => addLocalSourceMock(...args),
    removeCommunitySource: (...args: unknown[]) => removeCommunitySourceMock(...args),
    removeLocalSource: (...args: unknown[]) => removeLocalSourceMock(...args),
    enableSource: (...args: unknown[]) => enableSourceMock(...args),
    disableSource: (...args: unknown[]) => disableSourceMock(...args),
    enableSourceForProject: (...args: unknown[]) => enableSourceForProjectMock(...args),
    disableSourceForProject: (...args: unknown[]) => disableSourceForProjectMock(...args),
  };
});

function renderWithQueryClient(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  const renderResult = render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
  return { ...renderResult, queryClient };
}

const REMOTE_PROJECT_ID = '00000000-0000-0000-0000-0000000000aa';
const HOME_PROJECT_ID = '00000000-0000-0000-0000-0000000000bb';

function selectRemoteProject() {
  useSelectedProjectMock.mockReturnValue({
    selectedProjectId: REMOTE_PROJECT_ID,
    selectedProject: { id: REMOTE_PROJECT_ID, name: 'Remote DevChain' },
  });
  useOptionalBackendMock.mockReturnValue({
    activeRemote: {
      id: 'remote-1',
      name: 'Workstation',
      online: true,
      version: '1.0.0',
      versionMatches: true,
    },
  });
}

function makeSource(overrides: Record<string, unknown>) {
  return {
    name: 'community-source',
    kind: 'community',
    enabled: true,
    repoUrl: 'https://github.com/acme/community-source',
    skillCount: 1,
    ...overrides,
  };
}

const BUILTIN_SOURCE = makeSource({
  name: 'openai',
  kind: 'builtin',
  repoUrl: 'https://github.com/openai/openai-cookbook',
  skillCount: 3,
});

const HOST_SOURCES = [BUILTIN_SOURCE, makeSource({ projectEnabled: true })];
const HOME_SOURCES = [BUILTIN_SOURCE, makeSource()];

describe('SourcesPopover', () => {
  beforeEach(() => {
    toastSpy.mockReset();
    useOptionalBackendMock.mockReset().mockReturnValue(undefined);
    hostFetchMock.mockReset();
    homeFetchMock.mockReset();
    dialogSubmitPayload = {
      type: 'local',
      name: 'local-source',
      folderPath: '/tmp/local-source',
      existingProjects: { mode: 'none' },
    };
    fetchSourcesMock.mockReset();
    fetchCommunitySourcesMock.mockReset();
    fetchLocalSourcesMock.mockReset();
    addCommunitySourceMock.mockReset();
    addLocalSourceMock.mockReset();
    removeCommunitySourceMock.mockReset();
    removeLocalSourceMock.mockReset();
    enableSourceMock.mockReset();
    disableSourceMock.mockReset();
    enableSourceForProjectMock.mockReset();
    disableSourceForProjectMock.mockReset();

    useSelectedProjectMock.mockReturnValue({
      selectedProjectId: null,
      selectedProject: null,
    });

    fetchSourcesMock.mockResolvedValue([
      {
        name: 'openai',
        kind: 'builtin',
        enabled: true,
        repoUrl: 'https://github.com/openai/openai-cookbook',
        skillCount: 3,
      },
      {
        name: 'community-source',
        kind: 'community',
        enabled: true,
        repoUrl: 'https://github.com/acme/community-source',
        skillCount: 1,
      },
      {
        name: 'local-source',
        kind: 'local',
        enabled: true,
        repoUrl: '',
        folderPath: '/tmp/local-source',
        skillCount: 2,
      },
    ]);

    fetchCommunitySourcesMock.mockResolvedValue([
      {
        id: 'community-1',
        name: 'community-source',
        repoOwner: 'acme',
        repoName: 'community-source',
        branch: 'main',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);

    fetchLocalSourcesMock.mockResolvedValue([
      {
        id: 'local-1',
        name: 'local-source',
        folderPath: '/tmp/local-source',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);

    addLocalSourceMock.mockResolvedValue({
      id: 'local-1',
      name: 'local-source',
      folderPath: '/tmp/local-source',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    removeLocalSourceMock.mockResolvedValue(undefined);
  });

  it('renders local source in managed section and removes it', async () => {
    renderWithQueryClient(<SourcesPopover />);

    await waitFor(() => {
      expect(screen.getByText('Community & Local Sources')).toBeInTheDocument();
    });

    expect(screen.getByText('/tmp/local-source')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /remove local-source source/i }));
    fireEvent.click(screen.getByRole('button', { name: /remove source/i }));

    await waitFor(() => {
      expect(removeLocalSourceMock).toHaveBeenCalledWith(expect.any(Function), 'local-1');
    });
    expect(removeCommunitySourceMock).not.toHaveBeenCalled();
  });

  it('renders one branded, linked, non-removable DevChain built-in source', async () => {
    fetchSourcesMock.mockResolvedValue([
      {
        name: 'devchain',
        kind: 'builtin',
        enabled: true,
        repoUrl: 'https://github.com/TwiTech-LAB/devchain/tree/main/apps/local-app/skills',
        skillCount: 1,
      },
    ]);
    fetchCommunitySourcesMock.mockResolvedValue([]);
    fetchLocalSourcesMock.mockResolvedValue([]);

    renderWithQueryClient(<SourcesPopover />);

    const link = await screen.findByRole('link', { name: 'DevChain' });
    const builtInSection = screen.getByText('Built-in Sources').parentElement;
    const sourceRow = link.closest<HTMLElement>('.rounded-md.border');

    expect(screen.getAllByRole('link', { name: 'DevChain' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Sources (1/1)' })).toBeInTheDocument();
    expect(link).toHaveAttribute(
      'href',
      'https://github.com/TwiTech-LAB/devchain/tree/main/apps/local-app/skills',
    );
    expect(link).toHaveAttribute('target', '_blank');
    expect(builtInSection).toContainElement(link);
    expect(sourceRow).not.toBeNull();
    if (!sourceRow) throw new Error('Expected DevChain built-in source row');
    expect(sourceRow.querySelector('svg')).toHaveClass('text-sky-700');
    expect(within(sourceRow).queryByRole('button', { name: /remove/i })).toBeNull();
  });

  it('routes add-source dialog local submissions to addLocalSource', async () => {
    renderWithQueryClient(<SourcesPopover />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^add source$/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /^add source$/i }));
    fireEvent.click(screen.getByRole('button', { name: /submit local source/i }));

    await waitFor(() => {
      expect(addLocalSourceMock).toHaveBeenCalledWith(expect.any(Function), {
        name: 'local-source',
        folderPath: '/tmp/local-source',
        existingProjects: { mode: 'none' },
      });
    });

    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Local source added',
        description: expect.stringContaining('Disabled in existing projects'),
      }),
    );
  });

  it('names the chosen project in the add-source toast for a selected choice', async () => {
    useSelectedProjectMock.mockReturnValue({
      selectedProjectId: '00000000-0000-0000-0000-0000000000bb',
      selectedProject: { id: '00000000-0000-0000-0000-0000000000bb', name: 'DevChain' },
    });
    dialogSubmitPayload = {
      type: 'local',
      name: 'local-source',
      folderPath: '/tmp/local-source',
      existingProjects: {
        mode: 'selected',
        projectIds: ['00000000-0000-0000-0000-0000000000bb'],
      },
    };

    renderWithQueryClient(<SourcesPopover />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^add source$/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /^add source$/i }));
    fireEvent.click(screen.getByRole('button', { name: /submit local source/i }));

    await waitFor(() => {
      expect(addLocalSourceMock).toHaveBeenCalledWith(expect.any(Function), {
        name: 'local-source',
        folderPath: '/tmp/local-source',
        existingProjects: {
          mode: 'selected',
          projectIds: ['00000000-0000-0000-0000-0000000000bb'],
        },
      });
    });

    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        description: expect.stringContaining('Enabled in DevChain'),
      }),
    );
  });

  it('keeps a single sources request when no remote is active', async () => {
    useSelectedProjectMock.mockReturnValue({
      selectedProjectId: HOME_PROJECT_ID,
      selectedProject: { id: HOME_PROJECT_ID, name: 'DevChain' },
    });

    renderWithQueryClient(<SourcesPopover />);

    await waitFor(() => {
      expect(screen.getByText('Community & Local Sources')).toBeInTheDocument();
    });

    expect(fetchSourcesMock).toHaveBeenCalledTimes(1);
    expect(fetchSourcesMock).toHaveBeenCalledWith(hostFetchMock, HOME_PROJECT_ID);
    expect(fetchCommunitySourcesMock).toHaveBeenCalledWith(homeFetchMock);
    expect(fetchLocalSourcesMock).toHaveBeenCalledWith(homeFetchMock);
  });

  describe('built-in DevChain lock', () => {
    const DEVCHAIN_SOURCE = makeSource({
      name: 'devchain',
      kind: 'builtin',
      repoUrl: 'https://github.com/TwiTech-LAB/devchain/tree/main/apps/local-app/skills',
    });
    const DEVCHAIN_LOCAL_SOURCE = makeSource({
      name: 'devchain-local',
      kind: 'local',
      repoUrl: '',
      folderPath: '/tmp/devchain-local',
    });

    beforeEach(() => {
      fetchCommunitySourcesMock.mockResolvedValue([]);
      fetchLocalSourcesMock.mockResolvedValue([
        {
          id: 'local-dc',
          name: 'devchain-local',
          folderPath: '/tmp/devchain-local',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ]);
    });

    it('locks the no-project DevChain switch on and keeps devchain-local toggleable', async () => {
      fetchSourcesMock.mockResolvedValue([DEVCHAIN_SOURCE, DEVCHAIN_LOCAL_SOURCE]);
      disableSourceMock.mockResolvedValue({ name: 'devchain-local', enabled: false });

      renderWithQueryClient(<SourcesPopover />);

      const locked = await screen.findByRole('switch', { name: 'Devchain source is always on' });
      expect(locked).toBeChecked();
      expect(locked).toBeDisabled();
      expect(screen.getByText('Built-in DevChain skills are always on')).toBeInTheDocument();
      fireEvent.click(locked);

      const local = screen.getByRole('switch', {
        name: 'Enable or disable Devchain-local source',
      });
      expect(local).toBeEnabled();
      fireEvent.click(local);

      await waitFor(() => {
        expect(disableSourceMock).toHaveBeenCalledWith(homeFetchMock, 'devchain-local');
      });
      expect(disableSourceMock).toHaveBeenCalledTimes(1);
    });

    it('locks the global and project DevChain switches on, even for a stale "off" row', async () => {
      useSelectedProjectMock.mockReturnValue({
        selectedProjectId: HOME_PROJECT_ID,
        selectedProject: { id: HOME_PROJECT_ID, name: 'Home Project' },
      });
      fetchSourcesMock.mockResolvedValue([
        { ...DEVCHAIN_SOURCE, enabled: false, projectEnabled: false },
        { ...DEVCHAIN_LOCAL_SOURCE, projectEnabled: true },
      ]);

      renderWithQueryClient(<SourcesPopover />);

      const global = await screen.findByRole('switch', {
        name: 'Devchain is always on globally',
      });
      const project = screen.getByRole('switch', {
        name: 'Devchain is always on for Home Project',
      });
      for (const locked of [global, project]) {
        expect(locked).toBeChecked();
        expect(locked).toBeDisabled();
      }
      expect(screen.getAllByText('Built-in DevChain skills are always on')).toHaveLength(2);
      expect(screen.queryByRole('switch', { name: /Devchain is disabled globally/ })).toBeNull();

      expect(
        screen.getByRole('switch', { name: 'Enable or disable Devchain-local globally' }),
      ).toBeEnabled();
      expect(
        screen.getByRole('switch', { name: 'Enable or disable Devchain-local for Home Project' }),
      ).toBeEnabled();
      expect(disableSourceMock).not.toHaveBeenCalled();
      expect(disableSourceForProjectMock).not.toHaveBeenCalled();
    });
  });

  describe('remote project', () => {
    beforeEach(() => {
      selectRemoteProject();
    });

    it('sends the global switch home and the project switch to the host', async () => {
      fetchSourcesMock.mockImplementation(async (_fetchFn: unknown, projectId?: string) =>
        projectId ? HOST_SOURCES : HOME_SOURCES,
      );
      disableSourceMock.mockResolvedValue({ name: 'community-source', enabled: false });
      disableSourceForProjectMock.mockResolvedValue({
        name: 'community-source',
        projectId: REMOTE_PROJECT_ID,
        projectEnabled: false,
      });

      renderWithQueryClient(<SourcesPopover />);

      fireEvent.click(
        await screen.findByRole('switch', {
          name: 'Enable or disable Community-source globally',
        }),
      );

      await waitFor(() => {
        expect(disableSourceMock).toHaveBeenCalledWith(homeFetchMock, 'community-source');
      });

      fireEvent.click(
        screen.getByRole('switch', {
          name: 'Enable or disable Community-source for Remote DevChain',
        }),
      );

      await waitFor(() => {
        expect(disableSourceForProjectMock).toHaveBeenCalledWith(
          hostFetchMock,
          'community-source',
          REMOTE_PROJECT_ID,
        );
      });
    });

    it('shows the home state on the global switch while the host query is stale', async () => {
      fetchSourcesMock.mockImplementation(async (_fetchFn: unknown, projectId?: string) =>
        projectId
          ? HOST_SOURCES // host still lists the source as enabled
          : [
              BUILTIN_SOURCE,
              makeSource({ enabled: false }), // home has just disabled it
            ],
      );

      renderWithQueryClient(<SourcesPopover />);

      const globalSwitch = await screen.findByRole('switch', {
        name: 'Enable or disable Community-source globally',
      });

      expect(globalSwitch).toHaveAttribute('aria-checked', 'false');
    });

    it('marks a home source the host does not list and explains the push delay', async () => {
      fetchSourcesMock.mockImplementation(async (_fetchFn: unknown, projectId?: string) =>
        projectId ? HOST_SOURCES : [...HOME_SOURCES, makeSource({ name: 'local-source' })],
      );

      renderWithQueryClient(<SourcesPopover />);

      expect(await screen.findByText('Not on this host')).toBeInTheDocument();
      expect(screen.getByText(/reach the host within about 10 seconds/i)).toBeInTheDocument();
    });

    it('refetches the host query every 10 seconds while the popover is open', async () => {
      fetchSourcesMock.mockImplementation(async (_fetchFn: unknown, projectId?: string) =>
        projectId ? HOST_SOURCES : HOME_SOURCES,
      );

      const { queryClient } = renderWithQueryClient(<SourcesPopover />);
      await screen.findByText('Skill Sources');

      const hostQueryOptions = () =>
        queryClient.getQueryCache().find({
          queryKey: ['skill-sources', REMOTE_PROJECT_ID],
          exact: true,
        })?.options;

      expect(hostQueryOptions()?.refetchInterval).toBe(false);

      fireEvent.click(screen.getByRole('button', { name: 'toggle-popover' }));

      await waitFor(() => {
        expect(hostQueryOptions()?.refetchInterval).toBe(10_000);
      });

      const homeQuery = queryClient.getQueryCache().find({
        queryKey: ['home', 'skill-sources', 'global'],
        exact: true,
      });
      expect(homeQuery?.options.refetchInterval ?? false).toBe(false);
    });

    it('invalidates the remote skill list when the popover sees a host change', async () => {
      fetchSourcesMock.mockImplementation(async (_fetchFn: unknown, projectId?: string) =>
        projectId ? HOST_SOURCES : HOME_SOURCES,
      );

      const { queryClient } = renderWithQueryClient(<SourcesPopover />);
      await waitFor(() => {
        expect(queryClient.getQueryState(['skill-sources', REMOTE_PROJECT_ID])?.data).toEqual(
          HOST_SOURCES,
        );
      });

      const invalidateSpy = jest.spyOn(queryClient, 'invalidateQueries');
      const changedHostSources = [BUILTIN_SOURCE, makeSource({ skillCount: 5 })];

      await act(async () => {
        queryClient.setQueryData(['skill-sources', REMOTE_PROJECT_ID], changedHostSources);
      });

      await waitFor(() => {
        expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['skills'] });
      });

      invalidateSpy.mockClear();
      await act(async () => {
        queryClient.setQueryData(
          ['skill-sources', REMOTE_PROJECT_ID],
          changedHostSources.map((source) => ({ ...source })),
        );
      });

      expect(invalidateSpy).not.toHaveBeenCalled();
    });

    it('shows a VM-only source with its Project switch and no global controls', async () => {
      fetchSourcesMock.mockImplementation(async (_fetchFn: unknown, projectId?: string) =>
        projectId
          ? [...HOST_SOURCES, makeSource({ name: 'host-only', projectEnabled: false })]
          : HOME_SOURCES,
      );

      renderWithQueryClient(<SourcesPopover />);

      expect(await screen.findByText('Only on this VM')).toBeInTheDocument();
      const projectSwitch = screen.getByRole('switch', {
        name: 'Enable or disable Host-only for Remote DevChain',
      });
      expect(projectSwitch).toHaveAttribute('aria-checked', 'false');

      expect(
        screen.queryByRole('switch', { name: 'Enable or disable Host-only globally' }),
      ).toBeNull();
      expect(screen.queryByRole('button', { name: /remove host-only source/i })).toBeNull();

      expect(
        screen.getByRole('switch', { name: 'Enable or disable Community-source globally' }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('switch', {
          name: 'Enable or disable Community-source for Remote DevChain',
        }),
      ).toBeInTheDocument();
    });

    it('sends a VM-only source project switch to the host backend', async () => {
      fetchSourcesMock.mockImplementation(async (_fetchFn: unknown, projectId?: string) =>
        projectId
          ? [...HOST_SOURCES, makeSource({ name: 'host-only', projectEnabled: false })]
          : HOME_SOURCES,
      );
      enableSourceForProjectMock.mockResolvedValue({
        name: 'host-only',
        projectId: REMOTE_PROJECT_ID,
        projectEnabled: true,
      });

      renderWithQueryClient(<SourcesPopover />);

      fireEvent.click(
        await screen.findByRole('switch', {
          name: 'Enable or disable Host-only for Remote DevChain',
        }),
      );

      await waitFor(() => {
        expect(enableSourceForProjectMock).toHaveBeenCalledWith(
          hostFetchMock,
          'host-only',
          REMOTE_PROJECT_ID,
        );
      });
      expect(enableSourceMock).not.toHaveBeenCalled();
      expect(disableSourceMock).not.toHaveBeenCalled();
    });
  });
});
