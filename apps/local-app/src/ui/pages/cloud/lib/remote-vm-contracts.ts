import type {
  OpencodeLoginDto,
  PerProviderIdImportResult,
  ProviderAuthEntryDto,
} from '@/modules/provider-auth/provider-auth.dto';
import type { ProviderAuthGeneration } from '@/modules/provider-auth/provider-auth-generator.service';
import type { ForceSyncSource } from '@/modules/remotes/operations/remote-operation.dto';
import type { DockerSelection } from '@/modules/remotes/docker/docker-plan.dto';
import type { DockerCopyBackRequest } from '@/modules/remotes/docker/docker-copy-back.dto';
import type { ConnectProxmoxResult } from '@/modules/vm-providers/vm-providers.service';

export type { RemoteListItemDto, RemoteStatsHistoryDto } from '@/modules/remotes/dtos/remote.dto';
export type { ProbeResultDto, RemoteReadinessDto } from '@/modules/remotes/dtos/remote-probe.dto';
export type { RemoteProjectBindingRow } from '@/ui/lib/backend-provider';
export type { AvailableSshPublicKey } from '@/modules/remotes/host-install/ssh-key.service';

export interface CreateRemoteInput {
  name: string;
  baseUrl: string;
  apiKey?: string;
  /** Read on the VM; the certificate at `baseUrl` must match it. */
  certificateFingerprint: string;
}

export interface RemoteOperationDto {
  id: string;
  kind: string;
  remoteId: string;
  projectId: string | null;
  state: 'running' | 'failed' | 'done' | 'cancelled';
  steps: {
    id: string;
    label: string;
    state: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
    startedAt?: string | null;
    error: { message: string; code: string | null } | null;
  }[];
  details: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ClaimRequestBody {
  remoteId?: string;
  baseUrl?: string;
  /** Read on the VM; required with `baseUrl`. */
  certificateFingerprint?: string;
  name?: string;
  port?: number;
  /** `reuse:<entryId>`, `generate` or `skip`, per provider. */
  providerAuth: Record<string, string>;
  installDocker?: boolean;
  sshPublicKeys?: string[];
}

export interface SshCredentials {
  user: string;
  password?: string;
  privateKey?: string;
  keyName?: string;
  passphrase?: string;
  sudoPassword?: string;
}

export interface InstallHostRequestBody {
  address: string;
  ssh: SshCredentials;
  name?: string;
  providerAuth: Record<string, string>;
  installDocker?: boolean;
  sshPublicKeys?: string[];
  minDiskGib: number;
}

export interface ResetVmRequestBody {
  force: boolean;
  providerAuth: Record<string, string>;
  installDocker?: boolean;
  sshPublicKeys?: string[];
}

/** Change-logins body: only the changed providers, `skip` meaning "remove". */
export interface UpdateLoginsRequestBody {
  providerAuth: Record<string, string>;
  force: boolean;
}

export type OperationAction =
  | ({ action: 'attach' | 'detach'; remoteId: string } & AttachProjectRequest &
      DetachProjectRequest)
  | ({ action: 'forceSync'; remoteId: string } & ForceSyncRequest)
  | { action: 'updateHost'; remoteId: string; installDocker?: true }
  | { action: 'createVm'; connectionId: string; body: CreateVmRequestBody }
  | { action: 'installHost'; body: InstallHostRequestBody }
  | { action: 'resetVm'; remoteId: string; body: ResetVmRequestBody }
  | { action: 'destroyVm'; remoteId: string; body: { force: boolean } }
  | { action: 'updateLogins'; remoteId: string; body: UpdateLoginsRequestBody }
  | { action: 'claim'; body: ClaimRequestBody }
  | ({ action: 'retry'; operationId: string } & RetryOperationRequest)
  | { action: 'cancel'; operationId: string };

export interface VmProviderConnectionView {
  id: string;
  kind: 'proxmox';
  name: string;
  apiUrl: string;
  node: string;
  pool: string;
  storage: string;
  imageStorage: string;
  bridge: string;
  vmidMin: number;
  vmidMax: number;
  namePrefix: string;
  tag: string;
  sslFingerprint: string;
  caPem: string | null;
  tokenId: string;
  createdAt: string;
  updatedAt: string;
  capabilities: { create: true; destroy: true; powerState: true };
}

export interface HomeIdentity {
  user: string;
  homePath: string;
}

export interface LocalSshKey {
  name: string;
  type: string | null;
  encrypted: boolean;
}

export interface EstimatedProject {
  id: string;
  bytes: number | null;
  approximate: boolean;
}

export interface ProjectDiskEstimate {
  projects: EstimatedProject[];
  requiredDiskGib: number;
}

export interface ProxmoxSetupBlockFields {
  node: string;
  address: string;
  pool: string;
  storage: string;
  imageStorage: string;
  bridge: string;
}

export interface ProxmoxRightsCheck {
  ok: boolean;
  missing: string[];
}

export type ProxmoxFingerprintPreview = Extract<
  ConnectProxmoxResult,
  { confirmationRequired: true }
>;

export interface ProxmoxConnectedResult {
  confirmationRequired: false;
  connection: VmProviderConnectionView;
  permissions: ProxmoxRightsCheck;
}

export type CreateVmRequestBody = ClaimRequestBody & {
  name: string;
  cores: number;
  memory: number;
  disk: number;
};

/** What the Connect call sends: the project and the Docker items it carries. */
export interface AttachProjectRequest {
  projectId: string;
  /** The Docker items a Connect carries: plan item ids with their chosen modes. */
  docker?: DockerSelection;
}

/** What the Disconnect call sends. */
export interface DetachProjectRequest {
  projectId: string;
  force?: boolean;
  /** A Disconnect's "Copy Docker data back to this PC", with its choices. */
  dockerCopyBack?: DockerCopyBackRequest;
}

/** What the Force sync call sends: the project and the side whose files win. */
export interface ForceSyncRequest {
  projectId: string;
  source: ForceSyncSource;
}

export interface RetryOperationRequest {
  providerAuth?: Record<string, string>;
  ssh?: SshCredentials;
}

/** Vault metadata only; the server never sends payloads or ciphertext. */
export type ProviderAuthEntryItem = ProviderAuthEntryDto;

export interface ProviderAuthReleaseView {
  entry: ProviderAuthEntryItem;
  pullStatus: 'pulled' | 'offline' | 'not-needed';
}

export type ImportResult = PerProviderIdImportResult;

/** One login of this PC's OpenCode auth file: an id and a fixed type, never a credential value. */
export type OpencodeLoginItem = OpencodeLoginDto;

export type ProviderAuthGenerationView = ProviderAuthGeneration;

export type {
  ProjectFileSyncFailures,
  ProjectPatternPreview,
  SaveProjectIgnoresResult,
} from '@/modules/remotes/sync/remote-file-sync.dto';
export type { ProjectExclusionSuggestions } from '@/modules/file-sync/sync-path-inspection.dto';
export type { FileSyncAutoFix } from '@/modules/file-sync/file-sync-auto-fix.dto';
export type { SyncChownResult } from '@/modules/file-sync/sync-chown.dto';
export type {
  DockerPlan,
  DockerPlanRequest,
  DockerPresence,
} from '@/modules/remotes/docker/docker-plan.dto';
export type { DockerSyncState } from '@/modules/remotes/docker/docker-copy-back.dto';
export type { ConnectChoicesDto } from '@/modules/remotes/connect-choices.dto';

export interface ProjectIgnores {
  ignores: string[];
  revision: number;
}

/** What a receiving side still lacks in one shared folder. */
export interface FolderNeed {
  id: string;
  needItems: number;
  needBytes: number;
}

export interface ProjectFileSyncStatus {
  folders: FolderNeed[] | null;
}

export interface StartProviderAuthGenerationInput {
  provider: string;
  label?: string;
}
