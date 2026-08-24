import React from 'react';
import { Badge, badgeVariants } from '@/ui/components/ui/badge';
import { User } from 'lucide-react';
import { cn } from '@/ui/lib/utils';
import { getMergedWorktree, isMergedTag } from '@/ui/lib/epic-tags';
import { useToast } from '@/ui/hooks/use-toast';

export type EpicPreviewProps = {
  statusLabel?: string;
  statusColor?: string;
  agentName?: string | null;
  description?: string | null;
  subCount?: number;
  tags?: string[];
  maxLines?: number; // description clamp lines (default 2)
  metaRight?: React.ReactNode;
};

export function EpicPreview({
  statusLabel,
  statusColor,
  agentName,
  description,
  subCount,
  tags = [],
  maxLines = 2,
  metaRight,
}: EpicPreviewProps) {
  const { toast } = useToast();
  const showMeta = Boolean(statusLabel) || Boolean(agentName);
  const showSub = typeof subCount === 'number' && subCount > 0;
  const mergedFromWorktree = getMergedWorktree(tags);
  const visibleTags = tags.filter((tag) => !isMergedTag(tag));
  const shownTags = visibleTags.slice(0, 3);
  const hiddenTags = visibleTags.slice(shownTags.length);
  const hasTags = visibleTags.length > 0 || Boolean(mergedFromWorktree);

  const copyTag = async (tag: string): Promise<void> => {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error('Clipboard unavailable');
      }
      await navigator.clipboard.writeText(tag);
      toast({ title: 'Tag copied', description: tag });
    } catch {
      toast({
        variant: 'destructive',
        title: 'Tag could not be copied',
        description: 'Copy the tag manually and try again.',
      });
    }
  };

  return (
    <div className="space-y-2 text-left">
      {(showMeta || metaRight) && (
        <div className="flex items-center text-xs text-muted-foreground">
          <div className="flex items-center gap-2 min-w-0">
            {statusLabel && (
              <>
                <span
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: statusColor }}
                  aria-hidden="true"
                />
                <span className="font-medium text-foreground truncate">{statusLabel}</span>
              </>
            )}
            {agentName && (
              <span className="inline-flex items-center gap-1">
                <User className="h-3 w-3 flex-shrink-0" />
                <span className="truncate">{agentName}</span>
              </span>
            )}
          </div>
          {metaRight && <div className="ml-auto flex items-center gap-1">{metaRight}</div>}
        </div>
      )}
      {description && (
        <div
          className={cn(
            'text-xs text-muted-foreground leading-snug whitespace-pre-wrap',
            // Enumerate known clamp classes so Tailwind picks them up
            maxLines === 1
              ? 'line-clamp-1'
              : maxLines === 2
                ? 'line-clamp-2'
                : maxLines === 3
                  ? 'line-clamp-3'
                  : maxLines === 4
                    ? 'line-clamp-4'
                    : maxLines === 5
                      ? 'line-clamp-5'
                      : maxLines === 6
                        ? 'line-clamp-6'
                        : maxLines === 8
                          ? 'line-clamp-8'
                          : maxLines === 10
                            ? 'line-clamp-10'
                            : 'line-clamp-2',
          )}
        >
          {description}
        </div>
      )}
      {(showSub || hasTags) && (
        <div className="flex min-w-0 flex-nowrap gap-1 overflow-hidden text-xs">
          {showSub && (
            <Badge variant="secondary" className="shrink-0 gap-0.5">
              <span className="opacity-60">↳</span>
              {subCount}
            </Badge>
          )}
          {mergedFromWorktree && (
            <Badge
              variant="secondary"
              className="min-w-0 max-w-36 border border-amber-400/40 bg-amber-500/10"
              title={`Merged from ${mergedFromWorktree}`}
            >
              <span className="truncate">Merged from {mergedFromWorktree}</span>
            </Badge>
          )}
          {shownTags.map((tag) => (
            <button
              key={tag}
              type="button"
              className={cn(badgeVariants({ variant: 'outline' }), 'min-w-0 max-w-28 cursor-copy')}
              title={tag}
              aria-label={`Copy tag ${tag}`}
              onClick={(event) => {
                event.stopPropagation();
                void copyTag(tag);
              }}
            >
              <span className="truncate">{tag}</span>
            </button>
          ))}
          {hiddenTags.length > 0 && (
            <Badge variant="outline" className="shrink-0" title={hiddenTags.join(', ')}>
              +{hiddenTags.length}
            </Badge>
          )}
        </div>
      )}
    </div>
  );
}

export default EpicPreview;
