import { memo } from 'react';
import { cn } from '@/ui/lib/utils';
import {
  ChevronsUp,
  ChevronsDown,
  Brain,
  MessageSquare,
  ChevronUp,
  ChevronDown,
  Flame,
} from 'lucide-react';

export interface SessionNavigationToolbarProps {
  onTop: () => void;
  onEnd: () => void;
  onPrevThinking: (() => void) | null;
  onNextThinking: (() => void) | null;
  onNextResponse: (() => void) | null;
  onPrevHotspot: (() => void) | null;
  onNextHotspot: (() => void) | null;
  onToggleHotspotFilter: (() => void) | null;
  hotspotFilterActive: boolean;
  hotspotCount: number;
  hasChunks: boolean;
}

const navBtnClass =
  'h-7 w-7 flex items-center justify-center rounded hover:bg-muted/60 text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';
const disabledClass = 'opacity-40 cursor-default pointer-events-none';

export const SessionNavigationToolbar = memo(function SessionNavigationToolbar({
  onTop,
  onEnd,
  onPrevThinking,
  onNextThinking,
  onNextResponse,
  onPrevHotspot,
  onNextHotspot,
  onToggleHotspotFilter,
  hotspotFilterActive,
  hotspotCount,
  hasChunks,
}: SessionNavigationToolbarProps) {
  return (
    <div
      className="absolute bottom-3 right-3 z-10 flex flex-col gap-1 rounded-lg border border-border/60 bg-background/90 backdrop-blur-sm p-1 shadow-md"
      data-testid="session-navigation-toolbar"
    >
      <button
        type="button"
        onClick={onTop}
        className={navBtnClass}
        aria-label="Jump to top"
        title="Jump to top (Home)"
        aria-keyshortcuts="Home"
        data-testid="nav-jump-top"
      >
        <ChevronsUp className="h-4 w-4" />
      </button>

      {hasChunks && (
        <>
          <button
            type="button"
            onClick={onPrevThinking ?? undefined}
            className={cn(navBtnClass, !onPrevThinking && disabledClass)}
            aria-label="Previous thinking block"
            title="Previous thinking block (Alt+↑)"
            aria-keyshortcuts="Alt+ArrowUp"
            aria-disabled={!onPrevThinking}
            data-testid="nav-prev-thinking"
          >
            <Brain className="h-3 w-3" />
            <ChevronUp className="h-2.5 w-2.5 -ml-0.5" />
          </button>

          <button
            type="button"
            onClick={onNextThinking ?? undefined}
            className={cn(navBtnClass, !onNextThinking && disabledClass)}
            aria-label="Next thinking block"
            title="Next thinking block (Alt+↓)"
            aria-keyshortcuts="Alt+ArrowDown"
            aria-disabled={!onNextThinking}
            data-testid="nav-next-thinking"
          >
            <Brain className="h-3 w-3" />
            <ChevronDown className="h-2.5 w-2.5 -ml-0.5" />
          </button>

          <button
            type="button"
            onClick={onNextResponse ?? undefined}
            className={cn(navBtnClass, !onNextResponse && disabledClass)}
            aria-label="Next response"
            title="Next response (Alt+Shift+↓)"
            aria-keyshortcuts="Alt+Shift+ArrowDown"
            aria-disabled={!onNextResponse}
            data-testid="nav-next-response"
          >
            <MessageSquare className="h-3 w-3" />
            <ChevronDown className="h-2.5 w-2.5 -ml-0.5" />
          </button>

          {/* Hotspot controls separator */}
          <div className="h-px bg-border/40 mx-1" />

          {/* Hotspot filter toggle */}
          <button
            type="button"
            onClick={onToggleHotspotFilter ?? undefined}
            className={cn(
              navBtnClass,
              !onToggleHotspotFilter && disabledClass,
              hotspotFilterActive && 'bg-amber-500/10 text-amber-500',
            )}
            aria-label="Toggle hotspot filter"
            title="Toggle hotspot filter"
            aria-disabled={!onToggleHotspotFilter}
            aria-pressed={hotspotFilterActive}
            data-testid="nav-toggle-hotspot-filter"
          >
            <Flame className="h-3 w-3" />
            {hotspotCount > 0 && hotspotFilterActive && (
              <span className="text-[9px] tabular-nums" data-testid="nav-hotspot-count">
                {hotspotCount}
              </span>
            )}
          </button>

          {/* Prev/Next hotspot — only when filter active */}
          {hotspotFilterActive && (
            <>
              <button
                type="button"
                onClick={onPrevHotspot ?? undefined}
                className={cn(navBtnClass, !onPrevHotspot && disabledClass)}
                aria-label="Previous hotspot"
                title="Previous hotspot"
                aria-disabled={!onPrevHotspot}
                data-testid="nav-prev-hotspot"
              >
                <Flame className="h-3 w-3" />
                <ChevronUp className="h-2.5 w-2.5 -ml-0.5" />
              </button>

              <button
                type="button"
                onClick={onNextHotspot ?? undefined}
                className={cn(navBtnClass, !onNextHotspot && disabledClass)}
                aria-label="Next hotspot"
                title="Next hotspot"
                aria-disabled={!onNextHotspot}
                data-testid="nav-next-hotspot"
              >
                <Flame className="h-3 w-3" />
                <ChevronDown className="h-2.5 w-2.5 -ml-0.5" />
              </button>
            </>
          )}
        </>
      )}

      <button
        type="button"
        onClick={onEnd}
        className={navBtnClass}
        aria-label="Jump to end"
        title="Jump to end (End)"
        aria-keyshortcuts="End"
        data-testid="nav-jump-end"
      >
        <ChevronsDown className="h-4 w-4" />
      </button>
    </div>
  );
});

SessionNavigationToolbar.displayName = 'SessionNavigationToolbar';
