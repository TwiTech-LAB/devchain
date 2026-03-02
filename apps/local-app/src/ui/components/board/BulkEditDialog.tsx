import { Loader2 } from 'lucide-react';
import { Badge } from '@/ui/components/ui/badge';
import { Button } from '@/ui/components/ui/button';
import { Label } from '@/ui/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/components/ui/select';
import type { Agent, Epic, Status } from './types';

export interface BulkEditRow {
  epic: Epic;
  statusId: string;
  agentId: string | null;
}

export interface BulkEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bulkError: string | null;
  bulkLoading: boolean;
  rows: BulkEditRow[];
  statuses: Status[];
  agents: Agent[];
  onRowChange: (epicId: string, field: 'statusId' | 'agentId', value: string | null) => void;
  onClose: () => void;
  onSubmit: () => void;
  isSubmitting: boolean;
  canSubmit: boolean;
  isLightColor: (hex: string) => boolean;
}

export function BulkEditDialog({
  open,
  onOpenChange,
  bulkError,
  bulkLoading,
  rows,
  statuses,
  agents,
  onRowChange,
  onClose,
  onSubmit,
  isSubmitting,
  canSubmit,
  isLightColor,
}: BulkEditDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle>Bulk edit parent & sub-epics</DialogTitle>
          <DialogDescription>
            Update status and assignees for the parent epic and its sub-epics in one place.
            Triggered from the list-checks icon on parent cards.
          </DialogDescription>
        </DialogHeader>

        {bulkError && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 text-destructive text-sm p-3">
            {bulkError}
          </div>
        )}

        {bulkLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading parent and sub-epics…
          </div>
        )}

        {!bulkLoading && rows.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Select a parent epic to bulk edit its sub-epics.
          </p>
        )}

        {!bulkLoading && rows.length > 0 && (
          <div className="rounded-md border divide-y overflow-y-auto flex-1 min-h-0">
            {rows.map((row) => {
              const statusSelectId = `bulk-status-${row.epic.id}`;
              const agentSelectId = `bulk-agent-${row.epic.id}`;
              const isParent = !row.epic.parentId;
              const rowStatus = statuses.find((s) => s.id === row.statusId);
              const subBadgeStyle =
                !isParent && rowStatus?.color
                  ? {
                      backgroundColor: rowStatus.color,
                      color: isLightColor(rowStatus.color) ? '#1f2937' : '#ffffff',
                      borderColor: 'transparent',
                    }
                  : undefined;

              return (
                <div
                  key={row.epic.id}
                  className="grid gap-3 p-3 sm:grid-cols-[2fr,1.2fr,1.2fr]"
                  data-testid={`bulk-row-${row.epic.id}`}
                >
                  <div className="space-y-1 min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <Badge
                        variant={isParent ? 'secondary' : 'outline'}
                        className="text-[11px] shrink-0"
                        style={subBadgeStyle}
                      >
                        {isParent ? 'Parent' : 'Sub'}
                      </Badge>
                      <span className="font-semibold text-sm break-all">{row.epic.title}</span>
                    </div>
                    {row.epic.description && (
                      <p className="text-xs text-muted-foreground line-clamp-2">
                        {row.epic.description}
                      </p>
                    )}
                  </div>

                  <div className="space-y-1">
                    <Label htmlFor={statusSelectId}>Status</Label>
                    <Select
                      value={row.statusId}
                      onValueChange={(value) => onRowChange(row.epic.id, 'statusId', value)}
                    >
                      <SelectTrigger id={statusSelectId}>
                        <SelectValue placeholder="Select status" />
                      </SelectTrigger>
                      <SelectContent>
                        {statuses.map((status) => (
                          <SelectItem key={status.id} value={status.id}>
                            {status.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-1">
                    <Label htmlFor={agentSelectId}>Assignee</Label>
                    <Select
                      value={row.agentId ?? 'none'}
                      onValueChange={(value) =>
                        onRowChange(row.epic.id, 'agentId', value === 'none' ? null : value)
                      }
                    >
                      <SelectTrigger id={agentSelectId}>
                        <SelectValue placeholder="Select agent" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">Unassigned</SelectItem>
                        {agents.map((agent) => (
                          <SelectItem key={agent.id} value={agent.id}>
                            {agent.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <DialogFooter className="shrink-0">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onSubmit} disabled={!canSubmit}>
            {isSubmitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Saving...
              </>
            ) : (
              'Save changes'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
