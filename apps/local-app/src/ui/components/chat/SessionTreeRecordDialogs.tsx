import { ConfirmDialog } from '@/ui/components/shared/ConfirmDialog';
import type { useSessionTreeRecordActions } from '@/ui/hooks/useSessionTreeRecordActions';
import { sessionTreeLabel } from './SessionTree';

export function SessionTreeDeleteDialog({
  dialog,
  onConfirm,
  onCloseAutoFocus,
}: {
  dialog: ReturnType<typeof useSessionTreeRecordActions>['deleteDialog'];
  onConfirm: () => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  return (
    <ConfirmDialog
      open={dialog.isOpen}
      onOpenChange={dialog.onOpenChange}
      onCloseAutoFocus={onCloseAutoFocus}
      onConfirm={onConfirm}
      title="Delete session record?"
      description={`This removes ${dialog.target ? sessionTreeLabel(dialog.target) : 'the record'} from DevChain. The transcript stays on disk.`}
      confirmText="Delete"
      variant="destructive"
    />
  );
}
