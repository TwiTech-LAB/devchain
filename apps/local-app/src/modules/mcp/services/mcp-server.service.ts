import { Injectable } from '@nestjs/common';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';

/**
 * Service to hold the MCP Server instance
 * This allows sharing the server between controllers
 */
@Injectable()
export class McpServerService {
  private server: Server | null = null;

  setServer(server: Server) {
    this.server = server;
  }

  getServer(): Server | null {
    return this.server;
  }
}
