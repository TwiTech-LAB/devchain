import { useCallback, useEffect, useRef, useState } from 'react';

const BOTTOM_THRESHOLD = 48;

export interface UseAutoScrollBottomOptions {
  /** Whether auto-scroll is enabled (e.g., only for live sessions) */
  enabled: boolean;
  /** Dependency that triggers auto-scroll when changed (e.g., messages.length) */
  triggerDep: unknown;
}

export interface UseAutoScrollBottomResult {
  /** Ref to attach to the scroll container element */
  scrollContainerRef: React.RefObject<HTMLDivElement>;
  /** Ref to attach to a sentinel element at the bottom of content */
  bottomRef: React.RefObject<HTMLDivElement>;
  /** Whether the scroll container is currently at the bottom */
  isAtBottom: boolean;
  /** Manually scroll to the bottom */
  scrollToBottom: () => void;
  /** onScroll handler to attach to the scroll container */
  handleScroll: () => void;
}

/**
 * Hook for auto-scrolling a container to the bottom when new content arrives.
 *
 * Respects user scroll position: if the user has scrolled up, auto-scroll
 * is paused until they scroll back to the bottom or call `scrollToBottom()`.
 */
export function useAutoScrollBottom({
  enabled,
  triggerDep,
}: UseAutoScrollBottomOptions): UseAutoScrollBottomResult {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD;
    setIsAtBottom(atBottom);
  }, []);

  const scrollToBottom = useCallback(() => {
    if (bottomRef.current?.scrollIntoView) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
    setIsAtBottom(true);
  }, []);

  // Auto-scroll when trigger changes and we're at the bottom
  useEffect(() => {
    if (enabled && isAtBottom && bottomRef.current?.scrollIntoView) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [enabled, triggerDep]); // isAtBottom intentionally omitted to avoid re-trigger loops

  return {
    scrollContainerRef,
    bottomRef,
    isAtBottom,
    scrollToBottom,
    handleScroll,
  };
}
