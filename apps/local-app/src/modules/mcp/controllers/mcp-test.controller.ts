import { Controller, Post, Body } from '@nestjs/common';
import { McpServerService } from '../services/mcp-server.service';
import { createLogger } from '../../../common/logging/logger';

const logger = createLogger('McpTestController');

interface TestSamplingRequest {
  question: string;
  maxTokens?: number;
}

@Controller('mcp-test')
export class McpTestController {
  constructor(private readonly mcpServerService: McpServerService) {}

  @Post('sampling')
  async testSampling(@Body() body: TestSamplingRequest) {
    const { question, maxTokens = 500 } = body;

    logger.info({ question }, 'Sending sampling request to Claude/Codex');

    try {
      // Get the MCP server instance from the service
      const server = this.mcpServerService.getServer();

      if (!server) {
        return {
          success: false,
          error: 'MCP server not initialized',
        };
      }

      // Send a createMessage request to Claude/Codex
      const response = await server.createMessage({
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: question,
            },
          },
        ],
        maxTokens,
      });

      logger.info({ response }, 'Received response from Claude/Codex');

      return {
        success: true,
        response: {
          role: response.role,
          content: response.content,
          model: response.model,
          stopReason: response.stopReason,
        },
      };
    } catch (error) {
      logger.error({ error, question }, 'Failed to send sampling request');
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  @Post('logging')
  async testLogging(@Body() body: { message: string; level?: string }) {
    const { message, level = 'info' } = body;

    logger.info({ message, level }, 'Sending logging message to Claude/Codex');

    try {
      const server = this.mcpServerService.getServer();

      if (!server) {
        return {
          success: false,
          error: 'MCP server not initialized',
        };
      }

      await server.sendLoggingMessage({
        level: level as
          | 'debug'
          | 'info'
          | 'notice'
          | 'warning'
          | 'error'
          | 'critical'
          | 'alert'
          | 'emergency',
        data: message,
      });

      logger.info('Logging message sent successfully');

      return {
        success: true,
        message: 'Logging message sent',
      };
    } catch (error) {
      logger.error({ error }, 'Failed to send logging message');
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}
