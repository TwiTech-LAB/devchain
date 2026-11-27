import { useCallback, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/ui/lib/utils';
import { useTranscriptDisclosure } from '@/ui/hooks/useTranscriptDisclosure';

/** Marks the element that scrolls the transcript; "Show less" scrolls only this element. */
export const TRANSCRIPT_SCROLL_CONTAINER_ATTR = 'data-transcript-scroll-container';

export interface ClampedContentProps {
  /** Disclosure key, unique in the whole session. Ignored when `expanded` is passed. */
  disclosureKey: string;
  /** Controlled open state, for callers that act on it (for example to fetch the full text). */
  expanded?: boolean;
  children: ReactNode;
  /** Preview height in px while collapsed. */
  maxHeight?: number;
  /** The text was cut before render (character cap or server cut), so the toggle shows even if it fits. */
  truncated?: boolean;
  /** Toggle text while collapsed, for a caller whose expand does more than unclamp. */
  collapsedLabel?: string;
  onExpandedChange?: (expanded: boolean) => void;
  className?: string;
  /** Gradient start color of the bottom fade; match the block background. */
  fadeClassName?: string;
  'data-testid'?: string;
}

export function ClampedContent({
  disclosureKey,
  expanded: controlledExpanded,
  children,
  maxHeight = 384,
  truncated = false,
  collapsedLabel = 'Show full',
  onExpandedChange,
  className,
  fadeClassName = 'from-card',
  'data-testid': testId,
}: ClampedContentProps) {
  const [storedExpanded, setStoredExpanded] = useTranscriptDisclosure(disclosureKey);
  const isControlled = controlledExpanded !== undefined;
  const expanded = isControlled ? controlledExpanded : storedExpanded;
  const [overflowing, setOverflowing] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const clipRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const pendingCollapseScrollRef = useRef(false);
  const contentId = useId();

  // Measure the unclipped inner wrapper: its height does not depend on the clip,
  // so the observer cannot loop, and the result stays valid while expanded.
  // The observer also catches content and width changes. `flow-root` keeps the
  // children's vertical margins inside the wrapper, so the measured height ends
  // at the same edge the clip cuts at.
  useLayoutEffect(() => {
    const inner = innerRef.current;
    if (!inner) return;
    const measure = () => setOverflowing(inner.getBoundingClientRect().height > maxHeight);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(inner);
    return () => observer.disconnect();
  }, [maxHeight]);

  useLayoutEffect(() => {
    if (expanded || !pendingCollapseScrollRef.current) return;
    pendingCollapseScrollRef.current = false;
    const root = rootRef.current;
    const container = root?.closest<HTMLElement>(`[${TRANSCRIPT_SCROLL_CONTAINER_ATTR}]`);
    if (!root || !container) return;
    const offset = root.getBoundingClientRect().top - container.getBoundingClientRect().top;
    if (offset < 0) container.scrollTop += offset;
  }, [expanded]);

  const changeExpanded = useCallback(
    (next: boolean) => {
      if (!isControlled) setStoredExpanded(next);
      onExpandedChange?.(next);
    },
    [isControlled, setStoredExpanded, onExpandedChange],
  );

  const handleToggle = useCallback(() => {
    if (expanded) pendingCollapseScrollRef.current = true;
    changeExpanded(!expanded);
  }, [expanded, changeExpanded]);

  const handleFocusCapture = useCallback(
    (event: React.FocusEvent<HTMLDivElement>) => {
      if (expanded || !clipRef.current) return;
      const clipBottom = clipRef.current.getBoundingClientRect().bottom;
      if (event.target.getBoundingClientRect().bottom > clipBottom) changeExpanded(true);
    },
    [expanded, changeExpanded],
  );

  const showToggle = expanded || truncated || overflowing;

  return (
    <div ref={rootRef} className={className} data-testid={testId}>
      <div
        ref={clipRef}
        id={contentId}
        className="relative overflow-y-clip"
        style={expanded ? undefined : { maxHeight }}
        onFocusCapture={handleFocusCapture}
        data-expanded={expanded}
      >
        <div ref={innerRef} className="flow-root">
          {children}
        </div>
        {!expanded && overflowing && (
          <div
            aria-hidden="true"
            className={cn(
              'pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t to-transparent',
              fadeClassName,
            )}
            data-testid="clamped-content-fade"
          />
        )}
      </div>
      {showToggle && (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={handleToggle}
          className="mt-1 rounded-sm text-[11px] text-primary hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          data-testid="clamped-content-toggle"
        >
          {expanded ? 'Show less' : collapsedLabel}
        </button>
      )}
    </div>
  );
}
