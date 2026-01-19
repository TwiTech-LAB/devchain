import { Controller, All, Req, Res } from '@nestjs/common';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpService } from '../services/mcp.service';
import { McpServerService } from '../services/mcp-server.service';
import { createLogger } from '../../../common/logging/logger';
import { filterHiddenTools } from '../constants';
import { getToolDefinitions as getSharedToolDefinitions } from '../tool-definitions';

const logger = createLogger('McpSdkController');

@Controller('mcp')
export class McpSdkController {
  private server: Server;

  constructor(
    private readonly mcpService: McpService,
    private readonly mcpServerService: McpServerService,
  ) {
    this.server = new Server(
      {
        name: 'devchain-mcp',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
          resources: {},
        },
      },
    );

    // Register server in the service so other components can access it
    this.mcpServerService.setServer(this.server);

    // Register request handlers
    this.registerHandlers();
  }

  private registerHandlers() {
    // Handle tools/list
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      logger.info('tools/list request');
      return {
        tools: this.getToolDefinitions(),
      };
    });

    // Handle tools/call
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      // Default args to {} when MCP SDK omits arguments (undefined)
      const safeArgs = args ?? {};

      logger.info({ tool: name }, 'tools/call request');

      const result = await this.mcpService.handleToolCall(name, safeArgs);

      if (!result.success) {
        const error = result.error ?? {
          code: 'UNKNOWN_ERROR',
          message: 'Tool call failed for an unknown reason.',
        };

        const data = error.data as
          | { issues?: Array<{ path?: unknown[]; message?: string }>; suggestions?: string[] }
          | undefined;
        const issues = Array.isArray(data?.issues) ? (data.issues ?? []) : [];
        const suggestions = Array.isArray(data?.suggestions) ? data.suggestions : [];

        // Build human-readable summary for text content
        const issueLines = issues
          .map((issue) => {
            if (!issue) return '';
            const path = Array.isArray(issue.path) ? issue.path.join('.') : '';
            const message = issue.message ?? 'Invalid input';
            return path ? `${path}: ${message}` : message;
          })
          .filter((line) => typeof line === 'string' && line.trim().length > 0);

        const summary =
          issueLines.length > 0 ? issueLines.join(', ') : (error.message ?? 'Tool call failed');

        // Append suggestions to help AI agents self-correct
        const suggestionText = suggestions.length > 0 ? ` ${suggestions.join(' ')}` : '';

        const textMessage = error.code
          ? `${error.code}: ${summary}${suggestionText}`
          : `${summary}${suggestionText}`;

        logger.error(
          { tool: name, error, textMessage },
          'Tool call failed - returning isError result',
        );

        // Return isError result so Claude Code CLI can surface it to the model
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: textMessage,
            },
            {
              type: 'text' as const,
              text: JSON.stringify(error, null, 2),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result.data, null, 2),
          },
        ],
      };
    });

    // Handle resources/list
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      logger.info('resources/list request');
      return {
        resources: [],
      };
    });
  }

  private getToolDefinitions() {
    return filterHiddenTools(getSharedToolDefinitions());
  }

  @All()
  async handleRequest(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const sessionId = request.headers['mcp-session-id'] as string | undefined;
    logger.info({ method: request.method, url: request.url, sessionId }, 'MCP SDK request');

    // Convert Fastify request/response to Node.js IncomingMessage/ServerResponse
    const nodeReq = request.raw as IncomingMessage;
    const nodeRes = reply.raw as ServerResponse;

    // Create a new transport for this request
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    // Close transport when response is finished
    nodeRes.on('close', () => {
      transport.close();
    });

    // Connect server to transport and handle the request
    await this.server.connect(transport);
    await transport.handleRequest(nodeReq, nodeRes, request.body);
  }
}
