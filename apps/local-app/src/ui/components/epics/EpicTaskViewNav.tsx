import { Link } from 'react-router-dom';
import { cn } from '@/ui/lib/utils';
import {
  externalBoardProviderLabel,
  externalLinkedTaskPath,
  type ExternalBoardProvider,
  type ExternalLinkedTaskState,
} from '@/ui/lib/external-board';

export type EpicTaskView = 'devchain' | 'provider';

export interface EpicTaskViewNavProps {
  /** Epic the two views share; both destinations derive from it. */
  epicId: string;
  /** The one linked provider source. Never a list; selection happens in the caller. */
  provider: ExternalBoardProvider;
  activeView: EpicTaskView;
  /**
   * The only history state a view switch may forward: a Board return URL
   * reconstructed through `boardReturnUrlFromState`. Raw location state must
   * never cross a switch.
   */
  boardReturnState?: ExternalLinkedTaskState;
  className?: string;
}

const LINK_CLASS =
  'rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';

/**
 * Two-view switcher between a DevChain Epic and its single linked provider
 * task. Every switch replaces the current history entry so the two views
 * share one slot, keeping in-app back navigation intact.
 */
export function EpicTaskViewNav({
  epicId,
  provider,
  activeView,
  boardReturnState,
  className,
}: EpicTaskViewNavProps) {
  const devChainActive = activeView === 'devchain';
  const providerActive = activeView === 'provider';
  return (
    <nav
      aria-label="Task view"
      className={cn(
        'inline-flex items-center gap-1 rounded-md border bg-background p-1',
        className,
      )}
    >
      <Link
        to={`/epics/${encodeURIComponent(epicId)}`}
        replace
        state={boardReturnState}
        aria-current={devChainActive ? 'page' : undefined}
        className={cn(
          LINK_CLASS,
          devChainActive
            ? 'bg-secondary text-secondary-foreground'
            : 'text-muted-foreground hover:bg-muted',
        )}
      >
        DevChain
      </Link>
      <Link
        to={externalLinkedTaskPath(provider, epicId)}
        replace
        state={boardReturnState}
        aria-current={providerActive ? 'page' : undefined}
        className={cn(
          LINK_CLASS,
          providerActive
            ? 'bg-secondary text-secondary-foreground'
            : 'text-muted-foreground hover:bg-muted',
        )}
      >
        {externalBoardProviderLabel(provider)}
      </Link>
    </nav>
  );
}
