import { RemoteApiKeyService } from '../auth/remote-api-key.service';
import {
  HOST_API_KEY_REJECTED,
  HOST_API_KEY_REJECTED_MESSAGE,
  hashHostApiKey,
} from '../host-api-key';
import { dockerStep } from './docker.step';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { AppError, ConflictError } from '../../../common/errors/error-types';
import { createLogger } from '../../../common/logging/logger';
import {
  PROVIDER_AUTH_VERIFY,
  type ProviderAuthClaimBundle,
  type ProviderAuthClaimFile,
} from '../../provider-auth/provider-auth-adapters';
import { ProviderAuthGeneratorService } from '../../provider-auth/provider-auth-generator.service';
import { ProviderAuthVaultService } from '../../provider-auth/provider-auth-vault.service';
import { STORAGE_SERVICE, type RemoteStorage } from '../../storage/interfaces/storage.interface';
import type { RemoteOperation } from '../../storage/models/domain.models';
import { ProcessExecutor } from '../../terminal/services/process-executor/process-executor.port';
import { REMOTE_HEALTH_PORT, type RemoteHealthPort } from '../ports/remote-health.port';
import {
  RemoteHostClient,
  RemoteHostRequestError,
  type HostClaimOutcome,
  type HostProviderVerify,
} from './remote-host.client';
import { requireRemoteAddress } from '../remote-address';
import { RemoteOperationStepRefusedError } from './remote-operation.errors';
import {
  DEFAULT_REMOTE_OPERATION_TIMING,
  REMOTE_OPERATION_TIMING,
  sleep,
  type RemoteOperationTiming,
} from './remote-operation.timing';
import {
  stepStarted,
  type RemoteOperationDefinition,
  type RemoteOperationStepDefinition,
  type RemoteOperationStepRun,
} from './remote-operation.types';
import { buildGlobalGitConfigClaimFile } from './git-global-config';
import { isSupportedHostImage, unsupportedHostImageMessage } from '../host-image';
import { reportedVmUserMismatch, vmUserWarning } from '../vm-user-identity';

const logger = createLogger('ClaimOperation');

/** The bootstrap's rules (`apps/host-bootstrap/lib/validate.js`), checked before anything else. */
export const USER_NAME = /^[a-z_][a-z0-9_-]{0,31}$/;
export const HOME_ROOTS = ['/home/', '/Users/', '/var/home/'];

export const PROVIDER_AUTH_CHOICES = ['reuse', 'generate', 'skip'] as const;
export type ProviderAuthChoice = (typeof PROVIDER_AUTH_CHOICES)[number];

/** What the claim knows about one provider; never holds credentials. */
export interface ClaimProviderState {
  choice: ProviderAuthChoice;
  /** The chosen entry of a `reuse` choice. */
  entryId?: string;
  /** Entries resolved for this claim; families among them are checked out to the remote. */
  entryIds?: string[];
  /** Families this claim checked out, released again by a cancel or a re-auth. */
  checkedOut?: string[];
  /** The isolated login of a `generate` choice; the UI attaches to `sessionId`. */
  generationId?: string;
  sessionId?: string;
  opencodeProviderIds?: string[];
}

export interface ClaimDetails {
  installDocker?: boolean;
  sshPublicKeys?: string[];
  /** Where the VM's bootstrap answers before the claim. */
  bootstrapUrl: string;
  /**
   * The VM certificate (PEM) approved for this setup through a trusted
   * channel. Retries reuse it and never read it from the network again.
   */
  tlsCertificate?: string;
  userName: string;
  homePath: string;
  /** This PC's uid, asked of the VM when free; an old bootstrap drops it. */
  uid?: number;
  gid?: number;
  version: string;
  port: number;
  providerAuth: Record<string, ClaimProviderState>;
  /** The VM accepted the claim; later provider logins go to its host route. */
  claimed?: boolean;
  /** Providers whose login failed the host check; a retry resolves only these. */
  reauth?: string[];
  verified?: Record<string, HostProviderVerify>;
  /** What the last bundle contained: env keys and file paths, no values. */
  bundleSummary?: { envKeys: string[]; files: string[] };
}

/**
 * Claims an unclaimed host VM for this home: resolves the chosen provider
 * logins, sends them with the claim, checks each login on the host, and
 * registers the remote. The claim bundle is built in memory and sent once;
 * it is never persisted in the operation.
 */
@Injectable()
export class ClaimOperation implements RemoteOperationDefinition {
  readonly kind = 'claim' as const;
  readonly steps: readonly RemoteOperationStepDefinition[];
  private readonly bundles = new Map<string, ProviderAuthClaimBundle>();
  /** Isolated logins a resolve step is waiting on, by operation. */
  private readonly waiting = new Map<string, Set<string>>();
  private readonly timing: RemoteOperationTiming;

  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: RemoteStorage,
    @Inject(REMOTE_HEALTH_PORT) private readonly health: RemoteHealthPort,
    private readonly host: RemoteHostClient,
    private readonly vault: ProviderAuthVaultService,
    private readonly generator: ProviderAuthGeneratorService,
    private readonly processExecutor: ProcessExecutor,
    private readonly apiKeys: RemoteApiKeyService,
    @Optional() @Inject(REMOTE_OPERATION_TIMING) timing: RemoteOperationTiming | null = null,
  ) {
    this.timing = timing ?? DEFAULT_REMOTE_OPERATION_TIMING;
    this.steps = [
      { id: 'preflight', label: 'Check the VM', run: (c) => this.preflight(c) },
      {
        id: 'provider_auth_resolve',
        label: 'Prepare the logins',
        run: (c) => this.resolveProviderAuth(c),
      },
      { id: 'build_bundle', label: 'Package the logins', run: (c) => this.buildBundle(c) },
      { id: 'claim', label: 'Set up the VM and start DevChain', run: (c) => this.claim(c) },
      {
        id: 'verify_providers',
        label: 'Test the logins on the VM (Antigravity and Copilot make one model call)',
        run: (c) => this.verifyProviders(c),
      },
      {
        id: 'ssh_keys',
        label: 'Add your SSH key',
        skip: (details) => !(details as unknown as ClaimDetails).sshPublicKeys?.length,
        run: async ({ operation, details }) => {
          const keys = (details as unknown as ClaimDetails).sshPublicKeys ?? [];
          if (keys.length > 0) await this.host.applySshKeys(operation.remoteId, keys);
        },
      },
      { id: 'register_remote', label: 'Add the VM to this PC', run: (c) => this.registerRemote(c) },
      dockerStep(this.host, this.timing),
    ];
  }

  forget(operationId: string): void {
    this.bundles.delete(operationId);
  }

  /** Ends the logins the resolve step waits on; the step then fails and the cancel proceeds. */
  async interrupt(operationId: string): Promise<void> {
    for (const generationId of this.waiting.get(operationId) ?? []) {
      await this.generator.cancel(generationId).catch(() => undefined);
    }
  }

  assertCancellable(operation: RemoteOperation): void {
    if (stepStarted(operation, 'claim')) {
      throw new ConflictError('The VM may already be claimed; retry the operation instead.', {
        code: 'REMOTE_OPERATION_NOT_CANCELLABLE',
        operationId: operation.id,
      });
    }
  }

  retryFrom(operation: RemoteOperation): string | null {
    const failed = operation.steps.find((step) => step.state === 'failed');
    const reauth = (operation.details as Partial<ClaimDetails>).reauth ?? [];
    return failed?.id === 'verify_providers' && reauth.length > 0 ? 'provider_auth_resolve' : null;
  }

  /** Releases the families this claim checked out and stops its isolated logins. */
  async rollback(operation: RemoteOperation): Promise<void> {
    this.bundles.delete(operation.id);
    const details = operation.details as unknown as ClaimDetails;
    for (const state of Object.values(details.providerAuth ?? {})) {
      if (state.generationId) {
        await this.generator.cancel(state.generationId).catch(() => undefined);
      }
      for (const entryId of state.checkedOut ?? []) {
        await this.vault.release(entryId).catch(() => undefined);
      }
    }
  }

  private async preflight({ operation, details }: RemoteOperationStepRun): Promise<void> {
    const claim = details as unknown as ClaimDetails;
    if (!USER_NAME.test(claim.userName)) {
      throw refused('CLAIM_USER_NAME_INVALID', `"${claim.userName}" is not a valid user name.`);
    }
    if (!HOME_ROOTS.some((root) => claim.homePath.startsWith(root))) {
      throw refused(
        'CLAIM_HOME_PATH_INVALID',
        `The home path must be under ${HOME_ROOTS.join(', ')}.`,
      );
    }
    const runtime = await this.host.runtimeAt(
      claim.bootstrapUrl,
      await this.certificateFor(operation, claim),
    );
    if (runtime.state !== 'unclaimed') {
      throw refused(
        'VM_NOT_UNCLAIMED',
        runtime.version
          ? `The VM already runs DevChain ${runtime.version}; it is claimed.`
          : 'The address does not answer as an unclaimed DevChain host VM.',
      );
    }
    const imageVersion = runtime.imageVersion ?? null;
    if (!isSupportedHostImage(imageVersion)) {
      throw refused('HOST_IMAGE_UNSUPPORTED', unsupportedHostImageMessage(imageVersion));
    }
    logger.info({ operationId: operation.id, imageVersion }, 'Unclaimed VM checked');
  }

  private async resolveProviderAuth(run: RemoteOperationStepRun): Promise<void> {
    const claim = run.details as unknown as ClaimDetails;
    for (const provider of this.targets(claim)) {
      const state = claim.providerAuth[provider];
      if (claim.reauth?.includes(provider)) {
        await this.releaseCheckedOut(state);
        state.entryIds = undefined;
        if (state.choice === 'generate' && state.generationId) {
          // A finished login from before the check is replaced by a new one.
          state.generationId = undefined;
          state.sessionId = undefined;
        }
      }
      if (state.choice === 'reuse') {
        await this.resolveReuse(run.operation, provider, state);
      } else if (state.choice === 'generate') {
        await this.resolveGenerate(run, provider, state);
      }
      if (provider === 'opencode' && state.entryIds) {
        state.opencodeProviderIds = await this.vault.opencodeProviderIds(state.entryIds);
      }
    }
  }

  private async resolveReuse(
    operation: RemoteOperation,
    provider: string,
    state: ClaimProviderState,
  ): Promise<void> {
    const entryIds = claimEntryIds(state);
    if (entryIds.length === 0)
      throw refused('PROVIDER_AUTH_ENTRY_MISSING', `No login chosen for ${provider}.`);
    for (const entryId of entryIds) {
      const entry = await this.vault.get(entryId);
      if (entry.provider !== provider) {
        throw refused(
          'PROVIDER_AUTH_PROVIDER_MISMATCH',
          `The login "${entry.label}" belongs to ${entry.provider}, not ${provider}.`,
        );
      }
      if (entry.kind === 'family')
        await this.checkout(operation, provider, state, entryId, entry.label);
    }
    state.entryIds = entryIds;
  }

  /** Starts, or after a restart resumes, the isolated login and waits for its outcome. */
  private async resolveGenerate(
    run: RemoteOperationStepRun,
    provider: string,
    state: ClaimProviderState,
  ): Promise<void> {
    if (state.entryIds) return;
    let generation = state.generationId ? this.findGeneration(state.generationId) : null;
    if (!generation) {
      const remote = await this.storage.getRemote(run.operation.remoteId);
      generation = await this.generator.start(provider, `${remote.name} ${provider}`);
      state.generationId = generation.id;
      state.sessionId = generation.sessionId;
      await run.progress({ providerAuth: (run.details as unknown as ClaimDetails).providerAuth });
    }
    const waiting = this.waiting.get(run.operation.id) ?? new Set<string>();
    this.waiting.set(run.operation.id, waiting.add(generation.id));
    try {
      while (!generation.finishedAt) {
        await sleep(this.timing.pollIntervalMs);
        generation = this.generator.get(generation.id);
      }
    } finally {
      waiting.delete(generation.id);
      if (waiting.size === 0) this.waiting.delete(run.operation.id);
    }
    if (generation.state !== 'stored') {
      state.generationId = undefined;
      state.sessionId = undefined;
      throw refused(
        'PROVIDER_AUTH_GENERATION_FAILED',
        `The ${provider} login ended ${generation.state}${generation.error ? `: ${generation.error}` : '.'}`,
      );
    }
    for (const entry of generation.entries) {
      if (entry.kind === 'family') {
        await this.checkout(run.operation, provider, state, entry.id, entry.label);
      }
    }
    state.entryIds = generation.entries.map((entry) => entry.id);
  }

  private findGeneration(id: string) {
    try {
      return this.generator.get(id);
    } catch {
      // Generations live in memory; after a restart the login starts over.
      return null;
    }
  }

  private async checkout(
    operation: RemoteOperation,
    provider: string,
    state: ClaimProviderState,
    entryId: string,
    label: string,
  ): Promise<void> {
    try {
      await this.vault.checkout(entryId, operation.remoteId);
    } catch (error) {
      const holder =
        error instanceof AppError
          ? (error.details?.checkedOutRemoteId as string | undefined)
          : undefined;
      if (!holder) throw error;
      const name = await this.storage
        .getRemote(holder)
        .then((remote) => remote.name)
        .catch(() => holder);
      throw refused(
        'PROVIDER_AUTH_ALREADY_CHECKED_OUT',
        `The ${provider} login "${label}" is in use by remote "${name}". Release it there or choose another login.`,
        { entryId, checkedOutRemoteId: holder, checkedOutRemoteName: name },
      );
    }
    state.checkedOut = [...new Set([...(state.checkedOut ?? []), entryId])];
  }

  private async releaseCheckedOut(state: ClaimProviderState): Promise<void> {
    for (const entryId of state.checkedOut ?? []) {
      await this.vault.release(entryId).catch(() => undefined);
    }
    state.checkedOut = [];
  }

  private async buildBundle({ operation, details }: RemoteOperationStepRun): Promise<void> {
    const bundle = await this.bundleFor(details as unknown as ClaimDetails);
    this.bundles.set(operation.id, bundle);
    (details as unknown as ClaimDetails).bundleSummary = {
      envKeys: Object.keys(bundle.env),
      files: bundle.files.map((file) => file.path),
    };
  }

  private async claim({ operation, details }: RemoteOperationStepRun): Promise<void> {
    const claim = details as unknown as ClaimDetails;
    // Rebuilt after a restart: the vault holds the same entries.
    const bundle = this.bundles.get(operation.id) ?? (await this.bundleFor(claim));
    try {
      if (claim.claimed) {
        await this.host.applyProviderAuth(operation.remoteId, bundle);
        return;
      }
      let outcome: HostClaimOutcome = 'starting';
      const certificate = await this.certificateFor(operation, claim);
      try {
        const apiKey = await this.apiKeys.getOrCreate(operation.remoteId);
        const keyFile = hostApiKeyFile(claim.homePath, apiKey);
        const gitConfig = await this.gitConfigFile(claim.homePath);
        outcome = await this.host.claim(
          claim.bootstrapUrl,
          certificate,
          {
            userName: claim.userName,
            homePath: claim.homePath,
            ...(claim.uid !== undefined ? { uid: claim.uid } : {}),
            ...(claim.gid !== undefined ? { gid: claim.gid } : {}),
            version: claim.version,
            port: claim.port,
            providerAuth: {
              ...bundle,
              files: [...bundle.files, ...(gitConfig ? [gitConfig] : []), keyFile],
            },
          },
          apiKey,
        );
      } catch (error) {
        if (!(error instanceof RemoteHostRequestError) || error.status !== null) throw error;
      }
      if (outcome !== 'claimed') await this.waitWhileInstalling(claim.bootstrapUrl, certificate);
      const remote = await this.storage.getRemote(operation.remoteId);
      // A refused claim can be this claim's own earlier attempt, still installing
      // or answered after a restart; only another DevChain version proves otherwise.
      const address = requireRemoteAddress(remote);
      const answer = await this.waitForDevChain(address, certificate, claim.version);
      if (answer !== 'ready') {
        throw answer === 'other_version' || outcome === 'already_claimed'
          ? refused('VM_ALREADY_CLAIMED', 'The VM is already claimed by someone else.')
          : refused('HOST_START_TIMEOUT', `DevChain did not answer on ${address} after the claim.`);
      }
      claim.claimed = true;
    } finally {
      this.bundles.delete(operation.id);
    }
  }

  private async certificateFor(operation: RemoteOperation, claim: ClaimDetails): Promise<string> {
    return claim.tlsCertificate ?? (await this.host.certificateOf(operation.remoteId));
  }

  /**
   * The claim request gets no answer once Node's fetch has waited 300 s for
   * headers, while the bootstrap keeps installing. It reports `claiming` on
   * its own port until the handover, when it stops listening.
   */
  private async waitWhileInstalling(bootstrapUrl: string, certificate: string): Promise<void> {
    const deadline = Date.now() + this.timing.claimInstallTimeoutMs;
    let installing = false;
    while (Date.now() < deadline) {
      const runtime = await this.host.runtimeAt(bootstrapUrl, certificate).catch(() => null);
      if (runtime?.state === 'claiming') {
        installing = true;
      } else if (installing && runtime?.state === 'unclaimed') {
        // A failed bootstrap claim resets to `unclaimed`; waiting for DevChain would be pointless.
        throw refused(
          'CLAIM_INSTALL_FAILED',
          'The VM stopped the install: its bootstrap reports no claim in progress. See `journalctl -u devchain-bootstrap` on the VM, then retry.',
        );
      } else {
        return;
      }
      await sleep(this.timing.pollIntervalMs);
    }
  }

  private async gitConfigFile(homePath: string): Promise<ProviderAuthClaimFile | null> {
    // The file can hold secrets; only its outcome is logged, never its content.
    const file = await buildGlobalGitConfigClaimFile(this.processExecutor, homePath);
    if (file === null) {
      logger.info('git config: not set on this PC; the VM gets none');
      return null;
    }

    logger.info('git config: sent');
    return file;
  }

  private async waitForDevChain(
    baseUrl: string,
    certificate: string,
    version: string,
  ): Promise<'ready' | 'other_version' | 'timeout'> {
    const deadline = Date.now() + this.timing.claimStartTimeoutMs;
    for (;;) {
      const runtime = await this.host.runtimeAt(baseUrl, certificate).catch(() => null);
      if (runtime?.version === version) return 'ready';
      if (runtime?.version) return 'other_version';
      if (Date.now() >= deadline) return 'timeout';
      await sleep(this.timing.pollIntervalMs);
    }
  }

  private async verifyProviders({ operation, details }: RemoteOperationStepRun): Promise<void> {
    const claim = details as unknown as ClaimDetails;
    const verified: Record<string, HostProviderVerify> = { ...claim.verified };
    const failed: string[] = [];
    for (const provider of this.targets(claim)) {
      if (!PROVIDER_AUTH_VERIFY[provider]) continue;
      const result = await this.host.verifyProviderAuth(
        operation.remoteId,
        provider,
        claim.providerAuth[provider].opencodeProviderIds ?? [],
      );
      verified[provider] = result;
      if (!result.ok) failed.push(provider);
    }
    claim.verified = verified;
    claim.reauth = failed;
    if (failed.length > 0) {
      const reasons = failed.map(
        (provider) => `${provider}: ${verified[provider].hint ?? 'failed'}`,
      );
      throw refused(
        'PROVIDER_AUTH_VERIFY_FAILED',
        `Login check failed on the VM (${reasons.join('; ')}). Re-authenticate: a retry prepares the login again for ${failed.join(', ')} only.`,
        { providers: failed },
      );
    }
  }

  private async registerRemote({ operation, progress }: RemoteOperationStepRun): Promise<void> {
    const health = await this.health.refresh(operation.remoteId);
    if (!health.online || !health.versionMatches) {
      throw refused(
        'REMOTE_NOT_HEALTHY',
        health.online
          ? `The remote runs version ${health.version ?? 'unknown'}, which differs from this instance.`
          : `The remote does not answer: ${health.error ?? 'offline'}.`,
      );
    }
    if (health.apiKeyRejected) throw refused(HOST_API_KEY_REJECTED, HOST_API_KEY_REJECTED_MESSAGE);
    const mismatch = reportedVmUserMismatch(health);
    if (mismatch) await progress({ dockerUserWarning: vmUserWarning(mismatch) });
  }

  /** Every provider with a login, or only those a failed check sent back. */
  private targets(claim: ClaimDetails): string[] {
    const chosen = Object.entries(claim.providerAuth)
      .filter(([, state]) => state.choice !== 'skip')
      .map(([provider]) => provider);
    return claim.reauth?.length
      ? chosen.filter((provider) => claim.reauth!.includes(provider))
      : chosen;
  }

  private bundleFor(claim: ClaimDetails): Promise<ProviderAuthClaimBundle> {
    const entryIds = this.targets(claim).flatMap(
      (provider) => claim.providerAuth[provider].entryIds ?? [],
    );
    return this.vault.buildClaimBundle({ entryIds, homePath: claim.homePath });
  }
}

/** The entries a provider's choice names; older records carry a single `entryId`. */
export function claimEntryIds(state: ClaimProviderState): string[] {
  return state.entryIds?.length ? state.entryIds : state.entryId ? [state.entryId] : [];
}

export function refused(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): RemoteOperationStepRefusedError {
  return new RemoteOperationStepRefusedError(code, message, details);
}

/** The claim file that gives the host the digest of its API key; the key itself stays on this PC. */
function hostApiKeyFile(homePath: string, apiKey: string): ProviderAuthClaimFile {
  return {
    path: `${homePath}/.devchain/host-api-key`,
    contentBase64: Buffer.from(`${hashHostApiKey(apiKey)}\n`).toString('base64'),
    mode: '0600',
  };
}
