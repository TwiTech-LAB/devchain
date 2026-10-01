import { useState, type FormEvent } from 'react';
import { useHomeFetch } from '@/ui/hooks/useFetchFactory';
import { useHomeQueryClient } from '@/ui/components/BackendBoundary';
import { REMOTES_LIST_QUERY_KEY } from '@/ui/lib/backend-provider';
import { readErrorMessage } from '@/ui/hooks/useRemotes';
import { getErrorMessage } from '@/ui/lib/toast-helpers';
import { Button } from '@/ui/components/ui/button';
import { Input } from '@/ui/components/ui/input';
import { Label } from '@/ui/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/ui/components/ui/dialog';

const CHANGE_FAILED = 'Could not change the VM API key.';

export function ApiKeyDialog({
  remoteId,
  name,
  mode,
  onClose,
}: {
  remoteId: string;
  name: string;
  mode: 'enter' | 'reset';
  onClose: () => void;
}) {
  const homeFetch = useHomeFetch();
  const queryClient = useHomeQueryClient();
  const [apiKey, setApiKey] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const entering = mode === 'enter';
  const canSubmit = !pending && (!entering || apiKey.trim() !== '');
  let submitLabel = entering ? 'Check and save' : 'Reset API key';
  if (pending) submitLabel = 'Saving…';
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setPending(true);
    setError(null);
    try {
      const response = await homeFetch(
        `/api/remotes/${remoteId}/api-key${entering ? '' : '/reset'}`,
        {
          method: entering ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(entering ? { apiKey: apiKey.trim() } : {}),
        },
      );
      if (!response.ok) throw new Error(await readErrorMessage(response, CHANGE_FAILED));
      setApiKey('');
      onClose();
    } catch (cause) {
      setError(getErrorMessage(cause, CHANGE_FAILED));
    } finally {
      setPending(false);
      void queryClient.invalidateQueries({ queryKey: REMOTES_LIST_QUERY_KEY });
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent>
        <form onSubmit={(event) => void submit(event)} className="space-y-4">
          <DialogHeader>
            <DialogTitle>
              {entering ? 'Enter API key' : 'Reset API key'} for {name}
            </DialogTitle>
            <DialogDescription>
              {entering ? (
                <>
                  Run <code>devchain host api-key reset</code> on the VM, then paste the key here.
                  This PC checks it before saving.
                </>
              ) : (
                'Generate a new API key on the VM and save it on this PC. Other PCs using the old key will lose access.'
              )}
            </DialogDescription>
          </DialogHeader>
          {entering && (
            <div className="space-y-1.5">
              <Label htmlFor="vm-api-key">API key</Label>
              <Input
                id="vm-api-key"
                type="password"
                autoComplete="new-password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                disabled={pending}
                autoFocus
              />
            </div>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
