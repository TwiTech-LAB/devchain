import { Injectable, Inject } from '@nestjs/common';
import { z } from 'zod';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { createLogger } from '../../../common/logging/logger';

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
};

@Injectable()
export class TunnelHandlerService {
  private readonly handlers: Record<string, (params: Record<string, unknown>) => Promise<unknown>>;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(@Inject(STORAGE_SERVICE) private readonly storage: any) {
    this.handlers = {
      'board.listProjects': (p) => this.listProjects(p),
      'board.listStatuses': (p) => this.listStatuses(p),
      'board.listParentEpics': (p) => this.listParentEpics(p),
      'board.listParentChildren': (p) => this.listParentChildren(p),
      'board.listEpicsByStatus': (p) => this.listEpicsByStatus(p),
      'board.listParentEpicsByStatus': (p) => this.listParentEpicsByStatus(p),
      'board.getEpicDetail': (p) => this.getEpicDetail(p),
    };
  }

  async handle(req: JsonRpcRequest): Promise<JsonRpcResponse> {
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
      const result = await handler(req.params ?? {});
      return { jsonrpc: '2.0', id: req.id, result };
    } catch (err) {
      logger.error({ err, method: req.method, id: req.id }, 'RPC handler error');
      return {
        jsonrpc: '2.0',
        id: req.id,
        error: { code: -32603, message: err instanceof Error ? err.message : 'Internal error' },
      };
    }
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
        const statusDto = this.toStatusDto(status);
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
    const statusMap = this.toStatusMap(statusesResult);
    const statuses = this.itemsOf(statusesResult).map((status) => this.toStatusDto(status));
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
        ...this.toEpicDto(parent, statusMap, agentNameById),
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
    const statusMap = this.toStatusMap(statusesResult);
    const agentNameById = this.toAgentNameMap(agentsResult);

    return this.itemsOf(result).map((epic) => this.toEpicDto(epic, statusMap, agentNameById));
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
    const statusMap = this.toStatusMap(statusesResult);
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
      items: this.itemsOf(childrenResult).map((epic) =>
        this.toEpicDto(epic, statusMap, agentNameById),
      ),
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
    const statusMap = this.toStatusMap(statusesResult);
    const agentNameById = this.toAgentNameMap(agentsResult);
    return this.toEpicDto(epic, statusMap, agentNameById);
  }

  private toStatusDto(status: Record<string, unknown>): Record<string, unknown> {
    return {
      id: status.id,
      name: status.name ?? status.label,
      color: status.color,
      position: status.position,
    };
  }

  private toStatusMap(result: unknown): Map<string, Record<string, unknown>> {
    return new Map(
      this.itemsOf(result)
        .filter((status) => typeof status.id === 'string')
        .map((status) => [status.id as string, this.toStatusDto(status)]),
    );
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

  private toEpicDto(
    epic: Record<string, unknown>,
    statusMap?: Map<string, Record<string, unknown>>,
    agentNameById?: Map<string, string>,
  ): Record<string, unknown> {
    const statusId = epic.statusId as string | undefined;
    const status = statusId ? statusMap?.get(statusId) : undefined;
    const agentId = (epic.agentId as string | null | undefined) ?? null;
    const resolvedAgentName =
      (agentId ? agentNameById?.get(agentId) : undefined) ?? (epic.agentName as string | undefined);

    return {
      id: epic.id,
      title: epic.title,
      statusId,
      statusName: status?.name,
      statusColor: status?.color,
      statusPosition: status?.position,
      status,
      agentId,
      agentName: resolvedAgentName,
      parentId: epic.parentId,
      updatedAt: epic.updatedAt,
      description: epic.description,
      createdAt: epic.createdAt,
      tags: epic.tags,
    };
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
