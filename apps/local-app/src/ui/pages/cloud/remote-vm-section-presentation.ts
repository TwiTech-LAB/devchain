import type { ComponentProps } from 'react';
import type { ConfirmDialog } from '@/ui/components/shared/ConfirmDialog';
import type { ActivityDialog } from './ActivityDialog';
import type { AddOwnVmDialog } from './AddOwnVmDialog';
import type { AddVmDialog } from './AddVmDialog';
import type { ApiKeyDialog } from './ApiKeyDialog';
import type { ChangeLoginsDialog } from './ChangeLoginsDialog';
import type { ConnectDialog } from './ConnectDialog';
import type { DisconnectProjectDialog } from './DisconnectProjectDialog';
import type { FileSyncSettingsDialog } from './FileSyncSettingsDialog';
import type { FirstRunChecklist } from './FirstRunChecklist';
import type { FixFileSyncDialog } from './FixFileSyncDialog';
import type { ForceSyncDialog } from './ForceSyncDialog';
import type { GenerateLoginDialog } from './GenerateLoginDialog';
import type { LoginsTab } from './LoginsTab';
import type { NeedsAttention } from './NeedsAttention';
import type { ProjectListData, ProjectListRow } from './ProjectList';
import type { ProjectSummary } from './ProjectSummary';
import type { ProxmoxConnectDialog } from './ProxmoxConnectDialog';
import type { ProxmoxTab } from './ProxmoxTab';
import type { ReauthDialog } from './ReauthDialog';
import type { RemoteDeleteDialog } from './RemoteDeleteDialog';
import type { RenameVmDialog } from './RenameVmDialog';
import type { ResetVmDialog } from './ResetVmDialog';
import type { ProjectAction } from './remote-status';
import type { VmDetailsDrawer } from './VmDetailsDrawer';
import type { VmList } from './VmList';
import type { VmSummary } from './VmSummary';

export type RemoteVmTab = 'overview' | 'projects' | 'vms' | 'logins' | 'proxmox';

export interface RemoteVmSectionPresentation {
  readonly tabs: {
    readonly value: RemoteVmTab;
    readonly change: (value: string) => void;
    readonly counts: { projects: number; vms: number; logins: number; proxmox: number };
  };
  readonly operationsError: { readonly message: string } | null;
  readonly activityButton: {
    readonly open: () => void;
    readonly count: number;
    readonly anyFailed: boolean;
  };
  readonly overview: {
    readonly checklist: ComponentProps<typeof FirstRunChecklist> | null;
    readonly attention: ComponentProps<typeof NeedsAttention>;
    readonly vmSummary: ComponentProps<typeof VmSummary> | null;
    readonly projectSummary: ComponentProps<typeof ProjectSummary> | null;
  };
  readonly projects: ProjectListData;
  readonly projectActions: {
    readonly run: (row: ProjectListRow, action: ProjectAction) => void;
    readonly openSettings: (row: ProjectListRow) => void;
    readonly fixFileSync: (row: ProjectListRow) => void;
    readonly forceDisconnect: (row: ProjectListRow) => void;
    readonly canFixFileSync: (row: ProjectListRow) => boolean;
  };
  readonly vms: ComponentProps<typeof VmList>;
  readonly logins: ComponentProps<typeof LoginsTab>;
  readonly proxmox: ComponentProps<typeof ProxmoxTab>;
  readonly dialogs: {
    readonly apiKey: ComponentProps<typeof ApiKeyDialog> | null;
    readonly fileSyncSettings: ComponentProps<typeof FileSyncSettingsDialog> | null;
    readonly connect: ComponentProps<typeof ConnectDialog> | null;
    readonly disconnect: ComponentProps<typeof DisconnectProjectDialog> | null;
    readonly fixFileSync: ComponentProps<typeof FixFileSyncDialog> | null;
    readonly forceSync: {
      readonly key: string;
      readonly props: ComponentProps<typeof ForceSyncDialog>;
    } | null;
    readonly ownVm: ComponentProps<typeof AddOwnVmDialog> | null;
    readonly changeLogins: ComponentProps<typeof ChangeLoginsDialog> | null;
    readonly proxmoxConnect: ComponentProps<typeof ProxmoxConnectDialog> | null;
    readonly createVm: ComponentProps<typeof AddVmDialog> | null;
    readonly resetVm: ComponentProps<typeof ResetVmDialog> | null;
    readonly reauth: ComponentProps<typeof ReauthDialog> | null;
    readonly renameVm: ComponentProps<typeof RenameVmDialog> | null;
    readonly vmDetails: Omit<ComponentProps<typeof VmDetailsDrawer>, 'renderProjectAction'> | null;
    readonly activity: ComponentProps<typeof ActivityDialog>;
    readonly loginAttach: ComponentProps<typeof GenerateLoginDialog> | null;
    readonly docker: ComponentProps<typeof ConfirmDialog>;
    readonly deleteVm: ComponentProps<typeof RemoteDeleteDialog> | null;
  };
}
