import type { McpResponse } from '../../dtos/mcp.dto';

export type McpToolHandler<TParams = unknown> = (
  ctx: unknown,
  params: TParams,
) => Promise<McpResponse>;
