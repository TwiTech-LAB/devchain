import type {
  ProviderAuthEntryItem,
  ImportResult,
  ProviderAuthReleaseView,
  OpencodeLoginItem,
  ProviderAuthGenerationView,
  StartProviderAuthGenerationInput,
  ProjectFileSyncFailures,
  FileSyncAutoFix,
  ProjectIgnores,
  SaveProjectIgnoresResult,
  ProjectExclusionSuggestions,
  ProjectPatternPreview,
  SyncChownResult,
  ProjectFileSyncStatus,
  DockerPlanRequest,
  DockerPlan,
  DockerPresence,
  DockerSyncState,
  ConnectChoicesDto,
  AttachProjectRequest,
  AvailableSshPublicKey,
  ClaimRequestBody,
  CreateRemoteInput,
  CreateVmRequestBody,
  DetachProjectRequest,
  ForceSyncRequest,
  HomeIdentity,
  InstallHostRequestBody,
  LocalSshKey,
  ProbeResultDto,
  ProjectDiskEstimate,
  ProxmoxConnectedResult,
  ProxmoxFingerprintPreview,
  ProxmoxRightsCheck,
  ProxmoxSetupBlockFields,
  RemoteListItemDto,
  RemoteOperationDto,
  RemoteProjectBindingRow,
  RemoteReadinessDto,
  RemoteStatsHistoryDto,
  ResetVmRequestBody,
  RetryOperationRequest,
  UpdateLoginsRequestBody,
  VmProviderConnectionView,
} from './remote-vm-contracts';

export interface RemoteVmApi {
  listRemotes(signal: AbortSignal): Promise<RemoteListItemDto[]>;
  listBindings(signal: AbortSignal): Promise<RemoteProjectBindingRow[]>;
  createRemote(input: CreateRemoteInput): Promise<RemoteListItemDto>;
  deleteRemote(remoteId: string): Promise<void>;
  renameRemote(remoteId: string, name: string): Promise<RemoteListItemDto>;
  readReadiness(signal: AbortSignal): Promise<RemoteReadinessDto>;
  readStatsHistory(remoteId: string, signal: AbortSignal): Promise<RemoteStatsHistoryDto>;
  powerOn(remoteId: string): Promise<void>;
  setApiKey(remoteId: string, apiKey: string): Promise<void>;
  resetApiKey(remoteId: string): Promise<void>;
  listOperations(
    state: RemoteOperationDto['state'],
    limit: number,
    signal: AbortSignal,
  ): Promise<RemoteOperationDto[]>;
  readNewestOperation(projectId: string, signal: AbortSignal): Promise<RemoteOperationDto | null>;
  attachProject(remoteId: string, input: AttachProjectRequest): Promise<RemoteOperationDto>;
  detachProject(remoteId: string, input: DetachProjectRequest): Promise<RemoteOperationDto>;
  forceSync(remoteId: string, input: ForceSyncRequest): Promise<RemoteOperationDto>;
  updateHost(remoteId: string, input?: { installDocker: true }): Promise<RemoteOperationDto>;
  createVm(connectionId: string, input: CreateVmRequestBody): Promise<RemoteOperationDto>;
  installHost(input: InstallHostRequestBody): Promise<RemoteOperationDto>;
  resetVm(remoteId: string, input: ResetVmRequestBody): Promise<RemoteOperationDto>;
  destroyVm(remoteId: string, input: { force: boolean }): Promise<RemoteOperationDto>;
  updateLogins(remoteId: string, input: UpdateLoginsRequestBody): Promise<RemoteOperationDto>;
  claimHost(input: ClaimRequestBody): Promise<RemoteOperationDto>;
  retryOperation(operationId: string, input?: RetryOperationRequest): Promise<RemoteOperationDto>;
  cancelOperation(operationId: string): Promise<RemoteOperationDto>;
  probeAddress(
    address: string,
    options: { checkSsh: boolean; signal?: AbortSignal },
  ): Promise<ProbeResultDto>;
  readHomeIdentity(signal: AbortSignal): Promise<HomeIdentity>;
  listLocalSshKeys(): Promise<LocalSshKey[]>;
  listSshPublicKeys(signal: AbortSignal): Promise<AvailableSshPublicKey[]>;
  estimateProjectDisk(projectIds: string[]): Promise<ProjectDiskEstimate>;
  readHostInstallBlock(minDiskGib: number, signal: AbortSignal): Promise<string>;
  listVmProviders(signal: AbortSignal): Promise<VmProviderConnectionView[]>;
  checkVmProviderRights(connectionId: string): Promise<ProxmoxRightsCheck>;
  deleteVmProvider(connectionId: string): Promise<void>;
  readProxmoxSetupBlock(fields: ProxmoxSetupBlockFields): Promise<string>;
  previewProxmoxConnection(connectionString: string): Promise<ProxmoxFingerprintPreview>;
  connectProxmox(connectionString: string): Promise<ProxmoxConnectedResult>;
  countRunningAgents(remoteId: string, signal: AbortSignal): Promise<number>;
  listProviderAuthEntries(signal: AbortSignal): Promise<ProviderAuthEntryItem[]>;
  createStaticProviderAuth(input: Record<string, string>): Promise<ProviderAuthEntryItem>;
  importOpencodeLogins(providerIds: string[]): Promise<{ results: ImportResult[] }>;
  deleteProviderAuthEntry(entryId: string): Promise<void>;
  renameProviderAuthEntry(entryId: string, label: string): Promise<ProviderAuthEntryItem>;
  releaseProviderAuthEntry(entryId: string): Promise<ProviderAuthReleaseView>;
  listOpencodeLogins(signal: AbortSignal): Promise<OpencodeLoginItem[]>;
  readProviderAuthGeneration(
    generationId: string,
    signal: AbortSignal,
  ): Promise<ProviderAuthGenerationView>;
  startProviderAuthGeneration(
    input: StartProviderAuthGenerationInput,
  ): Promise<ProviderAuthGenerationView>;
  cancelProviderAuthGeneration(generationId: string): Promise<void>;
  readProjectFileSyncFailures(
    projectId: string,
    signal: AbortSignal,
  ): Promise<ProjectFileSyncFailures>;
  readFileSyncAutoFix(projectId: string, signal: AbortSignal): Promise<FileSyncAutoFix>;
  setFileSyncAutoFix(projectId: string, enabled: boolean): Promise<FileSyncAutoFix>;
  readProjectIgnores(projectId: string, signal: AbortSignal): Promise<ProjectIgnores>;
  saveProjectIgnores(
    projectId: string,
    ignores: string[] | null,
    revision: number,
  ): Promise<SaveProjectIgnoresResult>;
  readFileSyncSuggestions(
    projectId: string,
    remoteId: string,
    signal: AbortSignal,
  ): Promise<ProjectExclusionSuggestions>;
  previewFileSyncPattern(
    projectId: string,
    pattern: string,
    signal: AbortSignal,
  ): Promise<ProjectPatternPreview>;
  giveFileOwnership(projectId: string, paths: string[]): Promise<SyncChownResult>;
  readFileSyncStatus(projectId: string, signal: AbortSignal): Promise<ProjectFileSyncStatus>;
  readDockerPlan(
    projectId: string,
    input: DockerPlanRequest,
    signal: AbortSignal,
  ): Promise<DockerPlan>;
  readDockerPresence(projectId: string, signal: AbortSignal): Promise<DockerPresence>;
  readDockerSyncState(
    projectId: string,
    remoteId: string,
    signal: AbortSignal,
  ): Promise<DockerSyncState | null>;
  readConnectChoices(projectId: string, signal: AbortSignal): Promise<ConnectChoicesDto>;
}
