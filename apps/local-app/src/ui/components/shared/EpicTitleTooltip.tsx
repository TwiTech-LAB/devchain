import React from 'react';
import { Button } from '@/ui/components/ui/button';
import { Edit, ListChecks, Trash2, Search, User } from 'lucide-react';

export type EpicTitleTooltipProps = {
  title: string;
  statusLabel?: string;
  statusColor?: string;
  agentName?: string | null;
  description?: string | null;
  showFilterToggle?: boolean;
  onViewDetails?: (e: React.MouseEvent) => void;
  onToggleParentFilter?: (e: React.MouseEvent) => void;
  showBulkEdit?: boolean;
  onBulkEdit?: (e: React.MouseEvent) => void;
  onEdit?: (e: React.MouseEvent) => void;
  onDelete?: (e: React.MouseEvent) => void;
  showOpenDetails?: boolean;
  // Uses onViewDetails when present
};

export function EpicTitleTooltip({
  title,
  statusLabel,
  statusColor,
  agentName,
  description,
  showFilterToggle,
  onViewDetails,
  onToggleParentFilter,
  showBulkEdit,
  onBulkEdit,
  onEdit,
  onDelete,
  showOpenDetails,
}: EpicTitleTooltipProps) {
  const showMeta = Boolean(statusLabel) || Boolean(agentName);
  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <p className="text-sm font-semibold leading-tight break-words whitespace-pre-wrap">
          {title}
        </p>
        {showMeta && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {statusLabel && (
              <>
                <span
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: statusColor }}
                  aria-hidden="true"
                />
                <span className="font-medium text-foreground">{statusLabel}</span>
              </>
            )}
            {agentName && (
              <span className="inline-flex items-center gap-1">
                <User className="h-3 w-3" />
                <span>{agentName}</span>
              </span>
            )}
          </div>
        )}
      </div>
      {(showBulkEdit || onEdit || onDelete || (showOpenDetails && onViewDetails)) && (
        <div className="flex items-center gap-1">
          {showOpenDetails && onViewDetails && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0"
              aria-label="Open epic details"
              onClick={onViewDetails}
            >
              <Search className="h-3 w-3" />
            </Button>
          )}
          {showBulkEdit && onBulkEdit && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0"
              title="Bulk edit parent and sub-epic status/assignee"
              aria-label="Bulk edit parent and sub-epics"
              onClick={onBulkEdit}
            >
              <ListChecks className="h-3 w-3" />
            </Button>
          )}
          {onEdit && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0"
              aria-label="Edit epic"
              onClick={onEdit}
            >
              <Edit className="h-3 w-3" />
            </Button>
          )}
          {onDelete && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0 text-destructive hover:text-destructive"
              aria-label="Delete epic"
              onClick={onDelete}
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          )}
        </div>
      )}
      {description && (
        <p className="text-xs text-muted-foreground leading-snug whitespace-pre-line">
          {description}
        </p>
      )}
      {(onViewDetails || (showFilterToggle && onToggleParentFilter)) && (
        <div className="flex items-center gap-3 pt-1">
          {onViewDetails && (
            <Button variant="link" size="sm" className="px-0 text-xs" onClick={onViewDetails}>
              View details
            </Button>
          )}
          {showFilterToggle && onToggleParentFilter && (
            <Button
              variant="link"
              size="sm"
              className="px-0 text-xs"
              onClick={onToggleParentFilter}
            >
              Toggle parent filter
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export default EpicTitleTooltip;
