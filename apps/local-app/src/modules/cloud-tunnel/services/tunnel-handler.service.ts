import { Injectable, Inject } from '@nestjs/common';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { createLogger } from '../../../common/logging/logger';
import { MobileChatRpcService } from './mobile-chat-rpc.service';
import { MobileBoardRpcService } from './mobile-board-rpc.service';
import { ViewportStreamerService } from './viewport-streamer.service';
import { E2eeTrustService } from '../../e2ee/services/e2ee-trust.service';
import { ActiveSessionLookup } from '../../sessions/services/active-session-lookup.service';
import { TerminalKeyInputFacade } from '../../terminal/services/terminal-key-input/terminal-key-input.facade';
import { DEFAULT_PROJECT_WORKSPACE_ID } from '../../storage/db/schema';
import { ValidationError, NotFoundError, ForbiddenError } from '../../../common/errors/error-types';
import { type RpcCryptoContext } from './tunnel-rpc-crypto.service';
import { toJsonRpcError } from './jsonrpc-error.util';
import { toEpicDto, toStatusDto, toStatusMap } from './epic-dto.util';
import {
  getMobileRpcParamsSchema,
  getMobileRpcResultSchema,
  isMobileRpcMethod,
  type MobileRpcMethod,
} from './mobile-rpc-contract.generated';
import {
  serializeRpcTranscriptChunks,
  serializeRpcTranscriptTail,
} from '../../session-reader/services/transcript-serialization';
import {
  MobileRpcWorkspaceAccessService,
  type MobileRpcWorkspaceAuthorization,
} from './mobile-rpc-workspace-access.service';

const logger = createLogger('TunnelHandler');

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type EpicListType = 'active' | 'archived' | 'all';

type MobileRpcHandler = (
  params: Record<string, unknown>,
  cryptoCtx?: RpcCryptoContext,
  workspaceAuthorization?: MobileRpcWorkspaceAuthorization,
) => Promise<unknown>;

type MobileRpcHandlerMap = {
  [M in MobileRpcMethod]: MobileRpcHandler;
};

@Injectable()
export class TunnelHandlerService {
  private readonly handlers: MobileRpcHandlerMap;

  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    @Inject(STORAGE_SERVICE) private readonly storage: any,
    // Composition point for mobile chat.* RPCs. board.* reads stay on storage;
    // chat.* methods and board.* mutations delegate to their seam
    // services (mobileChat.<method>(p) / mobileBoard.<method>(p)).
    private readonly mobileChat: MobileChatRpcService,
    // Board mutations + comments go through EpicsService (events/invariants),
    // never raw storage; see MobileBoardRpcService.
    private readonly mobileBoard: MobileBoardRpcService,
    // Live viewport lease control (terminal.viewport.subscribe/unsubscribe). The streamer
    // owns subscription lifecycle + source-side auth and emits `type:'viewport'` frames.
    private readonly viewportStreamer: ViewportStreamerService,
    // E2EE bootstrap: TOFU-adopt the mobile device's relayed public key so the PC can decrypt
    // its RPC. The plaintext lane may also carry non-secret display/grouping metadata; none
    // of those fields are a trust signal. The adopt derives and verifies the kid before store.
    private readonly e2eeTrust: E2eeTrustService,
    // Discrete mobile key input (terminal.sendKey). INLINE handler below (no per-domain
    // RpcService for a single method): source-side project scoping via ActiveSessionLookup,
    // then the narrow facade owns the registry/liveness/whitelist/rate-limit. TerminalIOService
    // is NEVER injected here — the facade is the only terminal surface CloudTunnel touches.
    private readonly terminalKeyInput: TerminalKeyInputFacade,
    private readonly activeSessions: ActiveSessionLookup,
    private readonly workspaceAccess?: MobileRpcWorkspaceAccessService,
  ) {
    this.handlers = {
      'board.listWorkspaces': (_p, _cryptoCtx, authorization) => this.listWorkspaces(authorization),
      'board.listProjects': (p, _cryptoCtx, authorization) => this.listProjects(p, authorization),
      'board.listStatuses': (p) => this.listStatuses(p),
      'board.listParentEpics': (p) => this.listParentEpics(p),
      'board.listParentChildren': (p) => this.listParentChildren(p),
      'board.listEpicsByStatus': (p) => this.listEpicsByStatus(p),
      'board.listParentEpicsByStatus': (p) => this.listParentEpicsByStatus(p),
      'board.getEpicDetail': (p) => this.getEpicDetail(p),
      'board.updateEpicAssignment': (p) => this.mobileBoard.updateEpicAssignment(p),
      'board.listEpicComments': (p) => this.mobileBoard.listEpicComments(p),
      'board.addEpicComment': (p) => this.mobileBoard.addEpicComment(p),
      'board.deleteEpicComment': (p) => this.mobileBoard.deleteEpicComment(p),
      // chat.* handlers delegate to this.mobileChat (the seam composes the
      // narrow session/storage facades; see MobileChatRpcService):
      'chat.listAgents': (p) => this.mobileChat.listAgents(p),
      'chat.listTeams': (p) => this.mobileChat.listTeams(p),
      'chat.listProfiles': (p) => this.mobileChat.listProfiles(p),
      'chat.listProfileConfigs': (p) => this.mobileChat.listProfileConfigs(p),
      'chat.createTeamAgent': (p) => this.mobileChat.createTeamAgent(p),
      'chat.createIndependentAgent': (p) => this.mobileChat.createIndependentAgent(p),
      'chat.deleteAgent': (p) => this.mobileChat.deleteAgent(p),
      'chat.getTranscriptSummary': (p) => this.mobileChat.getTranscriptSummary(p),
      'chat.getTranscriptChunks': async (p) =>
        serializeRpcTranscriptChunks(await this.mobileChat.getTranscriptChunks(p)),
      'chat.getTranscriptTail': async (p) =>
        serializeRpcTranscriptTail(await this.mobileChat.getTranscriptTail(p)),
      'chat.listCustomPrompts': (p) => this.mobileChat.listCustomPrompts(p),
      'chat.getCustomPrompt': (p) => this.mobileChat.getCustomPrompt(p),
      'chat.sendMessage': (p, cryptoCtx) => this.mobileChat.sendMessage(p, cryptoCtx),
      'chat.getPendingMessages': (p) => this.mobileChat.getPendingMessages(p),
      'chat.launchAgent': (p) => this.mobileChat.launchAgent(p),
      'chat.restartAgent': (p) => this.mobileChat.restartAgent(p),
      'chat.restoreSession': (p) => this.mobileChat.restoreSession(p),
      'chat.terminateSession': (p) => this.mobileChat.terminateSession(p),
      'chat.getOperationStatus': (p) => this.mobileChat.getOperationStatus(p),
      'chat.getAgentStatus': (p) => this.mobileChat.getAgentStatus(p),
      'chat.listPendingAskQuestions': (p) => this.mobileChat.listPendingAskQuestions(p),
      'chat.listSessions': (p) => this.mobileChat.listSessions(p),
      'chat.deleteSessionRecord': (p) => this.mobileChat.deleteSessionRecord(p),
      'chat.renameSession': (p) => this.mobileChat.renameSession(p),
      // Live viewport lease control:
      'terminal.viewport.subscribe': (p, cryptoCtx) =>
        this.viewportStreamer.subscribe(p, cryptoCtx),
      'terminal.viewport.unsubscribe': (p, cryptoCtx) =>
        Promise.resolve(this.viewportStreamer.unsubscribe(p, cryptoCtx)),
      // Discrete mobile key input. INLINE handler (no per-domain RpcService for a single
      // method — mirrors the revokeDeviceKey inline pattern): project-scope the session,
      // then delegate the tmux send to the narrow facade.
      'terminal.sendKey': (p) => this.sendTerminalKey(p),
      // E2EE bootstrap (RE2E1): adopt the mobile device's public key (email-login half of
      // the bidirectional exchange). Plaintext by design; the generated contract owns
      // that crypto-mode decision.
      'e2ee.adoptDeviceKey': (p) =>
        Promise.resolve(
          this.e2eeTrust.adoptPeerKeyTofu(
            {
              kid: p['kid'] as string,
              publicKeyB64: p['publicKeyB64'] as string,
              ...(p['label'] !== undefined ? { label: p['label'] as string } : {}),
            },
            // installId supersede metadata — carried beside the trust record, never a trust
            // signal; the trust/store layer validates + applies it (TOFU: evictVerified=false).
            p['installId'] as string | undefined,
          ),
        ),
      // Dormant paired-device revoke: sealed-only. Identity comes from the trusted crypto
      // context (verified envelope kid), not params; ordinary logout never dispatches it.
      'e2ee.revokeDeviceKey': (_p, cryptoCtx) => Promise.resolve(this.revokeDeviceKey(cryptoCtx)),
      // Bind the sender's notification routing kid to its paired device: sealed-only. The
      // paired X25519 identity comes ONLY from the verified envelope kid — all
      // caller-supplied sender identity is ignored.
      'e2ee.bindNotificationRoutingIdentity': (p, cryptoCtx) =>
        Promise.resolve(this.bindNotificationRoutingIdentity(p, cryptoCtx)),
    } satisfies MobileRpcHandlerMap;
  }

  async handle(req: JsonRpcRequest, cryptoCtx?: RpcCryptoContext): Promise<JsonRpcResponse> {
    if (!isMobileRpcMethod(req.method)) {
      logger.warn({ method: req.method, id: req.id }, 'Unknown RPC method');
      return { jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'Method not found' } };
    }

    const method = req.method;
    const params = req.params ?? {};
    const paramsResult = getMobileRpcParamsSchema(method).safeParse(params);
    if (!paramsResult.success) {
      logger.warn({ method, id: req.id, errors: paramsResult.error.format() }, 'Invalid params');
      return {
        jsonrpc: '2.0',
        id: req.id,
        error: { code: -32602, message: 'Invalid params', data: paramsResult.error.format() },
      };
    }

    try {
      const validatedParams = paramsResult.data as Record<string, unknown>;
      if (!this.workspaceAccess && process.env.NODE_ENV !== 'test') {
        throw new Error('Mobile RPC workspace authorization is unavailable');
      }
      const workspaceAuthorization = this.workspaceAccess
        ? await this.workspaceAccess.authorize(method, validatedParams, cryptoCtx)
        : { allowedWorkspaceIds: null };
      const wireResult = await this.handlers[method](params, cryptoCtx, workspaceAuthorization);
      const resultValidation = getMobileRpcResultSchema(method).safeParse(wireResult);
      if (!resultValidation.success) {
        logger.error(
          {
            method,
            schemaPaths: resultValidation.error.issues.map((issue) =>
              issue.path.length === 0 ? '<root>' : issue.path.join('.'),
            ),
          },
          'RPC handler returned an invalid result',
        );
        return {
          jsonrpc: '2.0',
          id: req.id,
          error: { code: -32603, message: 'Internal error' },
        };
      }
      return { jsonrpc: '2.0', id: req.id, result: wireResult };
    } catch (err) {
      logger.error({ err, method: req.method, id: req.id }, 'RPC handler error');
      return { jsonrpc: '2.0', id: req.id, error: toJsonRpcError(err) };
    }
  }

  /**
   * Sealed paired-device revoke: remove exactly the sender's own device key.
   * The target is `cryptoCtx.senderKid` — the VERIFIED envelope kid set by the crypto layer
   * (decryption proved the sender holds that key). ALL client params are ignored so a sealed
   * client can never name a DIFFERENT device (force-unpair). An absent `cryptoCtx` (only
   * reachable if this were ever dispatched off the sealed lane — the crypto seam already
   * rejects a plaintext attempt) is rejected here too; nothing is revoked.
   *
   * Delegates to `E2eeTrustService.revokeDevice` → `E2eeDeviceStoreService.revoke()`.
   *
   * Ordinary logout never invokes this handler and preserves the kid. A replay is a no-op while
   * the row is absent, but could remove the same persistent kid after re-adoption; formal replay
   * protection remains backlog `17c7d7bb`.
   */
  private revokeDeviceKey(cryptoCtx?: RpcCryptoContext): { kid: string; removed: boolean } {
    if (!cryptoCtx?.senderKid) {
      throw new ValidationError('e2ee.revokeDeviceKey requires a sealed sender context');
    }
    return this.e2eeTrust.revokeDevice(cryptoCtx.senderKid);
  }

  /**
   * Sealed notification-identity bind: store `params.routingKid` beside the paired device
   * identified by `cryptoCtx.senderKid` — the VERIFIED envelope kid set by the crypto layer
   * (decryption proved the sender holds that key). A caller-supplied sender identifier is
   * never read: a sealed client cannot bind a routing kid to a DIFFERENT paired device. An
   * absent `cryptoCtx` (only reachable off the sealed lane — the crypto seam already rejects
   * plaintext for sealed-only methods) fails closed here too; nothing is bound.
   */
  private bindNotificationRoutingIdentity(
    params: Record<string, unknown>,
    cryptoCtx?: RpcCryptoContext,
  ): { kid: string; routingKid: string; bound: boolean } {
    if (!cryptoCtx?.senderKid) {
      throw new ValidationError(
        'e2ee.bindNotificationRoutingIdentity requires a sealed sender context',
      );
    }
    const routingKid = params['routingKid'] as string;
    return this.e2eeTrust.bindNotificationRoutingIdentity(cryptoCtx.senderKid, routingKid);
  }

  /**
   * `terminal.sendKey({ sessionId, projectId, key })` — project-scope the session BEFORE the
   * key is sent (unknown → NotFoundError, cross-project → ForbiddenError), then hand the
   * whitelisted key to {@link TerminalKeyInputFacade.sendKey}. The scope check mirrors
   * `ViewportStreamerService.assertSessionInProject` / `MobileChatRpcService.assertSessionInProject`
   * (the shared SESSION_PROJECT_MISMATCH contract); the facade owns registry/liveness/whitelist/
   * rate-limit and surfaces `SESSION_NOT_RUNNING | INVALID_KEY | RATE_LIMITED` as AppError codes.
   */
  private async sendTerminalKey(params: Record<string, unknown>): Promise<{ ok: true }> {
    const sessionId = params['sessionId'] as string;
    const projectId = params['projectId'] as string;
    const key = params['key'] as string;
    await this.assertSessionInProject(sessionId, projectId);
    return this.terminalKeyInput.sendKey(sessionId, key);
  }

  /**
   * Enforce `session → agent → project` ownership before acting on a sessionId. Mirrors
   * `ViewportStreamerService.assertSessionInProject`: unknown → NotFoundError, cross-project →
   * ForbiddenError (`SESSION_PROJECT_MISMATCH`).
   */
  private async assertSessionInProject(sessionId: string, projectId: string): Promise<void> {
    const scope = await this.activeSessions.getSessionProjectScope(sessionId);
    if (!scope) {
      throw new NotFoundError('Session', sessionId);
    }
    if (scope.projectId !== projectId) {
      throw new ForbiddenError('Session does not belong to the requested project', {
        code: 'SESSION_PROJECT_MISMATCH',
        sessionId,
        projectId,
      });
    }
  }

  private async listWorkspaces(
    authorization?: MobileRpcWorkspaceAuthorization,
  ): Promise<unknown[]> {
    const workspaces = (await this.storage.listProjectWorkspaces()) as Array<
      Record<string, unknown>
    >;
    const allowed = authorization?.allowedWorkspaceIds;
    return workspaces
      .filter((workspace) => !allowed || allowed.has(workspace.id as string))
      .map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
        isDefault: workspace.isDefault,
        position: workspace.position,
        projectCount: workspace.projectCount,
      }));
  }

  private async listProjects(
    params: Record<string, unknown>,
    authorization?: MobileRpcWorkspaceAuthorization,
  ): Promise<unknown[]> {
    const workspaceId =
      authorization?.projectListWorkspaceId ??
      (params['workspaceId'] as string | undefined) ??
      DEFAULT_PROJECT_WORKSPACE_ID;
    const result = await this.storage.listProjects({ ...params, workspaceId });
    return this.itemsOf(result).map((project) => ({
      id: project.id,
      name: project.name,
    }));
  }

  private async listStatuses(params: Record<string, unknown>): Promise<unknown[]> {
    const projectId = params['projectId'] as string;
    const result = await this.storage.listStatuses(projectId, params);
    const statuses = this.itemsOf(result);

    return Promise.all(
      statuses.map(async (status) => {
        const parentEpics = await this.storage.listProjectEpics(projectId, {
          statusId: status.id,
          parentOnly: true,
          limit: 1,
          offset: 0,
        });
        const statusDto = toStatusDto(status);
        return {
          status: statusDto,
          epicCount: this.totalOf(parentEpics),
        };
      }),
    );
  }

  private async listParentEpics(params: Record<string, unknown>): Promise<unknown> {
    const projectId = params['projectId'] as string;
    const type = (params['type'] as EpicListType | undefined) ?? 'active';
    const limit = (params['limit'] as number | undefined) ?? 20;
    const offset = (params['offset'] as number | undefined) ?? 0;
    const limitPerParent = (params['limitPerParent'] as number | undefined) ?? 1000;

    const result = await this.listParentEpicsWithSummary(projectId, {
      type,
      limit,
      offset,
      limitPerParent,
    });

    return {
      statuses: result.statuses,
      items: result.items,
      total: result.total,
      limit: result.limit,
      offset: result.offset,
    };
  }

  private async listParentEpicsByStatus(params: Record<string, unknown>): Promise<unknown> {
    const projectId = params['projectId'] as string;
    const statusId = params['statusId'] as string;
    const type = (params['type'] as EpicListType | undefined) ?? 'active';
    const limit = (params['limit'] as number | undefined) ?? 20;
    const offset = (params['offset'] as number | undefined) ?? 0;

    await this.resolveProjectIdForStatus(statusId, projectId);

    const result = await this.listParentEpicsWithSummary(projectId, {
      statusId,
      type,
      limit,
      offset,
      limitPerParent: 1000,
    });

    return {
      items: result.items,
      total: result.total,
      limit: result.limit,
      offset: result.offset,
    };
  }

  private async listParentEpicsWithSummary(
    projectId: string,
    options: {
      statusId?: string;
      type: EpicListType;
      limit: number;
      offset: number;
      limitPerParent: number;
    },
  ): Promise<{
    statuses: Array<Record<string, unknown>>;
    items: Array<Record<string, unknown>>;
    total: number;
    limit: number;
    offset: number;
  }> {
    const { statusId, type, limit, offset, limitPerParent } = options;

    const [parentResult, statusesResult, agentsResult] = await Promise.all([
      this.storage.listProjectEpics(projectId, { statusId, parentOnly: true, type, limit, offset }),
      this.storage.listStatuses(projectId, { limit: 1000, offset: 0 }),
      this.storage.listAgents(projectId, { limit: 1000, offset: 0 }),
    ]);
    const parentItems = this.itemsOf(parentResult);
    const parentIds = parentItems
      .map((item) => item.id)
      .filter((id): id is string => typeof id === 'string');
    const statusMap = toStatusMap(this.itemsOf(statusesResult));
    const statuses = this.itemsOf(statusesResult).map((status) => toStatusDto(status));
    const agentNameById = this.toAgentNameMap(agentsResult);

    const subEpicsByParent =
      parentIds.length > 0
        ? await this.storage.listSubEpicsForParents(projectId, parentIds, { type, limitPerParent })
        : new Map<string, Record<string, unknown>[]>();

    let childSummaryByParent = this.aggregateChildSummaries(parentIds, subEpicsByParent, statusMap);

    if (this.hasPotentialChildTruncation(parentIds, subEpicsByParent, limitPerParent)) {
      childSummaryByParent = await this.buildCountSafeChildSummary(
        projectId,
        parentIds,
        type,
        statusMap,
      );
    }

    const items = parentItems.map((parent) => {
      const parentId = parent.id as string | undefined;
      const childSummary = parentId
        ? childSummaryByParent.get(parentId)
        : { childCount: 0, childStatusCounts: [] };

      return {
        ...toEpicDto(parent, statusMap, agentNameById),
        childCount: childSummary?.childCount ?? 0,
        childStatusCounts: childSummary?.childStatusCounts ?? [],
      };
    });

    return {
      statuses,
      items,
      total: this.totalOf(parentResult),
      limit: this.limitOf(parentResult, limit),
      offset: this.offsetOf(parentResult, offset),
    };
  }

  private async listEpicsByStatus(params: Record<string, unknown>): Promise<unknown[]> {
    const statusId = params['statusId'] as string;
    const projectId = await this.resolveProjectIdForStatus(statusId, params['projectId']);
    const [result, statusesResult, agentsResult] = await Promise.all([
      this.storage.listEpicsByStatus(statusId, {
        limit: (params['limit'] as number | undefined) ?? 100,
        offset: (params['offset'] as number | undefined) ?? 0,
      }),
      this.storage.listStatuses(projectId, { limit: 1000, offset: 0 }),
      this.storage.listAgents(projectId, { limit: 1000, offset: 0 }),
    ]);
    const statusMap = toStatusMap(this.itemsOf(statusesResult));
    const agentNameById = this.toAgentNameMap(agentsResult);

    return this.itemsOf(result).map((epic) => toEpicDto(epic, statusMap, agentNameById));
  }

  private async listParentChildren(params: Record<string, unknown>): Promise<unknown> {
    const parentId = params['parentId'] as string;
    const statusId = params['statusId'] as string | undefined;
    const limit = (params['limit'] as number | undefined) ?? 50;
    const offset = (params['offset'] as number | undefined) ?? 0;

    const parent = (await this.storage.getEpic(parentId)) as Record<string, unknown>;
    const projectId = parent.projectId as string | undefined;
    if (!projectId) {
      throw new Error('Parent epic is missing projectId');
    }

    const [childrenResult, statusesResult, agentsResult, rawChildStatusCounts] = await Promise.all([
      this.storage.listParentChildren(parentId, { statusId, limit, offset }),
      this.storage.listStatuses(projectId, { limit: 1000, offset: 0 }),
      this.storage.listAgents(projectId, { limit: 1000, offset: 0 }),
      this.storage.countSubEpicsByStatus(parentId),
    ]);
    const statusMap = toStatusMap(this.itemsOf(statusesResult));
    const agentNameById = this.toAgentNameMap(agentsResult);
    const childStatusCounts = Object.entries(
      (rawChildStatusCounts as Record<string, unknown> | null | undefined) ?? {},
    )
      .filter(
        (entry): entry is [string, number] =>
          typeof entry[0] === 'string' &&
          typeof entry[1] === 'number' &&
          Number.isFinite(entry[1]) &&
          entry[1] > 0,
      )
      .map(([childStatusId, count]) => {
        const status = statusMap.get(childStatusId);
        return {
          statusId: childStatusId,
          statusName: status?.name,
          statusColor: status?.color,
          count,
        };
      })
      .sort((a, b) => {
        const statusA = statusMap.get(a.statusId);
        const statusB = statusMap.get(b.statusId);
        return this.toStatusPosition(statusA) - this.toStatusPosition(statusB);
      });

    return {
      items: this.itemsOf(childrenResult).map((epic) => toEpicDto(epic, statusMap, agentNameById)),
      total: this.totalOf(childrenResult),
      limit: this.limitOf(childrenResult, limit),
      offset: this.offsetOf(childrenResult, offset),
      childStatusCounts,
    };
  }

  private async getEpicDetail(params: Record<string, unknown>): Promise<unknown> {
    const epic = await this.storage.getEpic(params['epicId']);
    const projectId = epic.projectId as string | undefined;
    if (!projectId) {
      throw new Error('Epic is missing projectId');
    }

    const [statusesResult, agentsResult] = await Promise.all([
      this.storage.listStatuses(projectId, { limit: 1000, offset: 0 }),
      this.storage.listAgents(projectId, { limit: 1000, offset: 0 }),
    ]);
    const statusMap = toStatusMap(this.itemsOf(statusesResult));
    const agentNameById = this.toAgentNameMap(agentsResult);
    return toEpicDto(epic, statusMap, agentNameById);
  }

  private toAgentNameMap(result: unknown): Map<string, string> {
    return new Map(
      this.itemsOf(result)
        .filter((agent) => typeof agent.id === 'string' && typeof agent.name === 'string')
        .map((agent) => [agent.id as string, agent.name as string]),
    );
  }

  private async resolveProjectIdForStatus(
    statusId: string,
    requestedProjectId: unknown,
  ): Promise<string> {
    const status = (await this.storage.getStatus(statusId)) as Record<string, unknown>;
    const statusProjectId = status.projectId as string | undefined;
    if (!statusProjectId) {
      throw new Error('Status is missing projectId');
    }
    if (
      typeof requestedProjectId === 'string' &&
      requestedProjectId.length > 0 &&
      requestedProjectId !== statusProjectId
    ) {
      throw new Error('projectId does not match status project');
    }

    return statusProjectId;
  }

  private aggregateChildSummaries(
    parentIds: string[],
    childrenByParent: Map<string, Record<string, unknown>[]>,
    statusMap: Map<string, Record<string, unknown>>,
  ): Map<string, { childCount: number; childStatusCounts: Array<Record<string, unknown>> }> {
    const summaryByParent = new Map<
      string,
      { childCount: number; childStatusCounts: Array<Record<string, unknown>> }
    >();

    for (const parentId of parentIds) {
      const children = childrenByParent.get(parentId) ?? [];
      const statusCount = new Map<string, number>();

      for (const child of children) {
        const statusId = child.statusId;
        if (typeof statusId !== 'string' || statusId.length === 0) continue;
        statusCount.set(statusId, (statusCount.get(statusId) ?? 0) + 1);
      }

      const childStatusCounts = Array.from(statusCount.entries())
        .map(([statusId, count]) => {
          const status = statusMap.get(statusId);
          return {
            statusId,
            statusName: status?.name,
            statusColor: status?.color,
            count,
          };
        })
        .sort((a, b) => {
          const statusA = statusMap.get(a.statusId);
          const statusB = statusMap.get(b.statusId);
          return this.toStatusPosition(statusA) - this.toStatusPosition(statusB);
        });

      summaryByParent.set(parentId, {
        childCount: children.length,
        childStatusCounts,
      });
    }

    return summaryByParent;
  }

  private hasPotentialChildTruncation(
    parentIds: string[],
    childrenByParent: Map<string, Record<string, unknown>[]>,
    limitPerParent: number,
  ): boolean {
    if (limitPerParent <= 0) return false;
    return parentIds.some(
      (parentId) => (childrenByParent.get(parentId)?.length ?? 0) >= limitPerParent,
    );
  }

  private async buildCountSafeChildSummary(
    projectId: string,
    parentIds: string[],
    type: EpicListType,
    statusMap: Map<string, Record<string, unknown>>,
  ): Promise<
    Map<string, { childCount: number; childStatusCounts: Array<Record<string, unknown>> }>
  > {
    const childrenByParent = new Map<string, Record<string, unknown>[]>();
    for (const parentId of parentIds) {
      childrenByParent.set(parentId, []);
    }
    if (parentIds.length === 0) {
      return this.aggregateChildSummaries(parentIds, childrenByParent, statusMap);
    }

    const parentSet = new Set(parentIds);
    const pageSize = 500;
    let offset = 0;
    let total = Number.POSITIVE_INFINITY;

    while (offset < total) {
      const page = await this.storage.listProjectEpics(projectId, {
        type,
        limit: pageSize,
        offset,
      });
      const items = this.itemsOf(page);
      total = this.totalOf(page);

      for (const item of items) {
        const parentId = item.parentId;
        if (typeof parentId !== 'string' || !parentSet.has(parentId)) continue;
        const bucket = childrenByParent.get(parentId) ?? [];
        bucket.push(item);
        childrenByParent.set(parentId, bucket);
      }

      offset += pageSize;
      if (items.length === 0) break;
    }

    return this.aggregateChildSummaries(parentIds, childrenByParent, statusMap);
  }

  private toStatusPosition(status?: Record<string, unknown>): number {
    const position = status?.position;
    if (typeof position === 'number') return position;
    return Number.MAX_SAFE_INTEGER;
  }

  private itemsOf(result: unknown): Record<string, unknown>[] {
    if (Array.isArray(result)) return result as Record<string, unknown>[];
    if (
      typeof result === 'object' &&
      result !== null &&
      Array.isArray((result as { items?: unknown }).items)
    ) {
      return (result as { items: Record<string, unknown>[] }).items;
    }
    return [];
  }

  private totalOf(result: unknown): number {
    if (typeof result === 'object' && result !== null) {
      const total = (result as { total?: unknown }).total;
      if (typeof total === 'number' && Number.isFinite(total)) return total;
    }
    return this.itemsOf(result).length;
  }

  private limitOf(result: unknown, fallback: number): number {
    if (typeof result === 'object' && result !== null) {
      const limit = (result as { limit?: unknown }).limit;
      if (typeof limit === 'number' && Number.isFinite(limit)) return limit;
    }
    return fallback;
  }

  private offsetOf(result: unknown, fallback: number): number {
    if (typeof result === 'object' && result !== null) {
      const offset = (result as { offset?: unknown }).offset;
      if (typeof offset === 'number' && Number.isFinite(offset)) return offset;
    }
    return fallback;
  }
}
