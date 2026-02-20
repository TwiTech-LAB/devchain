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

export interface AutoCompactEnableModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  providerId: string;
  providerName: string;
  onEnabled?: () => void;
  onSkipped?: () => void;
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as Record<string, unknown>;
    if (body && typeof body === 'object' && typeof body.message === 'string') {
      return body.message;
    }
  } catch {
    // ignore parse errors
  }
  return `Request failed with status ${response.status}`;
}

export function AutoCompactEnableModal({
  open,
  onOpenChange,
  providerId,
  providerName,
  onEnabled,
  onSkipped,
}: AutoCompactEnableModalProps) {
  const [isEnabling, setIsEnabling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleEnable = async () => {
    setIsEnabling(true);
    setError(null);

    try {
      const response = await fetch(`/api/providers/${providerId}/auto-compact/enable`, {
        method: 'POST',
      });

      if (!response.ok) {
        const message = await readErrorMessage(response);
        setError(message);
        return;
      }

      onEnabled?.();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error. Please try again.');
    } finally {
      setIsEnabling(false);
    }
  };

  const handleSkip = () => {
    if (isEnabling) return;
    onSkipped?.();
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        // Block all implicit close attempts (X button, overlay, escape).
        // Only explicit button handlers (Skip / Enable) close the modal.
        if (!nextOpen) return;
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent
        className="max-w-xl"
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-amber-500/10">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
            </div>
            <DialogTitle>Enable Auto-Compact for Claude</DialogTitle>
          </div>
          <DialogDescription className="text-left">
            Auto-compact improves context quality in long-running Claude sessions managed by
            DevChain. We recommend enabling it for reliable agent operation.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Provider: <span className="font-medium text-foreground">{providerName}</span>
          </p>

          {error && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Failed to enable auto-compact</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleSkip} disabled={isEnabling}>
            Skip
          </Button>
          <Button onClick={handleEnable} disabled={isEnabling}>
            {isEnabling && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Enable & Continue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
