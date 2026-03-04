import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OrchestratorApp } from '@/modules/orchestrator/ui/app/orchestrator-app';
import {
  createWorktree,
  listBranches,
  listIgnoredFiles,
  listTemplates,
  listWorktreeActivity,
  listWorktreeOverviews,
  listWorktrees,
  type CreateWorktreeInput,
  type WorktreeSummary,
} from '@/modules/orchestrator/ui/app/lib/worktrees';
import { useToast } from '@/ui/hooks/use-toast';

const toastSpy = jest.fn();

jest.mock('@/ui/hooks/use-toast', () => ({
  useToast: jest.fn(),
}));

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
const useToastMock = useToast as jest.MockedFunction<typeof useToast>;

function buildCreatedWorktree(
  input: CreateWorktreeInput,
  overrides: Partial<WorktreeSummary> = {},
): WorktreeSummary {
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
    ...overrides,
  };
}

function renderWithQuery(ownerProjectId = 'project-main') {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <OrchestratorApp ownerProjectId={ownerProjectId} />
    </QueryClientProvider>,
  );
}

describe('OrchestratorApp ignored files in create dialog', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    useToastMock.mockReturnValue({
      toast: toastSpy,
      toasts: [],
      dismiss: jest.fn(),
    });
    listWorktreesMock.mockResolvedValue([]);
    listWorktreeOverviewsMock.mockResolvedValue([]);
    listWorktreeActivityMock.mockResolvedValue([]);
    listBranchesMock.mockResolvedValue(['main']);
    listTemplatesMock.mockResolvedValue([{ slug: '3-agent-dev', name: '3-Agent Dev' }]);
    listIgnoredFilesMock.mockResolvedValue([
      { path: '.env.local', type: 'file', defaultIncluded: true },
      { path: 'node_modules/', type: 'directory', defaultIncluded: false },
    ]);
    createWorktreeMock.mockImplementation(async (input) => buildCreatedWorktree(input));
  });

  it('keeps ignored-files section collapsed by default and pre-checks defaultIncluded entries', async () => {
    const user = userEvent.setup();
    renderWithQuery();

    await user.click(screen.getByRole('button', { name: /new worktree/i }));
    await waitFor(() => {
      expect(listIgnoredFilesMock).toHaveBeenCalledWith('project-main');
    });

    const trigger = await screen.findByRole('button', { name: /include gitignored files/i });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByLabelText('.env.local')).not.toBeInTheDocument();

    await user.click(trigger);

    expect(await screen.findByLabelText('.env.local')).toBeChecked();
    expect(screen.getByLabelText('node_modules/')).not.toBeChecked();
  });

  it('shows empty state when no gitignored files are discovered', async () => {
    const user = userEvent.setup();
    listIgnoredFilesMock.mockResolvedValueOnce([]);
    renderWithQuery();

    await user.click(screen.getByRole('button', { name: /new worktree/i }));
    await user.click(await screen.findByRole('button', { name: /include gitignored files/i }));

    expect(await screen.findByText('No gitignored files found')).toBeInTheDocument();
  });

  it('sends selected ignored file paths in create payload', async () => {
    const user = userEvent.setup();
    renderWithQuery();

    await user.click(screen.getByRole('button', { name: /new worktree/i }));
    await user.type(screen.getByLabelText('Name'), 'feature-ignore-copy');
    await user.click(await screen.findByRole('button', { name: /include gitignored files/i }));
    await user.click(await screen.findByLabelText('node_modules/'));
    await user.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => {
      expect(createWorktreeMock).toHaveBeenCalled();
    });

    const createInput = createWorktreeMock.mock.calls[0]?.[0] as CreateWorktreeInput;
    expect(createInput.includeIgnoredFiles).toEqual(['.env.local', 'node_modules/']);
  });

  it('persists ignored file selections to project-scoped localStorage after create', async () => {
    const user = userEvent.setup();
    const setItemSpy = jest.spyOn(Storage.prototype, 'setItem');
    renderWithQuery('project-main');

    await user.click(screen.getByRole('button', { name: /new worktree/i }));
    await user.type(screen.getByLabelText('Name'), 'feature-persist-ignored');
    await user.click(await screen.findByRole('button', { name: /include gitignored files/i }));
    await user.click(await screen.findByLabelText('node_modules/'));
    await user.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => {
      expect(createWorktreeMock).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(setItemSpy).toHaveBeenCalledWith(
        'devchain:worktree-ignored-selection:project-main',
        JSON.stringify(['.env.local', 'node_modules/']),
      );
    });

    setItemSpy.mockRestore();
  });

  it('rehydrates saved selection from localStorage and filters stale paths', async () => {
    const user = userEvent.setup();
    localStorage.setItem(
      'devchain:worktree-ignored-selection:project-main',
      JSON.stringify(['node_modules/', 'stale/path.txt']),
    );
    renderWithQuery('project-main');

    await user.click(screen.getByRole('button', { name: /new worktree/i }));
    await user.click(await screen.findByRole('button', { name: /include gitignored files/i }));

    expect(await screen.findByLabelText('node_modules/')).toBeChecked();
    expect(screen.getByLabelText('.env.local')).not.toBeChecked();
  });

  it('falls back to defaultIncluded selection when localStorage data is malformed', async () => {
    const user = userEvent.setup();
    localStorage.setItem('devchain:worktree-ignored-selection:project-main', '{not-json');
    renderWithQuery('project-main');

    await user.click(screen.getByRole('button', { name: /new worktree/i }));
    await user.click(await screen.findByRole('button', { name: /include gitignored files/i }));

    expect(await screen.findByLabelText('.env.local')).toBeChecked();
    expect(screen.getByLabelText('node_modules/')).not.toBeChecked();
  });

  it('re-reads saved selection when owner project changes while dialog is open', async () => {
    const user = userEvent.setup();
    localStorage.setItem(
      'devchain:worktree-ignored-selection:project-a',
      JSON.stringify(['node_modules/']),
    );
    localStorage.setItem(
      'devchain:worktree-ignored-selection:project-b',
      JSON.stringify(['.env.local']),
    );
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
    await user.click(await screen.findByRole('button', { name: /include gitignored files/i }));
    expect(await screen.findByLabelText('node_modules/')).toBeChecked();
    expect(screen.getByLabelText('.env.local')).not.toBeChecked();

    view.rerender(
      <QueryClientProvider client={queryClient}>
        <OrchestratorApp ownerProjectId="project-b" />
      </QueryClientProvider>,
    );

    if (!screen.queryByRole('dialog', { name: /create new worktree/i })) {
      await user.click(screen.getByRole('button', { name: /new worktree/i }));
    }
    const ignoredFilesToggle = await screen.findByRole('button', {
      name: /include gitignored files/i,
    });
    if (ignoredFilesToggle.getAttribute('aria-expanded') !== 'true') {
      await user.click(ignoredFilesToggle);
    }

    await waitFor(() => {
      expect(screen.getByLabelText('.env.local')).toBeChecked();
      expect(screen.getByLabelText('node_modules/')).not.toBeChecked();
    });
  });

  it('filters ignored files and applies bulk select to visible entries only', async () => {
    const user = userEvent.setup();
    listIgnoredFilesMock.mockResolvedValueOnce([
      { path: '.env.local', type: 'file', defaultIncluded: true },
      { path: 'node_modules/', type: 'directory', defaultIncluded: false },
      { path: 'dist/cache/', type: 'directory', defaultIncluded: false },
    ]);
    renderWithQuery();

    await user.click(screen.getByRole('button', { name: /new worktree/i }));
    await user.click(await screen.findByRole('button', { name: /include gitignored files/i }));

    const filterInput = await screen.findByPlaceholderText('Filter files...');
    await user.type(filterInput, 'node');

    expect(screen.getByText('Showing 1 of 3')).toBeInTheDocument();
    expect(screen.getByLabelText('node_modules/')).not.toBeChecked();
    expect(screen.queryByLabelText('.env.local')).not.toBeInTheDocument();

    const selectAllShown = screen.getByRole('checkbox', { name: /select all shown/i });
    await user.click(selectAllShown);
    expect(screen.getByLabelText('node_modules/')).toBeChecked();
    expect(screen.getAllByText('2 selected').length).toBeGreaterThan(0);

    await user.clear(filterInput);
    expect(screen.getByRole('checkbox', { name: /select all shown/i })).toHaveAttribute(
      'data-state',
      'indeterminate',
    );

    await user.type(filterInput, 'node');
    await user.click(selectAllShown);
    expect(screen.getByLabelText('node_modules/')).not.toBeChecked();
    expect(screen.getAllByText('1 selected').length).toBeGreaterThan(0);
  });

  it('resets ignored-files filter on dialog close and owner project change', async () => {
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
    await user.click(await screen.findByRole('button', { name: /include gitignored files/i }));
    const filterInput = await screen.findByPlaceholderText('Filter files...');
    await user.type(filterInput, 'node');
    expect(filterInput).toHaveValue('node');

    await user.click(screen.getByRole('button', { name: /cancel/i }));
    await user.click(screen.getByRole('button', { name: /new worktree/i }));
    await user.click(await screen.findByRole('button', { name: /include gitignored files/i }));
    const reopenedFilterInput = await screen.findByPlaceholderText('Filter files...');
    expect(reopenedFilterInput).toHaveValue('');

    await user.type(reopenedFilterInput, 'env');
    expect(reopenedFilterInput).toHaveValue('env');

    view.rerender(
      <QueryClientProvider client={queryClient}>
        <OrchestratorApp ownerProjectId="project-b" />
      </QueryClientProvider>,
    );

    if (!screen.queryByRole('dialog', { name: /create new worktree/i })) {
      await user.click(screen.getByRole('button', { name: /new worktree/i }));
    }

    const ignoredFilesToggle = await screen.findByRole('button', {
      name: /include gitignored files/i,
    });
    if (ignoredFilesToggle.getAttribute('aria-expanded') !== 'true') {
      await user.click(ignoredFilesToggle);
    }
    const switchedFilterInput = await screen.findByPlaceholderText('Filter files...');

    await waitFor(() => {
      expect(switchedFilterInput).toHaveValue('');
    });
  });

  it('shows warning toast when ignored file copy has failures', async () => {
    const user = userEvent.setup();
    createWorktreeMock.mockImplementationOnce(async (input) =>
      buildCreatedWorktree(input, {
        copyResults: {
          copied: [],
          failed: [{ path: '.env.local', error: 'ENOENT' }],
        },
      }),
    );

    renderWithQuery();

    await user.click(screen.getByRole('button', { name: /new worktree/i }));
    await user.type(screen.getByLabelText('Name'), 'feature-copy-warning');
    await user.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => {
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Worktree created with warnings',
          description: expect.stringContaining('.env.local'),
        }),
      );
    });
  });
});
