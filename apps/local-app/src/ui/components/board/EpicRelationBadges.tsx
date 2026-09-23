import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type Ref,
} from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Link2, Minus, X } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/components/ui/popover';
import { ScrollArea } from '@/ui/components/ui/scroll-area';
import { useEpicRelations } from '@/ui/hooks/useEpicRelations';
import { useSelectedProject } from '@/ui/hooks/useProjectSelection';
import { useOptionalWorktreeTab } from '@/ui/hooks/useWorktreeTab';
import { EpicRelationRemoveDialog } from '@/ui/components/epics/EpicRelationRemoveDialog';
import type { EpicRelationCounts } from '@/ui/hooks/useEpicRelationCountsBatch';
import {
  relatedEpicRole,
  type EpicRelation,
  type EpicRelationTarget,
} from '@/ui/lib/epic-relations';

export const RELATION_PREVIEW_OPEN_DELAY_MS = 150;
export const RELATION_PREVIEW_CLOSE_DELAY_MS = 150;
const RELATION_PREVIEW_LOADING_DELAY_MS = 150;

const OUTSIDE_BOARD_HINT =
  'Counts can include Epics in this workspace that are outside the current board.';

type RelationPreviewMode = 'closed' | 'hover' | 'keyboard' | 'touch';

interface DirectionalPiece {
  key: 'source' | 'target' | 'neutral';
  count: number;
  title: string;
  icon: typeof ArrowLeft;
}

function directionalPieces(counts: EpicRelationCounts): DirectionalPiece[] | null {
  const { relatedSources, relatedTargets, relatedNeutral } = counts;
  if (
    relatedSources === undefined ||
    relatedTargets === undefined ||
    relatedNeutral === undefined
  ) {
    return null;
  }
  return [
    {
      key: 'source',
      count: relatedSources,
      title: `Related sources: ${relatedSources}. ${OUTSIDE_BOARD_HINT}`,
      icon: ArrowLeft,
    },
    {
      key: 'target',
      count: relatedTargets,
      title: `Related targets: ${relatedTargets}. ${OUTSIDE_BOARD_HINT}`,
      icon: ArrowRight,
    },
    {
      key: 'neutral',
      count: relatedNeutral,
      title: `Related without direction: ${relatedNeutral}`,
      icon: Minus,
    },
  ];
}

/**
 * One explicit accessible name for the trigger that always mirrors the
 * visible pieces: the directional split when present, the plain aggregate
 * otherwise, then the unchanged Blocks and Blocked-by counts. A Related
 * count of zero renders nothing visible, so it is omitted here too.
 */
function accessibleSummary(counts: EpicRelationCounts, pieces: DirectionalPiece[] | null): string {
  const parts: string[] = [];
  if (pieces) {
    const words: string[] = [];
    for (const piece of pieces) {
      if (piece.count === 0) continue;
      if (piece.key === 'neutral') {
        words.push(`${piece.count} without direction`);
      } else {
        words.push(`${piece.count} ${piece.key}${piece.count === 1 ? '' : 's'}`);
      }
    }
    if (words.length > 0) parts.push(`Related: ${words.join(', ')}`);
  } else if (counts.related > 0) {
    parts.push(`Related: ${counts.related}`);
  }
  if (counts.blocks > 0) parts.push(`Blocks: ${counts.blocks}`);
  if (counts.blockedBy > 0) parts.push(`Blocked by: ${counts.blockedBy}`);
  return `${parts.join('. ')}.`;
}

function RelationRowFacts({ target }: { target: EpicRelationTarget }) {
  return (
    <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
      <span className="inline-flex items-center gap-1">
        <span
          aria-hidden="true"
          className="h-1.5 w-1.5 rounded-full"
          style={{ backgroundColor: target.status.color }}
        />
        {target.status.label}
      </span>
      <span>{target.project.name}</span>
      <span className="font-mono">{target.shortId}</span>
    </p>
  );
}

// Both title variants truncate on their own line so a long title never
// displaces the status, project, or short-ID facts below it.
function RelationPreviewRow({
  relation,
  sameProject,
  activateCrossProject,
  titleLinkRef,
  onRemove,
}: {
  relation: EpicRelation;
  sameProject: boolean;
  /** Null while the focal workspace is unresolved: cross-project titles stay inert. */
  activateCrossProject: ((projectId: string) => void) | null;
  titleLinkRef?: Ref<HTMLAnchorElement>;
  onRemove: (relation: EpicRelation) => void;
}) {
  const { relatedEpic } = relation;
  const navigable = sameProject || activateCrossProject !== null;
  const to = sameProject
    ? `/epics/${relatedEpic.id}`
    : `/epics/${relatedEpic.id}?projectId=${encodeURIComponent(relatedEpic.project.id)}`;

  return (
    <li className="rounded-md border bg-muted/30 px-2 py-1.5">
      <div className="flex items-start justify-between gap-1">
        <div className="min-w-0 flex-1">
          {navigable ? (
            <Link
              ref={titleLinkRef}
              to={to}
              title={relatedEpic.title}
              draggable={false}
              className="block truncate rounded text-xs font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={(event) => {
                event.stopPropagation();
                if (
                  sameProject ||
                  event.button !== 0 ||
                  event.metaKey ||
                  event.ctrlKey ||
                  event.shiftKey ||
                  event.altKey
                ) {
                  return;
                }
                activateCrossProject?.(relatedEpic.project.id);
              }}
              onDragStart={(event) => event.stopPropagation()}
            >
              {relatedEpic.title}
            </Link>
          ) : (
            <p className="truncate text-xs font-medium" title={relatedEpic.title}>
              {relatedEpic.title}
            </p>
          )}
          <RelationRowFacts target={relatedEpic} />
        </div>
        <button
          type="button"
          draggable={false}
          className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Remove relation with ${relatedEpic.title}`}
          onClick={(event) => {
            // Same fence as the title link: the preview portal still bubbles
            // into the Epic card, so the click must neither open the editor
            // nor start a card drag.
            event.stopPropagation();
            onRemove(relation);
          }}
          onDragStart={(event) => event.stopPropagation()}
        >
          <X className="h-3 w-3" aria-hidden="true" />
        </button>
      </div>
    </li>
  );
}

/**
 * Typed relation badges for expanded Kanban cards and their relation preview.
 * Zero-count types never render; a summary with no nonzero type renders
 * nothing at all. The directional split replaces the plain Related total
 * whenever the batch payload carried a complete group.
 */
export function EpicRelationBadges({
  counts,
  epicId,
  epicTitle,
  focalProjectId,
  focalIsRoot,
  dragFenceRef,
  isDragging = false,
}: {
  counts: EpicRelationCounts;
  epicId: string;
  epicTitle: string;
  /** Project of the focal Epic; separates same-project links from cross-project ones. */
  focalProjectId: string;
  /** Whether the focal Epic is a root; the removal warning's eligibility needs it. */
  focalIsRoot: boolean;
  /** Card drag fence shared with EpicCard: armed on pointer-down, cleared on release. */
  dragFenceRef?: { current: boolean };
  /** A card drag closes the preview and blocks reopening while armed. */
  isDragging?: boolean;
}) {
  const [mode, setMode] = useState<RelationPreviewMode>('closed');
  const open = mode !== 'closed';
  const [entered, setEntered] = useState(false);
  const [removeRelation, setRemoveRelation] = useState<EpicRelation | null>(null);
  const openTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  // The pointer type of the last pointer-down on the trigger. A non-null
  // value marks the next focus event as pointer-induced, not keyboard.
  const lastPointerTypeRef = useRef<'mouse' | 'pen' | 'touch' | null>(null);
  const isDraggingRef = useRef(isDragging);
  isDraggingRef.current = isDragging;
  // One-use guard: an Escape-origin close restores focus to the trigger, and
  // the guard swallows the focus event that would otherwise reopen the preview.
  const restoreGuardRef = useRef(false);
  const focusedFirstLinkRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const firstLinkNodeRef = useRef<HTMLAnchorElement | null>(null);
  // Radix portals the content one render after the open state flips, so the
  // first link's ref attachment is the mount signal the entry effect waits on.
  const [firstLinkReady, setFirstLinkReady] = useState(false);
  const firstLinkRef = useCallback((node: HTMLAnchorElement | null) => {
    firstLinkNodeRef.current = node;
    setFirstLinkReady(node !== null);
  }, []);

  const clearOpenTimer = useCallback(() => {
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
  }, []);
  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);
  const clearTimers = useCallback(() => {
    clearOpenTimer();
    clearCloseTimer();
  }, [clearCloseTimer, clearOpenTimer]);
  const clearDragFence = useCallback(() => {
    if (dragFenceRef) dragFenceRef.current = false;
  }, [dragFenceRef]);

  useEffect(
    () => () => {
      clearTimers();
      clearDragFence();
    },
    [clearDragFence, clearTimers],
  );

  // A card drag always closes the preview and blocks delayed opens.
  useEffect(() => {
    if (isDragging) {
      clearTimers();
      setMode('closed');
    }
  }, [clearTimers, isDragging]);

  // Every close path funnels through mode='closed': reset the explicit-entry
  // state so the next open cycle needs a fresh Enter or Space.
  useEffect(() => {
    if (mode === 'closed') {
      setEntered(false);
      focusedFirstLinkRef.current = false;
    }
  }, [mode]);

  const scheduleOpen = useCallback(() => {
    clearOpenTimer();
    openTimerRef.current = window.setTimeout(() => {
      openTimerRef.current = null;
      if (isDraggingRef.current) return;
      setMode('hover');
    }, RELATION_PREVIEW_OPEN_DELAY_MS);
  }, [clearOpenTimer]);

  const scheduleClose = useCallback(() => {
    clearCloseTimer();
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      setMode('closed');
    }, RELATION_PREVIEW_CLOSE_DELAY_MS);
  }, [clearCloseTimer]);

  const staysWithin = (event: ReactPointerEvent<HTMLElement>): boolean =>
    event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget);

  const handleTriggerPointerOver = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (event.pointerType !== 'mouse' || staysWithin(event)) return;
    clearCloseTimer();
    if (mode === 'closed') scheduleOpen();
  };
  const handleTriggerPointerOut = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (event.pointerType !== 'mouse' || staysWithin(event)) return;
    clearOpenTimer();
    if (mode === 'hover') scheduleClose();
  };
  const handleContentPointerOver = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.pointerType !== 'mouse' || staysWithin(event)) return;
    clearCloseTimer();
  };
  const handleContentPointerOut = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.pointerType !== 'mouse' || staysWithin(event)) return;
    if (mode === 'hover') scheduleClose();
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const type = event.pointerType;
    lastPointerTypeRef.current =
      type === 'mouse' || type === 'pen' || type === 'touch' ? type : null;
    if (event.button !== 0) return;
    if (dragFenceRef) dragFenceRef.current = true;
    try {
      // Capturing keeps the release event on the trigger even when the
      // pointer is lifted outside it, so the fence can never stay armed.
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // Release handlers or unmount cleanup still clear the fence.
    }
  };

  const releaseDragFence = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    clearDragFence();
    try {
      const element = event.currentTarget;
      if (element.hasPointerCapture?.(event.pointerId)) {
        element.releasePointerCapture?.(event.pointerId);
      }
    } catch {
      // The pointer may already be implicitly released.
    }
  };

  const handleClick = (event: ReactMouseEvent<HTMLButtonElement>): void => {
    // Prevented before the explicit mode transition so Radix's internal
    // toggle never fires; the card click also stops here.
    event.preventDefault();
    event.stopPropagation();
    const pointerType = lastPointerTypeRef.current;
    if (pointerType === 'touch' || pointerType === 'pen') {
      setMode((current) => (current === 'closed' && !isDraggingRef.current ? 'touch' : 'closed'));
      return;
    }
    // Mouse and keyboard activation never close or pin an open preview. An
    // activation without a preceding pointer-down is keyboard or assistive
    // tech, so a closed (restored) trigger reopens in keyboard mode, not hover.
    setMode((current) => {
      if (current !== 'closed' || isDraggingRef.current) return current;
      return pointerType === 'mouse' ? 'hover' : 'keyboard';
    });
  };

  const handleTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    // The trigger owns keyboard activation: preventing the native button click
    // keeps Radix's toggle and the pointer branches out of explicit entry.
    event.preventDefault();
    if (isDraggingRef.current) return;
    setMode((current) => (current === 'closed' ? 'keyboard' : current));
    setEntered(true);
  };

  const handleFocus = (): void => {
    if (restoreGuardRef.current) {
      restoreGuardRef.current = false;
      return;
    }
    if (lastPointerTypeRef.current !== null || isDraggingRef.current) return;
    setMode((current) => (current === 'closed' ? 'keyboard' : current));
  };

  const handleBlur = (): void => {
    lastPointerTypeRef.current = null;
  };

  const handlePopoverOpenChange = (next: boolean): void => {
    if (!next) {
      clearTimers();
      setMode('closed');
    }
  };

  const pieces = directionalPieces(counts);
  const hasVisibleCount =
    counts.related > 0 ||
    counts.blocks > 0 ||
    counts.blockedBy > 0 ||
    (pieces?.some((piece) => piece.count > 0) ?? false);

  const { runtimeResolved, apiBase } = useOptionalWorktreeTab();
  const { selectedWorkspace, activateProject } = useSelectedProject();
  // Relations never cross workspaces, so the selected focal workspace is also
  // the workspace of every cross-project target shown here; activating a
  // target project needs its ID.
  const crossProjectWorkspaceId = selectedWorkspace?.id;
  const crossProjectNavigable = crossProjectWorkspaceId !== undefined;
  const activateCrossProject = useCallback(
    (projectId: string) => {
      if (crossProjectWorkspaceId === undefined) return;
      activateProject({ id: projectId, workspaceId: crossProjectWorkspaceId });
    },
    [activateProject, crossProjectWorkspaceId],
  );
  // Detail rows load and render only in the resolved main runtime; any other
  // context keeps the preview free of cached main-scope data.
  const admitted = open && runtimeResolved && apiBase === '';
  const query = useEpicRelations(epicId, { enabled: admitted });
  const firstPage = admitted ? query.data?.pages[0] : undefined;
  const rows = firstPage?.items ?? [];
  const total = firstPage?.total ?? 0;
  const remaining = Math.max(0, total - rows.length);
  const failed = admitted && query.isError;

  const [loadingVisible, setLoadingVisible] = useState(false);
  const loading = admitted && query.isLoading;
  useEffect(() => {
    setLoadingVisible(false);
    if (!loading) return;
    const timer = window.setTimeout(
      () => setLoadingVisible(true),
      RELATION_PREVIEW_LOADING_DELAY_MS,
    );
    return () => window.clearTimeout(timer);
  }, [loading]);

  const groups = useMemo(() => {
    if (!firstPage) return [];
    const related = firstPage.items.filter((relation) => relation.type === 'related');
    return [
      {
        key: 'source',
        title: 'Source',
        rows: related.filter((relation) => relatedEpicRole(relation) === 'Source'),
      },
      {
        key: 'target',
        title: 'Target',
        rows: related.filter((relation) => relatedEpicRole(relation) === 'Target'),
      },
      {
        key: 'neutral',
        title: 'No direction yet',
        rows: related.filter((relation) => relatedEpicRole(relation) === null),
      },
      { key: 'blocks', title: 'Blocks', rows: firstPage.items.filter((r) => r.type === 'blocks') },
      {
        key: 'blocked-by',
        title: 'Blocked by',
        rows: firstPage.items.filter((r) => r.type === 'blocked_by'),
      },
    ].filter((group) => group.rows.length > 0);
  }, [firstPage]);

  // The row whose title owns the entry-focus ref: the first row that renders
  // a link in DOM order (cross-project rows stay inert without a workspace).
  const firstLinkRelationId = useMemo(() => {
    for (const group of groups) {
      for (const relation of group.rows) {
        if (crossProjectNavigable || relation.relatedEpic.project.id === focalProjectId) {
          return relation.relationId;
        }
      }
    }
    return null;
  }, [groups, crossProjectNavigable, focalProjectId]);

  // Explicit Enter or Space entry moves focus to the first loaded title link
  // exactly once per open cycle, and only while the trigger still owns focus:
  // a query refresh or a focus moved elsewhere never steals focus back.
  useEffect(() => {
    if (!open || !entered || focusedFirstLinkRef.current) return;
    if (firstLinkRelationId === null || !firstLinkReady) return;
    if (document.activeElement !== triggerRef.current) return;
    const firstLink = firstLinkNodeRef.current;
    if (!firstLink) return;
    focusedFirstLinkRef.current = true;
    firstLink.focus();
  }, [entered, firstLinkReady, firstLinkRelationId, open]);

  const headingId = useId();

  if (!hasVisibleCount) return null;

  const badgeClass =
    'inline-flex items-center gap-0.5 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground';

  let relatedBadges: ReactNode = null;
  if (pieces) {
    relatedBadges = pieces
      .filter((piece) => piece.count > 0)
      .map((piece) => (
        <span key={piece.key} className={badgeClass} title={piece.title}>
          <piece.icon className="h-3 w-3" aria-hidden="true" />
          {piece.count}
        </span>
      ));
  } else if (counts.related > 0) {
    relatedBadges = (
      <span className={badgeClass} title={`Related: ${counts.related}. ${OUTSIDE_BOARD_HINT}`}>
        Related {counts.related}
      </span>
    );
  }

  let previewContent: ReactNode = null;
  if (loading) {
    if (loadingVisible) {
      previewContent = (
        <p role="status" className="py-2 text-center text-xs text-muted-foreground">
          Loading…
        </p>
      );
    }
  } else if (failed) {
    previewContent = (
      <p className="py-2 text-center text-xs text-muted-foreground">
        Relations could not be loaded.
      </p>
    );
  } else if (admitted && rows.length === 0 && remaining === 0) {
    previewContent = (
      <p className="py-2 text-center text-xs text-muted-foreground">No relations yet.</p>
    );
  } else if (admitted) {
    previewContent = (
      <ScrollArea className="max-h-72 pr-2">
        <div className="space-y-2">
          {groups.map((group) => (
            <section key={group.key} aria-label={`${group.title} relations`}>
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {group.title} ({group.rows.length})
              </p>
              <ul className="space-y-1">
                {group.rows.map((relation) => (
                  <RelationPreviewRow
                    key={relation.relationId}
                    relation={relation}
                    sameProject={relation.relatedEpic.project.id === focalProjectId}
                    activateCrossProject={crossProjectNavigable ? activateCrossProject : null}
                    titleLinkRef={
                      relation.relationId === firstLinkRelationId ? firstLinkRef : undefined
                    }
                    onRemove={setRemoveRelation}
                  />
                ))}
              </ul>
            </section>
          ))}
          {remaining > 0 ? (
            <p className="text-[10px] text-muted-foreground">
              +{remaining} more — open the Epic to see all.
            </p>
          ) : null}
        </div>
      </ScrollArea>
    );
  }

  return (
    <>
      <Popover open={open} onOpenChange={handlePopoverOpenChange}>
        <PopoverTrigger asChild>
          <button
            type="button"
            ref={triggerRef}
            data-testid="epic-relation-badges"
            aria-label={accessibleSummary(counts, pieces)}
            title={`Relations: ${counts.total}. ${OUTSIDE_BOARD_HINT}`}
            className="inline-flex flex-wrap items-center gap-1 rounded-full p-0.5 touch-manipulation focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onPointerOver={handleTriggerPointerOver}
            onPointerOut={handleTriggerPointerOut}
            onPointerDown={handlePointerDown}
            onPointerUp={releaseDragFence}
            onPointerCancel={releaseDragFence}
            onLostPointerCapture={clearDragFence}
            onClick={handleClick}
            onKeyDown={handleTriggerKeyDown}
            onFocus={handleFocus}
            onBlur={handleBlur}
          >
            {relatedBadges}
            {counts.blocks > 0 ? (
              <span
                className={badgeClass}
                title={`Blocks: ${counts.blocks}. ${OUTSIDE_BOARD_HINT}`}
              >
                Blocks {counts.blocks}
              </span>
            ) : null}
            {counts.blockedBy > 0 ? (
              <span
                className={badgeClass}
                title={`Blocked by: ${counts.blockedBy}. ${OUTSIDE_BOARD_HINT}`}
              >
                Blocked by {counts.blockedBy}
              </span>
            ) : null}
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="bottom"
          align="end"
          sideOffset={4}
          className="w-80 p-3"
          aria-labelledby={headingId}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onEscapeKeyDown={() => {
            // Escape-origin close: arm the restore guard before Radix runs its
            // deferred close autofocus.
            restoreGuardRef.current = true;
          }}
          onCloseAutoFocus={(event) => {
            if (restoreGuardRef.current) {
              // Let Radix move focus back to the trigger; the focus event
              // consumes the guard. When focus never moved, the deferred
              // cleanup below discards the unused guard so a later focus on
              // the trigger opens the preview normally again.
              window.setTimeout(() => {
                restoreGuardRef.current = false;
              }, 0);
              return;
            }
            event.preventDefault();
          }}
          onPointerOver={handleContentPointerOver}
          onPointerOut={handleContentPointerOut}
        >
          <h3
            id={headingId}
            className="mb-2 truncate text-xs font-semibold uppercase tracking-wide text-muted-foreground"
          >
            Relations for {epicTitle}
          </h3>
          {previewContent}
        </PopoverContent>
      </Popover>
      {/* Rendered outside PopoverContent: the preview closes when the pointer
          leaves it, and an open removal dialog must outlive that close. The
          portaled dialog still bubbles React events into the Epic card's
          tree, so this fence keeps its clicks and drags from opening the
          editor or starting a card drag. */}
      <div
        draggable={false}
        className="contents"
        onClick={(event) => event.stopPropagation()}
        onDragStart={(event) => event.stopPropagation()}
      >
        <EpicRelationRemoveDialog
          epicId={epicId}
          epicTitle={epicTitle}
          focalProjectId={focalProjectId}
          focalIsRoot={focalIsRoot}
          relation={removeRelation}
          onClose={() => setRemoveRelation(null)}
        />
      </div>
    </>
  );
}

/** Compact total badge for collapsed Board rows. */
export function EpicRelationTotalBadge({ total }: { total: number }) {
  return (
    <span
      className="inline-flex flex-shrink-0 items-center gap-0.5 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
      title={`Relations: ${total}. ${OUTSIDE_BOARD_HINT}`}
      data-testid="epic-relation-total-badge"
    >
      <Link2 className="h-3 w-3" aria-hidden="true" />
      {total}
    </span>
  );
}
