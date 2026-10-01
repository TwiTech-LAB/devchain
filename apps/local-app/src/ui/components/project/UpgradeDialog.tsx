import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/components/ui/dialog';
import { Button } from '@/ui/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/ui/components/ui/alert';
import { useToast } from '@/ui/hooks/use-toast';
import { AlertCircle, CheckCircle2, Loader2, RotateCcw } from 'lucide-react';
import { formatPromptTransferCounts } from '@/common/prompt-transfer';
import {
  formatProjectPreMutationFailure,
  isProjectPreMutationFailure,
} from '@/ui/pages/projects/lib/project-failures';
import type { UpgradeProjectResponse } from '@/ui/pages/projects/lib/project-contracts';
import { HOME_BACKEND, apiFetch } from '@/ui/lib/api-transport';

interface UpgradeDialogProps {
  projectId: string;
  projectName: string;
  targetVersion: string;
  source: 'bundled' | 'registry' | 'file';
  result: UpgradeProjectResponse;
  open: boolean;
  onClose: () => void;
}

async function restoreBackup(projectId: string, backupId: string): Promise<{ success: boolean }> {
  const res = await apiFetch(
    `/api/projects/${encodeURIComponent(projectId)}/restore-backup`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ backupId }),
    },
    { backend: HOME_BACKEND },
  );
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Restore failed' }));
    throw new Error(error.message || 'Restore failed');
  }
  return res.json();
}

export function UpgradeDialog({
  projectId,
  projectName,
  targetVersion,
  source,
  result,
  open,
  onClose,
}: UpgradeDialogProps) {
  const [restoreComplete, setRestoreComplete] = useState(false);
  const { toast } = useToast();
  const actionVerb = source === 'registry' ? 'Upgrade' : 'Update';
  const actionVerbPastParticiple = source === 'registry' ? 'upgraded' : 'updated';
  const preMutationFailure = isProjectPreMutationFailure(result) ? result : null;
  const manualBackupId =
    !result.success && !preMutationFailure && !result.restored ? result.backupId : undefined;

  const restoreMutation = useMutation({
    mutationFn: (backupId: string) => restoreBackup(projectId, backupId),
    onSuccess: () => {
      setRestoreComplete(true);
      toast({
        title: 'Backup Restored',
        description: 'Project has been restored to its previous state',
      });
    },
    onError: (error: Error) => {
      toast({ title: 'Restore Failed', description: error.message, variant: 'destructive' });
    },
  });

  const handleClose = () => {
    if (!restoreMutation.isPending) onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && handleClose()}>
      <DialogContent className="sm:max-w-lg">
        {result.success ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-status-ok">
                <CheckCircle2 className="h-5 w-5" />
                {actionVerb} Complete
              </DialogTitle>
              <DialogDescription>
                {projectName} has been {actionVerbPastParticiple} to v{result.newVersion}
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col items-center justify-center gap-4 py-8">
              <CheckCircle2 className="h-16 w-16 text-status-ok" />
              <p className="text-sm text-muted-foreground">
                All configured changes have been applied successfully.
              </p>
              {result.promptTransfer && (
                <div className="text-sm text-muted-foreground">
                  Prompts: {formatPromptTransferCounts(result.promptTransfer)}
                </div>
              )}
            </div>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-destructive">
                <AlertCircle className="h-5 w-5" />
                {actionVerb} Failed
              </DialogTitle>
              <DialogDescription>
                {preMutationFailure
                  ? `No changes were made to ${projectName}.`
                  : `The ${actionVerb.toLowerCase()} to v${targetVersion} did not complete.`}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-4">
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>{preMutationFailure ? 'Blocked before changes' : 'Error'}</AlertTitle>
                <AlertDescription>
                  {preMutationFailure
                    ? formatProjectPreMutationFailure(preMutationFailure)
                    : result.error || `${actionVerb} failed`}
                </AlertDescription>
              </Alert>

              {result.restored && (
                <Alert>
                  <RotateCcw className="h-4 w-4" />
                  <AlertTitle>Previous state restored</AlertTitle>
                  <AlertDescription>
                    Changes had started, but the project was automatically restored to its previous
                    state.
                  </AlertDescription>
                </Alert>
              )}

              {manualBackupId && !restoreComplete && (
                <Alert>
                  <RotateCcw className="h-4 w-4" />
                  <AlertTitle>Manual Restore Available</AlertTitle>
                  <AlertDescription>
                    Automatic restore did not complete. Restore the backup before continuing work in
                    this project.
                  </AlertDescription>
                </Alert>
              )}

              {restoreComplete && (
                <Alert>
                  <CheckCircle2 className="h-4 w-4" />
                  <AlertTitle>Backup Restored</AlertTitle>
                  <AlertDescription>
                    The project has been restored to its previous state.
                  </AlertDescription>
                </Alert>
              )}
            </div>
          </>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={restoreMutation.isPending}>
            {result.success || restoreComplete ? 'Done' : 'Close'}
          </Button>
          {manualBackupId && !restoreComplete && (
            <Button
              onClick={() => restoreMutation.mutate(manualBackupId)}
              disabled={restoreMutation.isPending}
              variant="destructive"
            >
              {restoreMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Restoring...
                </>
              ) : (
                <>
                  <RotateCcw className="mr-2 h-4 w-4" />
                  Restore Backup
                </>
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
