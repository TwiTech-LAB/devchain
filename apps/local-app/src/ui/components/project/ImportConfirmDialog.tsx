import { Loader2 } from 'lucide-react';
import { Button } from '@/ui/components/ui/button';
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

interface DryRunResult {
  counts: { toImport: Record<string, number>; toDelete: Record<string, number> };
  unmatchedStatuses?: Array<{ id: string; label: string; color: string; epicCount: number }>;
  templateStatuses?: Array<{ label: string; color: string }>;
}

interface ImportConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dryRunResult: DryRunResult | null;
  statusMappings: Record<string, string>;
  setStatusMappings: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  onConfirm: () => void;
  isImporting: boolean;
}

export function ImportConfirmDialog({
  open,
  onOpenChange,
  dryRunResult,
  statusMappings,
  setStatusMappings,
  onConfirm,
  isImporting,
}: ImportConfirmDialogProps) {
  const isMissingRequiredMappings =
    (dryRunResult?.unmatchedStatuses?.length ?? 0) > Object.keys(statusMappings).length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Replace Project Configuration?</DialogTitle>
          <DialogDescription>
            This will REPLACE prompts, profiles, agents, statuses, and the initial session prompt
            for this project. This action is destructive.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <div>
            <strong>To import</strong>
            <div className="grid grid-cols-2 gap-2 mt-1">
              {dryRunResult &&
                Object.entries(dryRunResult.counts.toImport).map(([k, v]) => (
                  <div key={k} className="flex justify-between">
                    <span className="capitalize">{k}</span>
                    <span>{v}</span>
                  </div>
                ))}
            </div>
          </div>
          <div>
            <strong>Will delete</strong>
            <div className="grid grid-cols-2 gap-2 mt-1">
              {dryRunResult &&
                Object.entries(dryRunResult.counts.toDelete).map(([k, v]) => (
                  <div key={k} className="flex justify-between">
                    <span className="capitalize">{k}</span>
                    <span>{v}</span>
                  </div>
                ))}
            </div>
          </div>
          {dryRunResult?.unmatchedStatuses && dryRunResult.unmatchedStatuses.length > 0 && (
            <div className="border-t pt-3 mt-3">
              <strong>Status Mapping Required</strong>
              <p className="text-xs text-muted-foreground mt-1 mb-2">
                The following statuses have epics but no matching status in the template. Map each
                to a template status:
              </p>
              <div className="space-y-2">
                {dryRunResult.unmatchedStatuses.map((status) => (
                  <div key={status.id} className="flex items-center gap-2">
                    <div className="flex items-center gap-1.5 min-w-[140px]">
                      <span
                        style={{ backgroundColor: status.color }}
                        className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                      />
                      <span className="truncate">{status.label}</span>
                      <span className="text-xs text-muted-foreground">({status.epicCount})</span>
                    </div>
                    <span className="text-muted-foreground">→</span>
                    <Select
                      value={statusMappings[status.id] || ''}
                      onValueChange={(val) =>
                        setStatusMappings((prev) => ({ ...prev, [status.id]: val }))
                      }
                    >
                      <SelectTrigger className="w-[140px]">
                        <SelectValue placeholder="Select status" />
                      </SelectTrigger>
                      <SelectContent>
                        {dryRunResult.templateStatuses?.map((ts) => (
                          <SelectItem key={ts.label} value={ts.label}>
                            <div className="flex items-center gap-1.5">
                              <span
                                style={{ backgroundColor: ts.color }}
                                className="w-2 h-2 rounded-full"
                              />
                              {ts.label}
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={onConfirm}
            disabled={isImporting || isMissingRequiredMappings}
          >
            {isImporting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
            Replace Project
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
