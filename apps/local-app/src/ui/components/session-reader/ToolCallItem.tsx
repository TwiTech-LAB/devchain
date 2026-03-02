import { useCallback, useMemo, useState } from 'react';
import { cn } from '@/ui/lib/utils';
import { fetchJsonOrThrow } from '@/ui/lib/sessions';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/ui/components/ui/collapsible';
import { ChevronRight, Wrench, Layers, AlertTriangle, Flame } from 'lucide-react';
import type { SerializedSemanticStep } from '@/ui/hooks/useSessionTranscript';
import {
  formatDuration,
  formatTokensSmart as formatTokens,
  truncateText,
} from '@/ui/utils/session-reader-formatters';

const INPUT_TRUNCATE = 500;
const RESULT_TRUNCATE = 500;
const SENSITIVE_KEYS = new Set([
  'token',
  'apikey',
  'api_key',
  'password',
  'secret',
  'authorization',
  'credentials',
  'key',
  'apisecret',
  'api_secret',
]);

interface FullToolResultResponse {
  sessionId: string;
  toolCallId: string;
  content: string | unknown[];
  isError: boolean;
  fullLength: number;
}

function formatToolResultSize(fullLength?: number): string {
  if (!fullLength || fullLength <= 0) return '';
  return `${(fullLength / 1024).toFixed(fullLength >= 10 * 1024 ? 0 : 1)} KB`;
}

function buildOneLiner(step: SerializedSemanticStep): string {
  const name = step.content.toolName ?? 'Unknown';
  const input = step.content.toolInput;
  if (!input) return name;

  // Common tool one-liner patterns
  if (input.file_path) return `${name}: ${String(input.file_path)}`;
  if (input.pattern) return `${name}: ${String(input.pattern)}`;
  if (input.command) return `${name}: ${truncateText(String(input.command), 60)}`;
  if (input.query) return `${name}: ${truncateText(String(input.query), 60)}`;
  if (input.prompt) return `${name}: ${truncateText(String(input.prompt), 60)}`;
  if (input.url) return `${name}: ${truncateText(String(input.url), 60)}`;
  if (input.description) return `${name}: ${truncateText(String(input.description), 60)}`;

  for (const [paramKey, value] of Object.entries(input)) {
    const normalizedKey = paramKey.toLowerCase();
    if (normalizedKey === 'sessionid' || normalizedKey === 'session_id') continue;
    if (SENSITIVE_KEYS.has(normalizedKey)) continue;
    if (typeof value === 'string' && value.length > 0 && value.length <= 80) {
      return `${name}: ${truncateText(value, 60)}`;
    }
  }

  return name;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface ToolCallItemProps {
  sessionId?: string | null;
  step: SerializedSemanticStep;
  resultStep?: SerializedSemanticStep;
  isStepHot?: boolean;
  percentOfChunk?: number;
}

export function ToolCallItem({
  sessionId,
  step,
  resultStep,
  isStepHot,
  percentOfChunk,
}: ToolCallItemProps) {
  const toolName = step.content.toolName ?? 'Unknown';
  const isTask = toolName === 'Task';
  const isError = resultStep?.content.isError ?? false;
  const oneLiner = buildOneLiner(step);
  const estimatedTokens = (step.estimatedTokens ?? 0) + (resultStep?.estimatedTokens ?? 0);
  const computedDuration = useMemo(() => {
    if (resultStep?.startTime && step.startTime) {
      const diff = new Date(resultStep.startTime).getTime() - new Date(step.startTime).getTime();
      return Number.isFinite(diff) ? Math.max(0, diff) : step.durationMs;
    }
    return step.durationMs;
  }, [resultStep?.startTime, step.startTime, step.durationMs]);

  const inputText = step.content.toolInput ? JSON.stringify(step.content.toolInput, null, 2) : null;

  const rawResult = resultStep?.content.toolResultContent;
  const resultText =
    rawResult && typeof rawResult === 'string'
      ? rawResult
      : rawResult
        ? JSON.stringify(rawResult, null, 2)
        : null;
  const toolCallId = resultStep?.content.toolCallId ?? step.content.toolCallId;
  const isServerTruncated = resultStep?.content.isTruncated === true;
  const [expandedServerResult, setExpandedServerResult] = useState<string | null>(null);
  const [isFetchingFullResult, setIsFetchingFullResult] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const effectiveResultText = expandedServerResult ?? resultText;
  const allowLocalResultToggle = !isServerTruncated || expandedServerResult !== null;
  const loadFullLabel = useMemo(() => {
    if (!isServerTruncated) return null;
    const sizeText = formatToolResultSize(resultStep?.content.fullLength);
    return sizeText ? `Show full result (${sizeText})` : 'Show full result';
  }, [isServerTruncated, resultStep?.content.fullLength]);

  const [showFullInput, setShowFullInput] = useState(false);
  const [showFullResult, setShowFullResult] = useState(false);

  const isInputLong = (inputText?.length ?? 0) > INPUT_TRUNCATE;
  const isResultLong = (effectiveResultText?.length ?? 0) > RESULT_TRUNCATE;

  const displayInput =
    inputText && isInputLong && !showFullInput
      ? inputText.slice(0, INPUT_TRUNCATE) + '…'
      : inputText;
  const displayResult =
    effectiveResultText && isResultLong && !showFullResult && allowLocalResultToggle
      ? effectiveResultText.slice(0, RESULT_TRUNCATE) + '…'
      : effectiveResultText;

  const handleLoadFullResult = useCallback(async () => {
    if (
      !sessionId ||
      !toolCallId ||
      !isServerTruncated ||
      isFetchingFullResult ||
      expandedServerResult !== null
    ) {
      return;
    }

    setFetchError(null);
    setIsFetchingFullResult(true);
    try {
      const response = await fetchJsonOrThrow<FullToolResultResponse>(
        `/api/sessions/${sessionId}/transcript/tool-result/${encodeURIComponent(toolCallId)}`,
        {},
        'Failed to fetch full tool result',
      );
      const fullText =
        typeof response.content === 'string'
          ? response.content
          : JSON.stringify(response.content, null, 2);
      setExpandedServerResult(fullText);
      setShowFullResult(true);
    } catch (error) {
      setFetchError(error instanceof Error ? error.message : 'Failed to fetch full tool result');
    } finally {
      setIsFetchingFullResult(false);
    }
  }, [expandedServerResult, isFetchingFullResult, isServerTruncated, sessionId, toolCallId]);

  return (
    <div
      className={cn(isStepHot && 'border-l-2 border-amber-500 pl-1.5')}
      data-testid="tool-call-wrapper"
    >
      <Collapsible>
        <CollapsibleTrigger
          className="group flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-sm"
          data-testid="tool-call-trigger"
        >
          <ChevronRight className="h-3 w-3 transition-transform group-data-[state=open]:rotate-90" />
          {isTask ? (
            <Layers className="h-3 w-3 text-blue-400" />
          ) : (
            <Wrench className="h-3 w-3 text-amber-400" />
          )}
          <span className="font-medium">{oneLiner}</span>
          <span className="ml-auto flex items-center gap-1.5">
            {isStepHot && (
              <Flame className="h-3 w-3 text-amber-500" data-testid="step-hotspot-flame" />
            )}
            {isStepHot && percentOfChunk != null && percentOfChunk > 0 && (
              <span
                className="text-amber-600 font-medium text-[10px] tabular-nums"
                data-testid="step-hotspot-pct"
              >
                {Math.round(percentOfChunk)}%
              </span>
            )}
            {estimatedTokens > 0 && (
              <span
                className="text-muted-foreground/60 text-[10px] tabular-nums"
                data-testid="tool-call-token-estimate"
              >
                ~{formatTokens(estimatedTokens)}
              </span>
            )}
            {computedDuration > 0 && (
              <>
                <span
                  className="inline-block h-1.5 w-1.5 rounded-full bg-green-500"
                  aria-hidden="true"
                  data-testid="tool-call-duration-dot"
                />
                <span
                  className="text-muted-foreground/60 text-[10px] tabular-nums"
                  data-testid="tool-call-duration"
                >
                  {formatDuration(computedDuration)}
                </span>
              </>
            )}
          </span>
          {isError && <AlertTriangle className="h-3 w-3 text-destructive" />}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mt-1 space-y-1">
            {displayInput && (
              <div>
                <pre
                  className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted/40 p-2 text-[11px] text-muted-foreground/80 leading-relaxed"
                  data-testid="tool-call-input"
                >
                  {displayInput}
                </pre>
                {isInputLong && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowFullInput((prev) => !prev);
                    }}
                    className="mt-0.5 text-[10px] text-primary/80 hover:text-primary transition-colors"
                    data-testid="tool-input-show-more"
                  >
                    {showFullInput ? 'Show less' : 'Show more'}
                  </button>
                )}
              </div>
            )}
            {displayResult && (
              <div>
                <pre
                  className={cn(
                    'max-h-64 overflow-auto whitespace-pre-wrap rounded-md p-2 text-[11px] leading-relaxed',
                    isError
                      ? 'bg-destructive/10 text-destructive'
                      : 'bg-muted/40 text-muted-foreground/80',
                  )}
                  data-testid="tool-call-result"
                >
                  {displayResult}
                </pre>
                {isServerTruncated && !expandedServerResult && sessionId && toolCallId && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleLoadFullResult();
                    }}
                    className="mt-0.5 text-[10px] text-primary/80 hover:text-primary transition-colors disabled:opacity-60"
                    disabled={isFetchingFullResult}
                    data-testid="tool-result-load-full"
                  >
                    {isFetchingFullResult ? 'Loading full result…' : loadFullLabel}
                  </button>
                )}
                {isResultLong && allowLocalResultToggle && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowFullResult((prev) => !prev);
                    }}
                    className="mt-0.5 text-[10px] text-primary/80 hover:text-primary transition-colors"
                    data-testid="tool-result-show-more"
                  >
                    {showFullResult ? 'Show less' : 'Show more'}
                  </button>
                )}
                {fetchError && (
                  <p className="text-[10px] text-destructive" data-testid="tool-result-load-error">
                    {fetchError}
                  </p>
                )}
              </div>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
