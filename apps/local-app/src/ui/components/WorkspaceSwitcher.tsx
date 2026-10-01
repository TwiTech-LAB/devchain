import { createRef, forwardRef, useCallback, useMemo, type KeyboardEvent } from 'react';
import type { ProjectWorkspace } from '@/ui/hooks/useProjectSelection';
import { cn } from '@/ui/lib/utils';
import { Button } from '@/ui/components/ui/button';
import { getWorkspaceIdentity } from '@/ui/lib/workspace-identity';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/ui/components/ui/tooltip';

interface WorkspaceSwitcherProps {
  workspaces: ProjectWorkspace[];
  selectedWorkspaceId?: string;
  onSelect: (workspaceId: string) => void;
}

interface WorkspaceButtonProps {
  workspace: ProjectWorkspace;
  index: number;
  isSelected: boolean;
  onSelect: (workspaceId: string) => void;
  onKeyNavigation: (event: KeyboardEvent<HTMLButtonElement>, index: number) => void;
}

const WorkspaceButton = forwardRef<HTMLButtonElement, WorkspaceButtonProps>(
  ({ workspace, index, isSelected, onSelect, onKeyNavigation }, ref) => {
    const handleClick = useCallback(() => onSelect(workspace.id), [onSelect, workspace.id]);
    const handleKeyDown = useCallback(
      (event: KeyboardEvent<HTMLButtonElement>) => onKeyNavigation(event, index),
      [index, onKeyNavigation],
    );
    const identity = getWorkspaceIdentity(workspace.name);

    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            ref={ref}
            type="button"
            variant="ghost"
            size="icon"
            className={cn(
              'relative h-8 w-8 shrink-0 border text-xs font-bold hover:z-10 focus-visible:z-20',
              identity.baseClassName,
              isSelected && 'z-10 ring-1 ring-foreground/40 ring-offset-1',
              isSelected && identity.selectedClassName,
            )}
            aria-label={`Switch to workspace ${workspace.name}`}
            aria-pressed={isSelected}
            title={workspace.name}
            onClick={handleClick}
            onKeyDown={handleKeyDown}
          >
            <span aria-hidden="true">{identity.initial}</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent>{workspace.name}</TooltipContent>
      </Tooltip>
    );
  },
);
WorkspaceButton.displayName = 'WorkspaceButton';

export function WorkspaceSwitcher({
  workspaces,
  selectedWorkspaceId,
  onSelect,
}: WorkspaceSwitcherProps) {
  const buttonRefs = useMemo(
    () => workspaces.map(() => createRef<HTMLButtonElement>()),
    [workspaces],
  );

  const focusWorkspace = useCallback(
    (index: number) => {
      const normalizedIndex = (index + workspaces.length) % workspaces.length;
      buttonRefs[normalizedIndex].current?.focus();
    },
    [buttonRefs, workspaces.length],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
      switch (event.key) {
        case 'ArrowRight':
        case 'ArrowDown':
          event.preventDefault();
          focusWorkspace(index + 1);
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
          event.preventDefault();
          focusWorkspace(index - 1);
          break;
        case 'Home':
          event.preventDefault();
          focusWorkspace(0);
          break;
        case 'End':
          event.preventDefault();
          focusWorkspace(workspaces.length - 1);
          break;
      }
    },
    [focusWorkspace, workspaces.length],
  );

  if (workspaces.length < 2) return null;

  return (
    <TooltipProvider>
      <div
        className="flex -space-x-1 pr-1"
        role="toolbar"
        aria-label="Switch workspace"
        aria-orientation="horizontal"
      >
        {workspaces.map((workspace, index) => {
          const isSelected = workspace.id === selectedWorkspaceId;
          return (
            <WorkspaceButton
              key={workspace.id}
              ref={buttonRefs[index]}
              workspace={workspace}
              index={index}
              isSelected={isSelected}
              onSelect={onSelect}
              onKeyNavigation={handleKeyDown}
            />
          );
        })}
      </div>
    </TooltipProvider>
  );
}
