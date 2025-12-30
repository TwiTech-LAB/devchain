import { Controller, Get, Param, NotFoundException } from '@nestjs/common';
import { createLogger } from '../../../common/logging/logger';
import { getAllActions, getActionMetadata } from '../actions/actions.registry';
import type { ActionDefinition } from '../actions/action.interface';

const logger = createLogger('ActionsController');

/**
 * Action metadata returned by API (without execute function)
 */
export type ActionMetadataDto = Omit<ActionDefinition, 'execute'>;

@Controller('api/actions')
export class ActionsController {
  /**
   * List all available actions.
   * GET /api/actions
   * Returns action metadata without the execute function for safe serialization.
   */
  @Get()
  listActions(): ActionMetadataDto[] {
    logger.info('GET /api/actions');
    return getAllActions();
  }

  /**
   * Get a specific action by type.
   * GET /api/actions/:type
   * @throws NotFoundException if action type not found
   */
  @Get(':type')
  getAction(@Param('type') type: string): ActionMetadataDto {
    logger.info({ type }, 'GET /api/actions/:type');

    const action = getActionMetadata(type);
    if (!action) {
      throw new NotFoundException(`Action type '${type}' not found`);
    }

    return action;
  }
}
