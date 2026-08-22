import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { Button } from '@/ui/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/ui/components/ui/dialog';
import { IntegrationConnectionForm } from '@/ui/components/integrations/IntegrationConnectionForm';
import type {
  IntegrationConnectionState,
  IntegrationProvider,
  ReplaceIntegrationConnectionInput,
} from '@/ui/hooks/useIntegrationConnections';
import {
  EXTERNAL_BOARD_PROVIDERS,
  externalBoardMyWorkPath,
  externalBoardProviderLabel,
  type ExternalBoardProvider,
} from '@/ui/lib/external-board';
import { disconnectedConnectionState } from '@/ui/lib/integration-connections';

export interface AddBoardButtonProps {
  connections: IntegrationConnectionState[];
  isLoading: boolean;
  onConnect: (input: ReplaceIntegrationConnectionInput) => Promise<unknown>;
  replacingProvider?: IntegrationProvider | undefined;
}

export function AddBoardButton({
  connections,
  isLoading,
  onConnect,
  replacingProvider,
}: AddBoardButtonProps) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<ExternalBoardProvider | null>(null);

  const candidates = useMemo(
    () =>
      EXTERNAL_BOARD_PROVIDERS.filter(
        (provider) => !connections.some((c) => c.provider === provider && c.connected),
      ),
    [connections],
  );

  if (isLoading || candidates.length === 0) return null;

  const effectiveSelected =
    selectedProvider !== null && candidates.includes(selectedProvider) ? selectedProvider : null;

  const openDialog = () => {
    setSelectedProvider(candidates.length === 1 ? candidates[0] : null);
    setOpen(true);
  };

  const closeDialog = () => {
    setOpen(false);
    setSelectedProvider(null);
  };

  const handleDialogOpenChange = (next: boolean) => {
    if (!next) closeDialog();
  };

  const handleReplace = async (input: ReplaceIntegrationConnectionInput) => {
    await onConnect(input);
    closeDialog();
    navigate(externalBoardMyWorkPath(input.provider));
  };

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="ml-1 h-8 gap-1 px-2 text-sm"
        onClick={openDialog}
        aria-haspopup="dialog"
      >
        <Plus className="h-4 w-4" aria-hidden="true" />
        Add board
      </Button>
      <Dialog open={open} onOpenChange={handleDialogOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add board</DialogTitle>
            <DialogDescription>Connect an external work board to this app.</DialogDescription>
          </DialogHeader>
          {effectiveSelected === null ? (
            <div className="flex flex-col gap-2">
              {candidates.map((provider) => (
                <Button
                  key={provider}
                  type="button"
                  variant="outline"
                  onClick={() => setSelectedProvider(provider)}
                >
                  Connect {externalBoardProviderLabel(provider)}
                </Button>
              ))}
            </div>
          ) : (
            // Only disconnected providers reach this dialog; credential replacement and
            // disconnect stay in Settings → Integrations, so the disconnect action is inert here.
            <IntegrationConnectionForm
              provider={effectiveSelected}
              connection={
                connections.find((c) => c.provider === effectiveSelected) ??
                disconnectedConnectionState(effectiveSelected)
              }
              onReplace={handleReplace}
              onDisconnect={async () => undefined}
              isReplacing={replacingProvider === effectiveSelected}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
