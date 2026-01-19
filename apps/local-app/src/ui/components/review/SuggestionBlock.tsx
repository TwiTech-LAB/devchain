import { useState } from 'react';
import { Button } from '@/ui/components/ui/button';
import { Badge } from '@/ui/components/ui/badge';
import { Check, Copy, Play, Loader2 } from 'lucide-react';
import { cn } from '@/ui/lib/utils';

export interface SuggestionBlockProps {
  /** The suggested code to replace the original */
  suggestedCode: string;
  /** The original code being replaced (if available) */
  originalCode?: string;
  /** File path where suggestion applies */
  filePath?: string | null;
  /** Start line number */
  lineStart?: number | null;
  /** End line number */
  lineEnd?: number | null;
  /** Callback to apply the suggestion */
  onApply?: () => Promise<void>;
  /** Whether the apply action is in progress */
  isApplying?: boolean;
  /** Whether the suggestion has been applied */
  isApplied?: boolean;
  /** Whether to show the apply button (e.g., only for agents) */
  showApplyButton?: boolean;
  className?: string;
}

/**
 * Parse suggestion blocks from markdown content.
 * Looks for ```suggestion or ```suggestion\n code blocks.
 * Returns an array of { type: 'text' | 'suggestion', content: string }
 */
export function parseSuggestionBlocks(
  content: string,
): Array<{ type: 'text' | 'suggestion'; content: string }> {
  const blocks: Array<{ type: 'text' | 'suggestion'; content: string }> = [];
  const suggestionRegex = /```suggestion\s*\n([\s\S]*?)```/g;

  let lastIndex = 0;
  let match;

  while ((match = suggestionRegex.exec(content)) !== null) {
    // Add text before the suggestion block
    if (match.index > lastIndex) {
      const textContent = content.slice(lastIndex, match.index).trim();
      if (textContent) {
        blocks.push({ type: 'text', content: textContent });
      }
    }

    // Add the suggestion block
    blocks.push({ type: 'suggestion', content: match[1].trimEnd() });
    lastIndex = match.index + match[0].length;
  }

  // Add remaining text after the last suggestion
  if (lastIndex < content.length) {
    const textContent = content.slice(lastIndex).trim();
    if (textContent) {
      blocks.push({ type: 'text', content: textContent });
    }
  }

  // If no suggestion blocks found, return the whole content as text
  if (blocks.length === 0 && content.trim()) {
    blocks.push({ type: 'text', content: content.trim() });
  }

  return blocks;
}

/**
 * Check if content contains any suggestion blocks
 */
export function hasSuggestionBlocks(content: string): boolean {
  return /```suggestion\s*\n[\s\S]*?```/.test(content);
}

/**
 * Renders a single suggestion block with diff-like preview
 */
export function SuggestionBlock({
  suggestedCode,
  originalCode,
  filePath,
  lineStart,
  lineEnd,
  onApply,
  isApplying = false,
  isApplied = false,
  showApplyButton = true,
  className,
}: SuggestionBlockProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(suggestedCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const lineInfo =
    lineStart !== null && lineStart !== undefined
      ? lineEnd !== null && lineEnd !== undefined && lineEnd !== lineStart
        ? `L${lineStart}-${lineEnd}`
        : `L${lineStart}`
      : null;

  return (
    <div
      className={cn('rounded-md border bg-muted/30 overflow-hidden', className)}
      data-testid="suggestion-block"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-blue-50 border-b">
        <div className="flex items-center gap-2">
          <Badge variant="secondary" className="text-xs bg-blue-100 text-blue-700">
            Suggestion
          </Badge>
          {filePath && lineInfo && (
            <span className="text-xs text-muted-foreground font-mono">
              {filePath}:{lineInfo}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            onClick={handleCopy}
            title="Copy suggestion"
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 text-green-600" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
      </div>

      {/* Diff preview */}
      <div className="text-sm font-mono">
        {/* Original code (if provided) */}
        {originalCode && (
          <div className="bg-red-50 border-l-4 border-red-300">
            {originalCode.split('\n').map((line, i) => (
              <div key={`old-${i}`} className="px-3 py-0.5 flex">
                <span className="text-red-500 mr-2 select-none">-</span>
                <span className="text-red-700">{line || ' '}</span>
              </div>
            ))}
          </div>
        )}

        {/* Suggested code */}
        <div className="bg-green-50 border-l-4 border-green-300">
          {suggestedCode.split('\n').map((line, i) => (
            <div key={`new-${i}`} className="px-3 py-0.5 flex">
              <span className="text-green-500 mr-2 select-none">+</span>
              <span className="text-green-700">{line || ' '}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Apply button */}
      {showApplyButton && onApply && !isApplied && (
        <div className="px-3 py-2 bg-muted/50 border-t">
          <Button
            size="sm"
            variant="secondary"
            className="h-7 text-xs"
            onClick={onApply}
            disabled={isApplying}
          >
            {isApplying ? (
              <>
                <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                Applying...
              </>
            ) : (
              <>
                <Play className="h-3 w-3 mr-1" />
                Apply Suggestion
              </>
            )}
          </Button>
        </div>
      )}

      {/* Applied indicator */}
      {isApplied && (
        <div className="px-3 py-2 bg-green-50 border-t">
          <span className="text-xs text-green-700 flex items-center gap-1">
            <Check className="h-3 w-3" />
            Suggestion applied
          </span>
        </div>
      )}
    </div>
  );
}

export default SuggestionBlock;
