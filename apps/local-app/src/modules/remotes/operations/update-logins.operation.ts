import { Inject, Injectable } from '@nestjs/common';
import { posix as path } from 'node:path';
import { ConflictError, NotFoundError } from '../../../common/errors/error-types';
import {
  OPENCODE_AUTH_FILE_PATH,
  PROVIDER_AUTH_ADAPTERS,
} from '../../provider-auth/provider-auth-adapters';
import { familyFilePaths } from '../../provider-auth/provider-auth-watcher.service';
import { ProviderAuthGeneratorService } from '../../provider-auth/provider-auth-generator.service';
import { ProviderAuthVaultService } from '../../provider-auth/provider-auth-vault.service';
import { ProviderAuthWritebackService } from '../../provider-auth/provider-auth-writeback.service';
import {
  STORAGE_SERVICE,
  type ProviderAuthStorage,
  type RemoteStorage,
} from '../../storage/interfaces/storage.interface';
import type { RemoteOperation } from '../../storage/models/domain.models';
import {
  ClaimOperation,
  claimEntryIds as entryIds,
  refused,
  type ClaimDetails,
  type ClaimProviderState,
} from './claim.operation';
import type { HostProviderAuthRemoveSpec } from '../host/host-provider-auth.dto';
import { RemoteHostClient } from './remote-host.client';
import {
  HOST_LIFECYCLE_KINDS,
  type RemoteOperationDefinition,
  type RemoteOperationStepDefinition,
  type RemoteOperationStepRun,
} from './remote-operation.types';

/** The env keys and login files one provider's logins place on the VM. */
export type AppliedProviderManifest = HostProviderAuthRemoveSpec;

/** Providers whose logins are files a running agent session rewrites. */
const FAMILY_PROVIDERS = new Set(familyFilePaths().map((file) => file.provider));

export interface UpdateLoginsDetails extends ClaimDetails {
  force: boolean;
  changedProviders: string[];
  previousProviderAuth: Record<string, ClaimProviderState>;
  releasedIds?: string[];
  writebackPaused?: boolean;
  applyStarted?: boolean;
  choicesReplaced?: boolean;
  appliedManifest?: Record<string, AppliedProviderManifest>;
  replacedManifest?: Record<string, AppliedProviderManifest>;
}

@Injectable()
export class UpdateLoginsOperation implements RemoteOperationDefinition {
  readonly kind = 'update_logins' as const;
  readonly steps: readonly RemoteOperationStepDefinition[];

  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: RemoteStorage & ProviderAuthStorage,
    private readonly host: RemoteHostClient,
    private readonly vault: ProviderAuthVaultService,
    private readonly writeback: ProviderAuthWritebackService,
    private readonly claim: ClaimOperation,
    private readonly generator: ProviderAuthGeneratorService,
  ) {
    const reuse = (id: string): RemoteOperationStepDefinition => {
      const step = claim.steps.find((candidate) => candidate.id === id);
      if (!step) throw new Error(`Missing claim step ${id}`);
      return {
        ...step,
        run: async (run) => {
          const details = run.details as unknown as UpdateLoginsDetails;
          await this.writeback.pause(run.operation.remoteId, run.operation.id);
          if (id === 'provider_auth_resolve') await this.release(run);
          if (id === 'claim') {
            details.applyStarted = true;
            // Progress is throttled; this boundary must be durable before any host write.
            await this.storage.updateRemoteOperation(run.operation.id, { details: run.details });
          }
          await step.run(run);
          if (id === 'provider_auth_resolve') details.choicesReplaced = false;
          if (id === 'build_bundle') await this.recordManifest(details);
        },
      };
    };
    this.steps = [
      {
        id: 'preflight',
        label: 'Check the VM and login choices',
        run: (run) => this.preflight(run),
      },
      { id: 'pull_families', label: 'Save the latest VM logins', run: (run) => this.pull(run) },
      {
        id: 'release_replaced',
        label: 'Release the replaced logins',
        run: (run) => this.release(run),
      },
      reuse('provider_auth_resolve'),
      reuse('build_bundle'),
      { ...reuse('claim'), label: 'Apply the logins on the VM' },
      { id: 'remove_dropped', label: 'Remove replaced logins', run: (run) => this.remove(run) },
      reuse('verify_providers'),
    ];
  }

  interrupt(id: string): Promise<void> {
    return this.claim.interrupt(id);
  }
  forget(id: string): void {
    this.claim.forget(id);
    this.writeback.resume(id);
  }
  retryFrom(operation: RemoteOperation): string | null {
    const claimRetry = this.claim.retryFrom(operation);
    if (claimRetry) return claimRetry;
    const failed = operation.steps.findIndex((step) => step.state === 'failed');
    const resolve = operation.steps.findIndex((step) => step.id === 'provider_auth_resolve');
    return operation.details.choicesReplaced && resolve >= 0 && failed >= resolve
      ? 'provider_auth_resolve'
      : null;
  }
  async completed(operation: RemoteOperation): Promise<void> {
    this.forget(operation.id);
  }

  assertCancellable(operation: RemoteOperation): void {
    if (operation.details.applyStarted) {
      throw new ConflictError('The logins may already be applied; retry the operation instead.', {
        code: 'REMOTE_OPERATION_NOT_CANCELLABLE',
        operationId: operation.id,
      });
    }
    this.claim.assertCancellable(operation);
  }

  async rollback(operation: RemoteOperation): Promise<void> {
    this.assertCancellable(operation);
    const details = operation.details as unknown as UpdateLoginsDetails;
    if (details.writebackPaused) await this.writeback.pause(operation.remoteId, operation.id);
    const previous = new Set(
      Object.values(details.previousProviderAuth).flatMap((state) => state.checkedOut ?? []),
    );
    const acquired = (await this.vault.familiesOfRemote(operation.remoteId)).filter(
      (entry) => details.changedProviders.includes(entry.provider) && !previous.has(entry.entryId),
    );
    for (const entry of acquired) await this.vault.release(entry.entryId);
    for (const provider of details.changedProviders) {
      const generationId = details.providerAuth[provider].generationId;
      if (generationId) await this.generator.cancel(generationId).catch(() => undefined);
    }
    for (const id of details.releasedIds ?? []) await this.vault.checkout(id, operation.remoteId);
    details.writebackPaused = false;
    await this.storage.updateRemoteOperation(operation.id, { details: operation.details });
    this.forget(operation.id);
  }

  private async preflight({ operation, details: raw }: RemoteOperationStepRun): Promise<void> {
    const details = raw as unknown as UpdateLoginsDetails;
    const open = await this.storage.listRemoteOperations({
      remoteId: operation.remoteId,
      states: ['running', 'failed'],
      kinds: HOST_LIFECYCLE_KINDS,
    });
    if (open.some((other) => other.id !== operation.id))
      throw refused('REMOTE_OPERATION_IN_PROGRESS', 'Another host operation is open.');
    const runtime = await this.host.remoteRuntime(operation.remoteId);
    if (
      !details.claimed ||
      runtime.version !== details.version ||
      runtime.state === 'unclaimed' ||
      runtime.state === 'claiming'
    ) {
      throw refused(
        'REMOTE_NOT_HEALTHY',
        'The VM must be claimed, online and running this DevChain version.',
      );
    }
    for (const provider of details.changedProviders) {
      const state = details.providerAuth[provider];
      if (state.choice !== 'reuse') continue;
      for (const id of entryIds(state)) {
        const entry = await this.vault.get(id);
        if (entry.provider !== provider)
          throw refused(
            'PROVIDER_AUTH_PROVIDER_MISMATCH',
            'The selected login belongs to another provider.',
          );
        if (
          entry.kind === 'family' &&
          entry.checkedOutRemoteId &&
          entry.checkedOutRemoteId !== operation.remoteId
        ) {
          throw refused(
            'PROVIDER_AUTH_ALREADY_CHECKED_OUT',
            'The selected login family is held by another VM.',
          );
        }
      }
    }
    if (
      !details.force &&
      details.changedProviders.some((provider) => FAMILY_PROVIDERS.has(provider))
    ) {
      let count: number;
      try {
        // A short read: an unknown count refuses the change, and the user can force it.
        count = (
          await this.host.listSessions(operation.remoteId, undefined, { timeoutMs: 3_000 })
        ).filter((session) => session.status === 'running' && session.agentId).length;
      } catch {
        throw refused(
          'REMOTE_AGENT_COUNT_UNKNOWN',
          'Running agent sessions could not be checked. Choose Change anyway to force this change.',
        );
      }
      if (count > 0)
        throw refused(
          'REMOTE_AGENTS_RUNNING',
          `${count} agent sessions are running. Restart them after changing logins. Choose Change anyway to force this change.`,
        );
    }
    details.appliedManifest ??= {};
    for (const [provider, state] of Object.entries(details.previousProviderAuth)) {
      details.appliedManifest[provider] ??= await this.manifest(provider, state, details.homePath);
    }
    details.replacedManifest ??= {};
    for (const provider of details.changedProviders) {
      details.replacedManifest[provider] = await this.manifest(
        provider,
        details.previousProviderAuth[provider],
        details.homePath,
        details.appliedManifest?.[provider],
      );
    }
  }

  private async pull({ operation }: RemoteOperationStepRun): Promise<void> {
    if (!(await this.writeback.pullFamiliesNow(operation.remoteId)).pulled) {
      throw refused(
        'PROVIDER_AUTH_PULL_FAILED',
        'The VM must be online so its latest login families can be saved.',
      );
    }
  }

  private async release({ operation, details: raw }: RemoteOperationStepRun): Promise<void> {
    const details = raw as unknown as UpdateLoginsDetails;
    await this.writeback.pause(operation.remoteId, operation.id);
    details.writebackPaused = true;
    details.releasedIds ??= [];
    await this.storage.updateRemoteOperation(operation.id, { details: raw });
    const targets = details.reauth?.length ? details.reauth : details.changedProviders;
    const families = await this.vault.familiesOfRemote(operation.remoteId);
    for (const family of families) {
      if (!targets.includes(family.provider)) continue;
      const selected = details.providerAuth[family.provider];
      if (selected.choice === 'reuse' && entryIds(selected).includes(family.entryId)) continue;
      // Save the restoration intent before releasing; checkout to this VM is idempotent.
      if (
        details.previousProviderAuth[family.provider]?.checkedOut?.includes(family.entryId) &&
        !details.releasedIds.includes(family.entryId)
      )
        details.releasedIds.push(family.entryId);
      await this.storage.updateRemoteOperation(operation.id, { details: raw });
      await this.vault.release(family.entryId);
    }
    for (const provider of targets) details.providerAuth[provider].checkedOut = [];
    await this.storage.updateRemoteOperation(operation.id, { details: raw });
  }

  private async recordManifest(details: UpdateLoginsDetails): Promise<void> {
    details.appliedManifest ??= {};
    details.replacedManifest ??= {};
    for (const provider of details.reauth ?? details.changedProviders) {
      details.replacedManifest[provider] = unionManifests(
        details.replacedManifest[provider],
        details.appliedManifest[provider],
      );
      details.appliedManifest[provider] = await this.manifest(
        provider,
        details.providerAuth[provider],
        details.homePath,
      );
    }
  }

  private async remove({ operation, details: raw }: RemoteOperationStepRun): Promise<void> {
    const details = raw as unknown as UpdateLoginsDetails;
    await this.writeback.pause(operation.remoteId, operation.id);
    const kept = unionManifests(...Object.values(details.appliedManifest ?? {}));
    const old = unionManifests(...Object.values(details.replacedManifest ?? {}));
    await this.host.applyProviderAuth(operation.remoteId, {
      env: {},
      files: [],
      remove: {
        envKeys: old.envKeys.filter((key) => !kept.envKeys.includes(key)),
        files: old.files.filter((file) => !kept.files.includes(file)),
      },
    });
  }

  private async manifest(
    provider: string,
    state: ClaimProviderState | undefined,
    homePath: string,
    recorded?: AppliedProviderManifest,
  ): Promise<AppliedProviderManifest> {
    if (!state || state.choice === 'skip') return { envKeys: [], files: [] };
    const envKeys = new Set(recorded?.envKeys ?? []);
    const files = new Set(recorded?.files ?? []);
    const adapter = PROVIDER_AUTH_ADAPTERS[provider];
    for (const id of entryIds(state)) {
      try {
        const payload = await this.storage.readProviderAuthPayload(id);
        if (payload.payloadKind === 'env') envKeys.add(payload.envKey);
      } catch (error) {
        if (!(error instanceof NotFoundError)) throw error;
        if (adapter?.payloadKind === 'env') envKeys.add(adapter.envKey);
      }
    }
    if (adapter?.payloadKind === 'files') files.add(path.join(homePath, adapter.filePath));
    if (adapter?.payloadKind === 'opencode-entry')
      files.add(path.join(homePath, OPENCODE_AUTH_FILE_PATH));
    return { envKeys: [...envKeys], files: [...files] };
  }
}

function unionManifests(
  ...manifests: (AppliedProviderManifest | undefined)[]
): AppliedProviderManifest {
  return {
    envKeys: [...new Set(manifests.flatMap((manifest) => manifest?.envKeys ?? []))],
    files: [...new Set(manifests.flatMap((manifest) => manifest?.files ?? []))],
  };
}
