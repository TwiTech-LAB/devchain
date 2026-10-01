import { Inject, Injectable } from '@nestjs/common';
import { ZodError } from 'zod';
import { createLogger } from '../../../common/logging/logger';
import { STORAGE_SERVICE, type StorageService } from '../../storage/interfaces/storage.interface';
import type { McpResponse } from '../dtos/mcp.dto';
import { suggestNestedPath } from '../utils/param-suggestion';
import { McpToolBindingRegistry } from './mcp-tool-binding.registry';
import { redactParams } from './utils/redact';
import { toProjectAdmissionErrorResponse } from './utils/project-admission-error';
import { ResourceResolver } from './utils/resource-resolver';

const logger = createLogger('McpService');

@Injectable()
export class McpService {
  private readonly resourceResolver: ResourceResolver;

  constructor(
    @Inject(STORAGE_SERVICE) storage: StorageService,
    private readonly bindingRegistry: McpToolBindingRegistry,
  ) {
    logger.info('McpService initialized');
    this.resourceResolver = new ResourceResolver(storage);
  }

  async handleToolCall(tool: string, params: unknown): Promise<McpResponse> {
    const normalizedParams = params ?? {};
    const normalizedTool = tool.replace(/[.\-/]/g, '_');

    try {
      logger.info(
        { tool: normalizedTool, originalTool: tool, params: redactParams(normalizedParams) },
        'Handling MCP tool call',
      );

      if (normalizedTool === 'notifications_initialized') {
        return { success: true, data: { acknowledged: true } };
      }

      const binding = this.bindingRegistry.resolve(normalizedTool);
      if (!binding) {
        logger.warn({ tool: normalizedTool }, 'Unknown MCP tool');
        return {
          success: false,
          error: {
            code: 'UNKNOWN_TOOL',
            message: `Unknown tool: ${tool}`,
          },
        };
      }

      const parsed = binding.paramsSchema
        ? binding.paramsSchema.parse(normalizedParams)
        : normalizedParams;
      return await binding.invoke(parsed);
    } catch (error) {
      const refused = toProjectAdmissionErrorResponse(error);
      if (refused) {
        logger.info({ tool: normalizedTool, code: refused.error?.code }, 'MCP write refused');
        return refused;
      }
      logger.error({ tool, error }, 'MCP tool call failed');
      if (error instanceof ZodError) {
        const suggestions: string[] = [];
        for (const issue of error.issues) {
          if (issue.code !== 'unrecognized_keys') continue;
          for (const key of issue.keys) {
            const suggestion = suggestNestedPath(key, normalizedTool);
            if (suggestion) suggestions.push(suggestion);
          }
        }

        return {
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid parameters supplied to MCP tool.',
            data: {
              issues: error.issues,
              ...(suggestions.length > 0 && { suggestions }),
            },
          },
        };
      }

      return {
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  }

  async handleResourceRequest(uri: string): Promise<McpResponse> {
    try {
      logger.info({ uri }, 'Handling MCP resource request');
      return await this.resourceResolver.resolve(uri);
    } catch (error) {
      logger.error({ uri, error }, 'MCP resource handler failed');
      return {
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  }
}
