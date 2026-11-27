import { useEffect, useState } from 'react';
import { fetchJsonOrThrow } from '@/ui/lib/sessions';
import { useFetchFactory } from '@/ui/hooks/useFetchFactory';
import { useTranscriptReaderResize } from '@/ui/hooks/useTranscriptDisclosure';

interface FullToolResultResponse {
  sessionId: string;
  toolCallId: string;
  content: string | unknown[];
  isError: boolean;
  fullLength: number;
  isComplete?: boolean;
}

function formatToolResultSize(fullLength?: number): string {
  if (!fullLength || fullLength <= 0) return '';
  return `${(fullLength / 1024).toFixed(fullLength >= 10 * 1024 ? 0 : 1)} KB`;
}

export interface FullToolResultState {
  /** The full result body; null until fetched. Row-local: refetched after a remount. */
  fullText: string | null;
  isLoading: boolean;
  error: string | null;
  /** The result was cut by the server and the full body can be requested. */
  canLoad: boolean;
}

interface FetchEntry {
  /** The result this entry belongs to; any other result reads as not fetched. */
  resultKey: string;
  fullText: string | null;
  error: string | null;
  isLoading: boolean;
}

/**
 * Fetches the full body of a server-truncated tool result while `expanded` is true.
 * An expanded block that mounts again (virtualized rows) therefore loads its body again.
 * State belongs to one result (session + tool call): when the caller switches to another
 * result, the earlier body, error and any late response are ignored.
 * A failed request is retried only after the block collapses and expands again.
 */
export function useFullToolResult({
  sessionId,
  toolCallId,
  isTruncated,
  expanded,
}: {
  sessionId?: string | null;
  toolCallId?: string;
  isTruncated?: boolean;
  expanded: boolean;
}): FullToolResultState {
  const fetchFn = useFetchFactory();
  // Stable for a mounted row, so it does not restart the fetch effect below.
  const readerResize = useTranscriptReaderResize();
  const canLoad = isTruncated === true && !!sessionId && !!toolCallId;
  const resultKey = canLoad ? `${sessionId}\u0000${toolCallId}` : null;
  const [entry, setEntry] = useState<FetchEntry | null>(null);
  const current = resultKey !== null && entry?.resultKey === resultKey ? entry : null;
  const fullText = current?.fullText ?? null;
  const error = current?.error ?? null;

  useEffect(() => {
    if (!expanded) setEntry((prev) => (prev?.error ? { ...prev, error: null } : prev));
  }, [expanded]);

  useEffect(() => {
    if (!expanded || resultKey === null || fullText !== null || error !== null) return;
    let cancelled = false;
    // A row that unmounts stops its download, so scrolling away and back does not overlap them.
    const controller = new AbortController();
    setEntry({ resultKey, fullText: null, error: null, isLoading: true });
    fetchJsonOrThrow<FullToolResultResponse>(
      `/api/sessions/${sessionId}/transcript/tool-result/${encodeURIComponent(toolCallId!)}`,
      { signal: controller.signal },
      'Failed to fetch full tool result',
      fetchFn,
    )
      .then((response) => {
        if (cancelled) return;
        // The reader asked for this body: its layout change keeps the reading position.
        readerResize();
        const text =
          typeof response.content === 'string'
            ? response.content
            : JSON.stringify(response.content, null, 2);
        if (response.isComplete === false) {
          // Showing the capped body as the full one would hide the missing part.
          const error = `The full result (${response.fullLength.toLocaleString('en-US')} characters) is no longer available from its source.`;
          setEntry({ resultKey, fullText: null, error, isLoading: false });
          return;
        }
        setEntry({ resultKey, fullText: text, error: null, isLoading: false });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        readerResize();
        const message = err instanceof Error ? err.message : 'Failed to fetch full tool result';
        setEntry({ resultKey, fullText: null, error: message, isLoading: false });
      });
    return () => {
      cancelled = true;
      controller.abort();
      setEntry((prev) =>
        prev?.resultKey === resultKey && prev.isLoading ? { ...prev, isLoading: false } : prev,
      );
    };
  }, [expanded, resultKey, fullText, error, sessionId, toolCallId, fetchFn, readerResize]);

  return { fullText, isLoading: current?.isLoading ?? false, error, canLoad };
}

/** The collapsed toggle text of a result the server cut: expanding it downloads the full body. */
export function loadFullResultLabel(fullLength?: number): string {
  const sizeText = formatToolResultSize(fullLength);
  return sizeText ? `Show full result (${sizeText})` : 'Show full result';
}

/** Loading and error line shown under a block whose full result is being fetched. */
export function FullToolResultStatus({
  isLoading,
  error,
}: Pick<FullToolResultState, 'isLoading' | 'error'>) {
  if (isLoading) {
    return (
      <p
        className="text-[10px] text-muted-foreground"
        aria-live="polite"
        data-testid="tool-result-loading"
      >
        Loading full result…
      </p>
    );
  }
  if (error) {
    return (
      <p className="text-[10px] text-destructive" role="alert" data-testid="tool-result-load-error">
        {error}
      </p>
    );
  }
  return null;
}
