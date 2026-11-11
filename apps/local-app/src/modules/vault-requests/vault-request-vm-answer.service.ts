import { Inject, Injectable } from '@nestjs/common';
import type { HostVaultRequestResolve } from '@devchain/shared';
import {
  ConflictError,
  NotFoundError,
  VaultAccessRefusedError,
} from '../../common/errors/error-types';
import {
  STORAGE_SERVICE,
  type AgentStorage,
  type VaultEntryStorage,
} from '../storage/interfaces/storage.interface';
import { SessionRowStore } from '../storage/sessions/session-row.store';
import { VaultAccessService, type VaultGrantedView } from '../vault/vault-access.service';
import { assertVaultEntryValue } from '../vault/vault-entry-rules';
import { VaultSessionValueStore } from '../vault/vault-session-values';
import { hasVaultFamilyApproval, VaultUseApprovalStore } from '../vault/vault-use-approvals';
import { VaultVmCacheService } from '../vault/vault-vm-cache.service';
import { putVaultRequestSessionValue } from './vault-request-session-value';
import {
  VaultRequestStore,
  vaultRequestNotPending,
  type VaultRequest,
} from './vault-request.store';
import {
  applyUseDecision,
  assertUseDecision,
  isUseRequest,
  notAUseRequest,
  recordUseDenial,
  useRequestNotFulfillable,
  type VaultUseRequest,
} from './vault-use-decision';

type AnswerStorage = Pick<AgentStorage, 'getAgent'> &
  Pick<VaultEntryStorage, 'listVaultUseFamilyApprovals'>;

function valueNotDelivered(): ConflictError {
  return new ConflictError('The answered Vault entry has not reached this VM yet.', {
    code: 'VAULT_REQUEST_VALUE_NOT_DELIVERED',
  });
}

/**
 * Home's answers to the requests of a claimed VM's agents. The VM owns the request,
 * so the answer ends it here and the VM's own notifier tells the agent.
 */
@Injectable()
export class VaultRequestVmAnswerService {
  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: AnswerStorage,
    private readonly store: VaultRequestStore,
    private readonly access: VaultAccessService,
    private readonly vmCache: VaultVmCacheService,
    private readonly sessionRows: SessionRowStore,
    private readonly sessionValues: VaultSessionValueStore,
    private readonly approvals: VaultUseApprovalStore,
  ) {}

  listPending(): VaultRequest[] {
    return this.store.listPending();
  }

  async resolve(requestId: string, answer: HostVaultRequestResolve): Promise<void> {
    const pending = this.store.get(requestId);
    if (pending && isUseRequest(pending)) return this.resolveUse(pending, answer);
    if (answer.status === 'approved') {
      if (!pending) throw vaultRequestNotPending();
      throw notAUseRequest();
    }
    if (answer.status === 'denied') {
      await this.store.resolve(requestId, 'denied', { reason: answer.reason?.trim() || null });
      return;
    }
    const sessionValue = answer.sessionValue?.value;
    if (sessionValue === undefined) {
      await this.store.resolve(requestId, 'fulfilled', {
        work: (request) => this.assertDelivered(request),
      });
      return;
    }
    if (!pending) throw vaultRequestNotPending();
    assertVaultEntryValue(pending.kind, sessionValue);
    await this.store.resolve(requestId, 'fulfilled', {
      work: async (request) =>
        putVaultRequestSessionValue(this.sessionRows, this.sessionValues, request, sessionValue),
    });
  }

  /**
   * A `use` answer goes to this VM's approvals, since the session runs here. A `family`
   * approval is a stored row: the request ends only once home's push brought it here.
   */
  private async resolveUse(
    pending: VaultUseRequest,
    answer: HostVaultRequestResolve,
  ): Promise<void> {
    const { requestId } = pending;
    if (answer.status === 'denied') {
      await this.store.resolve(requestId, 'denied', {
        reason: answer.reason?.trim() || null,
        // The claimed row is this same `use` request.
        work: async (request) => recordUseDenial(this.approvals, request as VaultUseRequest),
      });
      return;
    }
    if (answer.status !== 'approved') throw useRequestNotFulfillable();
    const { decision } = answer;
    assertUseDecision(pending, decision);
    await this.store.resolve(requestId, 'fulfilled', {
      work: (request) =>
        applyUseDecision(this.approvals, request as VaultUseRequest, decision, (use) =>
          this.assertApprovalDelivered(use),
        ),
    });
  }

  private async assertApprovalDelivered(request: VaultUseRequest): Promise<void> {
    const delivered =
      request.familySlug !== null &&
      (await hasVaultFamilyApproval(
        this.storage,
        request.entryId,
        request.projectId,
        request.familySlug,
      ));
    if (!delivered) {
      throw new ConflictError('The family approval has not reached this VM yet.', {
        code: 'VAULT_REQUEST_APPROVAL_NOT_DELIVERED',
      });
    }
  }

  /**
   * Home's push can fail without home knowing, so a stored answer ends the request only
   * once the agent resolves the name here: granted, with its value cached at the
   * granted revision.
   */
  private async assertDelivered(request: VaultRequest): Promise<void> {
    let view: VaultGrantedView;
    try {
      const agent = await this.storage.getAgent(request.agentId);
      view = await this.access.grantedForSession(agent, request.sessionId);
    } catch (error) {
      if (error instanceof NotFoundError || error instanceof VaultAccessRefusedError) {
        throw valueNotDelivered();
      }
      throw error;
    }
    // A session value of the same name overrides the stored entry, so the agent has it.
    if (view.sessionValues.some((value) => value.name === request.name)) return;
    const entry = view.stored.find((granted) => granted.name === request.name);
    if (!entry || !(await this.vmCache.holds([entry]))) throw valueNotDelivered();
  }
}
