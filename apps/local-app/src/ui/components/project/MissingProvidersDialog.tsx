import { Button } from '@/ui/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/components/ui/dialog';

interface MissingProvidersDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  missingProviders: string[] | undefined;
}

export function MissingProvidersDialog({
  open,
  onOpenChange,
  missingProviders,
}: MissingProvidersDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Providers Required</DialogTitle>
          <DialogDescription>
            The selected file requires the following providers to be installed/configured before
            importing:
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {missingProviders?.length ? (
            <ul className="list-disc pl-6 text-sm">
              {missingProviders.map((name) => (
                <li key={name}>{name}</li>
              ))}
            </ul>
          ) : null}
        </div>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
