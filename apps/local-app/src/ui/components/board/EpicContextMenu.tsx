import type { ReactNode } from 'react';
import { GitBranch } from 'lucide-react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/ui/components/ui/context-menu';
import type { Epic } from '@/ui/types';

export interface EpicContextMenuProps {
  epic: Epic;
  onMoveToWorktree: (epic: Epic) => void;
  /** Whether running worktrees are available (main mode only) */
  hasRunningWorktrees: boolean;
  children: ReactNode;
}

/**
 * Context menu wrapper for parent epic cards.
 * Shows "Move to worktree..." action on right-click.
 * Sub-epics and non-main-mode contexts render children without a menu.
 */
export function EpicContextMenu({
  epic,
  onMoveToWorktree,
  hasRunningWorktrees,
  children,
}: EpicContextMenuProps) {
  // Only show context menu for parent epics in main mode with running worktrees
  if (epic.parentId !== null || !hasRunningWorktrees) {
    return <>{children}</>;
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={() => onMoveToWorktree(epic)}>
          <GitBranch className="mr-2 h-4 w-4" />
          Move to worktree…
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
