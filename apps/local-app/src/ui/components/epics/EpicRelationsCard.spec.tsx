import { useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { axe } from 'jest-axe';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { EpicRelationsCard } from '@/ui/components/epics/EpicRelationsCard';
import { EpicRelationConfirmationError } from '@/ui/lib/epic-relations';
import { projectsQueryKeys } from '@/ui/pages/projects/lib/project-query-keys';
import type { EpicRelation, EpicRelationCandidate } from '@/ui/lib/epic-relations';

// Layer: component unit. Data hooks and project selection are stubbed because
// this spec owns card behavior: grouped focal-relative rendering, direction
// disclosure before a type change, add/edit/remove/load-more actions, and
// activateProject-before-navigation for cross-project targets.
const fetchMock = jest.fn();
jest.mock('@/ui/hooks/useFetchFactory', () => ({
  useFetchFactory: () => fetchMock,
}));

const activateProjectMock = jest.fn();
let selectedProjectFixture: {
  id: string;
  workspaceId: string;
  name: string;
} | null = null;
jest.mock('@/ui/hooks/useProjectSelection', () => ({
  useSelectedProject: () => ({
    selectedProject: selectedProjectFixture,
    activateProject: activateProjectMock,
  }),
}));

const useEpicRelationsMock = jest.fn();
const useEpicRelationCandidatesMock = jest.fn();
const useSetEpicRelationMock = jest.fn();
const useDeleteEpicRelationMock = jest.fn();
jest.mock('@/ui/hooks/useEpicRelations', () => ({
  useEpicRelations: (...args: unknown[]) => useEpicRelationsMock(...args),
  useEpicRelationCandidates: (...args: unknown[]) => useEpicRelationCandidatesMock(...args),
  useSetEpicRelation: (...args: unknown[]) => useSetEpicRelationMock(...args),
  useDeleteEpicRelation: (...args: unknown[]) => useDeleteEpicRelationMock(...args),
}));

const useEpicExternalSourcesBatchMock = jest.fn();
jest.mock('@/ui/hooks/useEpicExternalSourcesBatch', () => ({
  useEpicExternalSourcesBatch: (...args: unknown[]) => useEpicExternalSourcesBatchMock(...args),
}));

const fetchNextPageMock = jest.fn();
const candidatesFetchNextPageMock = jest.fn();
const setMutateMock = jest.fn();
const setResetMock = jest.fn();
const deleteMutateMock = jest.fn();

function targetFixture(
  id: string,
  projectId: string,
  projectName: string,
  title: string,
): EpicRelation['relatedEpic'] {
  return {
    id,
    shortId: id.slice(0, 8),
    title,
    status: { id: 'status-1', label: 'In Progress', color: '#2563eb' },
    project: { id: projectId, name: projectName },
  };
}

const SAME_PROJECT_ID = 'project-current';
const OTHER_PROJECT_ID = 'project-other';
const FOCAL_PROJECT_ID = 'project-focal';
const FOCAL_EPIC_ID = 'epic-1';
const DESIGN_ID = '11111111-1111-1111-1111-111111111111';
const SHIP_ID = '22222222-2222-2222-2222-222222222222';
const DOCS_ID = '33333333-3333-3333-3333-333333333333';
const AUTH_ID = '44444444-4444-4444-4444-444444444444';

const relations: EpicRelation[] = [
  {
    relationId: 'rel-1',
    // Design API is the stored source: the focal Epic logs time with it.
    type: 'related',
    sourceEpicId: DESIGN_ID,
    targetEpicId: FOCAL_EPIC_ID,
    relatedEpic: targetFixture(DESIGN_ID, FOCAL_PROJECT_ID, 'Focal Project', 'Design API'),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    relationId: 'rel-2',
    // Focal blocks Ship CLI.
    type: 'blocks',
    sourceEpicId: FOCAL_EPIC_ID,
    targetEpicId: SHIP_ID,
    relatedEpic: targetFixture(SHIP_ID, OTHER_PROJECT_ID, 'Other Project', 'Ship CLI'),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    relationId: 'rel-3',
    // Write docs blocks the focal Epic.
    type: 'blocked_by',
    sourceEpicId: DOCS_ID,
    targetEpicId: FOCAL_EPIC_ID,
    relatedEpic: targetFixture(DOCS_ID, SAME_PROJECT_ID, 'Current Project', 'Write docs'),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

const legacyNeutralRelation: EpicRelation = {
  relationId: 'rel-legacy',
  type: 'related',
  sourceEpicId: null,
  targetEpicId: null,
  relatedEpic: targetFixture(DOCS_ID, FOCAL_PROJECT_ID, 'Focal Project', 'Write docs'),
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const candidate: EpicRelationCandidate = {
  ...targetFixture(AUTH_ID, FOCAL_PROJECT_ID, 'Focal Project', 'Auth Service'),
  parentId: null,
};

function infiniteData<T>(items: T[], total: number) {
  return { pages: [{ items, total, limit: 20, offset: 0 }], pageParams: [0] };
}

const navigateSpy = jest.fn();
function EpicRoute() {
  const { id } = useParams();
  useEffect(() => {
    navigateSpy(id);
  }, [id]);
  return <div>Epic page {id}</div>;
}

function cardTree({
  focalProjectId = FOCAL_PROJECT_ID,
  focalIsRoot = true,
}: { focalProjectId?: string; focalIsRoot?: boolean } = {}) {
  return (
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route
          path="/"
          element={
            <EpicRelationsCard
              epicId={FOCAL_EPIC_ID}
              epicTitle="Focal Epic"
              focalProjectId={focalProjectId}
              focalIsRoot={focalIsRoot}
            />
          }
        />
        <Route path="/epics/:id" element={<EpicRoute />} />
      </Routes>
    </MemoryRouter>
  );
}

function renderCard({
  focalProjectId = FOCAL_PROJECT_ID,
  focalIsRoot = true,
}: { focalProjectId?: string; focalIsRoot?: boolean } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const options = { focalProjectId, focalIsRoot };
  const renderResult = render(
    <QueryClientProvider client={queryClient}>{cardTree(options)}</QueryClientProvider>,
  );
  return {
    ...renderResult,
    queryClient,
    // Re-renders the identical tree so a re-mocked hook return (for example a
    // fresh typed 409) reaches the mounted component with state preserved.
    rerenderTree: () =>
      renderResult.rerender(
        <QueryClientProvider client={queryClient}>{cardTree(options)}</QueryClientProvider>,
      ),
  };
}

function mockDataHooks(
  overrides: {
    relations?: EpicRelation[];
    total?: number;
    hasNextPage?: boolean;
    isLoading?: boolean;
    isError?: boolean;
    candidatesEnabled?: boolean;
    candidatesTotal?: number;
    candidateFixture?: EpicRelationCandidate;
    setError?: Error | null;
    deleteError?: Error | null;
    linkedEpicIds?: string[];
  } = {},
) {
  const items = overrides.relations ?? relations;
  const total = overrides.total ?? items.length;
  useEpicRelationsMock.mockReturnValue({
    data: infiniteData(items, total),
    isLoading: overrides.isLoading ?? false,
    isError: overrides.isError ?? false,
    hasNextPage: overrides.hasNextPage ?? false,
    isFetchingNextPage: false,
    fetchNextPage: fetchNextPageMock,
    refetch: jest.fn(),
  });
  useEpicRelationCandidatesMock.mockReturnValue({
    data: infiniteData([overrides.candidateFixture ?? candidate], overrides.candidatesTotal ?? 1),
    isLoading: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: candidatesFetchNextPageMock,
  });
  useSetEpicRelationMock.mockReturnValue({
    mutate: setMutateMock,
    reset: setResetMock,
    isPending: false,
    error: overrides.setError ?? null,
  });
  useDeleteEpicRelationMock.mockReturnValue({
    mutate: deleteMutateMock,
    reset: jest.fn(),
    isPending: false,
    error: overrides.deleteError ?? null,
  });
  useEpicExternalSourcesBatchMock.mockReturnValue({
    sources: new Map(overrides.linkedEpicIds?.map((id: string) => [id, {}]) ?? []),
    query: { isSuccess: true },
  });
}

function jsonResponse(data: unknown): Response {
  return { ok: true, json: async () => data } as Response;
}

describe('EpicRelationsCard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    selectedProjectFixture = null;
    mockDataHooks();
    // The shared removal dialog closes only after the delete succeeds, so the
    // delete double plays a successful server response.
    deleteMutateMock.mockImplementation((_input, opts) => {
      opts?.onSuccess?.();
    });
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === `/api/projects/${FOCAL_PROJECT_ID}`) {
        return jsonResponse({
          id: FOCAL_PROJECT_ID,
          workspaceId: 'ws-1',
          name: 'Focal Project',
        });
      }
      // The edit dialog resolves target eligibility from the Epic row.
      if (url === `/api/epics/${DESIGN_ID}`) {
        return jsonResponse({ id: DESIGN_ID, parentId: null, projectId: FOCAL_PROJECT_ID });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
  });

  it('renders grouped focal-relative relations with title, status, project, and short ID', () => {
    renderCard();

    expect(screen.getByText('Relations (3)')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Related (1)' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Blocks (1)' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Blocked by (1)' })).toBeInTheDocument();
    expect(screen.getAllByText('Design API').length).toBeGreaterThan(0);
    expect(screen.getByText('Ship CLI')).toBeInTheDocument();
    expect(screen.getAllByText('In Progress').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Other Project').length).toBeGreaterThan(0);
    expect(screen.getAllByText('22222222').length).toBeGreaterThan(0);
  });

  it('marks the related Epic’s role on directed rows and renders legacy neutral rows', () => {
    mockDataHooks({ relations: [relations[0]!, legacyNeutralRelation] });
    renderCard();

    // Design API is the stored source of its pair.
    expect(screen.getByText('Source')).toBeInTheDocument();
    // The legacy row carries no direction and stays readable.
    expect(screen.getByText('No direction yet')).toBeInTheDocument();
  });

  it('shows loading, error, and empty states without group headings', () => {
    mockDataHooks({ isLoading: true });
    const loading = renderCard();
    expect(loading.getByRole('status')).toBeInTheDocument();
    loading.unmount();

    mockDataHooks({ isError: true });
    const errorRender = renderCard();
    expect(errorRender.getByText('Relations unavailable')).toBeInTheDocument();
    errorRender.unmount();

    mockDataHooks({ relations: [], total: 0 });
    const emptyRender = renderCard();
    expect(emptyRender.getByText('Relations (0)')).toBeInTheDocument();
    expect(emptyRender.getByText('No relations yet.')).toBeInTheDocument();
    expect(emptyRender.queryByRole('heading', { name: /Related/ })).not.toBeInTheDocument();
    emptyRender.unmount();
  });

  it('loads the next relations page through the load-more action', () => {
    mockDataHooks({ hasNextPage: true, total: 5 });
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: /Load more \(3 of 5\)/ }));
    expect(fetchNextPageMock).toHaveBeenCalledTimes(1);
  });

  it('opens a themed removal confirmation and cancels without any request', () => {
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: 'Remove relation with Design API' }));

    const dialog = screen.getByRole('dialog', { name: 'Remove this relation?' });
    expect(dialog).toHaveTextContent('Time already logged to a provider does not move.');
    expect(deleteMutateMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Remove this relation?' })).not.toBeInTheDocument();
    expect(deleteMutateMock).not.toHaveBeenCalled();
  });

  it('confirms an eligible directed Related removal with source and target context once', async () => {
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: 'Remove relation with Design API' }));
    const dialog = screen.getByRole('dialog', { name: 'Remove this relation?' });
    // The pair routes time, so the warning names the exact source and target.
    await waitFor(() =>
      expect(dialog).toHaveTextContent('Current route: “Focal Epic” logs time with “Design API”.'),
    );
    expect(dialog).toHaveTextContent('Removing this relation deletes the pair and its time route.');
    expect(dialog).toHaveTextContent('Time already logged to a provider does not move.');

    fireEvent.click(screen.getByRole('button', { name: 'Remove', exact: true }));
    expect(deleteMutateMock).toHaveBeenCalledTimes(1);
    expect(deleteMutateMock).toHaveBeenCalledWith({ relatedEpicId: DESIGN_ID }, expect.anything());
    expect(screen.queryByRole('dialog', { name: 'Remove this relation?' })).not.toBeInTheDocument();
  });

  it('blocks confirmation until the directed Related removal context settles', async () => {
    let resolveTarget!: (response: Response) => void;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === `/api/epics/${DESIGN_ID}`) {
        return new Promise<Response>((resolve) => {
          resolveTarget = resolve;
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: 'Remove relation with Design API' }));
    const dialog = screen.getByRole('dialog', { name: 'Remove this relation?' });

    // While eligibility loads the warning stays generic and the confirm
    // action is unavailable, so the route context cannot be bypassed.
    expect(dialog).toHaveTextContent('Deleting removes this Related pair.');
    expect(dialog).toHaveTextContent('Time already logged to a provider does not move.');
    const confirm = screen.getByRole('button', { name: 'Remove', exact: true });
    expect(confirm).toBeDisabled();
    // Cancel stays available during the wait.
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();

    await act(async () => {
      resolveTarget(jsonResponse({ id: DESIGN_ID, parentId: null, projectId: FOCAL_PROJECT_ID }));
    });
    await waitFor(() =>
      expect(dialog).toHaveTextContent('Current route: “Focal Epic” logs time with “Design API”.'),
    );
    expect(screen.getByRole('button', { name: 'Remove', exact: true })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Remove', exact: true }));
    expect(deleteMutateMock).toHaveBeenCalledTimes(1);
    expect(deleteMutateMock).toHaveBeenCalledWith({ relatedEpicId: DESIGN_ID }, expect.anything());
  });

  it('keeps blocks and cross-project removal copy free of time-routing claims', () => {
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: 'Remove relation with Ship CLI' }));
    const dialog = screen.getByRole('dialog', { name: 'Remove this relation?' });
    expect(dialog).toHaveTextContent('Deleting removes this Blocks relation.');
    expect(dialog).not.toHaveTextContent('logs time with');
    expect(dialog).toHaveTextContent('Time already logged to a provider does not move.');

    fireEvent.click(screen.getByRole('button', { name: 'Remove', exact: true }));
    expect(deleteMutateMock).toHaveBeenCalledWith({ relatedEpicId: SHIP_ID }, expect.anything());
  });

  it('shows replacement wording before a type change and cancels without writing', async () => {
    renderCard();

    fireEvent.change(screen.getByLabelText('Relation type for Design API'), {
      target: { value: 'blocks' },
    });

    expect(
      await screen.findByRole('dialog', { name: 'Change relation type?' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/replaces the existing relation with “Design API”/),
    ).toBeInTheDocument();
    expect(setMutateMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(setMutateMock).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Relation type for Design API'), {
      target: { value: 'blocked_by' },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Change type' }));

    await waitFor(() => expect(setMutateMock).toHaveBeenCalledTimes(1));
    // The row select stays focal-relative: focal address first, type carries
    // the blocks polarity.
    expect(setMutateMock.mock.calls[0]?.[0]).toEqual({
      sourceEpicId: FOCAL_EPIC_ID,
      targetEpicId: DESIGN_ID,
      type: 'blocked_by',
    });
  });

  it('selects a candidate, previews source and target cards, and confirms the chosen direction', async () => {
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: 'Add relation' }));
    expect(await screen.findByRole('dialog', { name: 'Add relation' })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Search epics'), { target: { value: 'auth' } });
    expect(useEpicRelationCandidatesMock).toHaveBeenCalledWith(FOCAL_EPIC_ID, 'auth', {
      enabled: true,
    });

    fireEvent.click(screen.getByRole('button', { name: /Select Auth Service/ }));
    const addDialog = screen.getByRole('dialog', { name: 'Add relation' });
    expect(within(addDialog).getByText('Focal Epic')).toBeInTheDocument();
    expect(within(addDialog).getByText('Auth Service')).toBeInTheDocument();
    // The initiated Epic is the source and the selected Epic the target.
    expect(within(addDialog).getAllByText('Source')).toHaveLength(1);
    expect(within(addDialog).getAllByText('Target')).toHaveLength(1);
    expect(within(addDialog).getByTestId('relation-direction-summary')).toHaveTextContent(
      /“Auth Service” logs time with “Focal Epic”\./,
    );

    fireEvent.click(within(addDialog).getByRole('button', { name: 'Blocks' }));
    expect(within(addDialog).getByTestId('relation-direction-summary')).toHaveTextContent(
      /“Focal Epic” blocks “Auth Service”\./,
    );
    fireEvent.click(within(addDialog).getByRole('button', { name: 'Confirm link' }));

    expect(setMutateMock).toHaveBeenCalledTimes(1);
    expect(setMutateMock.mock.calls[0]?.[0]).toEqual({
      sourceEpicId: FOCAL_EPIC_ID,
      targetEpicId: AUTH_ID,
      type: 'blocks',
    });
  });

  it('writes the pair reversed after the arrow swaps source and target', async () => {
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: 'Add relation' }));
    await screen.findByRole('dialog', { name: 'Add relation' });
    fireEvent.click(screen.getByRole('button', { name: /Select Auth Service/ }));
    fireEvent.click(screen.getByRole('button', { name: /Swap source and target/i }));

    expect(screen.getByTestId('relation-direction-summary')).toHaveTextContent(
      /“Focal Epic” logs time with “Auth Service”\./,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Confirm link' }));

    await waitFor(() => expect(setMutateMock).toHaveBeenCalledTimes(1));
    expect(setMutateMock.mock.calls[0]?.[0]).toEqual({
      sourceEpicId: AUTH_ID,
      targetEpicId: FOCAL_EPIC_ID,
      type: 'related',
    });
  });

  it('states that child and cross-project candidates do not affect Epic time', async () => {
    mockDataHooks({
      candidateFixture: {
        ...candidate,
        parentId: 'epic-parent',
        project: { id: FOCAL_PROJECT_ID, name: 'Focal Project' },
      },
    });
    const childRender = renderCard();

    fireEvent.click(childRender.getByRole('button', { name: 'Add relation' }));
    await childRender.findByRole('dialog', { name: 'Add relation' });
    fireEvent.click(childRender.getByRole('button', { name: /Select Auth Service/ }));

    expect(childRender.getByTestId('relation-direction-summary')).toHaveTextContent(
      /does not affect Epic time/i,
    );
    childRender.unmount();

    mockDataHooks({
      candidateFixture: { ...candidate, project: { id: OTHER_PROJECT_ID, name: 'Other' } },
    });
    const crossProject = renderCard();
    fireEvent.click(crossProject.getByRole('button', { name: 'Add relation' }));
    await crossProject.findByRole('dialog', { name: 'Add relation' });
    fireEvent.click(crossProject.getByRole('button', { name: /Select Auth Service/ }));
    expect(crossProject.getByTestId('relation-direction-summary')).toHaveTextContent(
      /does not affect Epic time/i,
    );
  });

  it('activates the target project before navigating to a cross-project epic', async () => {
    selectedProjectFixture = { id: SAME_PROJECT_ID, workspaceId: 'ws-9', name: 'Current' };
    const { queryClient } = renderCard();

    await waitFor(() =>
      expect(
        queryClient.getQueryData(projectsQueryKeys.detail({ id: FOCAL_PROJECT_ID })),
      ).toBeDefined(),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open Ship CLI (22222222)' }));

    expect(activateProjectMock).toHaveBeenCalledWith({
      id: OTHER_PROJECT_ID,
      workspaceId: 'ws-1',
    });
    expect(
      await screen.findByText('Epic page 22222222-2222-2222-2222-222222222222'),
    ).toBeInTheDocument();
    expect(activateProjectMock.mock.invocationCallOrder[0]).toBeLessThan(
      navigateSpy.mock.invocationCallOrder[0],
    );
  });

  it('holds an immediate cross-project click while the focal workspace is pending, then completes it', async () => {
    selectedProjectFixture = { id: SAME_PROJECT_ID, workspaceId: 'ws-9', name: 'Current' };
    let resolveFocal: ((value: Response) => void) | undefined;
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === `/api/projects/${FOCAL_PROJECT_ID}`) {
        return new Promise<Response>((resolve) => {
          resolveFocal = resolve;
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: 'Open Ship CLI (22222222)' }));

    expect(activateProjectMock).not.toHaveBeenCalled();
    expect(navigateSpy).not.toHaveBeenCalled();
    expect(
      screen.queryByText('Epic page 22222222-2222-2222-2222-222222222222'),
    ).not.toBeInTheDocument();
    expect(screen.getByText('Opening project…')).toBeInTheDocument();
    expect(screen.getByText(/Preparing Other Project/)).toBeInTheDocument();

    await act(async () => {
      resolveFocal?.(
        jsonResponse({ id: FOCAL_PROJECT_ID, workspaceId: 'ws-1', name: 'Focal Project' }),
      );
    });

    await waitFor(() =>
      expect(activateProjectMock).toHaveBeenCalledWith({
        id: OTHER_PROJECT_ID,
        workspaceId: 'ws-1',
      }),
    );
    expect(
      await screen.findByText('Epic page 22222222-2222-2222-2222-222222222222'),
    ).toBeInTheDocument();
    expect(activateProjectMock.mock.invocationCallOrder[0]).toBeLessThan(
      navigateSpy.mock.invocationCallOrder[0],
    );
  });

  it('shows a retryable error and never navigates when the focal workspace cannot load', async () => {
    selectedProjectFixture = { id: SAME_PROJECT_ID, workspaceId: 'ws-9', name: 'Current' };
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === `/api/projects/${FOCAL_PROJECT_ID}`) {
        return { ok: false, json: async () => ({}) } as Response;
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: 'Open Ship CLI (22222222)' }));

    await waitFor(() => expect(screen.getByText('Project unavailable')).toBeInTheDocument());
    expect(activateProjectMock).not.toHaveBeenCalled();
    expect(navigateSpy).not.toHaveBeenCalled();
    expect(
      screen.getByText(/The workspace for Other Project could not be loaded/),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => {
      const projectCalls = fetchMock.mock.calls.filter(
        ([input]) => String(input) === `/api/projects/${FOCAL_PROJECT_ID}`,
      );
      expect(projectCalls.length).toBeGreaterThanOrEqual(2);
    });

    expect(activateProjectMock).not.toHaveBeenCalled();
    expect(navigateSpy).not.toHaveBeenCalled();
    expect(screen.getByText('Project unavailable')).toBeInTheDocument();
  });

  it('reuses the selected workspace when the focal project is selected', async () => {
    selectedProjectFixture = { id: FOCAL_PROJECT_ID, workspaceId: 'ws-9', name: 'Focal' };
    renderCard();

    await waitFor(() => expect(screen.getByText('Relations (3)')).toBeInTheDocument());
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Open Ship CLI (22222222)' }));

    expect(activateProjectMock).toHaveBeenCalledWith({
      id: OTHER_PROJECT_ID,
      workspaceId: 'ws-9',
    });
    expect(fetchMock).not.toHaveBeenCalledWith(
      `/api/projects/${FOCAL_PROJECT_ID}`,
      expect.anything(),
    );
  });

  it('navigates directly for same-project relations', async () => {
    selectedProjectFixture = { id: FOCAL_PROJECT_ID, workspaceId: 'ws-9', name: 'Focal' };
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: 'Open Design API (11111111)' }));

    expect(activateProjectMock).not.toHaveBeenCalled();
    expect(
      await screen.findByText('Epic page 11111111-1111-1111-1111-111111111111'),
    ).toBeInTheDocument();
  });

  it('opens the shared picker through Edit with the stored direction and swaps on save', async () => {
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: 'Edit relation with Design API' }));
    const editDialog = await screen.findByRole('dialog', { name: 'Edit relation' });
    expect(within(editDialog).getByText('Focal Epic')).toBeInTheDocument();
    expect(within(editDialog).getAllByText('Design API').length).toBeGreaterThan(0);
    // Design API is the stored source, so once eligibility resolves the
    // summary names the focal Epic as the one logging time.
    await waitFor(() =>
      expect(within(editDialog).getByTestId('relation-direction-summary')).toHaveTextContent(
        /“Focal Epic” logs time with “Design API”\./,
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: /Swap source and target/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(setMutateMock).toHaveBeenCalledTimes(1));
    // The flip writes the pair reversed: the focal Epic becomes the source.
    expect(setMutateMock.mock.calls[0]?.[0]).toEqual({
      sourceEpicId: FOCAL_EPIC_ID,
      targetEpicId: DESIGN_ID,
      type: 'related',
    });
  });

  it('notes a legacy neutral pair in Edit and stores the shown direction on save', async () => {
    mockDataHooks({ relations: [legacyNeutralRelation] });
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: 'Edit relation with Write docs' }));
    const editDialog = await screen.findByRole('dialog', { name: 'Edit relation' });
    expect(within(editDialog).getByText(/This pair has no direction yet\./)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(setMutateMock).toHaveBeenCalledTimes(1));
    expect(setMutateMock.mock.calls[0]?.[0]).toEqual({
      sourceEpicId: FOCAL_EPIC_ID,
      targetEpicId: DOCS_ID,
      type: 'related',
    });
  });

  it('shows server 409 facts in the edit dialog and retries with the exact accepted facts', async () => {
    mockDataHooks({
      setError: new EpicRelationConfirmationError('Confirm the route.', {
        sourceEpicId: DESIGN_ID,
        targetEpicId: FOCAL_EPIC_ID,
      }),
    });
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: 'Edit relation with Design API' }));
    expect(await screen.findByRole('dialog', { name: 'Edit relation' })).toBeInTheDocument();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Confirm the current time route');
    expect(alert).toHaveTextContent('Current route: “Focal Epic” logs time with “Design API”.');
    expect(alert).toHaveTextContent('Time already logged to a provider does not move.');

    fireEvent.click(screen.getByRole('button', { name: 'Accept route and save' }));
    expect(setMutateMock).toHaveBeenCalledTimes(1);
    // The edit draft keeps the stored direction (Design API is the source),
    // so the retry echoes the displayed facts on the reversed pair write.
    expect(setMutateMock.mock.calls[0]?.[0]).toEqual({
      sourceEpicId: DESIGN_ID,
      targetEpicId: FOCAL_EPIC_ID,
      type: 'related',
      confirmation: {
        acceptedRouteEffect: {
          sourceEpicId: DESIGN_ID,
          targetEpicId: FOCAL_EPIC_ID,
        },
      },
    });
  });

  it('shows the boundary warning when an eligible draft involves a linked endpoint', async () => {
    mockDataHooks({ linkedEpicIds: [FOCAL_EPIC_ID] });
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: 'Add relation' }));
    await screen.findByRole('dialog', { name: 'Add relation' });
    fireEvent.click(screen.getByRole('button', { name: /Select Auth Service/ }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Link boundary');
    expect(alert).toHaveTextContent('“Focal Epic” is linked to an external task');
    expect(alert).toHaveTextContent('Time already logged to a provider does not move.');
  });

  it('states that a Related edit with a child target does not affect Epic time', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === `/api/epics/${DESIGN_ID}`) {
        return jsonResponse({
          id: DESIGN_ID,
          parentId: 'epic-parent',
          projectId: FOCAL_PROJECT_ID,
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: 'Edit relation with Design API' }));
    const editDialog = await screen.findByRole('dialog', { name: 'Edit relation' });

    await waitFor(() =>
      expect(within(editDialog).getByTestId('relation-direction-summary')).toHaveTextContent(
        /does not affect Epic time/i,
      ),
    );
  });

  it('warns before a Blocks conversion removes a routed pair', async () => {
    renderCard();

    fireEvent.change(screen.getByLabelText('Relation type for Design API'), {
      target: { value: 'blocks' },
    });

    const dialog = await screen.findByRole('dialog', { name: 'Change relation type?' });
    expect(dialog).toHaveTextContent('Converting to Blocks removes the Related pair’s time route.');
    expect(dialog).toHaveTextContent('Time already logged to a provider does not move.');
  });

  it('keeps Blocks wording for a Related→Blocks displacement and derives it from the facts', async () => {
    mockDataHooks({
      setError: new EpicRelationConfirmationError('Confirm the route.', {
        sourceEpicId: FOCAL_EPIC_ID,
        targetEpicId: 'epic-other',
      }),
    });
    renderCard();

    fireEvent.change(screen.getByLabelText('Relation type for Design API'), {
      target: { value: 'blocks' },
    });

    const dialog = await screen.findByRole('dialog', { name: 'Change relation type?' });
    expect(dialog).toHaveTextContent('Converting to Blocks removes the Related pair’s time route.');
    expect(dialog).toHaveTextContent('Current route: Epic epic-oth logs time with “Focal Epic”.');
    expect(dialog).toHaveTextContent(
      'Saving converts the relation to Blocks and removes the Related pair’s time route.',
    );
    expect(dialog).not.toHaveTextContent('Saving removes the old Related pair');
  });

  it('states the old Related pair is removed for a Blocks→Related replacement', async () => {
    // Ship CLI is stored as a Blocks row; converting it to Related makes the
    // focal Epic the source of a new route, displacing its route to another
    // pair — a replacement, not a Blocks conversion.
    mockDataHooks({
      setError: new EpicRelationConfirmationError('Confirm the route.', {
        sourceEpicId: FOCAL_EPIC_ID,
        targetEpicId: 'epic-other',
      }),
    });
    renderCard();

    fireEvent.change(screen.getByLabelText('Relation type for Ship CLI'), {
      target: { value: 'related' },
    });

    const dialog = await screen.findByRole('dialog', { name: 'Change relation type?' });
    expect(dialog).toHaveTextContent('Current route: Epic epic-oth logs time with “Focal Epic”.');
    expect(dialog).toHaveTextContent('Saving removes the old Related pair');
    expect(dialog).not.toHaveTextContent('Converting to Blocks');
    expect(dialog).toHaveTextContent('Time already logged to a provider does not move.');
  });

  it('replaces displayed 409 facts after a later refusal and settles on the retry carrying them', async () => {
    const effectA = { sourceEpicId: DESIGN_ID, targetEpicId: 'epic-other-a' };
    const effectB = { sourceEpicId: DESIGN_ID, targetEpicId: FOCAL_EPIC_ID };
    // The mutate double plays the server: the A retry is refused, and the
    // retry carrying the displayed B facts succeeds and closes the dialog.
    let attempt = 0;
    setMutateMock.mockImplementation((_input, opts) => {
      attempt += 1;
      if (attempt >= 2) opts?.onSuccess?.();
    });
    mockDataHooks({ setError: new EpicRelationConfirmationError('Confirm A.', effectA) });
    const view = renderCard();

    fireEvent.click(view.getByRole('button', { name: 'Edit relation with Design API' }));
    let dialog = await view.findByRole('dialog', { name: 'Edit relation' });
    await waitFor(() =>
      expect(dialog).toHaveTextContent('Current route: Epic epic-oth logs time with “Design API”.'),
    );

    fireEvent.click(view.getByRole('button', { name: 'Accept route and save' }));
    expect(setMutateMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ confirmation: { acceptedRouteEffect: effectA } }),
      expect.anything(),
    );
    // The A retry is refused with fresh facts; the displayed effect must be
    // replaced in place while the dialog stays open.
    mockDataHooks({ setError: new EpicRelationConfirmationError('Confirm B.', effectB) });
    view.rerenderTree();
    dialog = view.getByRole('dialog', { name: 'Edit relation' });
    await waitFor(() =>
      expect(dialog).toHaveTextContent('Current route: “Focal Epic” logs time with “Design API”.'),
    );

    // The retry carrying exactly the displayed B facts succeeds: only that
    // effect is submitted, the stale A never rides along, and the dialog
    // closes through this submission's own success.
    fireEvent.click(view.getByRole('button', { name: 'Accept route and save' }));
    expect(setMutateMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ confirmation: { acceptedRouteEffect: effectB } }),
      expect.anything(),
    );
    expect(setMutateMock).toHaveBeenCalledTimes(2);
    await waitFor(() =>
      expect(view.queryByRole('dialog', { name: 'Edit relation' })).not.toBeInTheDocument(),
    );
  });

  it('clears stale 409 facts when the edit draft changes', async () => {
    mockDataHooks({
      setError: new EpicRelationConfirmationError('Confirm the route.', {
        sourceEpicId: 'epic-other',
        targetEpicId: DESIGN_ID,
      }),
    });
    const view = renderCard();

    fireEvent.click(view.getByRole('button', { name: 'Edit relation with Design API' }));
    const dialog = await view.findByRole('dialog', { name: 'Edit relation' });
    await waitFor(() => expect(dialog).toHaveTextContent('Confirm the current time route'));

    // Changing the draft invalidates the displayed facts: the user is no
    // longer approving that write.
    fireEvent.click(view.getByRole('button', { name: 'Blocks' }));
    expect(setResetMock).toHaveBeenCalled();
    mockDataHooks({ setError: null });
    view.rerenderTree();
    await waitFor(() =>
      expect(view.queryByText('Confirm the current time route')).not.toBeInTheDocument(),
    );
    expect(view.getByRole('button', { name: 'Save changes' })).toBeInTheDocument();
  });

  it('clears stale 409 facts when the add dialog changes draft or target', async () => {
    mockDataHooks({
      setError: new EpicRelationConfirmationError('Confirm the route.', {
        sourceEpicId: 'epic-other',
        targetEpicId: FOCAL_EPIC_ID,
      }),
    });
    const view = renderCard();

    fireEvent.click(view.getByRole('button', { name: 'Add relation' }));
    await view.findByRole('dialog', { name: 'Add relation' });
    fireEvent.click(view.getByRole('button', { name: /Select Auth Service/ }));
    await waitFor(() =>
      expect(view.getByText('Confirm the current time route')).toBeInTheDocument(),
    );

    // Selecting the target already reset once; every further draft or target
    // change clears the stale facts again.
    expect(setResetMock).toHaveBeenCalledTimes(1);
    fireEvent.click(view.getByRole('button', { name: /Swap source and target/i }));
    expect(setResetMock).toHaveBeenCalledTimes(2);

    fireEvent.click(view.getByRole('button', { name: 'Change target' }));
    expect(setResetMock).toHaveBeenCalledTimes(3);
    // Back on the search step the stale warning is gone from the dialog.
    mockDataHooks({ setError: null });
    view.rerenderTree();
    await waitFor(() =>
      expect(view.queryByText('Confirm the current time route')).not.toBeInTheDocument(),
    );
  });

  it('passes composed accessibility checks for the card and the add dialog', async () => {
    const { container } = renderCard();
    expect(await axe(container)).toHaveNoViolations();

    fireEvent.click(screen.getByRole('button', { name: 'Add relation' }));
    await screen.findByRole('dialog', { name: 'Add relation' });
    expect(await axe(document.body)).toHaveNoViolations();

    fireEvent.click(screen.getByRole('button', { name: /Select Auth Service/ }));
    expect(await axe(document.body)).toHaveNoViolations();
  });
});
