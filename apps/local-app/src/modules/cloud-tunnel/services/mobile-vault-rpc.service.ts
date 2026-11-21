import { Injectable } from '@nestjs/common';
import {
  VaultRequestFulfillService,
  type VaultRequestCandidate,
  type VaultRequestFulfillResult,
  type VaultRequestApproveResult,
  type VaultRequestView,
} from '../../vault-requests/vault-request-fulfill.service';
import type { VaultDeviceScope } from '../../vault-requests/vault-request-selection';
import type { VaultUseDecision } from '../../vault-requests/vault-use-decision';
import type { MobileRpcWorkspaceAuthorization } from './mobile-rpc-workspace-access.service';
import type { RpcCryptoContext } from './tunnel-rpc-crypto.service';
import { VaultUseOptInRegistry } from './vault-use-opt-in';

/**
 * The Vault scope of the device. A null set is full access, not single-workspace mode:
 * a fail-closed snapshot also gives a set.
 */
function deviceScope(
  authorization: MobileRpcWorkspaceAuthorization | undefined,
): VaultDeviceScope | undefined {
  const allowedWorkspaceIds = authorization?.allowedWorkspaceIds;
  return allowedWorkspaceIds ? { allowedWorkspaceIds } : undefined;
}

/**
 * The phone's answers to agent Vault requests. The same service as the web routes does the
 * work, so a web and a phone answer to one request end it once. Workspace authorization
 * runs before these handlers; the value arrives only on the sealed lane.
 */
@Injectable()
export class MobileVaultRpcService {
  constructor(
    private readonly requests: VaultRequestFulfillService,
    private readonly useOptIns: VaultUseOptInRegistry,
  ) {}

  /**
   * Pending requests of the projects in the device's workspaces; all of them in
   * one-workspace mode. The device scope does both this and the `grant` request rule
   * (`VaultRequestFulfillService.listPending`). `use` requests only when `params.types`
   * names them: an older phone build rejects the whole list when it holds a type it does
   * not know.
   */
  async listRequests(
    params: Record<string, unknown>,
    cryptoCtx: RpcCryptoContext | undefined,
    authorization: MobileRpcWorkspaceAuthorization | undefined,
  ): Promise<VaultRequestView[]> {
    const wantsUse = (params['types'] as string[] | undefined)?.includes('use') === true;
    if (wantsUse && cryptoCtx?.senderKid) this.useOptIns.record(cryptoCtx.senderKid);
    const pending = await this.requests.listPending(deviceScope(authorization));
    return pending.filter((request) => wantsUse || request.type !== 'use');
  }

  listRequestCandidates(
    params: Record<string, unknown>,
    authorization: MobileRpcWorkspaceAuthorization | undefined,
  ): Promise<VaultRequestCandidate[]> {
    return this.requests.listCandidates(params['requestId'] as string, deviceScope(authorization));
  }

  fulfillRequest(
    params: Record<string, unknown>,
    authorization?: MobileRpcWorkspaceAuthorization,
  ): Promise<VaultRequestFulfillResult> {
    return this.requests.fulfill(
      params['requestId'] as string,
      {
        value: params['value'] as string | undefined,
        permanent: params['permanent'] as boolean,
        entryId: params['entryId'] as string | undefined,
      },
      deviceScope(authorization),
    );
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
