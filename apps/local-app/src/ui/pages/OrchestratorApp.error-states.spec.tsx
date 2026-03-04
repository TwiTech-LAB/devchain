import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OrchestratorApp } from '@/modules/orchestrator/ui/app/orchestrator-app';
import {
  listBranches,
  listIgnoredFiles,
  listWorktreeActivity,
  listTemplates,
  listWorktreeOverviews,
  listWorktrees,
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

function renderWithQuery(ownerProjectId?: string | null): void {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <OrchestratorApp ownerProjectId={ownerProjectId} />
    </QueryClientProvider>,
  );
}

describe('OrchestratorApp create dialog error states', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    listWorktreesMock.mockResolvedValue([]);
    listWorktreeOverviewsMock.mockResolvedValue([]);
    listWorktreeActivityMock.mockResolvedValue([]);
    listBranchesMock.mockResolvedValue(['main']);
    listIgnoredFilesMock.mockResolvedValue([]);
    listTemplatesMock.mockResolvedValue([{ slug: '3-agent-dev', name: '3-Agent Dev' }]);
  });

  it('shows branch fetch errors and manual base-branch input in the create dialog', async () => {
    const user = userEvent.setup();
    listBranchesMock.mockRejectedValueOnce(new Error('Failed to load branches: HTTP 503'));

    renderWithQuery('project-main');

    await user.click(screen.getByRole('button', { name: /new worktree/i }));

    expect(await screen.findByText('Failed to load branches: HTTP 503')).toBeInTheDocument();
    expect(screen.getByLabelText(/enter base branch manually/i)).toBeInTheDocument();
  });

  it('shows template fetch errors in the create dialog', async () => {
    const user = userEvent.setup();
    listTemplatesMock.mockRejectedValueOnce(new Error('No templates available'));

    renderWithQuery('project-main');

    await user.click(screen.getByRole('button', { name: /new worktree/i }));

    expect(await screen.findByText('No templates available')).toBeInTheDocument();
    expect(screen.getByLabelText(/template/i)).toBeDisabled();
  });

  it('does not fetch branches when no project is selected', async () => {
    const user = userEvent.setup();

    renderWithQuery(null);
    await user.click(screen.getByRole('button', { name: /new worktree/i }));

    expect(listBranchesMock).not.toHaveBeenCalled();
    expect(listIgnoredFilesMock).not.toHaveBeenCalled();
    expect(await screen.findByLabelText(/enter base branch manually/i)).toBeInTheDocument();
  });
});
