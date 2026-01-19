import { Body, Controller, HttpCode, Post, Res, Get, Req, Headers, Delete } from '@nestjs/common';
import { McpService } from '../services/mcp.service';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'crypto';
import { filterHiddenTools } from '../constants';
import { getToolDefinitions } from '../tool-definitions';

// Minimal JSON-RPC types/utilities to avoid cross-package imports
type JsonRpcId = string | number | null;
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}
interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: unknown;
}
interface JsonRpcErrorShape {
  code: number;
  message: string;
  data?: unknown;
}
interface JsonRpcError {
  jsonrpc: '2.0';
  id: JsonRpcId;
  error: JsonRpcErrorShape;
}
const JSONRPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;
function makeError(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcError {
  const error: JsonRpcErrorShape = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}
function makeResult(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: '2.0', id, result };
}
function isJsonRpcRequest(msg: unknown): msg is JsonRpcRequest {
  if (!msg || typeof msg !== 'object') {
    return false;
  }
  const record = msg as Record<string, unknown>;
  return record.jsonrpc === '2.0' && typeof record.method === 'string';
}
function isNotification(msg: JsonRpcRequest): boolean {
  return !('id' in msg);
}

/**
 * Type guard to check if a value is a plain object (not array, null, or primitive).
 * Used to safely spread error.data into JSON-RPC error responses.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Safely extracts error data for spreading into JSON-RPC error response.
 * If data is a plain object, returns it for spreading.
 * If data is not an object (string, array, etc.), wraps it under a 'data' key.
 */
function getSpreadableErrorData(data: unknown): Record<string, unknown> {
  if (data === undefined || data === null) {
    return {};
  }
  if (isPlainObject(data)) {
    return data;
  }
  // Non-object data (string, number, array) - wrap under 'data' key
  return { data };
}

@Controller('mcp/rpc')
export class McpHttpController {
  // Session management for SSE connections
  private sessions = new Map<string, { reply: FastifyReply; pingInterval: NodeJS.Timeout }>();

  constructor(private readonly mcp: McpService) {}

  @Post()
  @HttpCode(200)
  async handle(
    @Body() payload: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Headers('mcp-session-id') _sessionId?: string,
  ): Promise<unknown> {
    // Support batch requests
    if (Array.isArray(payload)) {
      const responses = await Promise.all(payload.map((item) => this.handleOne(item, reply)));
      const filtered = responses.filter((r) => r !== null);
      // If the batch contains only notifications, send 204 No Content
      if (filtered.length === 0) {
        reply.status(204);
        return;
      }
      return filtered;
    }

    const result = await this.handleOne(payload, reply);
    if (result === null) {
      // Notification: no JSON-RPC response body
      reply.status(204);
      return;
    }
    return result;
  }

  private async handleOne(msg: unknown, reply: FastifyReply): Promise<unknown> {
    if (!isJsonRpcRequest(msg)) {
      return makeError(null, JSONRPC_ERRORS.INVALID_REQUEST, 'Invalid Request');
    }

    const req = msg as JsonRpcRequest;
    const id = req.id ?? null;

    try {
      // Handle JSON-RPC notifications (no id): execute side effects, return no content
      if (isNotification(req)) {
        // MCP protocol notifications that don't need processing
        if (req.method === 'notifications/initialized' || req.method === 'initialized') {
          // Silently acknowledge without processing
          return null;
        }
        // Other notifications could be handled here
        return null;
      }
      if (req.method === 'initialize') {
        // Generate session ID for this connection
        const newSessionId = randomUUID();
        reply.header('Mcp-Session-Id', newSessionId);

        const params = req.params as Record<string, unknown> | undefined;
        return makeResult(id, {
          protocolVersion: (params?.protocolVersion as string | undefined) ?? '2024-11-05',
          capabilities: {
            tools: {},
            resources: {},
            experimental: {
              streamableHttp: true,
            },
          },
          serverInfo: {
            name: 'devchain-local-app',
            version: '0.1.0',
          },
        });
      }
      // Support standard methods
      if (req.method === 'tools/list' || req.method === 'tools.list') {
        return makeResult(id, { tools: this.listTools() });
      }
      if (req.method === 'resources/list' || req.method === 'resources.list') {
        // No resources are exposed via HTTP JSON-RPC at the moment
        return makeResult(id, { resources: [] });
      }
      if (req.method === 'resources/read' || req.method === 'resources.read') {
        const p = (req.params || {}) as Record<string, unknown>;
        const uri = p?.uri;
        if (!uri || typeof uri !== 'string') {
          return makeError(id, JSONRPC_ERRORS.INVALID_PARAMS, 'Missing uri');
        }
        const resp = await this.mcp.handleResourceRequest(uri);
        if (resp.success) return makeResult(id, resp.data ?? null);
        return makeError(id, JSONRPC_ERRORS.INTERNAL_ERROR, resp.error?.message || 'Error', {
          code: resp.error?.code,
          ...getSpreadableErrorData(resp.error?.data),
        });
      }
      if (req.method === 'tools/call' || req.method === 'tools.call') {
        const p = (req.params || {}) as Record<string, unknown>;
        const name = p?.name ?? p?.tool ?? p?.method;
        const args = p?.arguments ?? p?.params ?? {};
        if (!name || typeof name !== 'string') {
          return makeError(id, JSONRPC_ERRORS.INVALID_PARAMS, 'Missing tool name');
        }
        const resp = await this.mcp.handleToolCall(name, args);
        if (resp.success)
          return makeResult(id, {
            content: [{ type: 'text', text: JSON.stringify(resp.data ?? null, null, 2) }],
            isError: false,
          });
        return makeError(id, JSONRPC_ERRORS.INTERNAL_ERROR, resp.error?.message || 'Error', {
          code: resp.error?.code,
          ...getSpreadableErrorData(resp.error?.data),
        });
      }

      // Direct tool invocation (method is the tool name)
      const resp = await this.mcp.handleToolCall(req.method, req.params ?? {});
      if (resp.success) return makeResult(id, resp.data ?? null);
      return makeError(id, JSONRPC_ERRORS.INTERNAL_ERROR, resp.error?.message || 'Error', {
        code: resp.error?.code,
        ...getSpreadableErrorData(resp.error?.data),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Internal error';
      return makeError(id, JSONRPC_ERRORS.INTERNAL_ERROR, message);
    }
  }

  private listTools(): Array<{ name: string; description?: string; inputSchema?: unknown }> {
    return filterHiddenTools(getToolDefinitions());
  }

  @Get()
  async handleSseStream(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
    @Headers('mcp-session-id') sessionId?: string,
    @Headers('last-event-id') _lastEventId?: string,
  ): Promise<void> {
    // Set SSE headers
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // Disable nginx buffering
    });

    // If session ID provided, associate this SSE stream with the session
    if (sessionId) {
      // Clean up old connection if exists
      const existing = this.sessions.get(sessionId);
      if (existing) {
        clearInterval(existing.pingInterval);
        this.sessions.delete(sessionId);
      }

      // Keep-alive ping every 30 seconds
      const pingInterval = setInterval(() => {
        try {
          reply.raw.write(': ping\n\n');
        } catch (error) {
          clearInterval(pingInterval);
          this.sessions.delete(sessionId);
        }
      }, 30000);

      // Store session
      this.sessions.set(sessionId, { reply, pingInterval });

      // Handle client disconnect
      request.raw.on('close', () => {
        clearInterval(pingInterval);
        this.sessions.delete(sessionId);
      });

      // Send endpoint event to confirm connection (optional)
      this.sendSseMessage(reply, 'endpoint', { message: 'SSE connection established' });
    }

    // Keep connection open
    return new Promise(() => {
      // Promise never resolves - connection stays open
    });
  }

  private sendSseMessage(reply: FastifyReply, event: string, data: unknown, id?: string): void {
    try {
      if (id) {
        reply.raw.write(`id: ${id}\n`);
      }
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (error) {
      // Client disconnected, ignore
    }
  }

  /**
   * Send message to specific session (for future use with server-initiated messages)
   */
  sendToSession(sessionId: string, event: string, data: unknown, id?: string): boolean {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.sendSseMessage(session.reply, event, data, id);
      return true;
    }
    return false;
  }

  @Delete()
  @HttpCode(200)
  async handleDelete(
    @Res({ passthrough: true }) reply: FastifyReply,
    @Headers('mcp-session-id') sessionId?: string,
  ): Promise<{ success: boolean }> {
    // Clean up session if it exists
    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (session) {
        clearInterval(session.pingInterval);
        this.sessions.delete(sessionId);
        return { success: true };
      }
    }
    return { success: false };
  }
}
