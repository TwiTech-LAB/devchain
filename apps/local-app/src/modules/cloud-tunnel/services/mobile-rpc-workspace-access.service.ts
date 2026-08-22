import { Inject, Injectable } from '@nestjs/common';
import { AppError, ForbiddenError, NotFoundError } from '../../../common/errors/error-types';
import { E2eeKeypairService } from '../../e2ee/services/e2ee-keypair.service';
import {
  PairedDeviceWorkspaceAccessService,
  canAccessWorkspace,
} from '../../e2ee/services/paired-device-workspace-access.service';
import { DEFAULT_PROJECT_WORKSPACE_ID } from '../../storage/db/schema';
import { STORAGE_SERVICE, type StorageService } from '../../storage/interfaces/storage.interface';
import { WorkspaceModeCoordinatorService } from '../../workspaces/services/workspace-mode-coordinator.service';
import type { MobileRpcMethod } from './mobile-rpc-contract.generated';
import type { RpcCryptoContext } from './tunnel-rpc-crypto.service';
import { ViewportStreamerService } from './viewport-streamer.service';

type WorkspaceBearingMobileRpcMethod = Exclude<
  MobileRpcMethod,
  'e2ee.adoptDeviceKey' | 'e2ee.revokeDeviceKey' | 'e2ee.bindNotificationRoutingIdentity'
>;

export type MobileRpcWorkspaceScope =
  | 'authorized-workspaces'
  | 'authorized-projects'
  | 'projectId'
  | 'parentId'
  | 'statusId-or-projectId'
  | 'epicId'
  | 'subscriptionId';

export const MOBILE_RPC_WORKSPACE_SCOPES = {
  'board.listWorkspaces': 'authorized-workspaces',
  'board.listProjects': 'authorized-projects',
  'board.listStatuses': 'projectId',
  'board.listParentEpics': 'projectId',
  'board.listParentChildren': 'parentId',
  'board.listEpicsByStatus': 'statusId-or-projectId',
  'board.listParentEpicsByStatus': 'projectId',
  'board.getEpicDetail': 'epicId',
  'board.updateEpicAssignment': 'projectId',
  'board.listEpicComments': 'projectId',
  'board.addEpicComment': 'projectId',
  'board.deleteEpicComment': 'projectId',
  'chat.listAgents': 'projectId',
  'chat.listTeams': 'projectId',
  'chat.listProfiles': 'projectId',
  'chat.listProfileConfigs': 'projectId',
  'chat.createTeamAgent': 'projectId',
  'chat.createIndependentAgent': 'projectId',
  'chat.deleteAgent': 'projectId',
  'chat.getTranscriptSummary': 'projectId',
  'chat.getTranscriptChunks': 'projectId',
  'chat.getTranscriptTail': 'projectId',
  'chat.listCustomPrompts': 'projectId',
  'chat.getCustomPrompt': 'projectId',
  'chat.sendMessage': 'projectId',
  'chat.getPendingMessages': 'projectId',
  'chat.launchAgent': 'projectId',
  'chat.restartAgent': 'projectId',
  'chat.restoreSession': 'projectId',
  'chat.terminateSession': 'projectId',
  'chat.getOperationStatus': 'projectId',
  'chat.getAgentStatus': 'projectId',
  'chat.listPendingAskQuestions': 'projectId',
  'chat.listSessions': 'projectId',
  'chat.deleteSessionRecord': 'projectId',
  'chat.renameSession': 'projectId',
  'terminal.viewport.subscribe': 'projectId',
  'terminal.viewport.unsubscribe': 'subscriptionId',
  'terminal.sendKey': 'projectId',
} as const satisfies Record<WorkspaceBearingMobileRpcMethod, MobileRpcWorkspaceScope>;

export interface MobileRpcWorkspaceAuthorization {
  readonly allowedWorkspaceIds: ReadonlySet<string> | null;
  readonly projectListWorkspaceId?: string;
}

const UNRESTRICTED_AUTHORIZATION: MobileRpcWorkspaceAuthorization = {
  allowedWorkspaceIds: null,
};

@Injectable()
export class MobileRpcWorkspaceAccessService {
  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly workspaceMode: WorkspaceModeCoordinatorService,
    private readonly deviceAccess: PairedDeviceWorkspaceAccessService,
    private readonly keypair: E2eeKeypairService,
    private readonly viewportStreamer: ViewportStreamerService,
  ) {}

  async authorize(
    method: MobileRpcMethod,
    params: Record<string, unknown>,
    cryptoCtx?: RpcCryptoContext,
  ): Promise<MobileRpcWorkspaceAuthorization> {
    if (
      method === 'e2ee.adoptDeviceKey' ||
      method === 'e2ee.revokeDeviceKey' ||
      method === 'e2ee.bindNotificationRoutingIdentity'
    ) {
      return UNRESTRICTED_AUTHORIZATION;
    }

    const mode = await this.workspaceMode.getSnapshot();
    const scope = MOBILE_RPC_WORKSPACE_SCOPES[method];
    const projectListWorkspaceId =
      scope === 'authorized-projects'
        ? ((params['workspaceId'] as string | undefined) ?? DEFAULT_PROJECT_WORKSPACE_ID)
        : undefined;

    if (!mode.multiWorkspaceMode && !mode.failClosedPending) {
      return projectListWorkspaceId
        ? { ...UNRESTRICTED_AUTHORIZATION, projectListWorkspaceId }
        : UNRESTRICTED_AUTHORIZATION;
    }

    const allowedWorkspaceIds = await this.resolveAuthenticatedWorkspaceIds(cryptoCtx);
    if (scope === 'authorized-workspaces') return { allowedWorkspaceIds };
    if (scope === 'authorized-projects') {
      this.assertWorkspaceAllowed(projectListWorkspaceId!, allowedWorkspaceIds);
      return { allowedWorkspaceIds, projectListWorkspaceId };
    }

    const projectId = await this.resolveProjectId(scope, params);
    const workspaceId = await this.resolveCurrentProjectWorkspace(projectId);
    this.assertWorkspaceAllowed(workspaceId, allowedWorkspaceIds);
    return { allowedWorkspaceIds };
  }

  private async resolveAuthenticatedWorkspaceIds(
    cryptoCtx?: RpcCryptoContext,
  ): Promise<ReadonlySet<string>> {
    if (!cryptoCtx?.senderKid) {
      try {
        await this.keypair.exportPublic();
      } catch {
        throw new AppError(
          'Workspace access requires desktop end-to-end encryption, but encryption is unavailable.',
          'WORKSPACE_E2EE_UNAVAILABLE',
          503,
        );
      }
      throw new AppError(
        'Update and re-pair this phone before using multi-workspace features.',
        'WORKSPACE_DEVICE_PAIRING_REQUIRED',
        409,
      );
    }

    try {
      return new Set(this.deviceAccess.getAccess(cryptoCtx.senderKid).workspaceIds);
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw new AppError(
          'Update and re-pair this phone before using multi-workspace features.',
          'WORKSPACE_DEVICE_PAIRING_REQUIRED',
          409,
        );
      }
      throw error;
    }
  }

  private async resolveProjectId(
    scope: Exclude<MobileRpcWorkspaceScope, 'authorized-workspaces' | 'authorized-projects'>,
    params: Record<string, unknown>,
  ): Promise<string> {
    try {
      switch (scope) {
        case 'projectId':
          return params['projectId'] as string;
        case 'parentId':
          return (await this.storage.getEpic(params['parentId'] as string)).projectId;
        case 'statusId-or-projectId':
          return typeof params['projectId'] === 'string'
            ? params['projectId']
            : (await this.storage.getStatus(params['statusId'] as string)).projectId;
        case 'epicId':
          return (await this.storage.getEpic(params['epicId'] as string)).projectId;
        case 'subscriptionId': {
          const projectId = await this.viewportStreamer.resolveSubscriptionProjectId(
            params['subscriptionId'] as string,
          );
          if (!projectId) throw new NotFoundError('Viewport subscription');
          return projectId;
        }
      }
    } catch (error) {
      if (error instanceof NotFoundError) throw this.accessDenied();
      throw error;
    }
  }

  private async resolveCurrentProjectWorkspace(projectId: string): Promise<string> {
    try {
      return (await this.storage.getProject(projectId)).workspaceId;
    } catch (error) {
      if (error instanceof NotFoundError) throw this.accessDenied();
      throw error;
    }
  }

  private assertWorkspaceAllowed(
    workspaceId: string,
    allowedWorkspaceIds: ReadonlySet<string>,
  ): void {
    // Same predicate the notification recipient resolver uses — one access model.
    if (!canAccessWorkspace({ workspaceIds: [...allowedWorkspaceIds] }, workspaceId)) {
      throw this.accessDenied();
    }
  }

  private accessDenied(): ForbiddenError {
    return new ForbiddenError('Workspace access denied');
  }
}
