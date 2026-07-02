import { Injectable, Inject } from '@nestjs/common';
import { z } from 'zod';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { createLogger } from '../../../common/logging/logger';
import { MobileChatRpcService } from './mobile-chat-rpc.service';
import { MobileBoardRpcService } from './mobile-board-rpc.service';
import { ViewportStreamerService } from './viewport-streamer.service';
import { E2eeTrustService } from '../../e2ee/services/e2ee-trust.service';
import { ValidationError } from '../../../common/errors/error-types';
import { type RpcCryptoContext } from './tunnel-rpc-crypto.service';
import { toJsonRpcError } from './jsonrpc-error.util';
import { toEpicDto, toStatusDto, toStatusMap } from './epic-dto.util';

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

const METHOD_SCHEMAS: Record<string, z.ZodTypeAny> = {
  'board.listProjects': z.object({}).passthrough(),
  'board.listStatuses': z.object({ projectId: z.string().uuid() }).passthrough(),
  'board.listParentEpics': z
    .object({
      projectId: z.string().uuid(),
      type: z.enum(['active', 'archived', 'all']).optional(),
      limit: z.number().int().positive().optional(),
      offset: z.number().int().nonnegative().optional(),
      limitPerParent: z.number().int().positive().optional(),
    })
    .passthrough(),
  'board.listParentChildren': z
    .object({
      parentId: z.string().uuid(),
      statusId: z.string().uuid().optional(),
      limit: z.number().int().positive().optional(),
      offset: z.number().int().nonnegative().optional(),
    })
    .passthrough(),
  'board.listEpicsByStatus': z
    .object({
      statusId: z.string().uuid(),
      projectId: z.string().uuid().optional(),
      limit: z.number().int().positive().optional(),
      offset: z.number().int().nonnegative().optional(),
    })
    .passthrough(),
  'board.listParentEpicsByStatus': z
    .object({
      projectId: z.string().uuid(),
      statusId: z.string().uuid(),
      type: z.enum(['active', 'archived', 'all']).optional(),
      limit: z.number().int().positive().optional(),
      offset: z.number().int().nonnegative().optional(),
    })
    .passthrough(),
  'board.getEpicDetail': z.object({ epicId: z.string().uuid() }).passthrough(),
  // Board mutations + comments (tunnel schemas are STRICTER than REST):
  'board.updateEpicAssignment': z
    .object({
      projectId: z.string().uuid(),
      epicId: z.string().uuid(),
      agentId: z.string().uuid().nullable(),
      version: z.number().int().nonnegative(),
    })
    .passthrough(),
  'board.listEpicComments': z
    .object({
      projectId: z.string().uuid(),
      epicId: z.string().uuid(),
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).optional(),
    })
    .passthrough(),
  'board.addEpicComment': z
    .object({
      projectId: z.string().uuid(),
      epicId: z.string().uuid(),
      authorName: z.string().trim().min(1),
      content: z.string().trim().min(1),
    })
    .passthrough(),
  'board.deleteEpicComment': z
    .object({
      projectId: z.string().uuid(),
      epicId: z.string().uuid(),
      commentId: z.string().uuid(),
    })
    .passthrough(),
  'chat.listAgents': z.object({ projectId: z.string().uuid() }).passthrough(),
  'chat.listTeams': z.object({ projectId: z.string().uuid() }).passthrough(),
  // teamId omitted/null → the "standalone" (unlinked) profile set; a uuid → that team's
  // linked profiles (the handler asserts the team belongs to the project).
  'chat.listProfiles': z
    .object({ projectId: z.string().uuid(), teamId: z.string().uuid().nullish() })
    .passthrough(),
  'chat.listProfileConfigs': z
    .object({ projectId: z.string().uuid(), profileId: z.string().uuid() })
    .passthrough(),
  'chat.createTeamAgent': z
    .object({
      projectId: z.string().uuid(),
      teamId: z.string().uuid(),
      name: z.string().trim().min(1),
      providerConfigId: z.string().uuid(),
      description: z.string().optional(),
    })
    .passthrough(),
  'chat.createIndependentAgent': z
    .object({
      projectId: z.string().uuid(),
      name: z.string().trim().min(1),
      profileId: z.string().uuid(),
      providerConfigId: z.string().uuid(),
      description: z.string().optional(),
    })
    .passthrough(),
  'chat.deleteAgent': z
    .object({ projectId: z.string().uuid(), agentId: z.string().uuid() })
    .passthrough(),
  'chat.getTranscriptSummary': z
    .object({ sessionId: z.string().uuid(), projectId: z.string().uuid() })
    .passthrough(),
  'chat.getTranscriptChunks': z
    .object({
      sessionId: z.string().uuid(),
      projectId: z.string().uuid(),
      cursor: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(100).optional(),
      direction: z.enum(['forward', 'backward']).optional(),
    })
    .passthrough(),
  'chat.getTranscriptTail': z
    .object({
      sessionId: z.string().uuid(),
      projectId: z.string().uuid(),
      since: z.string().min(1),
    })
    .passthrough(),
  'chat.sendMessage': z
    .object({
      agentId: z.string().uuid(),
      projectId: z.string().uuid(),
      text: z.string().trim().min(1),
    })
    .passthrough(),
  'chat.launchAgent': z
    .object({ agentId: z.string().uuid(), projectId: z.string().uuid() })
    .passthrough(),
  'chat.restartAgent': z
    .object({ agentId: z.string().uuid(), projectId: z.string().uuid() })
    .passthrough(),
  'chat.restoreSession': z
    .object({ sessionId: z.string().uuid(), projectId: z.string().uuid() })
    .passthrough(),
  'chat.terminateSession': z
    .object({ sessionId: z.string().uuid(), projectId: z.string().uuid() })
    .passthrough(),
  'chat.getOperationStatus': z
    .object({ operationId: z.string().uuid(), projectId: z.string().uuid() })
    .passthrough(),
  'chat.getAgentStatus': z
    .object({ agentId: z.string().uuid(), projectId: z.string().uuid() })
    .passthrough(),
  'chat.listPendingAskQuestions': z
    .object({ sessionId: z.string().uuid(), projectId: z.string().uuid() })
    .passthrough(),
  'chat.listSessions': z
    .object({
      agentId: z.string().uuid(),
      projectId: z.string().uuid(),
      cursor: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    })
    .passthrough(),
  'chat.deleteSessionRecord': z
    .object({ sessionId: z.string().uuid(), projectId: z.string().uuid() })
    .passthrough(),
  'chat.renameSession': z
    .object({
      sessionId: z.string().uuid(),
      projectId: z.string().uuid(),
      // nullable (NOT optional): null/empty clears the name; max enforced here too.
      name: z.string().trim().max(120).nullable(),
    })
    .passthrough(),
  // Live viewport lease control. `cols`/`rows` are advisory (forward-compat); v1 has no
  // mobile resize (single shared pane). The screen frames ride the separate `viewport`
  // tunnel lane, not this RPC channel.
  'terminal.viewport.subscribe': z
    .object({
      sessionId: z.string().uuid(),
      projectId: z.string().uuid(),
      cols: z.number().int().positive().optional(),
      rows: z.number().int().positive().optional(),
    })
    .passthrough(),
  'terminal.viewport.unsubscribe': z.object({ subscriptionId: z.string().min(1) }).passthrough(),
  // E2EE bootstrap (RE2E1): the mobile delivers its X25519 public key + kid. The service
  // derives-and-verifies the kid + validates the key length, so the schema only asserts
  // both fields are present non-empty strings.
  'e2ee.adoptDeviceKey': z
    .object({
      kid: z.string().min(1),
      publicKeyB64: z.string().min(1),
      // Optional stable per-install id (M2 dedup). Opaque/bounded here; the device store is
      // the single validator (canonical-UUID before store/evict). A non-canonical value does
      // NOT reject the adopt — it just isn't stored (old-client append behavior).
      installId: z.string().max(100).optional(),
    })
    .passthrough(),
  // E2EE logout revoke (M3): the target device is taken from the VERIFIED sealed-sender
  // context, NEVER from params — so params are accepted-but-ignored (permissive passthrough).
  'e2ee.revokeDeviceKey': z.object({}).passthrough(),
};

@Injectable()
export class TunnelHandlerService {
  private readonly handlers: Record<
    string,
    (params: Record<string, unknown>, cryptoCtx?: RpcCryptoContext) => Promise<unknown>
  >;

  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    @Inject(STORAGE_SERVICE) private readonly storage: any,
    // Composition point for mobile chat.* RPCs. board.* reads stay on storage;
    // chat.* methods (Tasks 2–5) and board.* mutations delegate to their seam
    // services (mobileChat.<method>(p) / mobileBoard.<method>(p)).
    private readonly mobileChat: MobileChatRpcService,
    // Board mutations + comments go through EpicsService (events/invariants),
    // never raw storage; see MobileBoardRpcService.
    private readonly mobileBoard: MobileBoardRpcService,
    // Live viewport lease control (terminal.viewport.subscribe/unsubscribe). The streamer
    // owns subscription lifecycle + source-side auth and emits `type:'viewport'` frames.
    private readonly viewportStreamer: ViewportStreamerService,
    // E2EE bootstrap (RE2E1): TOFU-adopt the mobile device's relayed public key so the PC
    // can decrypt that device's RPC. Delivered plaintext (public key only); the adopt
    // derives-and-verifies the kid before storing (no unverified ingestion).
    private readonly e2eeTrust: E2eeTrustService,
  ) {
    this.handlers = {
      'board.listProjects': (p) => this.listProjects(p),
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
      'chat.getTranscriptChunks': (p) => this.mobileChat.getTranscriptChunks(p),
      'chat.getTranscriptTail': (p) => this.mobileChat.getTranscriptTail(p),
      'chat.sendMessage': (p) => this.mobileChat.sendMessage(p),
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
      'terminal.viewport.subscribe': (p) => this.viewportStreamer.subscribe(p),
      'terminal.viewport.unsubscribe': (p) => Promise.resolve(this.viewportStreamer.unsubscribe(p)),
      // E2EE bootstrap (RE2E1): adopt the mobile device's public key (email-login half of
      // the bidirectional exchange). Plaintext by design — see RPC_BOOTSTRAP_METHODS.
      'e2ee.adoptDeviceKey': (p) =>
        Promise.resolve(
          this.e2eeTrust.adoptPeerKeyTofu(
            {
              kid: p['kid'] as string,
              publicKeyB64: p['publicKeyB64'] as string,
            },
            // installId supersede metadata — carried beside the trust record, never a trust
            // signal; the trust/store layer validates + applies it (TOFU: evictVerified=false).
            p['installId'] as string | undefined,
          ),
        ),
      // E2EE logout revoke (M3): sealed-only. Identity comes from the trusted crypto context
      // (verified envelope kid), NOT params — the crypto seam rejects a plaintext attempt.
      'e2ee.revokeDeviceKey': (_p, cryptoCtx) => Promise.resolve(this.revokeDeviceKey(cryptoCtx)),
    };
  }

  async handle(req: JsonRpcRequest, cryptoCtx?: RpcCryptoContext): Promise<JsonRpcResponse> {
    const handler = this.handlers[req.method];
    if (!handler) {
      logger.warn({ method: req.method, id: req.id }, 'Unknown RPC method');
      return { jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'Method not found' } };
    }

    const schema = METHOD_SCHEMAS[req.method];
    if (schema) {
      const parseResult = schema.safeParse(req.params ?? {});
      if (!parseResult.success) {
        logger.warn(
          { method: req.method, id: req.id, errors: parseResult.error.format() },
          'Invalid params',
        );
        return {
          jsonrpc: '2.0',
          id: req.id,
          error: { code: -32602, message: 'Invalid params', data: parseResult.error.format() },
        };
      }
    }

    try {
      const result = await handler(req.params ?? {}, cryptoCtx);
      return { jsonrpc: '2.0', id: req.id, result };
    } catch (err) {
      logger.error({ err, method: req.method, id: req.id }, 'RPC handler error');
      return { jsonrpc: '2.0', id: req.id, error: toJsonRpcError(err) };
    }
  }

  /**
   * E2EE logout revoke (M3 `paired-device-dedup`): remove EXACTLY the sender's own device key.
   * The target is `cryptoCtx.senderKid` — the VERIFIED envelope kid set by the crypto layer
   * (decryption proved the sender holds that key). ALL client params are ignored so a sealed
   * client can never name a DIFFERENT device (force-unpair). An absent `cryptoCtx` (only
   * reachable if this were ever dispatched off the sealed lane — the crypto seam already
   * rejects a plaintext attempt) is rejected here too; nothing is revoked.
   *
   * Delegates to `E2eeTrustService.revokeDevice` → `E2eeDeviceStoreService.revoke()`.
   *
   * Replay convergence: a replayed revoke targets a kid that died at the phone's logout →
   * `revoke()` returns `false` → clean no-op. The kid cannot be re-adopted (its private key
   * was destroyed on the phone). Formal replay protection remains backlog `17c7d7bb`.
   */
  private revokeDeviceKey(cryptoCtx?: RpcCryptoContext): { kid: string; removed: boolean } {
    if (!cryptoCtx?.senderKid) {
      throw new ValidationError('e2ee.revokeDeviceKey requires a sealed sender context');
    }
    return this.e2eeTrust.revokeDevice(cryptoCtx.senderKid);
  }

  private async listProjects(params: Record<string, unknown>): Promise<unknown[]> {
    const result = await this.storage.listProjects(params);
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
