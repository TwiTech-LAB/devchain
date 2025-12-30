import { Body, Controller, HttpCode, Post, Res, Get, Req, Headers, Delete } from '@nestjs/common';
import { McpService } from '../services/mcp.service';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'crypto';
import { filterHiddenTools } from '../constants';

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
        });
      }

      // Direct tool invocation (method is the tool name)
      const resp = await this.mcp.handleToolCall(req.method, req.params ?? {});
      if (resp.success) return makeResult(id, resp.data ?? null);
      return makeError(id, JSONRPC_ERRORS.INTERNAL_ERROR, resp.error?.message || 'Error', {
        code: resp.error?.code,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Internal error';
      return makeError(id, JSONRPC_ERRORS.INTERNAL_ERROR, message);
    }
  }

  private listTools(): Array<{ name: string; description?: string; inputSchema?: unknown }> {
    const tools = [
      {
        name: 'devchain_list_sessions',
        description:
          'List active sessions for discovery. This is the bootstrap tool that requires no sessionId - use it to discover valid session IDs for other MCP calls.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'devchain_list_documents',
        description: 'List all documents for the project resolved from the session.',
        inputSchema: {
          type: 'object',
          required: ['sessionId'],
          properties: {
            sessionId: {
              type: 'string',
              description: 'Session ID (full UUID or 8+ char prefix)',
            },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Filter by tags (all must match)',
            },
            q: { type: 'string', description: 'Search query for title/content' },
            limit: { type: 'number', description: 'Max results (default: 100)' },
            offset: { type: 'number', description: 'Pagination offset (default: 0)' },
          },
        },
      },
      {
        name: 'devchain_activity_start',
        description:
          'Start an activity for an agent; posts a system start message and begins a running timer (DM by default).',
        inputSchema: {
          type: 'object',
          required: ['sessionId', 'title'],
          properties: {
            sessionId: {
              type: 'string',
              description: 'Session ID (full UUID or 8+ char prefix)',
            },
            title: { type: 'string', description: 'Activity title (<=256 chars)' },
            threadId: { type: 'string', description: 'Target thread UUID (optional)' },
            announce: { type: 'boolean', description: 'Whether to post the start system message' },
          },
        },
      },
      {
        name: 'devchain_activity_finish',
        description:
          'Finish the latest running activity for an agent; optionally posts a finish system message.',
        inputSchema: {
          type: 'object',
          required: ['sessionId'],
          properties: {
            sessionId: {
              type: 'string',
              description: 'Session ID (full UUID or 8+ char prefix)',
            },
            threadId: { type: 'string', description: 'Target thread UUID (optional)' },
            message: { type: 'string', description: 'Optional finish message (<=1000 chars)' },
            status: {
              type: 'string',
              enum: ['success', 'failed', 'canceled'],
              description: 'Final status (default success)',
            },
          },
        },
      },
      {
        name: 'devchain_get_document',
        description: 'Get a single document by ID or slug, with optional link resolution',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Document UUID' },
            slug: { type: 'string', description: 'Document slug (requires projectId)' },
            projectId: { type: 'string', description: 'Project ID when using slug' },
            includeLinks: {
              type: 'string',
              enum: ['none', 'meta', 'inline'],
              description:
                'Link resolution: none (no links), meta (link metadata), inline (full content)',
            },
            maxDepth: {
              type: 'number',
              description: 'Max depth for inline resolution (default: 1)',
            },
            maxBytes: {
              type: 'number',
              description: 'Max bytes for inline content (default: 64KB)',
            },
          },
        },
      },
      {
        name: 'devchain_create_document',
        description: 'Create a new markdown document in the project resolved from the session',
        inputSchema: {
          type: 'object',
          required: ['sessionId', 'title', 'contentMd'],
          properties: {
            sessionId: {
              type: 'string',
              description: 'Session ID (full UUID or 8+ char prefix)',
            },
            title: { type: 'string', description: 'Document title' },
            contentMd: { type: 'string', description: 'Markdown content' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Document tags' },
          },
        },
      },
      {
        name: 'devchain_update_document',
        description: 'Update an existing document',
        inputSchema: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', description: 'Document UUID' },
            title: { type: 'string', description: 'New title' },
            slug: { type: 'string', description: 'New slug' },
            contentMd: { type: 'string', description: 'New markdown content' },
            tags: { type: 'array', items: { type: 'string' }, description: 'New tags' },
            archived: { type: 'boolean', description: 'Archive status' },
            version: { type: 'number', description: 'Version for optimistic locking' },
          },
        },
      },
      {
        name: 'devchain_list_prompts',
        description: 'List prompts for the project resolved from the session',
        inputSchema: {
          type: 'object',
          required: ['sessionId'],
          properties: {
            sessionId: {
              type: 'string',
              description: 'Session ID (full UUID or 8+ char prefix)',
            },
            tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tags' },
            q: { type: 'string', description: 'Search query' },
          },
        },
      },
      {
        name: 'devchain_get_prompt',
        description: 'Get a specific prompt by ID or by (name + sessionId)',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Prompt UUID' },
            name: { type: 'string', description: 'Prompt name/title' },
            version: { type: 'number', description: 'Specific version number' },
            sessionId: {
              type: 'string',
              description:
                'Session ID (full UUID or 8+ char prefix) required when querying by name',
            },
          },
        },
      },
      {
        name: 'devchain_list_agents',
        description: 'List agents for the project resolved from the session',
        inputSchema: {
          type: 'object',
          required: ['sessionId'],
          properties: {
            sessionId: {
              type: 'string',
              description: 'Session ID (full UUID or 8+ char prefix)',
            },
            limit: { type: 'number', description: 'Max results (default: 100)' },
            offset: { type: 'number', description: 'Pagination offset (default: 0)' },
            q: {
              type: 'string',
              description: 'Optional case-insensitive substring filter on agent name',
            },
          },
        },
      },
      {
        name: 'devchain_get_agent_by_name',
        description: 'Fetch a single agent by name for the project resolved from the session',
        inputSchema: {
          type: 'object',
          required: ['sessionId', 'name'],
          properties: {
            sessionId: {
              type: 'string',
              description: 'Session ID (full UUID or 8+ char prefix)',
            },
            name: {
              type: 'string',
              description: 'Agent name to look up (case-insensitive match)',
            },
          },
        },
      },
      {
        name: 'devchain_list_statuses',
        description: 'List project statuses resolved from the session',
        inputSchema: {
          type: 'object',
          required: ['sessionId'],
          properties: {
            sessionId: {
              type: 'string',
              description: 'Session ID (full UUID or 8+ char prefix)',
            },
          },
        },
      },
      {
        name: 'devchain_list_epics',
        description: 'List epics for the project resolved from the session with optional filters',
        inputSchema: {
          type: 'object',
          required: ['sessionId'],
          properties: {
            sessionId: {
              type: 'string',
              description: 'Session ID (full UUID or 8+ char prefix)',
            },
            statusName: {
              type: 'string',
              description: 'Optional status name filter (case-insensitive)',
            },
            limit: { type: 'number', description: 'Max results (default: 100)' },
            offset: { type: 'number', description: 'Pagination offset (default: 0)' },
            q: {
              type: 'string',
              description: 'Optional search query applied to epic titles and descriptions',
            },
          },
        },
      },
      {
        name: 'devchain_list_assigned_epics_tasks',
        description:
          'List epics assigned to the specified agent within the project resolved from the session',
        inputSchema: {
          type: 'object',
          required: ['sessionId', 'agentName'],
          properties: {
            sessionId: {
              type: 'string',
              description: 'Session ID (full UUID or 8+ char prefix)',
            },
            agentName: { type: 'string', description: 'Agent name to match (case-insensitive)' },
            limit: { type: 'number', description: 'Max results (default: 100)' },
            offset: { type: 'number', description: 'Pagination offset (default: 0)' },
          },
        },
      },
      {
        name: 'devchain_create_epic',
        description: 'Create a new epic within the project resolved from the session',
        inputSchema: {
          type: 'object',
          required: ['sessionId', 'title'],
          properties: {
            sessionId: {
              type: 'string',
              description: 'Session ID (full UUID or 8+ char prefix)',
            },
            title: { type: 'string', description: 'Epic title' },
            description: { type: 'string', description: 'Optional epic description' },
            statusName: {
              type: 'string',
              description: 'Optional status name (case-insensitive)',
            },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional list of tags to assign to the epic',
            },
            agentName: {
              type: 'string',
              description: 'Optional agent name to assign (case-insensitive)',
            },
            parentId: {
              type: 'string',
              description: 'Optional parent epic UUID to nest this epic under',
            },
          },
        },
      },
      {
        name: 'devchain_get_epic_by_id',
        description: 'Fetch a single epic, including comments and related hierarchy details',
        inputSchema: {
          type: 'object',
          required: ['sessionId', 'id'],
          properties: {
            sessionId: {
              type: 'string',
              description: 'Session ID (full UUID or 8+ char prefix)',
            },
            id: { type: 'string', description: 'Epic UUID' },
          },
        },
      },
      {
        name: 'devchain_add_epic_comment',
        description:
          'Add a comment to the specified epic within the project resolved from the session. Author is derived from session agent.',
        inputSchema: {
          type: 'object',
          required: ['sessionId', 'epicId', 'content'],
          properties: {
            sessionId: {
              type: 'string',
              description: 'Session ID (full UUID or 8+ char prefix)',
            },
            epicId: { type: 'string', description: 'Epic UUID' },
            content: { type: 'string', description: 'Comment body content' },
          },
        },
      },
      {
        name: 'devchain_update_epic',
        description:
          'Update an epic with flexible field updates including status (by name), assignment (by agent name or clear), parent hierarchy, and tags. Uses optimistic locking via version.',
        inputSchema: {
          type: 'object',
          required: ['sessionId', 'id', 'version'],
          properties: {
            sessionId: {
              type: 'string',
              description: 'Session ID (full UUID or 8+ char prefix)',
            },
            id: { type: 'string', description: 'Epic UUID' },
            version: { type: 'number', description: 'Current version for optimistic locking' },
            title: { type: 'string', description: 'New epic title' },
            description: { type: 'string', description: 'New epic description' },
            statusName: {
              type: 'string',
              description: 'Status name (case-insensitive exact match)',
            },
            assignment: {
              type: 'object',
              description:
                'Assignment update: either { agentName: string } to assign or { clear: true } to unassign',
              oneOf: [
                {
                  type: 'object',
                  required: ['agentName'],
                  properties: {
                    agentName: {
                      type: 'string',
                      description: 'Agent name (case-insensitive exact match)',
                    },
                  },
                },
                {
                  type: 'object',
                  required: ['clear'],
                  properties: {
                    clear: {
                      type: 'boolean',
                      const: true,
                      description: 'Set to true to clear assignment',
                    },
                  },
                },
              ],
            },
            parentId: {
              type: 'string',
              description: 'Parent epic UUID (mutually exclusive with clearParent)',
            },
            clearParent: {
              type: 'boolean',
              description: 'Set to true to remove parent (mutually exclusive with parentId)',
            },
            setTags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Replace all tags with this array',
            },
            addTags: { type: 'array', items: { type: 'string' }, description: 'Tags to add' },
            removeTags: { type: 'array', items: { type: 'string' }, description: 'Tags to remove' },
          },
        },
      },
      {
        name: 'devchain_create_record',
        description: 'Create a new record (generic data storage for epics)',
        inputSchema: {
          type: 'object',
          required: ['epicId', 'type', 'data'],
          properties: {
            epicId: { type: 'string', description: 'Epic UUID this record belongs to' },
            type: { type: 'string', description: 'Record type identifier' },
            data: { type: 'object', description: 'Arbitrary JSON data' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Record tags' },
          },
        },
      },
      {
        name: 'devchain_update_record',
        description: 'Update an existing record',
        inputSchema: {
          type: 'object',
          required: ['id', 'version'],
          properties: {
            id: { type: 'string', description: 'Record UUID' },
            data: { type: 'object', description: 'New data (merged)' },
            type: { type: 'string', description: 'New type' },
            tags: { type: 'array', items: { type: 'string' }, description: 'New tags' },
            version: { type: 'number', description: 'Current version for optimistic locking' },
          },
        },
      },
      {
        name: 'devchain_get_record',
        description: 'Get a record by ID',
        inputSchema: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', description: 'Record UUID' } },
        },
      },
      {
        name: 'devchain_list_records',
        description: 'List records for an epic with optional filtering',
        inputSchema: {
          type: 'object',
          required: ['epicId'],
          properties: {
            epicId: { type: 'string', description: 'Epic UUID' },
            type: { type: 'string', description: 'Filter by record type' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tags' },
            limit: { type: 'number', description: 'Max results' },
            offset: { type: 'number', description: 'Pagination offset' },
          },
        },
      },
      {
        name: 'devchain_add_tags',
        description: 'Add tags to a record',
        inputSchema: {
          type: 'object',
          required: ['id', 'tags'],
          properties: {
            id: { type: 'string', description: 'Record UUID' },
            tags: {
              type: 'array',
              items: { type: 'string' },
              minItems: 1,
              description: 'Tags to add',
            },
          },
        },
      },
      {
        name: 'devchain_remove_tags',
        description: 'Remove tags from a record',
        inputSchema: {
          type: 'object',
          required: ['id', 'tags'],
          properties: {
            id: { type: 'string', description: 'Record UUID' },
            tags: {
              type: 'array',
              items: { type: 'string' },
              minItems: 1,
              description: 'Tags to remove',
            },
          },
        },
      },
      {
        name: 'devchain_send_message',
        description:
          'Send a chat message. Sender is derived from session agent. Provide recipientAgentNames to create a new agent-initiated group.',
        inputSchema: {
          type: 'object',
          required: ['sessionId', 'message'],
          properties: {
            sessionId: {
              type: 'string',
              description: 'Session ID (full UUID or 8+ char prefix)',
            },
            recipientAgentNames: {
              type: 'array',
              items: { type: 'string' },
              description: 'Agent names (case-insensitive) to receive the message.',
            },
            recipient: {
              type: 'string',
              enum: ['user', 'agents'],
              description: 'Set to "user" to DM the user without a threadId.',
            },
            message: { type: 'string', description: 'Message content to deliver.' },
          },
        },
      },
      {
        name: 'devchain_chat_ack',
        description: 'Mark a chat message as read for an agent and emit a message.read event.',
        inputSchema: {
          type: 'object',
          required: ['sessionId', 'thread_id', 'message_id'],
          properties: {
            sessionId: {
              type: 'string',
              description: 'Session ID (full UUID or 8+ char prefix)',
            },
            thread_id: { type: 'string', description: 'Chat thread UUID.' },
            message_id: { type: 'string', description: 'Chat message UUID to acknowledge.' },
          },
        },
      },
      {
        name: 'devchain_chat_read_history',
        description:
          'Fetch recent messages for a chat thread so agents can catch up after an invite.',
        inputSchema: {
          type: 'object',
          required: ['thread_id'],
          properties: {
            thread_id: { type: 'string', description: 'Chat thread UUID.' },
            limit: { type: 'number', description: 'Max messages to return (default 50, max 200).' },
            since: {
              type: 'string',
              description: 'ISO timestamp; only messages after this time are returned.',
            },
            exclude_system: {
              type: 'boolean',
              description:
                'Exclude system messages. Defaults to true when omitted to show only user/agent authored messages.',
            },
          },
        },
      },
      {
        name: 'devchain_chat_list_members',
        description: 'List members of a chat thread along with their online status.',
        inputSchema: {
          type: 'object',
          required: ['thread_id'],
          properties: { thread_id: { type: 'string', description: 'Chat thread UUID.' } },
        },
      },
    ];

    return filterHiddenTools(tools);
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
