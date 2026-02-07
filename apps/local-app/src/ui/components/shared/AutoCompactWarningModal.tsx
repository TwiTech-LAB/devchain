import { useState } from 'react';
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
import { AlertTriangle, Loader2 } from 'lucide-react';

export interface AutoCompactWarningModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  providerId: string;
  providerName: string;
  agentName?: string;
  onDisabled?: () => void;
}

async function readErrorMessage(response: Response): Promise<string> {
  const fallback = 'Failed to disable Claude auto-compact';

  try {
    const raw = await response.text();
    if (!raw) return fallback;

    try {
      const parsed = JSON.parse(raw) as { message?: unknown };
      if (typeof parsed.message === 'string') return parsed.message;
      if (Array.isArray(parsed.message)) return parsed.message.join(', ');
    } catch {
      // Non-JSON response body - return as-is.
    }

    return raw;
  } catch {
    return fallback;
  }
}

export function AutoCompactWarningModal({
  open,
  onOpenChange,
  providerId,
  providerName,
  agentName,
  onDisabled,
}: AutoCompactWarningModalProps) {
  const hasProviderId = providerId.trim().length > 0;
  const [isDisabling, setIsDisabling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleOpenChange = (nextOpen: boolean) => {
    if (isDisabling && !nextOpen) {
      return;
    }
    onOpenChange(nextOpen);
  };

  const handleDisable = async () => {
    if (isDisabling || !hasProviderId) return;

    setIsDisabling(true);
    setError(null);

    try {
      const response = await fetch(`/api/providers/${providerId}/auto-compact/disable`, {
        method: 'POST',
      });

      if (!response.ok) {
        setError(await readErrorMessage(response));
        return;
      }

      onDisabled?.();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disable Claude auto-compact');
    } finally {
      setIsDisabling(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-xl" data-auto-compact-warning-modal="true">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-amber-500/10">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
            </div>
            <DialogTitle>Claude Auto-Compact Detected</DialogTitle>
          </div>
          <DialogDescription className="text-left">
            Claude Code&apos;s built-in auto-compact feature is currently enabled in your
            configuration (<code>~/.claude.json</code>). In long-running agent sessions managed by
            Devchain, this can cause instability - Devchain handles context compaction automatically
            through its watcher system, making Claude&apos;s built-in auto-compact redundant and
            potentially disruptive. We recommend disabling it for reliable agent operation.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">Provider: {providerName}</p>

          {agentName ? (
            <p className="text-sm font-medium text-foreground">Blocked session: {agentName}</p>
          ) : null}

          {!hasProviderId ? (
            <Alert>
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Provider Unavailable</AlertTitle>
              <AlertDescription>
                Unable to identify the Claude provider. Please disable auto-compact manually by
                setting <code>autoCompactEnabled: false</code> in <code>~/.claude.json</code>.
              </AlertDescription>
            </Alert>
          ) : null}

          {error ? (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Disable Failed</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isDisabling}>
            Cancel
          </Button>
          <Button onClick={handleDisable} disabled={isDisabling || !hasProviderId}>
            {isDisabling ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Disabling...
              </>
            ) : (
              'Disable & Continue'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
