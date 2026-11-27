import { useEffect, useState } from 'react';
import { ConfirmDialog } from '@/ui/components/shared/ConfirmDialog';
import { useConfirmDialog } from '@/ui/hooks/useFormDialog';
import type { ProfileProviderConfig } from '@/ui/lib/provider-configs';
import type { SavePointAvailability, SessionTreeNode } from '@/ui/lib/sessions';
import { SessionsTable } from './SessionsTable';
import { sessionTreeLabel, switchRestoreWarning } from './SessionTree';

export interface PreviousSessionsTableProps {
  agentId: string;
  /** The agent's name, for the provider mismatch reason. */
  agentName?: string | null;
  projectId: string;
  onRead: (sessionId: string) => void;
  /** Gets the switch config id when the session ran on another provider; the user confirmed it. */
  onRestore: (sessionId: string, switchToProviderConfigId?: string) => void;
  onStartFromHere: (sessionId: string, availability: SavePointAvailability | undefined) => void;
  /** No session of the agent is live here, so a rollback replaces none. */
  onRollback: (
    sessionId: string,
    savePointId: string,
    keepCurrent: boolean,
    savePointLabel: string,
  ) => void;
  currentProviderName: string | null;
  /** The agent's profile configs; undefined while they load or when the fetch failed. */
  providerConfigs?: readonly ProfileProviderConfig[];
  restoringSessionIds: Record<string, boolean>;
  forkingSessionIds: Record<string, boolean>;
  rollingBackSessionIds: Record<string, boolean>;
  /** True while a save point list or a dialog of the table is open; false when it unmounts. */
  onDialogOpenChange?: (open: boolean) => void;
}

interface SwitchRestore {
  node: SessionTreeNode;
  /** The config the dialog showed; a confirm restores on exactly this one. */
  config: ProfileProviderConfig;
}

export function PreviousSessionsTable({
  onRead,
  onRestore,
  onStartFromHere,
  onRollback,
  onDialogOpenChange,
  ...tableProps
}: PreviousSessionsTableProps) {
  const switchRestore = useConfirmDialog<SwitchRestore>();
  const [tableDialogOpen, setTableDialogOpen] = useState(false);
  const dialogOpen = switchRestore.isOpen || tableDialogOpen;
  useEffect(() => {
    onDialogOpenChange?.(dialogOpen);
    return () => onDialogOpenChange?.(false);
  }, [dialogOpen, onDialogOpenChange]);

  const request = switchRestore.target;
  return (
    <div className="mt-3">
      <SessionsTable
        {...tableProps}
        onRead={(node) => onRead(node.id)}
        onRestore={(node, config) =>
          config ? switchRestore.open({ node, config }) : onRestore(node.id)
        }
        onFork={(node, availability) => onStartFromHere(node.id, availability)}
        onRollback={(session, savePoint, keepCurrent) =>
          onRollback(session.id, savePoint.id, keepCurrent, sessionTreeLabel(savePoint))
        }
        onDialogOpenChange={setTableDialogOpen}
      >
        <p className="mb-1.5 text-xs font-medium text-muted-foreground">Previous sessions</p>
      </SessionsTable>
      <ConfirmDialog
        open={switchRestore.isOpen}
        onOpenChange={switchRestore.onOpenChange}
        onConfirm={() => request && onRestore(request.node.id, request.config.id)}
        title="Restore session?"
        confirmText="Restore"
        description={
          request
            ? switchRestoreWarning(
                request.node,
                request.config,
                tableProps.currentProviderName,
                tableProps.agentName,
              )
            : ''
        }
      />
    </div>
  );
}
