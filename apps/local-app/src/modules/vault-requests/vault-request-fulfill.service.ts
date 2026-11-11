import { Inject, Injectable } from '@nestjs/common';
import type { HostVaultRequestResolve } from '@devchain/shared';
import { ConflictError, ValidationError } from '../../common/errors/error-types';
import { RemoteHostClient } from '../remotes/operations/remote-host.client';
import {
  REMOTE_VAULT_DELIVERY_PORT,
  type RemoteVaultDeliveryPort,
} from '../remotes/ports/remote-vault-delivery.port';
import { hostErrorCode } from '../remotes/transport/host-transport';
import {
  STORAGE_SERVICE,
  type ProjectStorage,
  type RemoteStorage,
  type VaultEntryStorage,
} from '../storage/interfaces/storage.interface';
import { SessionRowStore } from '../storage/sessions/session-row.store';
import { VaultAccessService } from '../vault/vault-access.service';
import { VaultEntriesService } from '../vault/vault-entries.service';
import { assertVaultEntryValue } from '../vault/vault-entry-rules';
import { VaultKeyService } from '../vault/vault-key.service';
import { VaultSessionValueStore } from '../vault/vault-session-values';
import { VaultUseApprovalStore } from '../vault/vault-use-approvals';
import {
  applyUseDecision,
  assertUseDecision,
  isUseRequest,
  recordUseDenial,
  useRequestNotFulfillable,
  type VaultUseDecision,
  type VaultUseRequest,
} from './vault-use-decision';
import { VaultVmCacheService } from '../vault/vault-vm-cache.service';
import {
  putVaultRequestSessionValue,
  vaultRequestSessionEnded,
} from './vault-request-session-value';
import { findRequestedEntry } from './vault-request.service';
import {
  VaultRequestStore,
  vaultRequestNotPending,
  type VaultRequest,
} from './vault-request.store';

/** A pending request as the web shows it. Never holds a value. */
export interface VaultRequestView extends VaultRequest {
  projectName: string;
  /** The description of the entry a `grant` request names; null for `create`. */
  entryDescription: string | null;
  /** The VM a mirrored request came from; null for a request raised on this instance. */
  remoteName: string | null;
}

export interface VaultRequestFulfillInput {
  /** The new value of a `create` request; a `grant` request takes none. */
  value?: string;
  /** False keeps a `create` value in memory for the requesting session only. */
  permanent: boolean;
}

export interface VaultRequestApproveResult {
  requestId: string;
  status: 'approved';
  decision: VaultUseDecision;
}

export interface VaultRequestFulfillResult {
  requestId: string;
  status: 'fulfilled';
  permanent: boolean;
  /** The entry that was created or granted; null for a session-only value. */
  entryId: string | null;
}

type FulfillStorage = Pick<
  VaultEntryStorage,
  'addVaultEntryGrant' | 'addVaultUseFamilyApproval' | 'getVaultEntry' | 'listVaultEntries'
> &
  Pick<ProjectStorage, 'getProject'> &
  Pick<RemoteStorage, 'getRemote'>;

/** The VM's refusals of an answer, re-thrown with home's text for the web and the phone. */
const VM_ANSWER_REFUSALS: Readonly<Record<string, () => ConflictError>> = {
  VAULT_REQUEST_NOT_PENDING: vaultRequestNotPending,
  VAULT_REQUEST_SESSION_ENDED: vaultRequestSessionEnded,
  VAULT_REQUEST_VALUE_NOT_DELIVERED: () =>
    new ConflictError('The entry has not reached the VM yet. Try again in a few seconds.', {
      code: 'VAULT_REQUEST_VALUE_NOT_DELIVERED',
    }),
  VAULT_REQUEST_APPROVAL_NOT_DELIVERED: () =>
    new ConflictError('The approval has not reached the VM yet. Try again in a few seconds.', {
      code: 'VAULT_REQUEST_APPROVAL_NOT_DELIVERED',
    }),
};

function valueRequired(): ValidationError {
  return new ValidationError('Enter the value of the entry.', {
    code: 'VAULT_REQUEST_VALUE_REQUIRED',
  });
}

/**
 * The answer's shape checks. They run once per answer, before the store claim, for home
 * and VM requests alike: the remote path relies on them for its `input.value` casts.
 */
function assertAnswer(request: VaultRequest, input: VaultRequestFulfillInput): void {
  if (request.type === 'use') throw useRequestNotFulfillable();
  if (request.type === 'grant') {
    if (input.value !== undefined) {
      throw new ValidationError('A grant request uses the stored value. Send no value.', {
        code: 'VAULT_REQUEST_VALUE_NOT_ALLOWED',
      });
    }
    if (!input.permanent) {
      throw new ValidationError('A grant request can only be approved as a permanent grant.', {
        code: 'VAULT_REQUEST_GRANT_PERMANENT_ONLY',
      });
    }
    return;
  }
  if (input.value === undefined || input.value === '') throw valueRequired();
  assertVaultEntryValue(request.kind, input.value);
}

/**
 * The user's answers to agent requests, from the home web UI and the phone. Each answer
 * goes through the store's single terminal transition, so two surfaces never both
 * succeed. A request mirrored from a VM is answered on that VM inside the same claim.
 */
@Injectable()
export class VaultRequestFulfillService {
  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: FulfillStorage,
    private readonly store: VaultRequestStore,
    private readonly vault: VaultKeyService,
    private readonly access: VaultAccessService,
    private readonly entries: VaultEntriesService,
    private readonly sessionValues: VaultSessionValueStore,
    private readonly useApprovals: VaultUseApprovalStore,
    private readonly sessionRows: SessionRowStore,
    private readonly vmCache: VaultVmCacheService,
    private readonly host: RemoteHostClient,
    @Inject(REMOTE_VAULT_DELIVERY_PORT) private readonly delivery: RemoteVaultDeliveryPort,
  ) {}

  /** Empty on a claimed VM: home lists and answers the request, so a VM shows none. */
  async listPending(): Promise<VaultRequestView[]> {
    if (this.vmCache.isClaimedHost()) return [];
    const pending = this.store.listPending();
    const remoteIds = new Set(
      pending
        .map((request) => this.store.remoteOrigin(request.requestId))
        .filter((remoteId): remoteId is string => remoteId !== null),
    );
    const remoteNames = new Map(
      await Promise.all(
        [...remoteIds].map(
          async (remoteId) =>
            [
              remoteId,
              await this.storage
                .getRemote(remoteId)
                .then((remote) => remote.name)
                .catch(() => null),
            ] as const,
        ),
      ),
    );
    return Promise.all(
      pending.map(async (request) => ({
        ...request,
        projectName: await this.storage
          .getProject(request.projectId)
          .then((project) => project.name)
          .catch(() => request.projectId),
        entryDescription: request.entryId
          ? await this.storage
              .getVaultEntry(request.entryId)
              .then((entry) => entry.description)
              .catch(() => null)
          : null,
        remoteName: remoteNames.get(this.store.remoteOrigin(request.requestId) ?? '') ?? null,
      })),
    );
  }

  async fulfill(
    requestId: string,
    input: VaultRequestFulfillInput,
  ): Promise<VaultRequestFulfillResult> {
    this.vault.assertHome();
    assertAnswer(this.requirePending(requestId), input);
    let entryId: string | null = null;
    const done = (id: string) => (entryId = id);
    await this.store.resolve(requestId, 'fulfilled', {
      work: async (claimed) => {
        const remoteId = this.store.remoteOrigin(claimed.requestId);
        if (remoteId) await this.fulfillOnRemote(remoteId, claimed, input, done);
        else await this.fulfillLocally(claimed, input, done);
      },
    });
    return { requestId, status: 'fulfilled', permanent: input.permanent, entryId };
  }

  /**
   * Approves a `use` request. `session` and `once` go to the session's in-memory
   * approvals; `family` stores a lasting approval for the requester's family in the
   * project, so it falls under the locked-write rule.
   */
  async approve(requestId: string, decision: VaultUseDecision): Promise<VaultRequestApproveResult> {
    this.vault.assertHome();
    assertUseDecision(this.requirePending(requestId), decision);
    await this.store.resolve(requestId, 'fulfilled', {
      work: async (claimed) => {
        // `assertUseDecision` validated this same pending row before the claim.
        const request = claimed as VaultUseRequest;
        const remoteId = this.store.remoteOrigin(request.requestId);
        if (remoteId) await this.approveOnRemote(remoteId, request, decision);
        else {
          await applyUseDecision(this.useApprovals, request, decision, (use) =>
            this.writeFamilyApproval(use),
          );
        }
      },
    });
    return { requestId, status: 'approved', decision };
  }

  async deny(requestId: string, reason?: string): Promise<void> {
    this.vault.assertHome();
    const trimmed = reason?.trim() || null;
    await this.store.resolve(requestId, 'denied', {
      reason: trimmed,
      work: async (claimed) => {
        const remoteId = this.store.remoteOrigin(claimed.requestId);
        if (!remoteId) {
          if (isUseRequest(claimed)) recordUseDenial(this.useApprovals, claimed);
          return;
        }
        await this.resolveOnRemote(remoteId, claimed.requestId, {
          status: 'denied',
          ...(trimmed && { reason: trimmed }),
        });
      },
    });
  }

  /**
   * The VM runs the session, so its own approvals take a `session` or `once` answer. A
   * `family` approval is written here, pushed and acknowledged, and only then ends on
   * the VM, which checks that the row reached its snapshot.
   */
  private async approveOnRemote(
    remoteId: string,
    request: VaultUseRequest,
    decision: VaultUseDecision,
  ): Promise<void> {
    if (decision !== 'family') {
      await this.resolveOnRemote(remoteId, request.requestId, { status: 'approved', decision });
      return;
    }
    await this.writeFamilyApproval(request);
    await this.delivery.pushConfirmed(remoteId);
    await this.endOnRemote(remoteId, request.requestId, { status: 'approved', decision });
  }

  private async writeFamilyApproval(request: VaultUseRequest): Promise<void> {
    await this.access.assertAccessWritable();
    // `assertUseDecision` refuses a family decision for a requester without a family.
    await this.storage.addVaultUseFamilyApproval(
      request.entryId,
      request.projectId,
      request.familySlug as string,
    );
  }

  /**
   * Ends the request on its VM, taking "already ended" as success: the home-side writes
   * exist, so the agent's next ask or use succeeds without this request.
   */
  private async endOnRemote(
    remoteId: string,
    requestId: string,
    answer: HostVaultRequestResolve,
  ): Promise<void> {
    try {
      await this.resolveOnRemote(remoteId, requestId, answer);
    } catch (error) {
      if (error instanceof ConflictError && error.details?.code === 'VAULT_REQUEST_NOT_PENDING') {
        return;
      }
      throw error;
    }
  }

  /** Answers a request raised on this instance: a grant, a stored entry or a session value. */
  private async fulfillLocally(
    request: VaultRequest,
    input: VaultRequestFulfillInput,
    done: (entryId: string) => void,
  ): Promise<void> {
    if (request.type === 'grant') {
      return this.grantExisting(request.entryId as string, request, done);
    }
    const value = input.value as string;
    if (input.permanent) {
      done((await this.createStoredEntry(request, value)).id);
      return;
    }
    putVaultRequestSessionValue(this.sessionRows, this.sessionValues, request, value);
  }

  /**
   * The VM owns the request, so it ends there first. A stored answer is written here,
   * then pushed and acknowledged, and only then ends on the VM: the agent never hears
   * "available" before `vault exec` can resolve the name. The type is derived again
   * from the current entries, so a retry after a write whose delivery failed grants
   * the entry it created.
   */
  private async fulfillOnRemote(
    remoteId: string,
    request: VaultRequest,
    input: VaultRequestFulfillInput,
    done: (entryId: string) => void,
  ): Promise<void> {
    if (!input.permanent) {
      await this.resolveOnRemote(remoteId, request.requestId, {
        status: 'fulfilled',
        sessionValue: { value: input.value as string },
      });
      return;
    }
    const existing = await findRequestedEntry(this.storage, request.projectId, request.name);
    if (existing) {
      await this.grantExisting(existing.id, request, done);
    } else if (request.type === 'grant') {
      // A grant answer carries no value (the modal shows no field for it), so a request
      // whose entry was deleted after adoption can only be denied.
      throw new ConflictError(
        `The entry "${request.name}" no longer exists. Deny the request so the agent can ask again.`,
        { code: 'VAULT_REQUEST_ENTRY_DELETED' },
      );
    } else {
      done((await this.createStoredEntry(request, input.value as string)).id);
    }
    await this.delivery.pushConfirmed(remoteId);
    await this.endOnRemote(remoteId, request.requestId, { status: 'fulfilled' });
  }

  /** Ends the request on its VM. A refusal by the VM keeps its code. */
  private async resolveOnRemote(
    remoteId: string,
    requestId: string,
    answer: HostVaultRequestResolve,
  ): Promise<void> {
    try {
      await this.host.resolveVaultRequest(remoteId, requestId, answer);
    } catch (error) {
      const code = hostErrorCode(error);
      const refusal = code ? VM_ANSWER_REFUSALS[code] : undefined;
      if (refusal) throw refusal();
      throw error;
    }
  }

  /** Adds to the entry's grants: the other families of the project keep theirs. */
  private async grantExisting(
    entryId: string,
    request: VaultRequest,
    done: (entryId: string) => void,
  ): Promise<void> {
    await this.access.assertAccessWritable();
    await this.storage.addVaultEntryGrant(entryId, request.projectId, request.familySlug);
    done(entryId);
  }

  /** A new entry of the requesting project, granted to the requester's family. */
  private createStoredEntry(request: VaultRequest, value: string) {
    return this.entries.createEntry({
      projects: [
        request.familySlug
          ? { projectId: request.projectId, mode: 'families', familySlugs: [request.familySlug] }
          : { projectId: request.projectId, mode: 'all' },
      ],
      name: request.name,
      kind: request.kind,
      description: request.description,
      value,
    });
  }

  private requirePending(requestId: string): VaultRequest {
    const request = this.store.get(requestId);
    if (!request) throw vaultRequestNotPending();
    return request;
  }
}
