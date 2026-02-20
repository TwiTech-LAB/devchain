import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OrchestratorApp } from '@/modules/orchestrator/ui/app/orchestrator-app';
import {
  deleteWorktree,
  listWorktreeActivity,
  listWorktreeOverviews,
  listWorktrees,
  type WorktreeOverview,
  type WorktreeSummary,
} from '@/modules/orchestrator/ui/app/lib/worktrees';

jest.mock('@/modules/orchestrator/ui/app/lib/worktrees', () => {
  const actual = jest.requireActual('@/modules/orchestrator/ui/app/lib/worktrees');
  return {
    ...actual,
    listWorktrees: jest.fn(),
    listWorktreeOverviews: jest.fn(),
    listWorktreeActivity: jest.fn(),
    listBranches: jest.fn(),
    listTemplates: jest.fn(),
    createWorktree: jest.fn(),
    stopWorktree: jest.fn(),
    deleteWorktree: jest.fn(),
    previewMerge: jest.fn(),
    triggerMerge: jest.fn(),
  };
});

const listWorktreesMock = listWorktrees as jest.MockedFunction<typeof listWorktrees>;
const listWorktreeOverviewsMock = listWorktreeOverviews as jest.MockedFunction<
  typeof listWorktreeOverviews
>;
const listWorktreeActivityMock = listWorktreeActivity as jest.MockedFunction<
  typeof listWorktreeActivity
>;
const deleteWorktreeMock = deleteWorktree as jest.MockedFunction<typeof deleteWorktree>;

function makeWorktree(overrides: Partial<WorktreeSummary> = {}): WorktreeSummary {
  return {
    id: 'wt-1',
    name: 'feature-auth',
    branchName: 'feature/auth',
    baseBranch: 'main',
    repoPath: '/repo',
    worktreePath: '/repo/.worktrees/feature-auth',
    containerId: null,
    containerPort: 4310,
    templateSlug: '3-agent-dev',
    ownerProjectId: 'project-main',
    status: 'running',
    description: null,
    devchainProjectId: 'project-wt-1',
    mergeCommit: null,
    mergeConflicts: null,
    errorMessage: null,
    commitsAhead: 1,
    commitsBehind: 0,
    runtimeType: 'container',
    processId: null,
    runtimeToken: null,
    startedAt: '2024-01-01T00:00:00.000Z',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeOverview(worktree: WorktreeSummary): WorktreeOverview {
  return {
    worktree,
    epics: { total: 1, done: 0 },
    agents: { total: 1 },
    fetchedAt: '2024-01-01T00:00:00.000Z',
  };
}

function renderWithQuery() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <OrchestratorApp />
    </QueryClientProvider>,
  );
}

function createDeferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('OrchestratorApp delete state management', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const worktree = makeWorktree();
    listWorktreesMock.mockResolvedValue([worktree]);
    listWorktreeOverviewsMock.mockResolvedValue([makeOverview(worktree)]);
    listWorktreeActivityMock.mockResolvedValue([]);
  });

  it('shows card-level deleting state and renders delete failures inline', async () => {
    const user = userEvent.setup();
    const deferredDelete = createDeferred();
    deleteWorktreeMock.mockReturnValueOnce(deferredDelete.promise);

    renderWithQuery();

    const deleteButton = await screen.findByRole('button', { name: /^delete$/i });
    await user.click(deleteButton);

    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /^delete worktree$/i }));

    await waitFor(() => {
      expect(deleteWorktreeMock).toHaveBeenCalledWith('wt-1', { deleteBranch: true });
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: 'feature-auth' }).closest('[aria-busy="true"]'),
      ).not.toBeNull();
    });

    const deletingCard = screen
      .getByRole('heading', { name: 'feature-auth' })
      .closest('[aria-busy="true"]');
    expect(deletingCard).not.toBeNull();
    expect(
      within(deletingCard as HTMLElement).getByRole('button', { name: /^open$/i }),
    ).toBeDisabled();
    expect(
      within(deletingCard as HTMLElement).getByRole('button', { name: /^stop$/i }),
    ).toBeDisabled();
    expect(
      within(deletingCard as HTMLElement).getByRole('button', { name: /^merge$/i }),
    ).toBeDisabled();
    expect(
      within(deletingCard as HTMLElement).getByRole('button', { name: /^delete$/i }),
    ).toBeDisabled();
    expect((deletingCard as HTMLElement).querySelector('svg.animate-spin')).not.toBeNull();

    deferredDelete.reject(new Error('Delete failed in backend'));

    await waitFor(() => {
      expect(screen.getByText('Delete failed in backend')).toHaveClass(
        'text-xs',
        'text-destructive',
      );
    });
    expect(screen.getAllByText('Delete failed in backend')).toHaveLength(1);
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: 'feature-auth' }).closest('[aria-busy="true"]'),
      ).toBeNull();
    });
  });

  it('allows retrying delete for the same worktree after a failure', async () => {
    const user = userEvent.setup();
    deleteWorktreeMock
      .mockRejectedValueOnce(new Error('first delete failed'))
      .mockResolvedValueOnce(undefined);

    renderWithQuery();

    const deleteButton = await screen.findByRole('button', { name: /^delete$/i });
    await user.click(deleteButton);

    const firstDialog = await screen.findByRole('dialog');
    await user.click(within(firstDialog).getByRole('button', { name: /^delete worktree$/i }));

    await waitFor(() => {
      expect(deleteWorktreeMock).toHaveBeenNthCalledWith(1, 'wt-1', { deleteBranch: true });
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(await screen.findByText('first delete failed')).toBeInTheDocument();

    await user.click(await screen.findByRole('button', { name: /^delete$/i }));
    expect(screen.queryByText('first delete failed')).not.toBeInTheDocument();
    const secondDialog = await screen.findByRole('dialog');
    await user.click(within(secondDialog).getByRole('button', { name: /^delete worktree$/i }));

    await waitFor(() => {
      expect(deleteWorktreeMock).toHaveBeenNthCalledWith(2, 'wt-1', { deleteBranch: true });
    });
  });

  it('closes dialog immediately, shows deleting overlay, and removes overview card on successful delete', async () => {
    const user = userEvent.setup();
    const worktree = makeWorktree();
    const deferredDelete = createDeferred();
    listWorktreesMock.mockResolvedValueOnce([worktree]).mockResolvedValue([]);
    listWorktreeOverviewsMock
      .mockResolvedValueOnce([makeOverview(worktree)])
      .mockResolvedValueOnce([]);
    deleteWorktreeMock.mockReturnValueOnce(deferredDelete.promise);

    renderWithQuery();

    await user.click(await screen.findByRole('button', { name: /^delete$/i }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /^delete worktree$/i }));

    await waitFor(() => {
      expect(deleteWorktreeMock).toHaveBeenCalledWith('wt-1', { deleteBranch: true });
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(
      screen.getByRole('heading', { name: 'feature-auth' }).closest('[aria-busy="true"]'),
    ).not.toBeNull();

    await act(async () => {
      deferredDelete.resolve();
    });

    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'feature-auth' })).not.toBeInTheDocument();
    });
  });

  it('keeps other overview cards interactive while one card is deleting', async () => {
    const user = userEvent.setup();
    const primaryWorktree = makeWorktree();
    const secondaryWorktree = makeWorktree({
      id: 'wt-2',
      name: 'feature-billing',
      branchName: 'feature/billing',
      devchainProjectId: 'project-wt-2',
    });
    const deferredDelete = createDeferred();
    listWorktreesMock.mockResolvedValue([primaryWorktree, secondaryWorktree]);
    listWorktreeOverviewsMock.mockResolvedValue([
      makeOverview(primaryWorktree),
      makeOverview(secondaryWorktree),
    ]);
    deleteWorktreeMock.mockReturnValueOnce(deferredDelete.promise);

    renderWithQuery();

    const deleteButtons = await screen.findAllByRole('button', { name: /^delete$/i });
    await user.click(deleteButtons[0]);

    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /^delete worktree$/i }));

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: 'feature-auth' }).closest('[aria-busy="true"]'),
      ).not.toBeNull();
    });

    const overviewOpenButtons = screen.getAllByRole('button', { name: /^open$/i });
    expect(overviewOpenButtons[0]).toBeDisabled();
    const secondaryOpenButton = overviewOpenButtons[1];
    expect(secondaryOpenButton).toBeEnabled();

    await user.click(secondaryOpenButton);
    expect(await screen.findByRole('heading', { name: 'feature/billing' })).toBeInTheDocument();

    await act(async () => {
      deferredDelete.resolve();
    });
  });

  it('applies deleting state to selected-tab and merged-notice delete buttons with inline selected-tab errors', async () => {
    const user = userEvent.setup();
    const mergedWorktree = makeWorktree({ status: 'merged' });
    listWorktreesMock.mockResolvedValue([mergedWorktree]);
    listWorktreeOverviewsMock.mockResolvedValue([makeOverview(mergedWorktree)]);
    deleteWorktreeMock.mockRejectedValueOnce(new Error('selected delete failed'));

    renderWithQuery();

    await user.click(await screen.findByRole('button', { name: /^open$/i }));
    expect(await screen.findByRole('heading', { name: 'feature/auth' })).toBeInTheDocument();

    const deleteButtons = await screen.findAllByRole('button', { name: /^delete worktree$/i });
    expect(deleteButtons).toHaveLength(2);
    await user.click(deleteButtons[0]);

    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /^delete worktree$/i }));

    await waitFor(() => {
      expect(deleteWorktreeMock).toHaveBeenCalledWith('wt-1', { deleteBranch: true });
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    expect(await screen.findByText('selected delete failed')).toHaveClass(
      'text-xs',
      'text-destructive',
    );
    for (const button of screen.getAllByRole('button', { name: /^delete worktree$/i })) {
      expect(button).toBeEnabled();
    }
  });

  it('switches back to overview after successful delete from selected-tab', async () => {
    const user = userEvent.setup();
    const mergedWorktree = makeWorktree({ status: 'merged' });
    const deferredDelete = createDeferred();
    listWorktreesMock.mockResolvedValueOnce([mergedWorktree]).mockResolvedValue([]);
    listWorktreeOverviewsMock
      .mockResolvedValueOnce([makeOverview(mergedWorktree)])
      .mockResolvedValueOnce([]);
    deleteWorktreeMock.mockReturnValueOnce(deferredDelete.promise);

    renderWithQuery();

    await user.click(await screen.findByRole('button', { name: /^open$/i }));
    expect(await screen.findByRole('heading', { name: 'feature/auth' })).toBeInTheDocument();

    const selectedTabDeleteButton = (
      await screen.findAllByRole('button', {
        name: /^delete worktree$/i,
      })
    )[0];
    await user.click(selectedTabDeleteButton);

    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /^delete worktree$/i }));

    await waitFor(() => {
      for (const button of screen.getAllByRole('button', { name: /^delete worktree$/i })) {
        expect(button).toBeDisabled();
      }
      expect(document.querySelector('button svg.animate-spin')).not.toBeNull();
    });

    await act(async () => {
      deferredDelete.resolve();
    });

    expect(await screen.findByRole('heading', { name: 'Worktree Overview' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'feature/auth' })).not.toBeInTheDocument();
  });
});
