import { Inject, Injectable } from '@nestjs/common';
import { createLogger } from '../../../common/logging/logger';
import { HomeGitGuardService } from '../../file-sync/home-git-guard.service';
import { FileSyncManagedExclusionsStore } from '../../file-sync/file-sync-managed-exclusions.store';
import { codeIgnores, gitIgnores, type FolderSyncStatus } from '../../file-sync/file-sync.dto';
import {
  FileSyncService,
  evaluateCompletion,
  projectFolderId,
} from '../../file-sync/file-sync.service';
import { GitService } from '../../git/services/git.service';
import { RemoteHostClient } from '../operations/remote-host.client';
import { REMOTE_HEALTH_PORT, type RemoteHealthPort } from '../ports/remote-health.port';
import { RemoteBindingsService } from '../services/remote-bindings.service';

const logger = createLogger('RemoteFileSyncService');
const CHECK_INTERVAL_MS = 30_000;
const PROBLEM_GRACE_MS = 2 * 60_000;
const STALLED_MS = 10 * 60_000;

interface SyncObservation {
  since: number;
  count: number;
}
type MoveStep = 'create' | 'settle' | 'ignores' | 'directions' | 'guard' | 'done';
interface ProjectState {
  remoteId: string;
  step: MoveStep;
  hasGit: boolean;
  head?: string;
  warning: string | null;
  guardWarning?: string | null;
  checkWarning?: string | null;
  lastCheck?: number;
  observations?: Map<string, SyncObservation>;
}

/** Owned by the live-sync lifecycle: stop() drains its tick before any handoff starts. */
@Injectable()
export class RemoteFileSyncService {
  private readonly projects = new Map<string, ProjectState>();

  constructor(
    private readonly files: FileSyncService,
    private readonly host: RemoteHostClient,
    private readonly bindings: RemoteBindingsService,
    @Inject(REMOTE_HEALTH_PORT) private readonly health: RemoteHealthPort,
    private readonly exclusions: FileSyncManagedExclusionsStore,
    private readonly git: GitService,
    private readonly guard: HomeGitGuardService,
  ) {}

  warning(projectId: string): string | null {
    const state = this.projects.get(projectId);
    return state?.checkWarning ?? state?.warning ?? state?.guardWarning ?? null;
  }

  forget(projectId: string): void {
    this.projects.delete(projectId);
  }

  async tick(projectId: string, remoteId: string, active: () => boolean): Promise<void> {
    const health = this.health.getState(remoteId);
    if (!active() || !health.online || health.apiKeyRejected || !health.versionMatches) return;
    const binding = await this.bindings.get(projectId);
    if (!active() || binding?.state !== 'remote' || binding.remoteId !== remoteId) return;
    let state = this.projects.get(projectId);
    if (!state || state.remoteId !== remoteId) {
      state = { remoteId, step: 'create', hasGit: false, warning: null };
      this.projects.set(projectId, state);
    }
    try {
      if (state.step !== 'done') {
        await this.move(projectId, state, active);
        // Migration's revert and ordinary upkeep must never run in the same tick.
        return;
      }
      await this.checkSync(projectId, state, active);
      if (!state.hasGit || !active()) return;
      const id = projectFolderId(projectId, 'git');
      const config = await this.files.folderConfiguration(id);
      if (!active() || config.type !== 'receiveonly' || config.paused) return;
      const status = await this.files.status(id);
      if (!active() || status.state !== 'idle' || status.needTotalItems !== 0) return;
      state.warning = null;
      if (status.receiveOnlyChangedFiles > 0) {
        await this.files.revertLocalChanges(id);
        return;
      }
      const root = await this.files.folderPath(projectId);
      const head = await this.git.mirroredHead(projectId, root);
      if (!active() || head === null || head === state.head) return;
      await this.git.refreshIndexFromHead(projectId, root);
      state.head = head;
    } catch (error) {
      state.warning =
        'File sync could not finish updating this project. It will retry automatically.';
      logger.warn({ error, projectId, step: state.step }, 'Remote file sync will retry');
    }
  }

  private async checkSync(
    projectId: string,
    state: ProjectState,
    active: () => boolean,
  ): Promise<void> {
    const now = Date.now();
    if (!active() || (state.lastCheck !== undefined && now - state.lastCheck < CHECK_INTERVAL_MS))
      return;
    state.lastCheck = now;
    try {
      const folders = await this.files.projectFolders(projectId);
      const configurations = await Promise.all(
        folders.map(async (folder) => ({
          ...folder,
          config: await this.files.folderConfiguration(folder.id),
        })),
      );
      const code = configurations.find((folder) => folder.kind === 'code');
      const homeId = this.files.device().deviceId;
      const peers = code?.config.devices.filter((device) => device.deviceID !== homeId);
      if (peers?.length !== 1) throw new Error('Expected one VM device in the code folder');
      const peerId = peers[0].deviceID;
      const [connected, statuses] = await Promise.all([
        this.files.isConnected(peerId),
        Promise.all(
          configurations.map(async (folder) => ({
            ...folder,
            status: await this.files.status(folder.id, folder.kind === 'code' ? peerId : undefined),
          })),
        ),
      ]);
      if (!active()) return;
      const observations = new Map<string, SyncObservation>();
      const warnings: string[] = [];
      const observe = (
        key: string,
        count: number,
        limit: number,
        message: (since: string) => string,
      ) => {
        if (count <= 0) return;
        const previous = state.observations?.get(key);
        const since = !previous || count < previous.count ? now : previous.since;
        observations.set(key, { since, count });
        if (now - since >= limit)
          warnings.push(message(new Date(since).toTimeString().slice(0, 5)));
      };
      observe(
        'connection',
        connected ? 0 : 1,
        PROBLEM_GRACE_MS,
        (since) =>
          `No file sync connection to the VM since ${since}; changes do not move between this PC and the VM.`,
      );
      for (const { id, config, status } of statuses) {
        const error = folderError(config, status);
        observe(
          `error:${id}`,
          error ? 1 : 0,
          PROBLEM_GRACE_MS,
          (since) => `File sync at home has an error since ${since}: ${error}.`,
        );
      }
      const stalled = `no progress for ${STALLED_MS / 60_000} minutes`;
      for (const { id, status } of statuses) {
        observe(
          `home:${id}`,
          status.needTotalItems,
          STALLED_MS,
          (since) =>
            `This PC has not received ${status.needTotalItems} pending file sync items since ${since} (${stalled}).`,
        );
        const { peer } = status;
        if (peer) {
          observe(
            `peer:${id}`,
            peer.needItems,
            STALLED_MS,
            (since) =>
              `The VM has not received ${peer.needItems} pending file sync items from this PC since ${since} (${stalled}).`,
          );
        }
      }
      state.observations = observations;
      state.checkWarning = warnings[0] ?? null;
    } catch (error) {
      if (!active()) return;
      state.checkWarning = 'DevChain could not read the file sync status. It will try again.';
      logger.warn({ error, projectId }, 'Remote file sync check failed');
    }
  }

  private async move(projectId: string, state: ProjectState, active: () => boolean): Promise<void> {
    const { remoteId } = state;
    const codeId = projectFolderId(projectId, 'code');
    const gitId = projectFolderId(projectId, 'git');
    if (state.step === 'create') {
      const folders = await this.files.projectFolders(projectId);
      if (!active() || !folders.some((folder) => folder.kind === 'code')) return;
      state.hasGit = (await this.files.initialFolders(projectId)).some(
        (folder) => folder.kind === 'git',
      );
      if (state.hasGit) {
        const home = this.files.device();
        const host = await this.host.syncDevice(remoteId);
        if (!active()) return;
        await this.files.addPeer(host);
        await this.host.syncPeer(remoteId, home);
        await this.host.syncFolders(remoteId, {
          projectId,
          kind: 'git',
          type: 'sendonly',
          peerDeviceId: home.deviceId,
          ignores: gitIgnores(true),
          paused: true,
        });
        await this.files.ensureFolder({
          projectId,
          kind: 'git',
          type: 'receiveonly',
          peerDeviceId: host.deviceId,
          ignores: gitIgnores(true),
          paused: true,
        });
        await this.host.syncFolderType(remoteId, gitId, { paused: false });
        await this.files.updateFolder(gitId, { paused: false });
        await Promise.all([this.host.syncScan(remoteId, gitId), this.files.rescan(gitId)]);
      }
      state.step = state.hasGit ? 'settle' : 'ignores';
    }
    if (!active()) return;
    if (state.step === 'settle') {
      const config = await this.files.folderConfiguration(gitId);
      if (config.type !== 'receiveonly' || config.paused)
        throw new Error('Git share is not receiving');
      const [sender, receiver] = await Promise.all([
        this.host.syncStatus(remoteId, gitId, this.files.device().deviceId),
        this.files.status(gitId),
      ]);
      if (!active()) return;
      if (receiver.state === 'idle' && receiver.receiveOnlyChangedFiles > 0) {
        await this.files.revertLocalChanges(gitId);
        return;
      }
      if (!evaluateCompletion(sender, receiver).done) {
        state.warning =
          'Git sync is still settling. The file sync update will retry automatically.';
        return;
      }
      state.step = 'ignores';
    }
    if (!active()) return;
    if (state.step === 'ignores') {
      const ignores = codeIgnores(this.exclusions.get(projectId), this.files.getIgnores(projectId));
      await this.host.syncFolderType(remoteId, codeId, { ignores });
      await this.files.updateFolder(codeId, { ignores });
      state.step = 'directions';
    }
    if (!active()) return;
    if (state.step === 'directions') {
      await this.host.syncFolderType(remoteId, codeId, { type: 'sendreceive' });
      await this.files.updateFolder(codeId, { type: 'sendreceive' });
      state.step = 'guard';
    }
    if (!active()) return;
    if (state.step === 'guard') {
      if (state.hasGit) {
        state.guardWarning = await this.guard.install(projectId, remoteId);
      }
      state.step = 'done';
      state.warning = null;
    }
  }
}

/** What is wrong with a home folder, in the order a user should fix it; null when nothing is. */
function folderError(config: { paused: boolean }, status: FolderSyncStatus): string | null {
  if (config.paused) return 'folder is paused';
  const message = status.error?.trim();
  if (message) return message;
  if ((status.errors ?? 0) > 0) return `${status.errors} files failed`;
  if (status.state === 'error') return 'folder is in an error state';
  return null;
}
