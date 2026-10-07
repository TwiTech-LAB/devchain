import type { DockerSelection } from '../docker/docker-plan.dto';
import { REMOTE_HEALTH_PORT, type RemoteHealthPort } from '../ports/remote-health.port';
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { getAppVersion } from '../../../common/app-version';
import { getEnvConfig } from '../../../common/config/env.config';
import { ConflictError, ValidationError } from '../../../common/errors/error-types';
import { createLogger } from '../../../common/logging/logger';
import { PROVIDER_AUTH_LOGIN_ADAPTERS } from '../../provider-auth/provider-auth-adapters';
import { ProviderAuthVaultService } from '../../provider-auth/provider-auth-vault.service';
import { ProviderAdapterFactory } from '../../providers/adapters/provider-adapter.factory';
import { STORAGE_SERVICE, type StorageService } from '../../storage/interfaces/storage.interface';
import type {
  Remote,
  RemoteOperation,
  RemoteOperationState,
} from '../../storage/models/domain.models';
import { BASE_URL_MESSAGE, normalizeRemoteBaseUrl } from '../dtos/remote.dto';
import { RemotesService } from '../services/remotes.service';
import {
  assertClaimableIdentity,
  claimIdentityMismatch,
  CLAIM_IDENTITY_KINDS,
} from '../home-identity';
import type { ClaimDetails, ClaimProviderState } from './claim.operation';
import type { DetachDetails } from './detach.operation';
import type { DockerCopyBackRequest } from '../docker/docker-copy-back.dto';
import type {
  UpdateLoginsData,
  ClaimRemoteData,
  InstallHostData,
  ProviderAuthSelection,
} from './remote-operation.dto';
import { RemoteOperationRunner } from './remote-operation.runner';
import { HOST_LIFECYCLE_KINDS, VM_LIFECYCLE_KINDS } from './remote-operation.types';
import { requireRemoteAddress, stripIpv6Brackets } from '../remote-address';
import type { UpdateLoginsDetails } from './update-logins.operation';
import type { UpdateHostDetails } from './update-host.operation';
import { InstallHostOperation, type InstallHostDetails } from './install-host.operation';
import { SshKeyService } from '../host-install/ssh-key.service';
import { ConnectChoicesStore } from '../connect-choices.store';
import { RemoteFileSyncService } from '../sync/remote-file-sync.service';
import type { ForceSyncSource } from './remote-operation.dto';
import { GitOwnerOperation } from './git-owner.operation';
import { GitOwnerStore, type GitOwner } from '../git-owner.store';
import { RemoteHostClient } from './remote-host.client';
import { RemoteOperationStepRefusedError } from './remote-operation.errors';
import { TURN_FALLBACK_IDLE_MS } from '../../terminal/services/terminal-activity.service';
import {
  type GitOwnerStartResult,
  type GitOwnerStatus,
  type GitSwitchAgent,
} from './git-owner.dto';

const logger = createLogger('RemoteOperationsService');

@Injectable()
export class RemoteOperationsService {
  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly runner: RemoteOperationRunner,
    private readonly remotes: RemotesService,
    private readonly vault: ProviderAuthVaultService,
    private readonly providers: ProviderAdapterFactory,
    private readonly installHostOperation: InstallHostOperation,
    private readonly sshKeys: SshKeyService,
    @Inject(REMOTE_HEALTH_PORT) private readonly health: RemoteHealthPort,
    private readonly choices: ConnectChoicesStore,
    private readonly files: RemoteFileSyncService,
    private readonly gitSwitch: GitOwnerOperation,
    private readonly gitOwners: GitOwnerStore,
    private readonly host: RemoteHostClient,
  ) {}

  async gitOwner(
    remoteId: string,
    projectId: string,
    owner: GitOwner,
    force: boolean,
  ): Promise<GitOwnerStartResult> {
    requireRemoteAddress(await this.storage.getRemote(remoteId));
    await this.assertNoOpenVmOperation(remoteId);
    await this.storage.getProject(projectId);
    if (owner === 'vm' && force)
      throw new RemoteOperationStepRefusedError(
        'GIT_RETURN_FORCE_UNSUPPORTED',
        'Return does not support --force. Run `devchain git return`.',
      );
    const [open] = await this.storage.listRemoteOperations({
      projectId,
      states: ['running', 'failed'],
      limit: 1,
    });
    let cancelledOperationId: string | undefined;
    if (open) {
      if (open.kind !== 'git_owner' || open.remoteId !== remoteId)
        throw inProgress(open, 'Another operation is open for this project.');
      if (open.state === 'running') return open;
      await this.runner.whenIdle(open.id);
      const current = await this.storage.getRemoteOperation(open.id);
      if (current.state === 'running') return current;
      if (current.state === 'failed') {
        if (current.details.owner === owner && (current.details.force === true) === force)
          return this.retry(current.id);
        // After git_flip has started, the cancel refuses with GIT_SWITCH_UNFINISHED.
        await this.runner.cancel(current.id);
        cancelledOperationId = current.id;
      }
    }
    const binding = await this.storage.getRemoteProjectBinding(projectId);
    if (binding?.state !== 'remote' || binding.remoteId !== remoteId)
      throw new RemoteOperationStepRefusedError(
        'GIT_PROJECT_NOT_CONNECTED',
        'The project must be connected to this VM to move Git.',
        { projectId, remoteId },
      );
    if (this.gitOwners.get(projectId) === owner)
      return { owner, changed: false, ...(cancelledOperationId && { cancelledOperationId }) };
    await this.gitSwitch.validate(remoteId, projectId);
    const unknownAgents: GitSwitchAgent[] = [];
    if (owner === 'home' && !force) {
      let busy: GitSwitchAgent[];
      try {
        const sessions = await this.host.listSessions(remoteId, projectId);
        busy = [];
        for (const session of sessions) {
          if (session.status !== 'running' || !session.agentId || session.activityState === 'idle')
            continue;
          const agent = await this.storage.getAgent(session.agentId);
          const starting =
            session.activityState !== 'busy' &&
            Date.now() - Date.parse(session.startedAt) < TURN_FALLBACK_IDLE_MS;
          const state =
            session.activityState === 'busy' ? 'busy' : starting ? 'starting' : 'unknown';
          const info: GitSwitchAgent = {
            agentName: agent.name,
            state,
            since: state === 'busy' ? (session.busySince ?? session.startedAt) : session.startedAt,
          };
          if (state === 'unknown') unknownAgents.push(info);
          else busy.push(info);
        }
      } catch (error) {
        logger.warn({ error, projectId, remoteId }, 'VM agent sessions could not be checked');
        throw new RemoteOperationStepRefusedError(
          'GIT_TAKE_AGENTS_UNKNOWN',
          'Agent sessions on the VM could not be checked. Try again, or use `devchain git take --force`.',
        );
      }
      if (busy.length)
        throw new RemoteOperationStepRefusedError(
          'GIT_TAKE_AGENTS_BUSY',
          'Agents on the VM are busy or starting. Wait for them to finish, or use `devchain git take --force`.',
          { agents: busy },
        );
    }
    return this.runner.start({
      kind: 'git_owner',
      remoteId,
      projectId,
      details: { owner, force, unknownAgents },
    });
  }

  async gitOwnerStatus(projectId: string): Promise<GitOwnerStatus> {
    await this.storage.getProject(projectId);
    const binding = await this.storage.getRemoteProjectBinding(projectId);
    const [operation] = await this.storage.listRemoteOperations({
      projectId,
      kinds: ['git_owner'],
      states: ['running', 'failed'],
      limit: 1,
    });
    const remote = binding ? await this.storage.getRemote(binding.remoteId) : null;
    const step =
      operation?.steps.find((item) => item.state === 'running' || item.state === 'failed') ??
      operation?.steps.find((item) => item.state === 'pending');
    return {
      connected: binding?.state === 'remote',
      remoteId: binding?.remoteId ?? null,
      remoteName: remote?.name ?? null,
      owner: binding ? this.gitOwners.get(projectId) : 'home',
      open: operation
        ? {
            operationId: operation.id,
            owner: operation.details.owner as GitOwner,
            force: operation.details.force === true,
            state: operation.state === 'failed' ? 'failed' : 'running',
            step: step?.id ?? null,
            error: step?.error ?? null,
          }
        : null,
    };
  }

  /**
   * Claims an unclaimed VM. With `baseUrl` (the bootstrap's address) the
   * remote is created for DevChain's address on the VM: the same host with
   * the claimed port. The VM always receives this PC's OS user and home path,
   * so stored absolute paths stay valid on the VM.
   */
  async claim(input: ClaimRemoteData): Promise<RemoteOperation> {
    const port = input.port ?? getEnvConfig().PORT;
    const details = await this.claimDetails({
      bootstrapUrl: '',
      providerAuth: input.providerAuth,
      installDocker: input.installDocker,
      sshPublicKeys: input.sshPublicKeys,
      port,
    });
    let remote: Remote;
    let bootstrapUrl: string;
    if (input.remoteId) {
      remote = await this.storage.getRemote(input.remoteId);
      await this.assertNoOpenHostOperation(remote.id);
      const address = requireRemoteAddress(remote);
      if (portOf(address) !== port) {
        throw new ValidationError(
          `The remote's address uses port ${portOf(address)}, but DevChain on the VM would listen on ${port}.`,
          { reason: 'claim_port_mismatch' },
        );
      }
      bootstrapUrl = address;
    } else {
      // The bootstrap and DevChain on the VM serve one certificate, so the
      // bootstrap's approves both. Nothing is saved or sent on a mismatch.
      const origin = normalizeRemoteBaseUrl(input.baseUrl ?? '');
      if (!origin) throw new ValidationError(BASE_URL_MESSAGE, { reason: 'base_url_invalid' });
      const certificate = await this.remotes.approveCertificate(
        origin,
        input.certificateFingerprint ?? '',
      );
      const prepared = await this.prepareAddressRemote(origin, input.name, port, certificate);
      remote = prepared.remote;
      bootstrapUrl = prepared.bootstrapUrl;
      await this.assertNoOpenHostOperation(remote.id);
      if (remote.tlsCertificate !== certificate) {
        remote = await this.storage.updateRemoteTlsCertificate(remote.id, certificate);
      }
      details.tlsCertificate = certificate;
    }
    details.bootstrapUrl = bootstrapUrl;
    return this.runner.start({
      kind: 'claim',
      remoteId: remote.id,
      projectId: null,
      details: details as unknown as Record<string, unknown>,
    });
  }

  async installHost(input: InstallHostData): Promise<RemoteOperation> {
    // The claim would refuse this only after the full install; check it now
    // so a refusal costs no SSH connection and names the rule and the value.
    assertClaimableIdentity();
    const resolvedSsh = await this.sshKeys.resolve(input.ssh);
    const port = getEnvConfig().PORT;
    const source = new URL(input.address);
    source.protocol = 'https:';
    source.port = '3000';
    const prepared = await this.prepareAddressRemote(source.origin, input.name, port);
    await this.assertNoOpenHostOperation(prepared.remote.id);
    const claim = await this.claimDetails({
      bootstrapUrl: prepared.bootstrapUrl,
      providerAuth: input.providerAuth,
      installDocker: input.installDocker,
      sshPublicKeys: input.sshPublicKeys,
      port,
    });
    const operationId = randomUUID();
    const details: InstallHostDetails = {
      ...claim,
      address: stripIpv6Brackets(new URL(input.address).hostname),
      sshUser: input.ssh.user,
      sshAuthKind: resolvedSsh.credentials.privateKey ? 'key' : 'password',
      ...(resolvedSsh.keyName ? { sshKeyName: resolvedSsh.keyName } : {}),
      minDiskGib: input.minDiskGib,
      ...(input.name ? { name: input.name } : {}),
    };
    this.installHostOperation.seedCredentials(operationId, resolvedSsh.credentials);
    try {
      return await this.runner.start({
        id: operationId,
        kind: 'install_host',
        remoteId: prepared.remote.id,
        projectId: null,
        details: details as unknown as Record<string, unknown>,
      });
    } catch (error) {
      this.installHostOperation.forget(operationId);
      throw error;
    }
  }

  async claimDetails(input: {
    bootstrapUrl: string;
    providerAuth: ProviderAuthSelection;
    installDocker?: boolean;
    sshPublicKeys?: string[];
    port?: number;
  }): Promise<ClaimDetails> {
    // The VM identity is locked to this PC; refuse a user name the bootstrap
    // would reject before any connection is opened.
    const identity = assertClaimableIdentity();
    const providerAuth = await this.providerChoices(input.providerAuth);
    return {
      bootstrapUrl: input.bootstrapUrl,
      userName: identity.user,
      homePath: identity.homePath,
      // Only a real POSIX uid can be requested; null never leaves a field the
      // bootstrap would refuse.
      ...(identity.uid !== null ? { uid: identity.uid } : {}),
      ...(identity.gid !== null ? { gid: identity.gid } : {}),
      version: getAppVersion(),
      port: input.port ?? getEnvConfig().PORT,
      providerAuth,
      installDocker: input.installDocker,
      sshPublicKeys: input.sshPublicKeys,
    };
  }

  /** Installs this home's version on a claimed host VM. */
  async updateHost(remoteId: string, installDocker?: boolean): Promise<RemoteOperation> {
    await this.storage.getRemote(remoteId);
    await this.assertNoOpenHostOperation(remoteId);
    const health = await this.health.refresh(remoteId);
    const optedIn = (await this.lastInstallDockerChoice(remoteId)) === true;
    const details: UpdateHostDetails = {
      version: getAppVersion(),
      versionChange: health.version !== getAppVersion(),
      installDocker: installDocker ?? optedIn,
      dockerChange:
        installDocker === true &&
        (!optedIn || !(health.docker?.installed && health.docker.userInGroup)),
    };
    return this.runner.start({
      kind: 'update_host',
      remoteId,
      projectId: null,
      details: details as unknown as Record<string, unknown>,
    });
  }

  async updateLogins(remoteId: string, input: UpdateLoginsData): Promise<RemoteOperation> {
    const remote = await this.storage.getRemote(remoteId);
    await this.assertNoOpenHostOperation(remoteId);
    const [previousOperation] = await this.storage.listRemoteOperations({
      remoteId,
      kinds: CLAIM_IDENTITY_KINDS,
      states: ['done'],
      limit: 1,
    });
    const previous = previousOperation?.details as unknown as UpdateLoginsDetails | undefined;
    if (!previous) throw new ConflictError('This VM has no completed login setup.');
    const families = await this.vault.familiesOfRemote(remoteId);
    const previousProviderAuth: Record<string, ClaimProviderState> = {};
    for (const [provider, state] of Object.entries(previous.providerAuth)) {
      previousProviderAuth[provider] = {
        choice: state.choice,
        entryId: state.entryId,
        entryIds: state.entryIds,
        checkedOut: families
          .filter((family) => family.provider === provider)
          .map((family) => family.entryId),
      };
    }
    const choices = await this.providerChoices(input.providerAuth);
    const providerAuth = { ...previousProviderAuth };
    for (const [provider, choice] of Object.entries(choices)) {
      providerAuth[provider] = {
        ...choice,
        checkedOut: previousProviderAuth[provider]?.checkedOut,
      };
    }
    const details: UpdateLoginsDetails = {
      bootstrapUrl: requireRemoteAddress(remote),
      userName: previous.userName,
      sshPublicKeys: previous.sshPublicKeys,
      homePath: previous.homePath,
      version: getAppVersion(),
      port: previous.port,
      claimed: true,
      force: input.force,
      previousProviderAuth,
      providerAuth,
      changedProviders: Object.keys(choices),
      reauth: Object.keys(choices),
      appliedManifest: previous.appliedManifest,
    };
    return this.runner.start({
      kind: 'update_logins',
      remoteId,
      projectId: null,
      details: details as unknown as Record<string, unknown>,
    });
  }

  async attach(
    remoteId: string,
    projectId: string,
    docker?: DockerSelection,
  ): Promise<RemoteOperation> {
    requireRemoteAddress(await this.storage.getRemote(remoteId));
    await this.assertNoOpenVmOperation(remoteId);
    await this.storage.getProject(projectId);
    const includeDocker = Boolean(docker?.items.length);
    const operation = await this.runner.start({
      kind: 'attach',
      remoteId,
      projectId,
      details: includeDocker ? { dockerSelection: docker } : {},
    });
    this.choices.recordAttach(projectId, remoteId, includeDocker);
    return operation;
  }

  async forceSync(
    remoteId: string,
    projectId: string,
    source: ForceSyncSource,
  ): Promise<RemoteOperation> {
    requireRemoteAddress(await this.storage.getRemote(remoteId));
    await this.assertNoOpenVmOperation(remoteId);
    await this.storage.getProject(projectId);
    const offer = await this.files.forceSyncOffer(projectId);
    if (!offer.offered)
      throw new ConflictError(offer.reason ?? 'Force sync is not available for this project.');
    return this.runner.start({
      kind: 'force_sync',
      remoteId,
      projectId,
      details: { source, forceSync: { source } },
    });
  }

  /**
   * A detach takes over a failed operation of the project without rolling it
   * back: a failed attach that already handed the project to the remote (its
   * rollback would release the host copy with the host's work), or, when
   * forced, a failed detach or force sync whose host steps cannot run. Any other open
   * operation keeps the detach out (409 from storage).
   */
  async detach(
    remoteId: string,
    projectId: string,
    force: boolean,
    dockerCopyBack?: DockerCopyBackRequest,
  ): Promise<RemoteOperation> {
    await this.storage.getRemote(remoteId);
    await this.assertNoOpenVmOperation(remoteId);
    await this.storage.getProject(projectId);
    const superseded = await this.supersedeOpenOperation(projectId, force);
    const details: DetachDetails = { force, ...(dockerCopyBack && !force && { dockerCopyBack }) };
    const detach = await this.runner.start({
      kind: 'detach',
      remoteId,
      projectId,
      details: details as Record<string, unknown>,
    });
    if (superseded) {
      await this.storage.updateRemoteOperation(superseded.id, {
        details: { ...superseded.details, supersededBy: detach.id },
      });
      logger.info(
        { operationId: superseded.id, kind: superseded.kind, detachId: detach.id, projectId },
        'Failed operation taken over by a detach',
      );
    }
    return detach;
  }

  private async supersedeOpenOperation(
    projectId: string,
    force: boolean,
  ): Promise<RemoteOperation | null> {
    const [open] = await this.storage.listRemoteOperations({
      projectId,
      states: ['running', 'failed'],
      limit: 1,
    });
    if (!open || open.state !== 'failed') return null;
    // A retry may be executing or may start before the takeover: decide on the
    // row as it is once no step runs, and write only if it is still failed.
    await this.runner.whenIdle(open.id);
    const current = await this.storage.getRemoteOperation(open.id);
    if (current.state === 'running') throw inProgress(current, 'Another operation is running.');
    if (current.state !== 'failed') return null;
    if (current.kind === 'attach' && !stepDone(current, 'bind_remote')) {
      throw inProgress(
        current,
        'The connect has not handed the project to the remote; cancel it instead.',
      );
    }
    if (current.kind === 'detach' && !force) {
      throw inProgress(current, 'A disconnect failed; retry it or force a new disconnect.');
    }
    if ((current.kind === 'force_sync' || current.kind === 'git_owner') && !force) {
      throw inProgress(
        current,
        `${current.kind === 'git_owner' ? 'The Git switch' : 'Force sync'} failed; retry it, or force a disconnect.`,
      );
    }
    if (
      current.kind !== 'attach' &&
      current.kind !== 'detach' &&
      current.kind !== 'force_sync' &&
      current.kind !== 'git_owner'
    ) {
      throw inProgress(current, 'Another operation is open for this project.');
    }
    return this.runner.supersede(current, { supersededAt: new Date().toISOString() });
  }

  list(filter: {
    projectId?: string;
    state?: RemoteOperationState;
    limit?: number;
  }): Promise<RemoteOperation[]> {
    return this.storage.listRemoteOperations({
      projectId: filter.projectId,
      states: filter.state ? [filter.state] : undefined,
      limit: filter.limit,
    });
  }

  get(id: string): Promise<RemoteOperation> {
    return this.storage.getRemoteOperation(id);
  }

  /**
   * Re-runs a failed operation. For a claim whose login check failed,
   * `providerAuth` may replace the choices of the providers that failed.
   */
  async retry(
    id: string,
    providerAuth?: ProviderAuthSelection,
    ssh?: InstallHostData['ssh'],
  ): Promise<RemoteOperation> {
    const operation = await this.storage.getRemoteOperation(id);
    // A switch that just failed may still be finishing; a running one is refused at once below.
    if (operation.kind === 'git_owner' && operation.state === 'failed') {
      await this.runner.whenIdle(id);
      await this.gitSwitch.validate(operation.remoteId, operation.projectId!, operation);
    }
    const mismatch = claimIdentityMismatch(operation.kind, operation.details);
    if (mismatch) {
      throw new ValidationError(mismatch, {
        reason: 'claim_identity_mismatch',
        operationId: id,
      });
    }
    if (ssh) {
      if (operation.kind !== 'install_host' || operation.state !== 'failed') {
        throw new ValidationError('SSH credentials apply only to a failed host installation.', {
          reason: 'retry_ssh_not_applicable',
        });
      }
      const resolvedSsh = await this.sshKeys.resolve(ssh);
      const details = { ...operation.details };
      delete details.sshKeyName;
      await this.storage.updateRemoteOperation(id, {
        expectedState: 'failed',
        details: {
          ...details,
          sshUser: ssh.user,
          sshAuthKind: resolvedSsh.credentials.privateKey ? 'key' : 'password',
          ...(resolvedSsh.keyName ? { sshKeyName: resolvedSsh.keyName } : {}),
        },
      });
      this.installHostOperation.seedCredentials(id, resolvedSsh.credentials);
    }
    if (providerAuth && Object.keys(providerAuth).length > 0) {
      await this.replaceFailedChoices(id, providerAuth);
    }
    return this.runner.retry(id);
  }

  private async replaceFailedChoices(id: string, selection: ProviderAuthSelection): Promise<void> {
    const operation = await this.storage.getRemoteOperation(id);
    const details = operation.details as unknown as ClaimDetails;
    const reauth = details.reauth ?? [];
    const unexpected = Object.keys(selection).filter((provider) => !reauth.includes(provider));
    if (
      !(CLAIM_IDENTITY_KINDS as readonly string[]).includes(operation.kind) ||
      operation.state !== 'failed' ||
      unexpected.length > 0
    ) {
      throw new ValidationError(
        'New login choices apply only to the providers whose check failed in a claim.',
        { reason: 'retry_choices_not_applicable', providers: unexpected },
      );
    }
    const choices = await this.providerChoices(selection);
    const providerAuth = { ...details.providerAuth };
    for (const [provider, choice] of Object.entries(choices)) {
      // The resolve step releases what the old choice checked out.
      providerAuth[provider] = { ...choice, checkedOut: providerAuth[provider]?.checkedOut };
    }
    await this.storage.updateRemoteOperation(id, {
      details: {
        ...operation.details,
        providerAuth,
        ...(operation.kind === 'update_logins' ? { choicesReplaced: true } : {}),
      },
      expectedState: 'failed',
    });
  }

  /**
   * The VM row for a setup at `origin`, an already normalized https origin;
   * created when missing. A new row gets `tlsCertificate`; an existing row
   * keeps its own until the caller replaces it.
   */
  private async prepareAddressRemote(
    origin: string,
    name: string | undefined,
    port: number,
    tlsCertificate: string | null = null,
  ): Promise<{ remote: Remote; bootstrapUrl: string }> {
    const url = new URL(origin);
    const bootstrapUrl = url.origin;
    url.port = String(port);
    const devchainUrl = url.origin;
    const existing = (await this.storage.listRemotes({ limit: 500 })).items.find(
      (item) => item.baseUrl === devchainUrl,
    );
    const remote =
      existing ??
      (await this.storage.createRemote({
        name: name ?? url.hostname,
        baseUrl: devchainUrl,
        kind: 'address',
        tlsCertificate,
      }));
    return { remote, bootstrapUrl };
  }

  private async providerChoices(
    selection: ProviderAuthSelection,
  ): Promise<Record<string, ClaimProviderState>> {
    const choices: Record<string, ClaimProviderState> = {};
    for (const [provider, choice] of Object.entries(selection)) {
      if (!this.providers.isSupported(provider)) {
        throw new ValidationError(`Provider "${provider}" is not supported.`, {
          reason: 'provider_not_supported',
          supported: this.providers.getSupportedProviders(),
        });
      }
      if (choice === 'skip') {
        choices[provider] = { choice: 'skip' };
      } else if (choice === 'generate') {
        if (!PROVIDER_AUTH_LOGIN_ADAPTERS[provider]) {
          throw new ValidationError(`${provider} has no isolated login; choose a stored token.`, {
            reason: 'provider_auth_paste_only',
            provider,
          });
        }
        choices[provider] = { choice: 'generate' };
      } else {
        const entryId = choice.slice('reuse:'.length);
        const entry = await this.vault.get(entryId);
        if (entry.provider !== provider) {
          throw new ValidationError(`The login "${entry.label}" belongs to ${entry.provider}.`, {
            reason: 'provider_auth_provider_mismatch',
            provider,
          });
        }
        choices[provider] = { choice: 'reuse', entryId };
      }
    }
    return choices;
  }

  /** One host or VM lifecycle operation per remote at a time. */
  /** The Docker option that the last finished operation on this remote recorded, if any. */
  async lastInstallDockerChoice(remoteId: string): Promise<boolean | undefined> {
    const previous = await this.storage.listRemoteOperations({
      remoteId,
      kinds: ['claim', 'create_vm', 'install_host', 'reset_vm', 'update_host'],
      states: ['done'],
      limit: 200,
    });
    return previous.find((operation) => typeof operation.details.installDocker === 'boolean')
      ?.details.installDocker as boolean | undefined;
  }

  async assertNoOpenHostOperation(remoteId: string): Promise<void> {
    const open = (
      await this.storage.listRemoteOperations({
        states: ['running', 'failed'],
        remoteId,
        kinds: HOST_LIFECYCLE_KINDS,
        limit: 1,
      })
    ).find(
      (operation) =>
        operation.remoteId === remoteId &&
        (HOST_LIFECYCLE_KINDS as readonly string[]).includes(operation.kind),
    );
    if (open) {
      throw inProgress(open, 'A host lifecycle operation is already open for this remote.');
    }
  }

  private async assertNoOpenVmOperation(remoteId: string): Promise<void> {
    const open = (
      await this.storage.listRemoteOperations({
        states: ['running', 'failed'],
        remoteId,
        kinds: VM_LIFECYCLE_KINDS,
        limit: 1,
      })
    ).find(
      (operation) =>
        operation.remoteId === remoteId &&
        (VM_LIFECYCLE_KINDS as readonly string[]).includes(operation.kind),
    );
    if (open) throw inProgress(open, 'A VM lifecycle operation is open for this remote.');
  }

  cancel(id: string): Promise<RemoteOperation> {
    return this.runner.cancel(id);
  }
}

function portOf(baseUrl: string): number {
  const url = new URL(baseUrl);
  return url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
}

function stepDone(operation: RemoteOperation, stepId: string): boolean {
  return operation.steps.some((step) => step.id === stepId && step.state === 'done');
}

function inProgress(operation: RemoteOperation, message: string): ConflictError {
  return new ConflictError(message, {
    code: 'REMOTE_OPERATION_IN_PROGRESS',
    projectId: operation.projectId,
    operationId: operation.id,
    kind: operation.kind,
    state: operation.state,
  });
}
