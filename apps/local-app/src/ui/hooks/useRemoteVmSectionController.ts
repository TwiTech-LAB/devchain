import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { ForceSyncOffer } from '@/modules/remotes/sync/remote-file-sync.dto';
import type { ForceSyncSource } from '@/modules/remotes/operations/remote-operation.dto';
import type { DockerCopyBackRequest } from '@/modules/remotes/docker/docker-copy-back.dto';
import type { RemoteListItemDto } from '@/modules/remotes/dtos/remote.dto';
import { useHomeQueryClient } from '@/ui/components/BackendBoundary';
import { runtimeInfoQueryKey } from './useRuntime';
import { useAllProjects, useWorkspaces } from './useAllProjects';
import { useProjectNewestOperations } from './useProjectNewestOperations';
import { useHomeIdentity } from './useHomeIdentity';
import { useProviderAuth } from './useProviderAuth';
import type {
  ProviderAuthGenerationView,
  ClaimRequestBody,
  InstallHostRequestBody,
  OperationAction,
  RemoteOperationDto,
  CreateRemoteInput,
  VmProviderConnectionView,
} from '@/ui/pages/cloud/lib/remote-vm-contracts';
import { useSelectedProject } from './useProjectSelection';
import { useRemoteReadiness } from './useRemoteReadiness';
import { useRemoteOperations } from './useRemoteOperations';
import { useRemotes } from './useRemotes';
import { useSubNavSearchParam } from './useSubNavSearchParam';
import { useVmPowerOn } from './useVmPowerOn';
import { useVmProviderConnections } from './useVmProviderConnections';
import { fetchRuntimeInfo } from '@/ui/lib/runtime';
import { getErrorMessage, useToastHelpers } from '@/ui/lib/toast-helpers';
import { useActivityView } from '@/ui/pages/cloud/ActivityDialog';
import type { ConnectRequest } from '@/ui/pages/cloud/ConnectDialog';
import type { CreateVmRequest } from '@/ui/pages/cloud/AddVmDialog';
import { addressHost } from '@/ui/pages/cloud/own-vm-address';
import type { ActivityActions } from '@/ui/pages/cloud/OperationDetail';
import type { ProjectListData, ProjectListRow } from '@/ui/pages/cloud/ProjectList';
import { useProjectActionIntent } from '@/ui/pages/cloud/project-action-intent';
import {
  POWER_ON_GRACE_MS,
  attentionItems,
  createStatusContext,
  canFixFileSync,
  projectStatus,
  vmReachable,
  vmStatus,
  type AttentionAction,
  type ProjectAction,
  type VmAction,
} from '@/ui/pages/cloud/remote-status';
import {
  removePurpose,
  vmMenuItems,
  vmWhere,
  type RemovePurpose,
  type VmMenuKey,
} from '@/ui/pages/cloud/VmList';
import type {
  RemoteVmSectionPresentation,
  RemoteVmTab,
} from '@/ui/pages/cloud/remote-vm-section-presentation';

const TAB_KEYS: RemoteVmTab[] = ['overview', 'projects', 'vms', 'logins', 'proxmox'];

export function useRemoteVmSectionController(): RemoteVmSectionPresentation {
  const {
    remotes,
    remotesLoading,
    bindings,
    bindingsLoading,
    bindingByProjectId,
    createRemote,
    deleteRemote,
    renameRemote,
  } = useRemotes();
  const {
    operations,
    recentFinished,
    action,
    loading: operationsLoading,
    error: operationsError,
    refresh,
  } = useRemoteOperations();
  const activity = useActivityView();
  const {
    projects: allProjects,
    truncated: projectsTruncated,
    loading: projectsLoading,
    error: projectsError,
  } = useAllProjects();
  const { workspaces } = useWorkspaces();
  const { activateProject } = useSelectedProject();
  const { entries: loginEntries } = useProviderAuth();
  const readiness = useRemoteReadiness();
  const homeIdentity = useHomeIdentity();
  const runtime = useQuery(
    { queryKey: runtimeInfoQueryKey, queryFn: fetchRuntimeInfo, staleTime: Infinity },
    useHomeQueryClient(),
  );
  const { powerOn, pending: powerOnPending, poweredOnAt } = useVmPowerOn();
  const navigate = useNavigate();
  const { showError } = useToastHelpers();
  const [tab, setTab] = useSubNavSearchParam([...TAB_KEYS], 'overview', 'tab');
  const [searchParams, setSearchParams] = useSearchParams();
  const viewedVmId = searchParams.get('vm');
  const {
    connections: providerConnections,
    loading: providerConnectionsLoading,
    error: providerConnectionsError,
  } = useVmProviderConnections();

  /** The refusal of the last start request; the open form shows it. */
  const [startError, setStartError] = useState<string | null>(null);
  /** The refusal of the last Retry or Cancel; the Activity detail shows it. */
  const [activityError, setActivityError] = useState<string | null>(null);
  /** Starts an operation: success opens its Activity detail, a refusal stays with the form. */
  const start = (input: OperationAction, onStarted: () => void = () => {}) => {
    setStartError(null);
    action.mutate(input, {
      onSuccess: (operation) => {
        onStarted();
        openActivityDetail(operation.id);
      },
      onError: (error) => setStartError(error.message),
    });
  };
  /** A start from a row button, which has no form to hold the error. */
  const startFromRow = (input: OperationAction) =>
    action.mutate(input, {
      onSuccess: (operation) => openActivityDetail(operation.id),
      onError: (error) => showError({ title: 'Could not start', description: error.message }),
    });
  /** Retry and Cancel keep the Activity view on the same operation. */
  const runInActivity = (input: OperationAction) => {
    setActivityError(null);
    action.mutate(input, { onError: (error) => setActivityError(error.message) });
  };
  const dismiss = (close: () => void) => () => {
    setStartError(null);
    close();
  };

  /** The open Connect flow: fixed to a project, or started from a VM. */
  const [connectTarget, setConnectTarget] = useState<{
    projectId?: string;
    remoteId?: string;
  } | null>(null);
  const [fixFileSyncProjectId, setFixFileSyncProjectId] = useState<string | null>(null);
  const [forceSyncTarget, setForceSyncTarget] = useState<{
    projectId: string;
    remoteId: string;
    remoteName: string;
    offer: ForceSyncOffer;
  } | null>(null);
  const closeForceSync = dismiss(() => setForceSyncTarget(null));
  const forceSync = (source: ForceSyncSource) => {
    if (forceSyncTarget)
      start(
        {
          action: 'forceSync',
          remoteId: forceSyncTarget.remoteId,
          projectId: forceSyncTarget.projectId,
          source,
        },
        closeForceSync,
      );
  };
  const [fileSyncProjectId, setFileSyncProjectId] = useState<string | null>(null);
  /** `remoteId` and `force` come from a stopped operation's recovery action. */
  const [disconnectTarget, setDisconnectTarget] = useState<{
    id: string;
    name: string;
    remoteId?: string;
    force?: boolean;
  } | null>(null);
  const disconnectBinding = disconnectTarget
    ? bindingByProjectId.get(disconnectTarget.id)
    : undefined;
  const disconnectRemoteId = disconnectTarget?.remoteId ?? disconnectBinding?.remoteId;
  const disconnectRemote = remotes.find((remote) => remote.id === disconnectRemoteId);
  const closeConnect = dismiss(() => setConnectTarget(null));
  const closeDisconnect = dismiss(() => setDisconnectTarget(null));
  // The dialog passes no selection rather than an empty one.
  const connect = ({ projectId, remoteId, docker }: ConnectRequest) =>
    start({ action: 'attach', remoteId, projectId, ...(docker ? { docker } : {}) }, closeConnect);
  const disconnect = (force: boolean, dockerCopyBack?: DockerCopyBackRequest) => {
    if (disconnectTarget && disconnectRemoteId)
      start(
        {
          action: 'detach',
          remoteId: disconnectRemoteId,
          projectId: disconnectTarget.id,
          force,
          ...(dockerCopyBack && { dockerCopyBack }),
        },
        closeDisconnect,
      );
  };

  const [deleteTarget, setDeleteTarget] = useState<{
    remote: RemoteListItemDto;
    purpose: RemovePurpose;
    initialDestroy?: boolean;
  } | null>(null);
  const [apiKeyTarget, setApiKeyTarget] = useState<{
    remote: RemoteListItemDto;
    mode: 'enter' | 'reset';
  } | null>(null);
  const [renameTarget, setRenameTarget] = useState<RemoteListItemDto | null>(null);
  const [proxmoxConnectOpen, setProxmoxConnectOpen] = useState(false);
  const [createVmTarget, setCreateVmTarget] = useState<{
    id: string;
    name: string;
    namePrefix: string;
  } | null>(null);
  const [resetTarget, setResetTarget] = useState<RemoteListItemDto | null>(null);
  const [dockerTarget, setDockerTarget] = useState<RemoteListItemDto | null>(null);
  /** The open Add your own VM flow; `address` comes from a VM row that is not set up. */
  const [ownVmTarget, setOwnVmTarget] = useState<{ address?: string } | null>(null);
  const [changeLoginsTarget, setChangeLoginsTarget] = useState<RemoteListItemDto | null>(null);
  const [reauthTarget, setReauthTarget] = useState<{
    operationId: string;
    providers: string[];
    remoteId: string | null;
  } | null>(null);
  const [loginAttach, setLoginAttach] = useState<ProviderAuthGenerationView | null>(null);

  const closeOwnVm = dismiss(() => setOwnVmTarget(null));
  const claim = (body: ClaimRequestBody) => start({ action: 'claim', body }, closeOwnVm);
  const installHost = (body: InstallHostRequestBody) =>
    start({ action: 'installHost', body }, closeOwnVm);
  // The server checks the new VM's health at once, so its row does not start as Offline.
  const addVm = (input: CreateRemoteInput) => {
    setStartError(null);
    createRemote.mutate(input, {
      onSuccess: closeOwnVm,
      onError: (error) => setStartError(getErrorMessage(error, 'Could not add the VM.')),
    });
  };
  // Re-authenticate retries the same operation, so the Activity view stays where it is.
  const reauth = (operationId: string, providerAuth: Record<string, string>) => {
    setStartError(null);
    action.mutate(
      { action: 'retry', operationId, providerAuth },
      {
        onSuccess: () => setReauthTarget(null),
        onError: (error) => setStartError(error.message),
      },
    );
  };
  const changeLogins = (remoteId: string, providerAuth: Record<string, string>, force: boolean) => {
    // A failed preflight stays cancellable, and the server refuses a new
    // attempt while it stays open — so cancel it before sending, forced or not.
    const failedOpen = operations.find(
      (operation) =>
        operation.remoteId === remoteId &&
        operation.kind === 'update_logins' &&
        operation.state === 'failed',
    );
    const send = () =>
      start({ action: 'updateLogins', remoteId, body: { providerAuth, force } }, () =>
        setChangeLoginsTarget(null),
      );
    if (failedOpen) {
      setStartError(null);
      action.mutate(
        { action: 'cancel', operationId: failedOpen.id },
        { onSuccess: send, onError: (error) => setStartError(error.message) },
      );
    } else {
      send();
    }
  };
  const createVm = (body: CreateVmRequest) => {
    if (!createVmTarget) return;
    start({ action: 'createVm', connectionId: createVmTarget.id, body }, () =>
      setCreateVmTarget(null),
    );
  };
  const resetVm = (force: boolean) => {
    if (!resetTarget) return;
    start({ action: 'resetVm', remoteId: resetTarget.id, body: { force, providerAuth: {} } }, () =>
      setResetTarget(null),
    );
  };
  const destroyVm = (force: boolean) => {
    if (!deleteTarget) return;
    start({ action: 'destroyVm', remoteId: deleteTarget.remote.id, body: { force } }, () =>
      setDeleteTarget(null),
    );
  };

  // The page re-renders when a Power on's "Starting" period ends.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const ends = [...poweredOnAt.values()]
      .map((startedAt) => startedAt + POWER_ON_GRACE_MS)
      .filter((end) => end > Date.now());
    if (ends.length === 0) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(...ends) - Date.now() + 50);
    return () => clearTimeout(timer);
  }, [poweredOnAt, now]);
  useEffect(() => setNow(Date.now()), [poweredOnAt]);

  const projectNames = useMemo(
    () => new Map(allProjects.map((project) => [project.id, project.name] as const)),
    [allProjects],
  );
  // Only a failed or stuck binding needs its project's newest operation: the
  // cleanup error of a cancelled Connect, or the operation that View opens.
  const projectsNeedingNewest = useMemo(
    () =>
      bindings
        .filter((binding) => binding.state !== 'remote')
        .map((binding) => binding.projectId)
        .sort(),
    [bindings],
  );
  const newestProjectOperations = useProjectNewestOperations(projectsNeedingNewest);
  const statusContext = useMemo(
    () =>
      createStatusContext({
        remotes,
        bindings,
        operations,
        projectNames,
        newestProjectOperations,
        poweredOnAt,
        now,
      }),
    [remotes, bindings, operations, projectNames, newestProjectOperations, poweredOnAt, now],
  );
  const statuses = useMemo(
    () => new Map(remotes.map((remote) => [remote.id, vmStatus(remote, statusContext)] as const)),
    [remotes, statusContext],
  );
  const attention = useMemo(
    () =>
      attentionItems(statusContext, {
        syncthing: readiness.readiness?.syncthing ?? null,
        version: runtime.data?.version ?? null,
        homePath: homeIdentity?.homePath ?? null,
      }),
    [statusContext, readiness.readiness, runtime.data, homeIdentity],
  );
  // An open failed create or reset reserves its VM, so no newer operation can hide it.
  const failedVmOperations = useMemo(
    () =>
      new Set(
        operations
          .filter(
            (operation) =>
              operation.state === 'failed' &&
              (operation.kind === 'create_vm' || operation.kind === 'reset_vm'),
          )
          .map((operation) => operation.remoteId),
      ),
    [operations],
  );
  const projectCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const binding of bindings) {
      counts.set(binding.remoteId, (counts.get(binding.remoteId) ?? 0) + 1);
    }
    return counts;
  }, [bindings]);
  const connectionNames = useMemo(
    () => new Map(providerConnections.map((connection) => [connection.id, connection.name])),
    [providerConnections],
  );
  const remoteNameById = useMemo(
    () => new Map(remotes.map((remote) => [remote.id, remote.name])),
    [remotes],
  );
  const activityNames = useMemo(
    () => ({ remotes: remoteNameById, projects: projectNames }),
    [remoteNameById, projectNames],
  );
  const anyVmReady = [...statuses.values()].some((status) => status.state === 'ready');
  // Bindings must settle before the summary may show: with a VM but no binding
  // the checklist owns Overview, and the summary must not flash before it.
  const overviewLoaded = !remotesLoading && !bindingsLoading;
  const showChecklist = overviewLoaded && bindings.length === 0;
  const projectRows = useMemo<ProjectListRow[]>(
    () =>
      allProjects.map((project) => {
        const binding = bindingByProjectId.get(project.id);
        return {
          project,
          status: projectStatus(project.id, statusContext),
          // A failed binding means the project stayed on this PC.
          onVm: binding !== undefined && binding.state !== 'failed',
        };
      }),
    [allProjects, bindingByProjectId, statusContext],
  );
  const projectData: ProjectListData = {
    rows: projectRows,
    workspaces,
    loading: projectsLoading,
    error: projectsError,
    truncated: projectsTruncated,
  };
  const settingsRow = projectRows.find((row) => row.project.id === fileSyncProjectId);
  /** The projects bound to a VM, for the dialogs that list what a change affects. */
  const boundProjects = (remoteId: string) =>
    (statusContext.bindingsByRemote.get(remoteId) ?? []).map((binding) => ({
      id: binding.projectId,
      name: projectNames.get(binding.projectId) ?? binding.projectId,
    }));

  const openForceSync = (offer: ForceSyncOffer) => {
    if (!fixFileSyncProjectId) return;
    const binding = bindingByProjectId.get(fixFileSyncProjectId);
    if (!binding) return;
    setStartError(null);
    setForceSyncTarget({
      projectId: fixFileSyncProjectId,
      remoteId: binding.remoteId,
      remoteName: remoteNameById.get(binding.remoteId) ?? binding.remoteId,
      offer,
    });
    setFixFileSyncProjectId(null);
    setDisconnectTarget(null);
  };

  const openActivityList = () => {
    setActivityError(null);
    activity.openList();
  };
  const openActivityDetail = (operationId: string) => {
    setActivityError(null);
    activity.openDetail(operationId);
  };
  /** Opens the VM's details drawer through the URL, so a reload keeps it open. */
  const viewVm = (remoteId: string) => {
    const next = new URLSearchParams(searchParams);
    next.set('vm', remoteId);
    setSearchParams(next);
  };
  /** Overview's read-only links: one write of both keys, so neither can clobber the other. */
  const viewVmOnVmsTab = (remoteId: string) => {
    const next = new URLSearchParams(searchParams);
    next.set('tab', 'vms');
    next.set('vm', remoteId);
    setSearchParams(next);
  };
  const closeVmDrawer = () => {
    const next = new URLSearchParams(searchParams);
    next.delete('vm');
    setSearchParams(next);
  };
  const viewedRemote = remotes.find((remote) => remote.id === viewedVmId);
  const viewedStatus = viewedRemote ? statuses.get(viewedRemote.id) : undefined;
  const viewedProjects = useMemo(() => {
    const bound = new Set(
      bindings
        .filter((binding) => binding.remoteId === viewedVmId)
        .map((binding) => binding.projectId),
    );
    return projectRows.filter((row) => bound.has(row.project.id));
  }, [bindings, projectRows, viewedVmId]);
  const openRemove = (remote: RemoteListItemDto, initialDestroy = false) => {
    const status = statuses.get(remote.id);
    if (!status) return;
    setDeleteTarget({
      remote,
      purpose: removePurpose(remote, status, failedVmOperations.has(remote.id)),
      initialDestroy,
    });
  };
  const updateVm = (remoteId: string) => startFromRow({ action: 'updateHost', remoteId });
  const clearActivityError = useCallback(() => setActivityError(null), []);
  useProjectActionIntent({
    loaded: !remotesLoading && !bindingsLoading && !projectsLoading && !operationsLoading,
    rows: projectRows,
    onConnect: setConnectTarget,
    onDisconnect: setDisconnectTarget,
    onOpenActivity: clearActivityError,
  });
  const onProjectAction = (row: ProjectListRow, projectAction: ProjectAction) => {
    const target = { id: row.project.id, name: row.project.name };
    switch (projectAction.kind) {
      case 'connect':
        return setConnectTarget({ projectId: target.id });
      case 'disconnect':
        return setDisconnectTarget(target);
      case 'view':
      case 'resolve':
        return projectAction.operationId
          ? openActivityDetail(projectAction.operationId)
          : openActivityList();
    }
  };
  const onVmAction = (remote: RemoteListItemDto, vmAction: VmAction) => {
    switch (vmAction.kind) {
      case 'enter-api-key':
        return setApiKeyTarget({ remote, mode: 'enter' });
      case 'remove':
        return openRemove(remote);
      case 'open-activity':
      case 'resolve':
        return openActivityDetail(vmAction.operationId);
      case 'set-up':
        return setOwnVmTarget({ address: addressHost(remote.baseUrl ?? '') ?? undefined });
      case 'power-on':
        return void powerOn(remote);
      case 'update':
        return updateVm(remote.id);
    }
  };
  const onVmMenu = (remote: RemoteListItemDto, key: VmMenuKey) => {
    switch (key) {
      case 'enter-api-key':
        return setApiKeyTarget({ remote, mode: 'enter' });
      case 'reset-api-key':
        return setApiKeyTarget({ remote, mode: 'reset' });
      case 'connect-project':
        return setConnectTarget({ remoteId: remote.id });
      case 'change-logins':
        return setChangeLoginsTarget(remote);
      // Installing Docker restarts DevChain on the VM, so it asks first.
      case 'install-docker':
        return setDockerTarget(remote);
      case 'update':
        return updateVm(remote.id);
      case 'power-on':
        return void powerOn(remote);
      case 'rename':
        return setRenameTarget(remote);
      case 'view':
        return viewVm(remote.id);
      case 'reset':
        return setResetTarget(remote);
      case 'remove':
        return openRemove(remote);
      case 'destroy':
        return openRemove(remote, true);
    }
  };
  const onAttentionAction = (attentionAction: AttentionAction) => {
    switch (attentionAction.kind) {
      case 'fix-file-sync':
        return setFixFileSyncProjectId(attentionAction.projectId);
      case 'enter-api-key': {
        const remote = remotes.find((item) => item.id === attentionAction.remoteId);
        if (remote) setApiKeyTarget({ remote, mode: 'enter' });
        return;
      }
      case 'open-activity':
        return openActivityDetail(attentionAction.operationId);
      case 'view-vm':
        return viewVmOnVmsTab(attentionAction.remoteId);
    }
  };

  // Recovery flows close Activity first; their own start opens it again.
  const openRecoveryDisconnect = (operation: RemoteOperationDto, force: boolean) => {
    if (!operation.projectId) return;
    activity.close();
    setDisconnectTarget({
      id: operation.projectId,
      name: projectNames.get(operation.projectId) ?? operation.projectId,
      remoteId: operation.remoteId,
      force,
    });
  };
  const activityActions: ActivityActions = {
    retry: (operation, ssh) =>
      runInActivity({ action: 'retry', operationId: operation.id, ...(ssh ? { ssh } : {}) }),
    cancel: (operation) => runInActivity({ action: 'cancel', operationId: operation.id }),
    reauth: (operation, providers) =>
      setReauthTarget({
        operationId: operation.id,
        providers,
        remoteId: operation.remoteId ?? null,
      }),
    openLogin: setLoginAttach,
    disconnectInstead: (operation) => openRecoveryDisconnect(operation, false),
    forceDisconnect: (operation) => openRecoveryDisconnect(operation, true),
    connectProject: (remoteId) => {
      activity.close();
      setConnectTarget({ remoteId });
    },
    openChat: (projectId) => {
      const project = allProjects.find((candidate) => candidate.id === projectId);
      if (!project) return;
      activity.close();
      activateProject(project);
      navigate('/chat');
    },
  };
  const openCount = statusContext.open.length;
  const anyFailed = statusContext.open.some((operation) => operation.state === 'failed');
  const openProxmoxCreate = (connection: VmProviderConnectionView) =>
    setCreateVmTarget({
      id: connection.id,
      name: connection.name,
      namePrefix: connection.namePrefix,
    });
  const addOwnVm = () => setOwnVmTarget({});

  const openVms = () => setTab('vms');
  const openProxmoxConnect = () => setProxmoxConnectOpen(true);
  const renameAndClose = async (name: string) => {
    if (!renameTarget) return;
    await renameRemote.mutateAsync({ id: renameTarget.id, name });
    setRenameTarget(null);
  };
  const renameViewedVm = async (name: string) => {
    if (!viewedRemote) return;
    await renameRemote.mutateAsync({ id: viewedRemote.id, name });
  };
  const createOnConnectedServer = (connection: VmProviderConnectionView) => {
    setProxmoxConnectOpen(false);
    setTab('vms');
    openProxmoxCreate(connection);
  };
  const installDocker = () => {
    if (dockerTarget) {
      startFromRow({ action: 'updateHost', remoteId: dockerTarget.id, installDocker: true });
    }
    setDockerTarget(null);
  };
  const removeVm = () => {
    if (!deleteTarget) return;
    deleteRemote.mutate(
      { id: deleteTarget.remote.id, name: deleteTarget.remote.name },
      { onSuccess: refresh },
    );
  };

  return {
    tabs: {
      value: tab,
      change: (value) => setTab(value as RemoteVmTab),
      counts: {
        projects: projectData.rows.length,
        vms: remotes.length,
        logins: loginEntries.length,
        proxmox: providerConnections.length,
      },
    },
    operationsError,
    activityButton: { open: openActivityList, count: openCount, anyFailed },
    overview: {
      checklist: showChecklist
        ? {
            readiness: readiness.readiness,
            checking: readiness.checking,
            error: readiness.error,
            vmExists: remotes.length > 0,
            anyVmReady,
            onCheckAgain: readiness.checkAgain,
            onGoToVms: openVms,
            onConnect: () => setConnectTarget({}),
          }
        : null,
      attention: { items: attention, onAction: onAttentionAction },
      vmSummary:
        overviewLoaded && !showChecklist && remotes.length > 0
          ? {
              remotes,
              statuses,
              onOpenVm: viewVmOnVmsTab,
              onManageVms: openVms,
            }
          : null,
      projectSummary:
        overviewLoaded && !showChecklist && projectRows.some((row) => row.onVm)
          ? {
              rows: projectRows,
              remoteNames: remoteNameById,
              onOpenVm: viewVmOnVmsTab,
              onManageProjects: () => setTab('projects'),
            }
          : null,
    },
    projects: projectData,
    projectActions: {
      run: onProjectAction,
      openSettings: (row) => setFileSyncProjectId(row.project.id),
      fixFileSync: (row) => setFixFileSyncProjectId(row.project.id),
      forceDisconnect: (row) =>
        setDisconnectTarget({
          id: row.project.id,
          name: row.project.name,
          remoteId: row.status.remoteId ?? undefined,
          force: true,
        }),
      canFixFileSync: (row) => canFixFileSync(bindingByProjectId.get(row.project.id)),
    },
    vms: {
      remotes,
      loading: remotesLoading,
      statuses,
      failedVmOperations,
      connectionNames,
      projectCounts,
      highlightedId: viewedVmId,
      pendingPowerOn: powerOnPending,
      connections: providerConnections,
      actionPending: action.isPending,
      onCreateOnServer: openProxmoxCreate,
      onAddOwnVm: addOwnVm,
      onConnectServer: openProxmoxConnect,
      onAction: onVmAction,
      onMenu: onVmMenu,
      onOpenActivity: openActivityDetail,
      onView: (remote) => viewVm(remote.id),
    },
    logins: { remotes },
    proxmox: {
      connections: providerConnections,
      loading: providerConnectionsLoading,
      error: providerConnectionsError,
      remotes,
      onOpenVms: openVms,
      onConnect: openProxmoxConnect,
    },
    dialogs: {
      apiKey: apiKeyTarget
        ? {
            remoteId: apiKeyTarget.remote.id,
            name: apiKeyTarget.remote.name,
            mode: apiKeyTarget.mode,
            onClose: () => setApiKeyTarget(null),
          }
        : null,
      fileSyncSettings: settingsRow
        ? {
            projectId: settingsRow.project.id,
            projectName: settingsRow.project.name,
            connected: bindingByProjectId.get(settingsRow.project.id)?.state === 'remote',
            busy: settingsRow.status.state === 'busy',
            onClose: () => setFileSyncProjectId(null),
          }
        : null,
      connect: connectTarget
        ? {
            initialProjectId: connectTarget.projectId,
            initialRemoteId: connectTarget.remoteId,
            remotes,
            statuses,
            projects: projectData,
            pending: action.isPending,
            error: startError,
            onClose: closeConnect,
            onUpdateVm: (remoteId) => {
              closeConnect();
              updateVm(remoteId);
            },
            onConnect: connect,
          }
        : null,
      disconnect:
        disconnectTarget && disconnectRemoteId
          ? {
              projectId: disconnectTarget.id,
              projectName: disconnectTarget.name,
              remoteId: disconnectRemoteId,
              remoteName: disconnectRemote?.name ?? disconnectRemoteId,
              offline: disconnectRemote !== undefined && !vmReachable(disconnectRemote),
              force: disconnectTarget.force,
              hostCursor: disconnectBinding?.hostCursor,
              pending: action.isPending,
              error: startError,
              onClose: closeDisconnect,
              onDisconnect: disconnect,
              onFixFileSync: () => setFixFileSyncProjectId(disconnectTarget.id),
            }
          : null,
      fixFileSync: fixFileSyncProjectId
        ? {
            projectId: fixFileSyncProjectId,
            projectName: projectNames.get(fixFileSyncProjectId) ?? fixFileSyncProjectId,
            warning: bindingByProjectId.get(fixFileSyncProjectId)?.fileSyncWarning,
            onForceSync: openForceSync,
            onClose: () => setFixFileSyncProjectId(null),
            onEditSettings: () => {
              setFileSyncProjectId(fixFileSyncProjectId);
              setFixFileSyncProjectId(null);
            },
          }
        : null,
      forceSync: forceSyncTarget
        ? {
            key: forceSyncTarget.projectId,
            props: {
              projectName: projectNames.get(forceSyncTarget.projectId) ?? forceSyncTarget.projectId,
              remoteName: forceSyncTarget.remoteName,
              offer: forceSyncTarget.offer,
              pending: action.isPending,
              error: startError,
              onClose: closeForceSync,
              onForceSync: forceSync,
            },
          }
        : null,
      ownVm: ownVmTarget
        ? {
            initialAddress: ownVmTarget.address,
            remotes,
            operations,
            projects: projectData,
            pending: action.isPending || createRemote.isPending,
            error: startError,
            onClose: closeOwnVm,
            onAddVm: addVm,
            onClaim: claim,
            onInstall: installHost,
            onOpenActivity: (operationId) => {
              closeOwnVm();
              openActivityDetail(operationId);
            },
            onViewVm: (remoteId) => {
              closeOwnVm();
              viewVm(remoteId);
            },
          }
        : null,
      changeLogins: changeLoginsTarget
        ? {
            remote: changeLoginsTarget,
            remoteNames: remoteNameById,
            pending: action.isPending,
            error: startError,
            onClose: dismiss(() => setChangeLoginsTarget(null)),
            onChangeLogins: (providerAuth, force) =>
              changeLogins(changeLoginsTarget.id, providerAuth, force),
          }
        : null,
      proxmoxConnect: proxmoxConnectOpen
        ? {
            onClose: () => setProxmoxConnectOpen(false),
            onAddVm: createOnConnectedServer,
          }
        : null,
      createVm: createVmTarget
        ? {
            connectionName: createVmTarget.name,
            namePrefix: createVmTarget.namePrefix,
            remoteNames: remoteNameById,
            pending: action.isPending,
            error: startError,
            onClose: dismiss(() => setCreateVmTarget(null)),
            onCreate: createVm,
          }
        : null,
      resetVm: resetTarget
        ? {
            remote: resetTarget,
            projects: boundProjects(resetTarget.id),
            pending: action.isPending,
            error: startError,
            onClose: dismiss(() => setResetTarget(null)),
            onReset: resetVm,
          }
        : null,
      reauth: reauthTarget
        ? {
            operationId: reauthTarget.operationId,
            providers: reauthTarget.providers,
            remoteId: reauthTarget.remoteId,
            remoteNames: remoteNameById,
            pending: action.isPending,
            error: startError,
            onClose: dismiss(() => setReauthTarget(null)),
            onRetry: reauth,
          }
        : null,
      renameVm: renameTarget
        ? {
            currentName: renameTarget.name,
            pending: renameRemote.isPending,
            onClose: () => setRenameTarget(null),
            onRename: renameAndClose,
          }
        : null,
      vmDetails:
        viewedRemote && viewedStatus
          ? {
              remote: viewedRemote,
              status: viewedStatus,
              where: vmWhere(viewedRemote, connectionNames),
              menu: vmMenuItems(
                viewedRemote,
                viewedStatus,
                failedVmOperations.has(viewedRemote.id),
              ),
              projects: viewedProjects,
              operations,
              recentFinished,
              names: activityNames,
              loginEntries,
              powerOnPending: powerOnPending.has(viewedRemote.id),
              onClose: closeVmDrawer,
              onAction: (vmAction) => onVmAction(viewedRemote, vmAction),
              onMenu: (key) => onVmMenu(viewedRemote, key),
              onRename: renameViewedVm,
              onOpenActivity: openActivityDetail,
              onConnectProject: () => setConnectTarget({ remoteId: viewedRemote.id }),
            }
          : null,
      activity: {
        view: activity.view,
        operations,
        recentFinished,
        names: activityNames,
        pending: action.isPending,
        error: activityError,
        actions: activityActions,
        onOpenList: openActivityList,
        onOpenDetail: openActivityDetail,
        onClose: activity.close,
      },
      loginAttach: loginAttach
        ? {
            provider: loginAttach.provider,
            attach: loginAttach,
            onClose: () => setLoginAttach(null),
          }
        : null,
      docker: {
        open: dockerTarget !== null,
        onOpenChange: (open) => {
          if (!open) setDockerTarget(null);
        },
        onConfirm: installDocker,
        title: `Install Docker on ${dockerTarget?.name ?? 'this VM'}?`,
        description:
          'Installing Docker restarts DevChain on this VM. Agent sessions that run there stop and must be started again.',
        confirmText: 'Install Docker',
      },
      deleteVm: deleteTarget
        ? {
            remote: deleteTarget.remote,
            purpose: deleteTarget.purpose,
            initialDestroy: deleteTarget.initialDestroy,
            projects: boundProjects(deleteTarget.remote.id),
            bindingsLoading,
            pending: deleteRemote.isPending || action.isPending,
            error: startError,
            onClose: dismiss(() => setDeleteTarget(null)),
            onDestroy: destroyVm,
            onDelete: removeVm,
          }
        : null,
    },
  };
}
