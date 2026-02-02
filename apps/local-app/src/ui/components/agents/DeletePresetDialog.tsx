import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/ui/components/ui/dialog';
import { Button } from '@/ui/components/ui/button';
import { useToast } from '@/ui/hooks/use-toast';
import { Loader2, AlertTriangle } from 'lucide-react';
import type { Preset } from '@/ui/lib/preset-validation';

interface DeletePresetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  presetToDelete: Preset | null;
}

async function deletePreset(projectId: string, presetName: string): Promise<void> {
  const res = await fetch(`/api/projects/${projectId}/presets`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ presetName }),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Failed to delete preset' }));
    throw new Error(error.message || 'Failed to delete preset');
  }
}

export function DeletePresetDialog({
  open,
  onOpenChange,
  projectId,
  presetToDelete,
}: DeletePresetDialogProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isDeleting, setIsDeleting] = useState(false);

  const handleDelete = async () => {
    if (!presetToDelete) return;

    setIsDeleting(true);
    try {
      await deletePreset(projectId, presetToDelete.name);

      toast({
        title: 'Preset Deleted',
        description: `Preset "${presetToDelete.name}" has been removed`,
      });

      // Refresh the presets list
      await queryClient.invalidateQueries({ queryKey: ['project-presets', projectId] });

      onOpenChange(false);
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to delete preset',
        variant: 'destructive',
      });
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isDeleting && onOpenChange(isOpen)}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Delete Preset</DialogTitle>
          <DialogDescription>
            Are you sure you want to delete this preset? This action cannot be undone.
          </DialogDescription>
        </DialogHeader>

        {presetToDelete && (
          <div className="py-4">
            <div className="flex items-center gap-2 p-3 bg-muted/50 rounded-md border border-destructive/20">
              <AlertTriangle className="h-5 w-5 text-destructive flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="font-medium text-sm">{presetToDelete.name}</p>
                {presetToDelete.description && (
                  <p className="text-xs text-muted-foreground whitespace-pre-line">
                    {presetToDelete.description}
                  </p>
                )}
                <p className="text-xs text-muted-foreground mt-1">
                  {presetToDelete.agentConfigs.length} agent configuration(s)
                </p>
              </div>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isDeleting}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleDelete} disabled={isDeleting}>
            {isDeleting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
