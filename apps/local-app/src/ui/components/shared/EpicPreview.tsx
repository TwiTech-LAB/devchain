import React from 'react';
import { Badge } from '@/ui/components/ui/badge';
import { User } from 'lucide-react';
import { cn } from '@/ui/lib/utils';

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
  const showMeta = Boolean(statusLabel) || Boolean(agentName);
  const showSub = typeof subCount === 'number' && subCount > 0;
  const hasTags = tags.length > 0;

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
        <div className="flex flex-wrap gap-1 text-xs">
          {showSub && (
            <Badge variant="secondary" className="gap-0.5">
              <span className="opacity-60">↳</span>
              {subCount}
            </Badge>
          )}
          {tags.slice(0, 3).map((tag) => (
            <Badge key={tag} variant="outline">
              {tag}
            </Badge>
          ))}
          {tags.length > 3 && <Badge variant="outline">+{tags.length - 3}</Badge>}
        </div>
      )}
    </div>
  );
}

export default EpicPreview;
