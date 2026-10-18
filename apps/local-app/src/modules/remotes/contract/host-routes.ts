import { HostWorktreesSchema, LaneAdmissionSchema } from '../../worktrees/host-worktrees.dto';
import { z } from 'zod';
import {
  GitCoordinatorRecordSchema,
  GitCoordinatorStatusSchema,
  GitFenceSchema,
  HomeWriteBeginSchema,
  HomeWriteEndSchema,
  HandoverBeginSchema,
  HandoverPhaseSchema,
  GitIndexSnapshotSchema,
} from '../git-coordinator/git-coordinator.dto';
import type { GitFence } from '../git-coordinator/git-coordinator.dto';
import {
  HostProviderCliSettingsSchema,
  HostProviderCliSettingsStatusSchema,
  HostSkillSettingsSchema,
  ProviderUsageSettingsSchema,
  HostSkillSettingsStatusSchema,
  PROJECT_REPLICA_CONTENT_TYPE,
  ProjectReplicaChangesSchema,
  ProjectReplicaImportResultSchema,
  ProjectReplicaV1Schema,
} from '@devchain/shared';
import { DockerRuntimeSchema } from '../../core/controllers/docker-runtime';
import {
  SCAN_TIMEOUT_MS,
  FolderSyncStatusSchema,
  ForceCopyBackupRequestSchema,
  ForceCopyBackupSchema,
  ReceiveOnlyChangesSchema,
  RemoteNeedSchema,
  RemoteNeedNamesSchema,
  SyncDeviceSchema,
  SyncFolderSchema,
  SyncFolderConfigurationSchema,
  SyncFolderIgnoresSchema,
  SyncFolderPatchSchema,
  SyncFolderRequestSchema,
} from '../../file-sync/file-sync.dto';
import {
  SyncInspectRequestSchema,
  SyncPathInspectionSchema,
} from '../../file-sync/sync-path-inspection.dto';
import {
  GitGuardInstallResultSchema,
  GitGuardRemoveRequestSchema,
  GitGuardRemoveResultSchema,
  VmGitGuardRequestSchema,
} from '../../file-sync/git-guard.dto';
import {
  HOST_HELPER_MIGRATION,
  HostDockerStatusSchema,
  HostUpdateStatusSchema,
  HostUpdateRequestSchema,
} from '../host/host-helper.dto';
import {
  HostProviderApplyRequestSchema,
  HostProviderVerifyRequestSchema,
} from '../host/host-provider-auth.dto';
import { HostSshKeysRequestSchema } from '../host/host-ssh-keys.dto';
import { RemoteSessionSchema } from '../operations/git-owner.dto';
import { ProjectTimeSettlementSchema } from '../time/project-time-settler.dto';
import {
  TranscriptListRequestSchema,
  TranscriptListingSchema,
} from '../transcripts/transcript-transfer.dto';
import { VmUidConflictSchema } from '../vm-user-identity';
import {
  SharedVmAbandonSchema,
  SharedVmDismissSchema,
  SharedVmFenceRequestSchema,
  SharedVmFenceResultSchema,
  SharedVmNoticesSchema,
  SharedVmNotifySchema,
  SharedVmNotifyResultSchema,
  SharedVmRosterSchema,
} from '../host/shared-vm.contract';

export const CONTROL_TIMEOUT_MS = 15_000;
export const REPLICA_TIMEOUT_MS = 120_000;
export const RUNTIME_TIMEOUT_MS = 5_000;
// Path inspection, ownership changes and skill-source uploads read or write many files.
const BULK_TIMEOUT_MS = 60_000;
// Claim installs DevChain and provider CLIs before answering. If the bootstrap
// loses its response, the operation checks /api/runtime to learn the outcome.
const CLAIM_TIMEOUT_MS = 45 * 60_000;
// Each host-side provider check can take 90 seconds.
const VERIFY_TIMEOUT_MS = 100_000;
const SETTINGS_TIMEOUT_MS = 3_000;

export const HostRuntimeSchema = z
  .object({
    state: z.string().optional(),
    bootId: z.string().optional(),
    docker: DockerRuntimeSchema.optional(),
    version: z.string().nullable().optional(),
    /** Absent on older builds and bootstraps. */
    homePath: z.string().nullable().optional(),
    uid: z.number().nullable().optional(),
    gid: z.number().nullable().optional(),
    requestedUid: z.number().int().optional(),
    requestedGid: z.number().int().optional(),
    primaryGroup: z.string().optional(),
    uidConflict: VmUidConflictSchema.optional(),
    imageVersion: z.string().nullable().optional(),
    cliVersions: z.record(z.string()).nullable().optional(),
  })
  .passthrough();
export type HostRuntime = z.infer<typeof HostRuntimeSchema>;

const HostProviderVerifySchema = z.object({
  ok: z.boolean(),
  summary: z.string(),
  hint: z.string().nullable(),
});
export type HostProviderVerify = z.infer<typeof HostProviderVerifySchema>;

const HostUpdateStatusBodySchema = z.object({
  status: HostUpdateStatusSchema.omit({ at: true }).passthrough().nullable(),
});
export type HostUpdateProgress = NonNullable<z.infer<typeof HostUpdateStatusBodySchema>['status']>;

const FrozenProjectSchema = z.object({ projectId: z.string(), frozenAt: z.string() });
const EpicIdSchema = z.object({ epicId: z.string().min(1) });
const CreatedEpicSchema = z.object({ id: z.string().min(1) });

type HostStatusBody = z.ZodTypeAny | 'error-code' | 'none';
export interface HostRoute {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: (params: never) => string;
  body?: z.ZodTypeAny;
  contentType?: string;
  timeoutMs: number;
  statuses: Readonly<Record<number, HostStatusBody>>;
  hostCodes?: Readonly<Record<string, string>>;
}
export type HostRouteParams<R extends HostRoute> = Parameters<R['path']>[0];
export type HostRouteBody<R extends HostRoute> = R extends { body: infer B extends z.ZodTypeAny }
  ? z.input<B>
  : never;
type HostResponseBody<B> = B extends z.ZodTypeAny
  ? z.output<B>
  : B extends 'error-code'
    ? string | null
    : undefined;
export type HostRouteResult<R extends HostRoute> = {
  [S in keyof R['statuses']]: { status: S; body: HostResponseBody<R['statuses'][S]> };
}[keyof R['statuses']];
export type HostHandlerResponse<
  R extends HostRoute,
  S extends keyof R['statuses'],
> = R['statuses'][S] extends 'none' ? void : HostResponseBody<R['statuses'][S]>;

// Older peers may omit bootId; this runtime always supplies its process identity.
export type HostRuntimeResponse = HostHandlerResponse<typeof hostRoutes.runtimeAt, 200> &
  Required<Pick<HostHandlerResponse<typeof hostRoutes.runtimeAt, 200>, 'bootId'>>;

type ProjectParams = { projectId: string };
type FolderParams = { folderId: string };
type FencedParams = { gitFence?: GitFence };
type NoParams = Record<string, never>;
const enc = encodeURIComponent;
const fixed = (path: string) => (_params: NoParams) => path;
const NO_CONTENT = { 204: 'none' } as const;
const RevisionAckSchema = z.object({ revision: z.string() });

export const HostProviderUsageSettingsSchema = z
  .object({ revision: z.string().regex(/^[a-f0-9]{64}$/), settings: ProviderUsageSettingsSchema })
  .strict();
export type HostProviderUsageSettings = z.infer<typeof HostProviderUsageSettingsSchema>;

/** `appliedRevision` is the revision of the values the VM runs with now. */
export const HostProviderUsageSettingsStatusSchema = z
  .object({ appliedRevision: z.string().nullable() })
  .strict();
export type HostProviderUsageSettingsStatus = z.infer<typeof HostProviderUsageSettingsStatusSchema>;
const projectPath = ({ projectId }: ProjectParams) => `/api/host/projects/${enc(projectId)}`;
const folderPath = ({ folderId }: FolderParams) => `/api/host/sync/folders/${enc(folderId)}`;
const fenced = (path: string, { gitFence }: FencedParams): string =>
  gitFence
    ? `${path}?${new URLSearchParams({ expectedGeneration: String(gitFence.expectedGeneration), transitionId: gitFence.transitionId ?? 'none' })}`
    : path;
const fencedFolderPath = (params: FolderParams & FencedParams) =>
  fenced(folderPath(params), params);
const syncStatusPath = ({
  folderId,
  deviceId,
  allErrors,
}: FolderParams & {
  deviceId?: string;
  allErrors?: boolean;
}) => {
  const query = new URLSearchParams({ folder: folderId });
  if (deviceId) query.set('device', deviceId);
  if (allErrors) query.set('errors', 'all');
  return `/api/host/sync/status?${query}`;
};
const helperCodes = {
  HOST_HELPER_OUTDATED: `The host helper needs one manual migration: ${HOST_HELPER_MIGRATION}`,
};

export const hostRoutes = {
  gitCoordinatorStatus: {
    method: 'GET',
    path: (params: ProjectParams) => `${projectPath(params)}/git-coordinator`,
    timeoutMs: CONTROL_TIMEOUT_MS,
    statuses: { 200: GitCoordinatorStatusSchema },
  },
  gitCoordinatorIndex: {
    method: 'GET',
    path: (params: ProjectParams) => `${projectPath(params)}/git-coordinator/index`,
    timeoutMs: REPLICA_TIMEOUT_MS,
    statuses: { 200: GitIndexSnapshotSchema },
  },
  homeWriteBegin: {
    method: 'POST',
    path: (params: ProjectParams) => `${projectPath(params)}/git-coordinator/home-write-begin`,
    body: HomeWriteBeginSchema,
    timeoutMs: CONTROL_TIMEOUT_MS,
    statuses: { 200: GitCoordinatorRecordSchema },
  },
  homeWriteEnd: {
    method: 'POST',
    path: (params: ProjectParams) => `${projectPath(params)}/git-coordinator/home-write-end`,
    body: HomeWriteEndSchema,
    timeoutMs: REPLICA_TIMEOUT_MS,
    statuses: { 200: GitCoordinatorRecordSchema },
  },
  handoverBegin: {
    method: 'POST',
    path: (params: ProjectParams) => `${projectPath(params)}/git-coordinator/handover-begin`,
    body: HandoverBeginSchema,
    timeoutMs: CONTROL_TIMEOUT_MS,
    statuses: { 200: GitCoordinatorRecordSchema },
  },
  handoverRenew: {
    method: 'POST',
    path: (params: ProjectParams) => `${projectPath(params)}/git-coordinator/handover-renew`,
    body: GitFenceSchema.strict(),
    timeoutMs: CONTROL_TIMEOUT_MS,
    statuses: { 200: GitCoordinatorRecordSchema },
  },
  handoverAbort: {
    method: 'POST',
    path: (params: ProjectParams) => `${projectPath(params)}/git-coordinator/handover-abort`,
    body: GitFenceSchema.strict(),
    timeoutMs: CONTROL_TIMEOUT_MS,
    statuses: { 200: GitCoordinatorRecordSchema },
  },
  handoverPhase: {
    method: 'POST',
    path: (params: ProjectParams) => `${projectPath(params)}/git-coordinator/handover-phase`,
    body: HandoverPhaseSchema,
    timeoutMs: REPLICA_TIMEOUT_MS,
    statuses: { 200: GitCoordinatorRecordSchema },
  },
  handoverComplete: {
    method: 'POST',
    path: (params: ProjectParams) => `${projectPath(params)}/git-coordinator/handover-complete`,
    body: GitFenceSchema.strict(),
    timeoutMs: CONTROL_TIMEOUT_MS,
    statuses: { 200: GitCoordinatorRecordSchema },
  },
  gitCoordinatorClose: {
    method: 'POST',
    path: (params: ProjectParams) => `${projectPath(params)}/git-coordinator/close`,
    timeoutMs: CONTROL_TIMEOUT_MS,
    statuses: { 200: GitCoordinatorRecordSchema },
  },
  gitCoordinatorReopen: {
    method: 'POST',
    path: (params: ProjectParams) => `${projectPath(params)}/git-coordinator/reopen`,
    timeoutMs: CONTROL_TIMEOUT_MS,
    statuses: { 200: GitCoordinatorRecordSchema },
  },
  listTranscripts: {
    method: 'POST',
    path: fixed('/api/host/transcripts/list'),
    body: TranscriptListRequestSchema,
    timeoutMs: CONTROL_TIMEOUT_MS,
    statuses: { 200: TranscriptListingSchema },
  },
  projectExists: {
    method: 'GET',
    path: ({ projectId }: ProjectParams) => `/api/projects/${enc(projectId)}`,
    timeoutMs: CONTROL_TIMEOUT_MS,
    statuses: { 200: 'none', 404: 'none' },
  },
  importProject: {
    method: 'POST',
    path: fixed('/api/host/projects/import'),
    body: ProjectReplicaV1Schema,
    contentType: PROJECT_REPLICA_CONTENT_TYPE,
    timeoutMs: REPLICA_TIMEOUT_MS,
    statuses: { 201: ProjectReplicaImportResultSchema, 409: 'error-code' },
  },
  exportReplica: {
    method: 'GET',
    path: (params: ProjectParams & { scope: 'attach' | 'detach' }) =>
      `${projectPath(params)}/replica?scope=${params.scope}`,
    timeoutMs: REPLICA_TIMEOUT_MS,
    statuses: { 200: ProjectReplicaV1Schema },
  },
  changes: {
    method: 'GET',
    path: (params: ProjectParams & { since: string | null; full: boolean }) => {
      const query = new URLSearchParams();
      if (params.since) query.set('since', params.since);
      if (params.full) query.set('full', 'true');
      const suffix = query.toString();
      return `${projectPath(params)}/changes${suffix ? `?${suffix}` : ''}`;
    },
    timeoutMs: REPLICA_TIMEOUT_MS,
    statuses: { 200: ProjectReplicaChangesSchema },
  },
  worktrees: {
    method: 'GET',
    path: (params: ProjectParams) => `${projectPath(params)}/worktrees`,
    timeoutMs: BULK_TIMEOUT_MS,
    statuses: { 200: HostWorktreesSchema },
  },
  laneAdmission: {
    method: 'POST',
    path: (params: ProjectParams) => `${projectPath(params)}/worktrees/admission`,
    body: LaneAdmissionSchema,
    timeoutMs: BULK_TIMEOUT_MS,
    statuses: { 200: LaneAdmissionSchema },
  },
  freeze: {
    method: 'POST',
    path: (params: ProjectParams) => `${projectPath(params)}/freeze`,
    timeoutMs: CONTROL_TIMEOUT_MS,
    statuses: { 200: FrozenProjectSchema },
  },
  installGitGuard: {
    method: 'POST',
    path: (params: ProjectParams) => `${projectPath(params)}/git-guard`,
    body: VmGitGuardRequestSchema.merge(GitFenceSchema).strict(),
    timeoutMs: CONTROL_TIMEOUT_MS,
    statuses: { 200: GitGuardInstallResultSchema },
  },
  removeGitGuard: {
    method: 'DELETE',
    path: (params: ProjectParams) => `${projectPath(params)}/git-guard`,
    body: GitGuardRemoveRequestSchema.merge(GitFenceSchema).strict(),
    timeoutMs: CONTROL_TIMEOUT_MS,
    statuses: { 200: GitGuardRemoveResultSchema },
  },
  thaw: {
    method: 'POST',
    path: (params: ProjectParams) => `${projectPath(params)}/thaw`,
    timeoutMs: CONTROL_TIMEOUT_MS,
    statuses: NO_CONTENT,
  },
  listSessions: {
    method: 'GET',
    path: ({ projectId }: { projectId?: string }) =>
      `/api/sessions${projectId ? `?${new URLSearchParams({ projectId })}` : ''}`,
    timeoutMs: CONTROL_TIMEOUT_MS,
    statuses: { 200: z.array(RemoteSessionSchema) },
  },
  stopSessions: {
    method: 'POST',
    path: (params: ProjectParams) => `${projectPath(params)}/stop-sessions`,
    timeoutMs: CONTROL_TIMEOUT_MS,
    statuses: NO_CONTENT,
  },
  settleTime: {
    method: 'POST',
    path: (params: ProjectParams) => `${projectPath(params)}/settle-time`,
    timeoutMs: CONTROL_TIMEOUT_MS,
    statuses: { 200: ProjectTimeSettlementSchema },
  },
  release: {
    method: 'POST',
    path: (params: ProjectParams) => `${projectPath(params)}/release`,
    timeoutMs: CONTROL_TIMEOUT_MS,
    statuses: { 204: 'none', 404: 'none' },
  },
  findEpicByIdempotencyKey: {
    method: 'GET',
    path: (params: ProjectParams & { key: string }) =>
      `${projectPath(params)}/epics/by-idempotency-key/${enc(params.key)}`,
    timeoutMs: CONTROL_TIMEOUT_MS,
    statuses: { 200: EpicIdSchema, 404: 'none' },
  },
  createEpic: {
    method: 'POST',
    path: fixed('/api/epics'),
    body: z.object({
      projectId: z.string(),
      statusId: z.string(),
      title: z.string(),
      description: z.string().nullable(),
      data: z.record(z.unknown()).nullable(),
    }),
    timeoutMs: CONTROL_TIMEOUT_MS,
    statuses: { 201: CreatedEpicSchema, 423: 'error-code' },
  },
  syncDevice: {
    method: 'GET',
    path: fixed('/api/host/sync/device'),
    timeoutMs: CONTROL_TIMEOUT_MS,
    statuses: { 200: SyncDeviceSchema },
  },
  syncPeer: {
    method: 'POST',
    path: fixed('/api/host/sync/peer'),
    body: SyncDeviceSchema,
    timeoutMs: CONTROL_TIMEOUT_MS,
    statuses: NO_CONTENT,
  },
  syncFolders: {
    method: 'POST',
    path: (params: FencedParams) => fenced('/api/host/sync/folders', params),
    body: SyncFolderRequestSchema,
    timeoutMs: CONTROL_TIMEOUT_MS,
    statuses: { 200: SyncFolderSchema },
  },
  syncForceCopyBackup: {
    method: 'POST',
    path: fixed('/api/host/sync/force-copy-backup'),
    body: ForceCopyBackupRequestSchema,
    timeoutMs: CONTROL_TIMEOUT_MS,
    statuses: { 200: ForceCopyBackupSchema },
  },
  syncFolderType: {
    method: 'PATCH',
    path: fencedFolderPath,
    body: SyncFolderPatchSchema,
    timeoutMs: CONTROL_TIMEOUT_MS,
    statuses: NO_CONTENT,
  },
  syncFolderConfiguration: {
    method: 'GET',
    path: (params: FolderParams) => `${folderPath(params)}/configuration`,
    timeoutMs: CONTROL_TIMEOUT_MS,
    statuses: { 200: SyncFolderConfigurationSchema },
  },
  syncFolderIgnores: {
    method: 'GET',
    path: (params: FolderParams) => `${folderPath(params)}/ignores`,
    timeoutMs: CONTROL_TIMEOUT_MS,
    statuses: { 200: SyncFolderIgnoresSchema },
  },
  syncRemoveFolder: {
    method: 'DELETE',
    path: fencedFolderPath,
    timeoutMs: CONTROL_TIMEOUT_MS,
    statuses: NO_CONTENT,
  },
  syncScan: {
    method: 'POST',
    path: (params: FolderParams & FencedParams) => fenced(`${folderPath(params)}/scan`, params),
    timeoutMs: SCAN_TIMEOUT_MS + CONTROL_TIMEOUT_MS,
    statuses: NO_CONTENT,
  },
  syncRevert: {
    method: 'POST',
    path: (params: FolderParams & FencedParams) => fenced(`${folderPath(params)}/revert`, params),
    timeoutMs: CONTROL_TIMEOUT_MS,
    statuses: NO_CONTENT,
  },
  syncOverride: {
    method: 'POST',
    path: (params: FolderParams & FencedParams) => fenced(`${folderPath(params)}/override`, params),
    timeoutMs: CONTROL_TIMEOUT_MS,
    statuses: NO_CONTENT,
  },
  syncLocalChanges: {
    method: 'GET',
    path: (params: FolderParams) => `${folderPath(params)}/local-changes`,
    timeoutMs: CONTROL_TIMEOUT_MS,
    statuses: { 200: ReceiveOnlyChangesSchema },
  },
  syncStatus: {
    method: 'GET',
    path: syncStatusPath,
    timeoutMs: CONTROL_TIMEOUT_MS,
    statuses: { 200: FolderSyncStatusSchema },
  },
  syncFolderExists: {
    method: 'GET',
    path: syncStatusPath,
    timeoutMs: CONTROL_TIMEOUT_MS,
    statuses: { 200: FolderSyncStatusSchema, 404: 'none' },
  },
  syncRemoteNeed: {
    method: 'GET',
    path: (params: FolderParams & { deviceId: string }) =>
      `${folderPath(params)}/remote-need?${new URLSearchParams({ device: params.deviceId })}`,
    timeoutMs: CONTROL_TIMEOUT_MS,
    statuses: { 200: RemoteNeedSchema },
  },
  syncRemoteNeedThrough: {
    method: 'GET',
    path: (params: FolderParams & { deviceId: string; sequence: number }) =>
      `${folderPath(params)}/remote-need-through?${new URLSearchParams({ device: params.deviceId, sequence: String(params.sequence) })}`,
    timeoutMs: CONTROL_TIMEOUT_MS,
    statuses: { 200: RemoteNeedNamesSchema },
  },
  syncInspect: {
    method: 'POST',
    path: fixed('/api/host/sync/inspect'),
    body: SyncInspectRequestSchema,
    timeoutMs: BULK_TIMEOUT_MS,
    statuses: { 200: SyncPathInspectionSchema },
  },
  setInstanceLabel: {
    method: 'PUT',
    path: fixed('/api/cloud/instance-label'),
    body: z.object({ label: z.string().max(128) }).strict(),
    timeoutMs: CONTROL_TIMEOUT_MS,
    statuses: { 200: 'none' },
  },
  runtimeAt: {
    method: 'GET',
    path: fixed('/api/runtime'),
    timeoutMs: RUNTIME_TIMEOUT_MS,
    statuses: { 200: HostRuntimeSchema },
  },
  claim: {
    method: 'POST',
    path: fixed('/api/host/claim'),
    body: z.object({
      userName: z.string(),
      homePath: z.string(),
      uid: z.number().optional(),
      gid: z.number().optional(),
      version: z.string(),
      port: z.number(),
      nonce: z.string().optional(),
      providerAuth: HostProviderApplyRequestSchema.pick({ env: true, files: true }),
    }),
    timeoutMs: CLAIM_TIMEOUT_MS,
    statuses: { 200: 'none', 409: 'error-code', 504: 'error-code' },
  },
  verifyProviderAuth: {
    method: 'POST',
    path: fixed('/api/host/provider-auth/verify'),
    body: HostProviderVerifyRequestSchema,
    timeoutMs: VERIFY_TIMEOUT_MS,
    statuses: { 200: HostProviderVerifySchema },
  },
  applyProviderAuth: {
    method: 'POST',
    path: fixed('/api/host/provider-auth'),
    body: HostProviderApplyRequestSchema,
    timeoutMs: CONTROL_TIMEOUT_MS,
    statuses: { 200: 'none' },
  },
  applySshKeys: {
    method: 'POST',
    path: fixed('/api/host/ssh-keys'),
    body: HostSshKeysRequestSchema,
    timeoutMs: CONTROL_TIMEOUT_MS,
    statuses: { 200: 'none' },
  },
  requestHostUpdate: {
    method: 'POST',
    path: fixed('/api/host/update'),
    body: HostUpdateRequestSchema,
    timeoutMs: CONTROL_TIMEOUT_MS,
    statuses: { 202: 'none', 409: 'error-code' },
  },
  sharedVmRoster: {
    method: 'GET',
    path: fixed('/api/host/shared-vm/roster'),
    timeoutMs: CONTROL_TIMEOUT_MS,
    statuses: { 200: SharedVmRosterSchema },
  },
  sharedVmNotify: {
    method: 'POST',
    path: fixed('/api/host/shared-vm/notify'),
    body: SharedVmNotifySchema,
    timeoutMs: CONTROL_TIMEOUT_MS,
    statuses: { 200: SharedVmNotifyResultSchema },
  },
  sharedVmNotices: {
    method: 'GET',
    path: fixed('/api/host/shared-vm/notices'),
    timeoutMs: CONTROL_TIMEOUT_MS,
    statuses: { 200: SharedVmNoticesSchema },
  },
  sharedVmDismiss: {
    method: 'POST',
    path: fixed('/api/host/shared-vm/dismiss'),
    body: SharedVmDismissSchema,
    timeoutMs: CONTROL_TIMEOUT_MS,
    statuses: { 204: 'none' },
  },
  sharedVmAbandon: {
    method: 'POST',
    path: fixed('/api/host/shared-vm/abandon'),
    body: SharedVmAbandonSchema,
    timeoutMs: CONTROL_TIMEOUT_MS,
    statuses: { 204: 'none' },
  },
  sharedVmFence: {
    method: 'POST',
    path: fixed('/api/host/shared-vm/fence'),
    body: SharedVmFenceRequestSchema,
    timeoutMs: CONTROL_TIMEOUT_MS,
    statuses: { 200: SharedVmFenceResultSchema },
  },
  hostUpdateStatus: {
    method: 'GET',
    path: fixed('/api/host/update'),
    timeoutMs: CONTROL_TIMEOUT_MS,
    statuses: { 200: HostUpdateStatusBodySchema },
  },
  requestDocker: {
    method: 'POST',
    path: fixed('/api/host/docker'),
    body: z.object({}).strict(),
    timeoutMs: CONTROL_TIMEOUT_MS,
    statuses: { 202: z.object({ jobId: z.string().nullable() }) },
    hostCodes: helperCodes,
  },
  dockerStatus: {
    method: 'GET',
    path: fixed('/api/host/docker'),
    timeoutMs: CONTROL_TIMEOUT_MS,
    statuses: { 200: z.object({ status: HostDockerStatusSchema.nullable() }) },
    hostCodes: helperCodes,
  },
  getProviderCliSettingsStatus: {
    method: 'GET',
    path: fixed('/api/host/provider-clis/status'),
    timeoutMs: SETTINGS_TIMEOUT_MS,
    statuses: { 200: HostProviderCliSettingsStatusSchema },
  },
  putProviderCliSettings: {
    method: 'PUT',
    path: fixed('/api/host/provider-clis'),
    body: HostProviderCliSettingsSchema,
    timeoutMs: SETTINGS_TIMEOUT_MS,
    statuses: { 202: RevisionAckSchema },
  },
  checkProviderClis: {
    method: 'POST',
    path: fixed('/api/host/provider-clis/check'),
    timeoutMs: SETTINGS_TIMEOUT_MS,
    statuses: { 202: z.object({ accepted: z.literal(true) }) },
  },
  getProviderUsageSettingsStatus: {
    method: 'GET',
    path: fixed('/api/host/provider-usage-settings/status'),
    timeoutMs: SETTINGS_TIMEOUT_MS,
    statuses: { 200: HostProviderUsageSettingsStatusSchema },
  },
  putProviderUsageSettings: {
    method: 'PUT',
    path: fixed('/api/host/provider-usage-settings'),
    body: HostProviderUsageSettingsSchema,
    timeoutMs: SETTINGS_TIMEOUT_MS,
    statuses: { 202: RevisionAckSchema },
  },
  getSkillSettingsStatus: {
    method: 'GET',
    path: fixed('/api/host/skill-settings/status'),
    timeoutMs: SETTINGS_TIMEOUT_MS,
    statuses: { 200: HostSkillSettingsStatusSchema },
  },
  putSkillSettings: {
    method: 'PUT',
    path: fixed('/api/host/skill-settings'),
    body: HostSkillSettingsSchema,
    timeoutMs: SETTINGS_TIMEOUT_MS,
    statuses: { 202: RevisionAckSchema },
  },
  uploadSkillSourceContent: {
    method: 'PUT',
    path: ({ name, contentHash }: { name: string; contentHash: string }) =>
      `/api/host/skill-settings/local-sources/${enc(name)}/content?${new URLSearchParams({ contentHash })}`,
    contentType: 'application/x-tar',
    timeoutMs: BULK_TIMEOUT_MS,
    statuses: { 200: z.object({ name: z.string(), contentHash: z.string() }) },
  },
} as const satisfies Record<string, HostRoute>;
