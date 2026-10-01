import type { RemoteListItemDto } from '@/modules/remotes/dtos/remote.dto';
import { Button } from '@/ui/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/components/ui/card';
import type { VmStatus } from './remote-status';
import { StatusChip } from './StatusChip';
import { VM_NAME_BUTTON_CLASS } from './VmList';

/**
 * Overview's read-only VM summary: one line per VM. The VMs tab owns every
 * action; a line only opens that VM's drawer there.
 */
export function VmSummary({
  remotes,
  statuses,
  onOpenVm,
  onManageVms,
}: {
  remotes: readonly RemoteListItemDto[];
  statuses: ReadonlyMap<string, VmStatus>;
  onOpenVm: (remoteId: string) => void;
  onManageVms: () => void;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0 pb-3">
        <CardTitle className="text-base">VMs</CardTitle>
        <Button size="sm" variant="outline" onClick={onManageVms}>
          Manage VMs
        </Button>
      </CardHeader>
      <CardContent>
        <ul aria-label="VMs" className="divide-y rounded-md border">
          {remotes.map((remote) => {
            const status = statuses.get(remote.id);
            return (
              <li
                key={remote.id}
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
              >
                <button
                  type="button"
                  onClick={() => onOpenVm(remote.id)}
                  className={VM_NAME_BUTTON_CLASS}
                >
                  {remote.name}
                </button>
                {status && <StatusChip tone={status.tone}>{status.label}</StatusChip>}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
