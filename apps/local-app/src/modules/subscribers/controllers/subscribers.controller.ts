import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  Query,
  BadRequestException,
} from '@nestjs/common';
import { createLogger } from '../../../common/logging/logger';
import { SubscribersService } from '../services/subscribers.service';
import {
  CreateSubscriberSchema,
  UpdateSubscriberSchema,
  ToggleSubscriberSchema,
  type CreateSubscriberData,
  type UpdateSubscriberData,
  type SubscriberDto,
} from '../dtos/subscriber.dto';
import type { Subscriber } from '../../storage/models/domain.models';
import {
  EVENT_FIELDS_CATALOG,
  type SubscribableEventDefinition,
} from '../events/event-fields-catalog';

const logger = createLogger('SubscribersController');

@Controller('api/subscribers')
export class SubscribersController {
  constructor(private readonly subscribersService: SubscribersService) {}

  /**
   * List all subscribable events with their field definitions.
   * GET /api/subscribers/events
   * Returns events grouped for UI display with fields available for input mapping.
   */
  @Get('events')
  listSubscribableEvents(): { events: SubscribableEventDefinition[] } {
    logger.info('GET /api/subscribers/events');

    const events = Object.values(EVENT_FIELDS_CATALOG);
    return { events };
  }

  /**
   * List all subscribers for a project.
   * GET /api/subscribers?projectId=<id>
   */
  @Get()
  async listSubscribers(@Query('projectId') projectId?: string): Promise<SubscriberDto[]> {
    logger.info({ projectId }, 'GET /api/subscribers');

    if (!projectId) {
      throw new BadRequestException('projectId query parameter is required');
    }

    const subscribers = await this.subscribersService.listSubscribers(projectId);
    return subscribers.map(this.toDto);
  }

  /**
   * Get a subscriber by ID.
   * GET /api/subscribers/:id
   * @throws NotFoundException if subscriber not found
   */
  @Get(':id')
  async getSubscriber(@Param('id') id: string): Promise<SubscriberDto> {
    logger.info({ id }, 'GET /api/subscribers/:id');

    // Service throws NotFoundException if not found
    const subscriber = await this.subscribersService.getSubscriber(id);
    return this.toDto(subscriber);
  }

  /**
   * Create a new subscriber.
   * POST /api/subscribers
   */
  @Post()
  async createSubscriber(@Body() body: unknown): Promise<SubscriberDto> {
    logger.info('POST /api/subscribers');

    const parseResult = CreateSubscriberSchema.safeParse(body);
    if (!parseResult.success) {
      throw new BadRequestException({
        message: 'Validation failed',
        errors: parseResult.error.errors,
      });
    }

    const data: CreateSubscriberData = parseResult.data;
    const subscriber = await this.subscribersService.createSubscriber({
      projectId: data.projectId,
      name: data.name,
      description: data.description ?? null,
      enabled: data.enabled,
      eventName: data.eventName,
      eventFilter: data.eventFilter ?? null,
      actionType: data.actionType,
      actionInputs: data.actionInputs,
      delayMs: data.delayMs,
      cooldownMs: data.cooldownMs,
      retryOnError: data.retryOnError,
      groupName: data.groupName ?? null,
      position: data.position,
      priority: data.priority,
    });

    return this.toDto(subscriber);
  }

  /**
   * Update an existing subscriber.
   * PUT /api/subscribers/:id
   * @throws NotFoundException if subscriber not found
   */
  @Put(':id')
  async updateSubscriber(@Param('id') id: string, @Body() body: unknown): Promise<SubscriberDto> {
    logger.info({ id }, 'PUT /api/subscribers/:id');

    const parseResult = UpdateSubscriberSchema.safeParse(body);
    if (!parseResult.success) {
      throw new BadRequestException({
        message: 'Validation failed',
        errors: parseResult.error.errors,
      });
    }

    const data: UpdateSubscriberData = parseResult.data;
    // Service throws NotFoundException if not found
    const subscriber = await this.subscribersService.updateSubscriber(id, data);

    return this.toDto(subscriber);
  }

  /**
   * Delete a subscriber.
   * DELETE /api/subscribers/:id
   * @throws NotFoundException if subscriber not found
   */
  @Delete(':id')
  async deleteSubscriber(@Param('id') id: string): Promise<void> {
    logger.info({ id }, 'DELETE /api/subscribers/:id');

    // Service throws NotFoundException if not found
    await this.subscribersService.deleteSubscriber(id);
  }

  /**
   * Toggle a subscriber's enabled status.
   * POST /api/subscribers/:id/toggle
   * @throws NotFoundException if subscriber not found
   */
  @Post(':id/toggle')
  async toggleSubscriber(@Param('id') id: string, @Body() body: unknown): Promise<SubscriberDto> {
    logger.info({ id }, 'POST /api/subscribers/:id/toggle');

    const parseResult = ToggleSubscriberSchema.safeParse(body);
    if (!parseResult.success) {
      throw new BadRequestException({
        message: 'Validation failed',
        errors: parseResult.error.errors,
      });
    }

    // Service throws NotFoundException if not found
    const subscriber = await this.subscribersService.toggleSubscriber(id, parseResult.data.enabled);

    return this.toDto(subscriber);
  }

  private toDto(subscriber: Subscriber): SubscriberDto {
    return {
      id: subscriber.id,
      projectId: subscriber.projectId,
      name: subscriber.name,
      description: subscriber.description,
      enabled: subscriber.enabled,
      eventName: subscriber.eventName,
      eventFilter: subscriber.eventFilter,
      actionType: subscriber.actionType,
      actionInputs: subscriber.actionInputs,
      delayMs: subscriber.delayMs,
      cooldownMs: subscriber.cooldownMs,
      retryOnError: subscriber.retryOnError,
      groupName: subscriber.groupName,
      position: subscriber.position,
      priority: subscriber.priority,
      createdAt: subscriber.createdAt,
      updatedAt: subscriber.updatedAt,
    };
  }
}
