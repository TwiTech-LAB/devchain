import { ConfirmDialog } from '@/ui/components/shared/ConfirmDialog';
import { CountBadge } from '@/ui/components/shared/CountBadge';
import { Badge } from '@/ui/components/ui/badge';
import { Button } from '@/ui/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui/components/ui/tabs';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/ui/components/ui/tooltip';
import { ActivityDialog } from './ActivityDialog';
import { AddOwnVmDialog } from './AddOwnVmDialog';
import { AddVmDialog } from './AddVmDialog';
import { ApiKeyDialog } from './ApiKeyDialog';
import { ChangeLoginsDialog } from './ChangeLoginsDialog';
import { ConnectDialog } from './ConnectDialog';
import { DisconnectProjectDialog } from './DisconnectProjectDialog';
import { FileSyncSettingsDialog } from './FileSyncSettingsDialog';
import { FirstRunChecklist } from './FirstRunChecklist';
import { FixFileSyncDialog } from './FixFileSyncDialog';
import { ForceSyncDialog } from './ForceSyncDialog';
import { GenerateLoginDialog } from './GenerateLoginDialog';
import { LoginsTab } from './LoginsTab';
import { NeedsAttention } from './NeedsAttention';
import { ProjectList, type ProjectListRow } from './ProjectList';
import { ProjectSummary } from './ProjectSummary';
import { ProxmoxConnectDialog } from './ProxmoxConnectDialog';
import { ProxmoxTab } from './ProxmoxTab';
import { ReauthDialog } from './ReauthDialog';
import { RemoteDeleteDialog } from './RemoteDeleteDialog';
import { RenameVmDialog } from './RenameVmDialog';
import { ResetVmDialog } from './ResetVmDialog';
import { VmDetailsDrawer } from './VmDetailsDrawer';
import { VmList } from './VmList';
import { VmSummary } from './VmSummary';
import type { RemoteVmSectionPresentation } from './remote-vm-section-presentation';

export function RemoteVmSectionView({
  presentation,
}: {
  presentation: RemoteVmSectionPresentation;
}) {
  const {
    tabs,
    operationsError,
    activityButton,
    overview,
    projects,
    projectActions,
    vms,
    logins,
    proxmox,
    dialogs,
  } = presentation;

  const renderProjectAction = (row: ProjectListRow) => {
    const projectAction = row.status.action;
    if (!projectAction) return null;
    const reason = projectAction.kind === 'connect' ? projectAction.disabledReason : null;
    const button = (
      <Button
        size="sm"
        variant={projectAction.kind === 'resolve' ? 'destructive' : 'outline'}
        disabled={reason !== null}
        onClick={() => projectActions.run(row, projectAction)}
      >
        {projectAction.label}
      </Button>
    );
    if (!reason) return button;
    // A disabled button gets no pointer events; the wrapper carries the tooltip.
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0} aria-label={`${projectAction.label}: ${reason}`}>
              {button}
            </span>
          </TooltipTrigger>
          <TooltipContent>{reason}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  };

  const renderProjectSettingsAction = (row: ProjectListRow) => (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        variant="ghost"
        disabled={row.status.state === 'busy'}
        onClick={() => projectActions.openSettings(row)}
      >
        File sync settings
      </Button>
      {projectActions.canFixFileSync(row) && (
        <Button
          size="sm"
          variant="outline"
          disabled={row.status.state === 'busy'}
          onClick={() => projectActions.fixFileSync(row)}
        >
          Fix file sync
        </Button>
      )}
      {row.status.operation?.kind === 'force_sync' && row.status.operation.state === 'failed' && (
        <Button size="sm" variant="destructive" onClick={() => projectActions.forceDisconnect(row)}>
          Force disconnect
        </Button>
      )}
      {renderProjectAction(row)}
    </div>
  );

  return (
    <div className="space-y-6">
      {dialogs.apiKey && (
        <ApiKeyDialog
          key={`${dialogs.apiKey.remoteId}:${dialogs.apiKey.mode}`}
          {...dialogs.apiKey}
        />
      )}
      {operationsError && (
        <p role="alert" className="text-sm text-destructive">
          Could not load operation progress: {operationsError.message}
        </p>
      )}

      <Tabs value={tabs.value} onValueChange={tabs.change}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <TabsList className="h-auto flex-wrap">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="projects">
              Projects
              <CountBadge count={tabs.counts.projects} />
            </TabsTrigger>
            <TabsTrigger value="vms">
              VMs
              <CountBadge count={tabs.counts.vms} />
            </TabsTrigger>
            <TabsTrigger value="logins">
              Logins
              <CountBadge count={tabs.counts.logins} />
            </TabsTrigger>
            <TabsTrigger value="proxmox">
              Proxmox
              <CountBadge count={tabs.counts.proxmox} />
            </TabsTrigger>
          </TabsList>
          <Button type="button" variant="outline" onClick={activityButton.open}>
            Activity
            {activityButton.count > 0 && (
              <Badge
                variant={activityButton.anyFailed ? 'destructive' : 'secondary'}
                className="ml-2"
              >
                {activityButton.count}
              </Badge>
            )}
          </Button>
        </div>

        <TabsContent value="overview" className="space-y-6">
          {overview.checklist && <FirstRunChecklist {...overview.checklist} />}
          <NeedsAttention {...overview.attention} />
          {overview.vmSummary && <VmSummary {...overview.vmSummary} />}
          {overview.projectSummary && <ProjectSummary {...overview.projectSummary} />}
        </TabsContent>
        <TabsContent value="projects">
          <ProjectList {...projects} renderAction={renderProjectSettingsAction} />
        </TabsContent>
        <TabsContent value="vms">
          <VmList {...vms} />
        </TabsContent>
        <TabsContent value="logins">
          <LoginsTab {...logins} />
        </TabsContent>
        <TabsContent value="proxmox">
          <ProxmoxTab {...proxmox} />
        </TabsContent>
      </Tabs>

      {dialogs.fileSyncSettings && (
        <FileSyncSettingsDialog
          key={dialogs.fileSyncSettings.projectId}
          {...dialogs.fileSyncSettings}
        />
      )}
      {dialogs.connect && <ConnectDialog {...dialogs.connect} />}
      {dialogs.disconnect && <DisconnectProjectDialog {...dialogs.disconnect} />}
      {dialogs.fixFileSync && (
        <FixFileSyncDialog key={dialogs.fixFileSync.projectId} {...dialogs.fixFileSync} />
      )}
      {dialogs.forceSync && (
        <ForceSyncDialog key={dialogs.forceSync.key} {...dialogs.forceSync.props} />
      )}
      {dialogs.ownVm && <AddOwnVmDialog {...dialogs.ownVm} />}
      {dialogs.changeLogins && <ChangeLoginsDialog {...dialogs.changeLogins} />}
      {dialogs.proxmoxConnect && <ProxmoxConnectDialog {...dialogs.proxmoxConnect} />}
      {dialogs.createVm && <AddVmDialog {...dialogs.createVm} />}
      {dialogs.resetVm && <ResetVmDialog {...dialogs.resetVm} />}
      {dialogs.reauth && <ReauthDialog {...dialogs.reauth} />}
      {dialogs.renameVm && <RenameVmDialog {...dialogs.renameVm} />}
      {dialogs.vmDetails && (
        <VmDetailsDrawer
          key={dialogs.vmDetails.remote.id}
          {...dialogs.vmDetails}
          renderProjectAction={renderProjectAction}
        />
      )}
      <ActivityDialog {...dialogs.activity} />
      {dialogs.loginAttach && <GenerateLoginDialog {...dialogs.loginAttach} />}
      <ConfirmDialog {...dialogs.docker} />
      {dialogs.deleteVm && <RemoteDeleteDialog {...dialogs.deleteVm} />}
    </div>
  );
}
