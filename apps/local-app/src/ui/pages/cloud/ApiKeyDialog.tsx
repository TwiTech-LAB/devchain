import { useState, type FormEvent } from 'react';
import { useRemoteVmApi } from './lib/remote-vm-api-context';
import { useHomeQueryClient } from '@/ui/components/BackendBoundary';
import { REMOTES_LIST_QUERY_KEY } from './lib/remote-vm-query-keys';
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
  const api = useRemoteVmApi();
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
      if (entering) await api.setApiKey(remoteId, apiKey.trim());
      else await api.resetApiKey(remoteId);
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
            <Button type="submit" disabled={!canSubmit} pending={pending}>
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
