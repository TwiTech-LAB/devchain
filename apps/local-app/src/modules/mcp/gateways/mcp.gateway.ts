import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Injectable } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { createLogger } from '../../../common/logging/logger';
import { McpService } from '../services/mcp.service';
import { McpToolCallSchema, McpResourceRequestSchema } from '../dtos/mcp.dto';
import { createEnvelope } from '../../terminal/dtos/ws-envelope.dto';

const logger = createLogger('McpGateway');

/**
 * MCP WebSocket Gateway
 * Handles MCP tool calls over WebSocket
 */
@WebSocketGateway({
  cors: false, // Local only, no CORS needed
  transports: ['websocket'],
  namespace: '/mcp', // Separate namespace for MCP calls
})
@Injectable()
export class McpGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  constructor(private readonly mcpService: McpService) {}

  afterInit() {
    logger.info('MCP WebSocket gateway initialized');
  }

  handleConnection(@ConnectedSocket() client: Socket) {
    logger.info({ clientId: client.id }, 'MCP client connected');
  }

  handleDisconnect(@ConnectedSocket() client: Socket) {
    logger.info({ clientId: client.id }, 'MCP client disconnected');
  }

  /**
   * Handle MCP tool call from client
   */
  @SubscribeMessage('mcp:call')
  async handleToolCall(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { tool: string; params: unknown; requestId?: string },
  ) {
    const { tool, params, requestId } = payload;
    logger.info({ clientId: client.id, tool, requestId }, 'Received MCP tool call');

    try {
      // Validate payload
      McpToolCallSchema.parse({ tool, params });

      // Execute tool
      const response = await this.mcpService.handleToolCall(tool, params);

      // Send response back to client
      const envelope = createEnvelope('mcp/response', 'tool_result', {
        requestId,
        tool,
        ...response,
      });

      client.emit('message', envelope);

      logger.info(
        { clientId: client.id, tool, requestId, success: response.success },
        'MCP tool call completed',
      );
    } catch (error) {
      logger.error({ clientId: client.id, tool, requestId, error }, 'MCP tool call failed');

      const errorEnvelope = createEnvelope('mcp/response', 'tool_result', {
        requestId,
        tool,
        success: false,
        error: {
          code: 'INVALID_REQUEST',
          message: error instanceof Error ? error.message : 'Invalid request',
        },
      });

      client.emit('message', errorEnvelope);
    }
  }

  /**
   * Broadcast MCP event to all connected clients
   */
  broadcastEvent(eventType: string, payload: unknown): void {
    const envelope = createEnvelope('mcp/events', eventType, payload);
    logger.debug({ eventType }, 'Broadcasting MCP event');
    this.server.emit('message', envelope);
  }

  @SubscribeMessage('mcp:resource')
  async handleResourceRequest(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { uri: string; requestId?: string },
  ) {
    const { uri, requestId } = payload;
    logger.info({ clientId: client.id, uri, requestId }, 'Received MCP resource request');

    try {
      McpResourceRequestSchema.parse({ uri });
      const response = await this.mcpService.handleResourceRequest(uri);

      const envelope = createEnvelope('mcp/response', 'resource_result', {
        requestId,
        uri,
        ...response,
      });
      client.emit('message', envelope);

      logger.info(
        { clientId: client.id, uri, requestId, success: response.success },
        'MCP resource request completed',
      );
    } catch (error) {
      logger.error({ clientId: client.id, uri, requestId, error }, 'MCP resource request failed');

      const errorEnvelope = createEnvelope('mcp/response', 'resource_result', {
        requestId,
        uri,
        success: false,
        error: {
          code: 'INVALID_RESOURCE_REQUEST',
          message: error instanceof Error ? error.message : 'Invalid request',
        },
      });

      client.emit('message', errorEnvelope);
    }
  }
}
