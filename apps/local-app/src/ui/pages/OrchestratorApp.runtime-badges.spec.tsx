import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OrchestratorApp } from '@/modules/orchestrator/ui/app/orchestrator-app';
import {
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

function makeWorktree(runtimeType: 'container' | 'process'): WorktreeSummary {
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
    runtimeType,
    processId: 1234,
    runtimeToken: null,
    startedAt: '2024-01-01T00:00:00.000Z',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };
}

function makeOverview(worktree: WorktreeSummary): WorktreeOverview {
  return {
    worktree,
    epics: { total: 2, done: 1 },
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

describe('OrchestratorApp runtime badges', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('shows runtime type badges in overview and detail worktree views', async () => {
    const user = userEvent.setup();
    const worktree = makeWorktree('process');
    listWorktreesMock.mockResolvedValue([worktree]);
    listWorktreeOverviewsMock.mockResolvedValue([makeOverview(worktree)]);
    listWorktreeActivityMock.mockResolvedValue([]);

    renderWithQuery();

    expect(await screen.findByRole('heading', { name: 'Worktree Overview' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /^open$/i })).toBeInTheDocument();
    expect(screen.getAllByText('Process').length).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: /^open$/i }));

    expect(await screen.findByRole('heading', { name: 'feature/auth' })).toBeInTheDocument();
    expect(screen.getAllByText('Process').length).toBeGreaterThan(0);
  });

  it('renders lifecycle activity feed with event messages, names, and type icons', async () => {
    const worktree = makeWorktree('container');
    listWorktreesMock.mockResolvedValue([worktree]);
    listWorktreeOverviewsMock.mockResolvedValue([makeOverview(worktree)]);
    listWorktreeActivityMock.mockResolvedValue([
      {
        id: 'evt-start',
        type: 'started',
        message: "Worktree 'feature-auth' started",
        worktreeId: 'wt-1',
        worktreeName: 'feature-auth',
        publishedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
      },
      {
        id: 'evt-stop',
        type: 'stopped',
        message: "Worktree 'feature-auth' stopped",
        worktreeId: 'wt-1',
        worktreeName: 'feature-auth',
        publishedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
      },
      {
        id: 'evt-create',
        type: 'created',
        message: "Worktree 'feature-auth' created on branch feature/auth",
        worktreeId: 'wt-1',
        worktreeName: 'feature-auth',
        publishedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
      },
      {
        id: 'evt-delete',
        type: 'deleted',
        message: "Worktree 'feature-auth' deleted",
        worktreeId: 'wt-1',
        worktreeName: 'feature-auth',
        publishedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      },
      {
        id: 'evt-merge',
        type: 'merged',
        message: "Worktree 'feature-auth' merged into main",
        worktreeId: 'wt-1',
        worktreeName: 'feature-auth',
        publishedAt: new Date(Date.now() - 6 * 60_000).toISOString(),
      },
      {
        id: 'evt-error',
        type: 'error',
        message: "Worktree 'feature-auth' encountered an error: probe failed",
        worktreeId: 'wt-1',
        worktreeName: 'feature-auth',
        publishedAt: new Date(Date.now() - 7 * 60_000).toISOString(),
      },
    ]);

    renderWithQuery();

    expect(await screen.findByRole('heading', { name: 'Lifecycle Activity' })).toBeInTheDocument();
    expect(await screen.findByText("Worktree 'feature-auth' merged into main")).toBeInTheDocument();
    expect(
      await screen.findByText("Worktree 'feature-auth' encountered an error: probe failed"),
    ).toBeInTheDocument();
    expect(screen.getAllByText('feature-auth').length).toBeGreaterThan(0);

    expect(document.querySelector('.lucide-play')).not.toBeNull();
    expect(document.querySelector('.lucide-square')).not.toBeNull();
    expect(document.querySelector('.lucide-trash-2')).not.toBeNull();
    expect(document.querySelector('.lucide-git-merge')).not.toBeNull();
    expect(document.querySelector('.lucide-alert-circle, .lucide-circle-alert')).not.toBeNull();
  });

  it('shows empty lifecycle activity state when no events are available', async () => {
    const worktree = makeWorktree('container');
    listWorktreesMock.mockResolvedValue([worktree]);
    listWorktreeOverviewsMock.mockResolvedValue([makeOverview(worktree)]);
    listWorktreeActivityMock.mockResolvedValue([]);

    renderWithQuery();

    expect(await screen.findByRole('heading', { name: 'Lifecycle Activity' })).toBeInTheDocument();
    expect(await screen.findByText('No activity yet.')).toBeInTheDocument();
  });
});
