import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Activity, ChevronRight, Plus, Server, Unplug } from 'lucide-react';
import {
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from '../ui/context-menu';
import { Spinner } from '../ui/spinner';
import { useSelectedProject } from '../../hooks/useProjectSelection';
import { useRemotes } from '../../hooks/useRemotes';
import { projectActionHref } from '@/ui/pages/cloud/project-action-intent';
import {
  connectBlockedReason,
  createStatusContext,
  vmStatus,
} from '@/ui/pages/cloud/remote-status';

/**
 * The right-click items of the cloud indicator for the project selected in
 * the header. It only links to Cloud → Remote VMs, which runs the real next
 * step: the dock reads VMs and bindings, not operations, so it can lag.
 */
export function ProjectVmContextMenu() {
  const { selectedProject } = useSelectedProject();
  const { remotes, remotesLoading, bindings, bindingsLoading, bindingByProjectId } = useRemotes();
  // Destroyed VMs stay listed on the Cloud page, but Connect never offers them.
  const vms = useMemo(() => {
    const ctx = createStatusContext({ remotes, bindings, operations: [] });
    return remotes.flatMap((remote) => {
      const status = vmStatus(remote, ctx);
      return status.state === 'removed' ? [] : [{ remote, reason: connectBlockedReason(status) }];
    });
  }, [remotes, bindings]);

  if (!selectedProject) return <ContextMenuItem disabled>Select a project first</ContextMenuItem>;
  if (remotesLoading || bindingsLoading)
    return (
      <ContextMenuItem disabled>
        <Spinner className="mr-2 h-3.5 w-3.5" />
        Loading…
      </ContextMenuItem>
    );

  const projectId = selectedProject.id;
  const binding = bindingByProjectId.get(projectId);
  const vmName = (remoteId: string) =>
    remotes.find((remote) => remote.id === remoteId)?.name ?? remoteId;

  if (binding?.state === 'remote') {
    return (
      <ContextMenuItem asChild>
        <Link to={projectActionHref(projectId)}>
          <Unplug className="mr-2 h-3.5 w-3.5" />
          Disconnect from {vmName(binding.remoteId)}
        </Link>
      </ContextMenuItem>
    );
  }

  if (binding?.state === 'attaching' || binding?.state === 'detaching') {
    const vm = vmName(binding.remoteId);
    return (
      <>
        <ContextMenuItem disabled>
          <Spinner className="mr-2 h-3.5 w-3.5" />
          {binding.state === 'attaching' ? `Connecting to ${vm}…` : `Disconnecting from ${vm}…`}
        </ContextMenuItem>
        <ContextMenuItem asChild>
          <Link to={projectActionHref(projectId)}>
            <Activity className="mr-2 h-3.5 w-3.5" />
            View activity
          </Link>
        </ContextMenuItem>
      </>
    );
  }

  if (vms.length === 0) {
    return (
      <ContextMenuItem asChild>
        <Link to="/cloud?section=remote-vm&tab=vms">
          <Plus className="mr-2 h-3.5 w-3.5" />
          Add VM
        </Link>
      </ContextMenuItem>
    );
  }

  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger>
        <Server className="mr-2 h-3.5 w-3.5" />
        Connect to VM
        <ChevronRight className="ml-auto h-4 w-4" />
      </ContextMenuSubTrigger>
      <ContextMenuSubContent>
        {vms.map(({ remote, reason }) =>
          reason ? (
            <ContextMenuItem key={remote.id} disabled>
              <span className="max-w-[200px] truncate">{remote.name}</span>
              <span className="ml-2 text-muted-foreground">· {reason}</span>
            </ContextMenuItem>
          ) : (
            <ContextMenuItem key={remote.id} asChild>
              <Link to={projectActionHref(projectId, remote.id)}>
                <span className="max-w-[200px] truncate">{remote.name}</span>
              </Link>
            </ContextMenuItem>
          ),
        )}
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}
