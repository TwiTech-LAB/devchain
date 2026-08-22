import { Link, useLocation } from 'react-router-dom';
import type { ExternalTaskSourceSummary } from '@/modules/external-integrations/models/external-provider.models';
import {
  externalBoardProviderLabel,
  externalLinkedTaskPath,
  externalLinkedTaskState,
} from '@/ui/lib/external-board';

export interface EpicExternalSourceNoteProps {
  source: ExternalTaskSourceSummary;
  /** Epic whose durable source this note carries; the link targets its workspace. */
  epicId: string;
  className?: string;
}

/**
 * Compact note opening the Epic's linked-task workspace inside DevChain. The
 * anchor stops click, key, and drag propagation so opening the workspace can
 * never edit, move, or start dragging the Epic. The vendor URL is never a
 * navigation target here; the workspace owns the external escape hatch.
 */
export function EpicExternalSourceNote({ source, epicId, className }: EpicExternalSourceNoteProps) {
  const providerLabel = externalBoardProviderLabel(source.provider);
  const { pathname, search } = useLocation();
  return (
    <div
      className={
        className ??
        'flex flex-wrap items-center justify-between gap-x-2 gap-y-1 rounded-b-lg border border-t-0 bg-muted/40 px-3 py-1.5 text-xs'
      }
    >
      <span className="text-muted-foreground">
        Imported from {providerLabel} · <span className="font-medium">{source.remoteKey}</span>
      </span>
      <Link
        to={externalLinkedTaskPath(source.provider, epicId)}
        state={externalLinkedTaskState(`${pathname}${search}`)}
        draggable={false}
        aria-label={`Open linked task ${source.remoteKey} in DevChain`}
        className="font-medium text-primary underline-offset-4 hover:underline"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
        onDragStart={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        Open linked task
      </Link>
    </div>
  );
}
