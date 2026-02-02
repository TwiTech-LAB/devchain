import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/ui/components/ui/dialog';
import { Button } from '@/ui/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/ui/components/ui/alert';
import { Badge } from '@/ui/components/ui/badge';
import { useToast } from '@/ui/hooks/use-toast';
import { ArrowRight, Upload, Loader2, AlertCircle, CheckCircle2, RotateCcw } from 'lucide-react';

// Simplified flow: confirm → applying → done | error (no download step - versions are cached)
type UpgradeStep = 'confirm' | 'applying' | 'done' | 'error';

interface UpgradeResult {
  success: boolean;
  newVersion?: string;
  error?: string;
  restored?: boolean; // true if auto-restore succeeded after failure
  backupId?: string; // Only present when restored=false (for manual fallback)
}

interface UpgradeDialogProps {
  projectId: string;
  projectName: string;
  templateSlug: string;
  currentVersion: string;
  targetVersion: string;
  /** Template source - used to differentiate copy between registry and bundled */
  source: 'bundled' | 'registry' | 'file';
  open: boolean;
  onClose: () => void;
}

async function upgradeProject(projectId: string, targetVersion: string): Promise<UpgradeResult> {
  const res = await fetch('/api/registry/upgrade-project', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId, targetVersion }),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Upgrade failed' }));
    throw new Error(error.message || 'Upgrade failed');
  }
  return res.json();
}

async function restoreBackup(backupId: string): Promise<{ success: boolean }> {
  const res = await fetch('/api/registry/restore-backup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ backupId }),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Restore failed' }));
    throw new Error(error.message || 'Restore failed');
  }
  return res.json();
}

export function UpgradeDialog({
  projectId,
  projectName,
  templateSlug,
  currentVersion,
  targetVersion,
  source,
  open,
  onClose,
}: UpgradeDialogProps) {
  // Conditional copy based on source
  const isRegistry = source === 'registry';
  const actionVerb = isRegistry ? 'Upgrade' : 'Update';
  const actionVerbPastParticiple = isRegistry ? 'upgraded' : 'updated';
  // Start at 'confirm' - no download step needed (versions are cached)
  const [step, setStep] = useState<UpgradeStep>('confirm');
  const [error, setError] = useState<string | null>(null);
  const [backupId, setBackupId] = useState<string | null>(null);

  const queryClient = useQueryClient();
  const { toast } = useToast();

  // templateSlug is used for display purposes only
  void templateSlug;

  // Upgrade mutation
  const upgradeMutation = useMutation({
    mutationFn: () => upgradeProject(projectId, targetVersion),
    onSuccess: (result) => {
      if (result.success) {
        setStep('done');
        toast({
          title: `${actionVerb} Complete`,
          description: `${projectName} ${actionVerbPastParticiple} to v${result.newVersion}`,
        });
        queryClient.invalidateQueries({ queryKey: ['project-template-metadata', projectId] });
      } else if (result.restored) {
        // Auto-restore succeeded - show toast and close dialog directly
        // (can't use handleClose here as mutation isPending check would block)
        toast({
          title: `${actionVerb} Failed`,
          description: 'Project was automatically restored to its previous state',
          variant: 'destructive',
        });
        setStep('confirm');
        setError(null);
        setBackupId(null);
        onClose();
      } else {
        // Auto-restore failed or no backup - show error step for manual restore
        setError(result.error || `${actionVerb} failed`);
        if (result.backupId) {
          setBackupId(result.backupId);
        }
        setStep('error');
      }
    },
    onError: (err: Error) => {
      setError(err.message);
      setStep('error');
    },
  });

  // Restore mutation
  const restoreMutation = useMutation({
    mutationFn: () => restoreBackup(backupId!),
    onSuccess: () => {
      toast({
        title: 'Backup Restored',
        description: 'Project has been restored to its previous state',
      });
      setBackupId(null);
      handleClose();
    },
    onError: (err: Error) => {
      toast({
        title: 'Restore Failed',
        description: err.message,
        variant: 'destructive',
      });
    },
  });

  const handleApply = () => {
    setStep('applying');
    upgradeMutation.mutate();
  };

  const handleRestore = () => {
    if (backupId) {
      restoreMutation.mutate();
    }
  };

  const handleClose = () => {
    if (!upgradeMutation.isPending && !restoreMutation.isPending) {
      setStep('confirm');
      setError(null);
      setBackupId(null);
      onClose();
    }
  };

  const isPending = upgradeMutation.isPending || restoreMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && handleClose()}>
      <DialogContent className="sm:max-w-lg">
        {/* Confirm Step - initial step (no download needed, versions are cached) */}
        {step === 'confirm' && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Upload className="h-5 w-5" />
                {actionVerb} Project
              </DialogTitle>
              <DialogDescription>
                {actionVerb} {projectName} to{' '}
                {isRegistry
                  ? 'a newer template version from the registry'
                  : 'the bundled template version'}
              </DialogDescription>
            </DialogHeader>

            <div className="py-4 space-y-4">
              {/* Version comparison */}
              <div className="flex items-center justify-center gap-4 text-lg">
                <Badge variant="outline" className="text-base px-3 py-1">
                  v{currentVersion}
                </Badge>
                <ArrowRight className="h-5 w-5 text-muted-foreground" />
                <Badge className="text-base px-3 py-1">v{targetVersion}</Badge>
              </div>

              <Alert>
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>What will change</AlertTitle>
                <AlertDescription>
                  <ul className="list-disc list-inside mt-2 space-y-1 text-sm">
                    <li>Prompts, profiles, agents, and statuses may be updated</li>
                    <li>Watchers and subscribers may be added or modified</li>
                    <li>Your epics, records, and documents will NOT be affected</li>
                  </ul>
                </AlertDescription>
              </Alert>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={handleClose}>
                Cancel
              </Button>
              <Button onClick={handleApply}>
                <Upload className="h-4 w-4 mr-2" />
                {actionVerb}
              </Button>
            </DialogFooter>
          </>
        )}

        {/* Applying Step */}
        {step === 'applying' && (
          <>
            <DialogHeader>
              <DialogTitle>Applying {actionVerb}</DialogTitle>
              <DialogDescription>Creating backup and applying changes...</DialogDescription>
            </DialogHeader>

            <div className="py-8 flex flex-col items-center justify-center gap-4">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
              <p className="text-sm text-muted-foreground">Please wait...</p>
            </div>
          </>
        )}

        {/* Done Step */}
        {step === 'done' && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-green-600">
                <CheckCircle2 className="h-5 w-5" />
                {actionVerb} Complete
              </DialogTitle>
              <DialogDescription>
                {projectName} has been {actionVerbPastParticiple} to v{targetVersion}
              </DialogDescription>
            </DialogHeader>

            <div className="py-8 flex flex-col items-center justify-center gap-4">
              <CheckCircle2 className="h-16 w-16 text-green-500" />
              <p className="text-sm text-muted-foreground">
                All changes have been applied successfully
              </p>
            </div>

            <DialogFooter>
              <Button onClick={handleClose}>Done</Button>
            </DialogFooter>
          </>
        )}

        {/* Error Step */}
        {step === 'error' && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-destructive">
                <AlertCircle className="h-5 w-5" />
                {actionVerb} Failed
              </DialogTitle>
            </DialogHeader>

            <div className="py-4 space-y-4">
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>Error</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>

              {backupId && (
                <Alert>
                  <RotateCcw className="h-4 w-4" />
                  <AlertTitle>Manual Restore Available</AlertTitle>
                  <AlertDescription>
                    Auto-restore failed. Click the button below to restore your project to its
                    previous state.
                  </AlertDescription>
                </Alert>
              )}
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={handleClose} disabled={isPending}>
                Close
              </Button>
              {backupId && (
                <Button
                  onClick={handleRestore}
                  disabled={restoreMutation.isPending}
                  variant="destructive"
                >
                  {restoreMutation.isPending ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Restoring...
                    </>
                  ) : (
                    <>
                      <RotateCcw className="h-4 w-4 mr-2" />
                      Restore Backup
                    </>
                  )}
                </Button>
              )}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
