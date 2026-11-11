import { Inject, Injectable } from '@nestjs/common';
import { canAccessWorkspace } from '../../e2ee/services/paired-device-workspace-access.service';
import { STORAGE_SERVICE, type ProjectStorage } from '../../storage/interfaces/storage.interface';
import {
  VaultRequestFulfillService,
  type VaultRequestFulfillResult,
  type VaultRequestApproveResult,
  type VaultRequestView,
} from '../../vault-requests/vault-request-fulfill.service';
import type { VaultUseDecision } from '../../vault-requests/vault-use-decision';
import type { MobileRpcWorkspaceAuthorization } from './mobile-rpc-workspace-access.service';
import type { RpcCryptoContext } from './tunnel-rpc-crypto.service';
import { VaultUseOptInRegistry } from './vault-use-opt-in';

/**
 * The phone's answers to agent Vault requests. The same service as the web routes does the
 * work, so a web and a phone answer to one request end it once. Workspace authorization
 * runs before these handlers; the value arrives only on the sealed lane.
 */
@Injectable()
export class MobileVaultRpcService {
  constructor(
    private readonly requests: VaultRequestFulfillService,
    @Inject(STORAGE_SERVICE) private readonly storage: Pick<ProjectStorage, 'getProject'>,
    private readonly useOptIns: VaultUseOptInRegistry,
  ) {}

  /**
   * Pending requests of the projects in the device's workspaces; all of them in
   * one-workspace mode. `use` requests only when `params.types` names them: an older
   * phone build rejects the whole list when it holds a type it does not know.
   */
  async listRequests(
    params: Record<string, unknown>,
    cryptoCtx: RpcCryptoContext | undefined,
    authorization: MobileRpcWorkspaceAuthorization | undefined,
  ): Promise<VaultRequestView[]> {
    const wantsUse = (params['types'] as string[] | undefined)?.includes('use') === true;
    if (wantsUse && cryptoCtx?.senderKid) this.useOptIns.record(cryptoCtx.senderKid);
    const pending = (await this.requests.listPending()).filter(
      (request) => wantsUse || request.type !== 'use',
    );
    const allowed = authorization?.allowedWorkspaceIds;
    if (!allowed) return pending;
    // The phone polls this list; requests share projects, so read each project once.
    const workspaceIds = new Map<string, string | null>();
    const visible: VaultRequestView[] = [];
    for (const request of pending) {
      let workspaceId = workspaceIds.get(request.projectId);
      if (workspaceId === undefined) {
        workspaceId = await this.storage
          .getProject(request.projectId)
          .then((project) => project.workspaceId)
          .catch(() => null);
        workspaceIds.set(request.projectId, workspaceId);
      }
      if (workspaceId && canAccessWorkspace({ workspaceIds: [...allowed] }, workspaceId)) {
        visible.push(request);
      }
    }
    return visible;
  }

  fulfillRequest(params: Record<string, unknown>): Promise<VaultRequestFulfillResult> {
    return this.requests.fulfill(params['requestId'] as string, {
      value: params['value'] as string | undefined,
      permanent: params['permanent'] as boolean,
    });
  }

  approveUse(params: Record<string, unknown>): Promise<VaultRequestApproveResult> {
    return this.requests.approve(
      params['requestId'] as string,
      params['decision'] as VaultUseDecision,
    );
  }

  async denyRequest(params: Record<string, unknown>): Promise<{ ok: true }> {
    await this.requests.deny(params['requestId'] as string, params['reason'] as string | undefined);
    return { ok: true };
  }
}
