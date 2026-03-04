import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OrchestratorApp } from '@/modules/orchestrator/ui/app/orchestrator-app';
import {
  createWorktree,
  listIgnoredFiles,
  listBranches,
  listTemplates,
  listWorktreeActivity,
  listWorktreeOverviews,
  listWorktrees,
  type CreateWorktreeInput,
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
    listIgnoredFiles: jest.fn(),
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
const listBranchesMock = listBranches as jest.MockedFunction<typeof listBranches>;
const listIgnoredFilesMock = listIgnoredFiles as jest.MockedFunction<typeof listIgnoredFiles>;
const listTemplatesMock = listTemplates as jest.MockedFunction<typeof listTemplates>;
const createWorktreeMock = createWorktree as jest.MockedFunction<typeof createWorktree>;

function buildCreatedWorktree(input: CreateWorktreeInput): WorktreeSummary {
  return {
    id: `${input.ownerProjectId}-${input.name}`,
    name: input.name,
    branchName: input.branchName,
    baseBranch: input.baseBranch,
    repoPath: `/repos/${input.ownerProjectId}`,
    worktreePath: `/repos/${input.ownerProjectId}/worktrees/${input.name}`,
    containerId: null,
    containerPort: null,
    templateSlug: input.templateSlug,
    ownerProjectId: input.ownerProjectId,
    status: 'running',
    description: input.description ?? null,
    devchainProjectId: `${input.ownerProjectId}-wt`,
    mergeCommit: null,
    mergeConflicts: null,
    errorMessage: null,
    commitsAhead: 0,
    commitsBehind: 0,
    runtimeType: input.runtimeType ?? 'process',
    processId: 1001,
    runtimeToken: null,
    startedAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('OrchestratorApp branch scoping', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    listWorktreesMock.mockResolvedValue([]);
    listWorktreeOverviewsMock.mockResolvedValue([]);
    listWorktreeActivityMock.mockResolvedValue([]);
    listTemplatesMock.mockResolvedValue([{ slug: '3-agent-dev', name: '3-Agent Dev' }]);
    listBranchesMock.mockImplementation(async (ownerProjectId: string) =>
      ownerProjectId === 'project-a' ? ['project-a-main'] : ['project-b-main'],
    );
    listIgnoredFilesMock.mockResolvedValue([]);
    createWorktreeMock.mockImplementation(async (input) => buildCreatedWorktree(input));
  });

  it('refetches branches and ignored files when ownerProjectId changes while create dialog is open', async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });
    const view = render(
      <QueryClientProvider client={queryClient}>
        <OrchestratorApp ownerProjectId="project-a" />
      </QueryClientProvider>,
    );

    await user.click(screen.getByRole('button', { name: /new worktree/i }));
    await waitFor(() => {
      expect(listBranchesMock).toHaveBeenCalledWith('project-a');
    });
    await waitFor(() => {
      expect(listIgnoredFilesMock).toHaveBeenCalledWith('project-a');
    });

    view.rerender(
      <QueryClientProvider client={queryClient}>
        <OrchestratorApp ownerProjectId="project-b" />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(listBranchesMock).toHaveBeenCalledWith('project-b');
    });
    await waitFor(() => {
      expect(listIgnoredFilesMock).toHaveBeenCalledWith('project-b');
    });
  });

  it('uses project-scoped branch source and ownerProjectId in create payload across projects', async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });

    const view = render(
      <QueryClientProvider client={queryClient}>
        <OrchestratorApp ownerProjectId="project-a" />
      </QueryClientProvider>,
    );

    await user.click(screen.getByRole('button', { name: /new worktree/i }));
    await waitFor(() => {
      expect(listBranchesMock).toHaveBeenCalledWith('project-a');
    });
    await user.type(screen.getByLabelText('Name'), 'feature-a');
    await user.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => {
      expect(createWorktreeMock).toHaveBeenCalled();
    });
    const firstCreateInput = createWorktreeMock.mock.calls[0]?.[0] as CreateWorktreeInput;
    expect(firstCreateInput.ownerProjectId).toBe('project-a');
    expect(firstCreateInput.baseBranch).toBe('project-a-main');

    view.rerender(
      <QueryClientProvider client={queryClient}>
        <OrchestratorApp ownerProjectId="project-b" />
      </QueryClientProvider>,
    );

    await user.click(screen.getByRole('button', { name: /new worktree/i }));
    await waitFor(() => {
      expect(listBranchesMock).toHaveBeenCalledWith('project-b');
    });
    await user.type(screen.getByLabelText('Name'), 'feature-b');
    await user.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => {
      expect(createWorktreeMock).toHaveBeenCalledTimes(2);
    });
    const secondCreateInput = createWorktreeMock.mock.calls[1]?.[0] as CreateWorktreeInput;
    expect(secondCreateInput.ownerProjectId).toBe('project-b');
    expect(secondCreateInput.baseBranch).toBe('project-b-main');
  });
});
