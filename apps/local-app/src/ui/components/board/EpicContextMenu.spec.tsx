import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { EpicContextMenu } from './EpicContextMenu';
import type { Epic } from '@/ui/types';
import type { ActiveWorktreeTab } from '@/ui/hooks/useWorktreeTab';

// Polyfill DOMRect for Radix floating-ui in jsdom
if (typeof globalThis.DOMRect === 'undefined') {
  (globalThis as unknown as Record<string, unknown>).DOMRect = class DOMRect {
    x = 0;
    y = 0;
    width = 0;
    height = 0;
    top = 0;
    right = 0;
    bottom = 0;
    left = 0;
    toJSON() {
      return {};
    }
    static fromRect() {
      return new DOMRect();
    }
  };
}

function makeEpic(overrides: Partial<Epic> = {}): Epic {
  return {
    id: 'epic-1',
    projectId: 'proj-1',
    title: 'Test Epic',
    description: null,
    statusId: 'status-1',
    version: 1,
    parentId: null,
    agentId: null,
    tags: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('EpicContextMenu', () => {
  const onMoveToWorktree = jest.fn();

  beforeEach(() => {
    onMoveToWorktree.mockClear();
  });

  it('renders children without context menu for sub-epics', () => {
    const epic = makeEpic({ parentId: 'parent-1' });
    render(
      <EpicContextMenu epic={epic} onMoveToWorktree={onMoveToWorktree} hasRunningWorktrees={true}>
        <div data-testid="child">Card Content</div>
      </EpicContextMenu>,
    );

    expect(screen.getByTestId('child')).toBeInTheDocument();
    expect(screen.queryByText('Move to worktree…')).not.toBeInTheDocument();
  });

  it('renders children without context menu when no running worktrees', () => {
    const epic = makeEpic({ parentId: null });
    render(
      <EpicContextMenu epic={epic} onMoveToWorktree={onMoveToWorktree} hasRunningWorktrees={false}>
        <div data-testid="child">Card Content</div>
      </EpicContextMenu>,
    );

    expect(screen.getByTestId('child')).toBeInTheDocument();
    expect(screen.queryByText('Move to worktree…')).not.toBeInTheDocument();
  });

  it('renders children without context menu for sub-epics even with running worktrees', () => {
    const epic = makeEpic({ parentId: 'parent-1' });
    render(
      <EpicContextMenu epic={epic} onMoveToWorktree={onMoveToWorktree} hasRunningWorktrees={true}>
        <div data-testid="child">Card Content</div>
      </EpicContextMenu>,
    );

    expect(screen.getByTestId('child')).toBeInTheDocument();
    expect(screen.queryByText('Move to worktree…')).not.toBeInTheDocument();
  });

  it('wraps children in a context menu trigger for parent epics with running worktrees', () => {
    const epic = makeEpic({ parentId: null });
    render(
      <EpicContextMenu epic={epic} onMoveToWorktree={onMoveToWorktree} hasRunningWorktrees={true}>
        <div data-testid="child">Card Content</div>
      </EpicContextMenu>,
    );

    // Children should still be rendered
    expect(screen.getByTestId('child')).toBeInTheDocument();
  });

  it('shows "Move to worktree…" on right-click for parent epic with running worktrees', async () => {
    const epic = makeEpic({ parentId: null });
    render(
      <EpicContextMenu epic={epic} onMoveToWorktree={onMoveToWorktree} hasRunningWorktrees={true}>
        <div data-testid="child">Card Content</div>
      </EpicContextMenu>,
    );

    fireEvent.contextMenu(screen.getByTestId('child'));

    await waitFor(() => {
      expect(screen.getByText('Move to worktree…')).toBeInTheDocument();
    });
  });

  it('calls onMoveToWorktree with the epic when menu item is clicked', async () => {
    const epic = makeEpic({ parentId: null, id: 'epic-42' });
    render(
      <EpicContextMenu epic={epic} onMoveToWorktree={onMoveToWorktree} hasRunningWorktrees={true}>
        <div data-testid="child">Card Content</div>
      </EpicContextMenu>,
    );

    fireEvent.contextMenu(screen.getByTestId('child'));

    await waitFor(() => {
      expect(screen.getByText('Move to worktree…')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Move to worktree…'));

    expect(onMoveToWorktree).toHaveBeenCalledTimes(1);
    expect(onMoveToWorktree).toHaveBeenCalledWith(epic);
  });
});

// ── Visibility gate logic (hasRunningWorktrees computation) ─────

describe('hasRunningWorktrees visibility gate', () => {
  function makeWorktree(overrides: Partial<ActiveWorktreeTab> = {}): ActiveWorktreeTab {
    return {
      id: 'wt-1',
      name: 'feature-branch',
      devchainProjectId: 'proj-wt',
      status: 'running',
      ...overrides,
    };
  }

  /** Mirrors the computation in BoardPage.tsx */
  function computeHasRunningWorktrees(
    activeWorktree: ActiveWorktreeTab | null,
    worktrees: ActiveWorktreeTab[],
  ): boolean {
    return activeWorktree === null && worktrees.some((wt) => wt.status === 'running');
  }

  it('returns false when worktrees array is empty', () => {
    expect(computeHasRunningWorktrees(null, [])).toBe(false);
  });

  it('returns false when all worktrees are stopped', () => {
    const worktrees = [
      makeWorktree({ id: 'wt-1', status: 'stopped' }),
      makeWorktree({ id: 'wt-2', status: 'stopped' }),
    ];
    expect(computeHasRunningWorktrees(null, worktrees)).toBe(false);
  });

  it('returns false when all worktrees have non-running statuses', () => {
    const worktrees = [
      makeWorktree({ id: 'wt-1', status: 'stopped' }),
      makeWorktree({ id: 'wt-2', status: 'merged' }),
      makeWorktree({ id: 'wt-3', status: 'completed' }),
    ];
    expect(computeHasRunningWorktrees(null, worktrees)).toBe(false);
  });

  it('returns true when at least one worktree is running', () => {
    const worktrees = [
      makeWorktree({ id: 'wt-1', status: 'stopped' }),
      makeWorktree({ id: 'wt-2', status: 'running' }),
    ];
    expect(computeHasRunningWorktrees(null, worktrees)).toBe(true);
  });

  it('returns true when all worktrees are running', () => {
    const worktrees = [
      makeWorktree({ id: 'wt-1', status: 'running' }),
      makeWorktree({ id: 'wt-2', status: 'running' }),
    ];
    expect(computeHasRunningWorktrees(null, worktrees)).toBe(true);
  });

  it('returns false when activeWorktree is set (worktree tab mode)', () => {
    const active = makeWorktree({ id: 'wt-active', status: 'running' });
    const worktrees = [makeWorktree({ id: 'wt-1', status: 'running' })];
    expect(computeHasRunningWorktrees(active, worktrees)).toBe(false);
  });
});
