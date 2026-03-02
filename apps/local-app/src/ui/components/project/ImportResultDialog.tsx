import { Button } from '@/ui/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/components/ui/dialog';
import type { ImportResult } from '@/ui/hooks/useProjectImport';

interface ImportResultDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  importResult: ImportResult | null;
}

export function ImportResultDialog({ open, onOpenChange, importResult }: ImportResultDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Import Completed</DialogTitle>
          <DialogDescription>Project configuration was replaced successfully.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          {importResult?.counts ? (
            <>
              <div>
                <strong>Imported</strong>
                <div className="grid grid-cols-2 gap-2 mt-1">
                  {Object.entries(importResult.counts.imported).map(([k, v]) => (
                    <div key={k} className="flex justify-between">
                      <span className="capitalize">{k}</span>
                      <span>{v}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <strong>Deleted</strong>
                <div className="grid grid-cols-2 gap-2 mt-1">
                  {Object.entries(importResult.counts.deleted).map(([k, v]) => (
                    <div key={k} className="flex justify-between">
                      <span className="capitalize">{k}</span>
                      <span>{v}</span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          ) : null}
          {importResult?.initialPromptSet !== undefined && (
            <p>Initial prompt mapping: {importResult.initialPromptSet ? 'Set' : 'Not set'}</p>
          )}
        </div>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
