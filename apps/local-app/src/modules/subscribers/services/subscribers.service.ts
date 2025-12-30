import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createLogger } from '../../../common/logging/logger';
import { STORAGE_SERVICE, type StorageService } from '../../storage/interfaces/storage.interface';
import type {
  Subscriber,
  CreateSubscriber,
  UpdateSubscriber,
} from '../../storage/models/domain.models';

/**
 * SubscribersService
 * Business logic for subscriber CRUD operations.
 * Subscribers are event-driven automation rules that execute actions
 * in response to watcher events.
 */
@Injectable()
export class SubscribersService {
  private readonly logger = createLogger('SubscribersService');

  constructor(@Inject(STORAGE_SERVICE) private readonly storage: StorageService) {}

  /**
   * List all subscribers for a project.
   *
   * @param projectId - The project ID
   * @returns Array of subscribers
   */
  async listSubscribers(projectId: string): Promise<Subscriber[]> {
    this.logger.debug({ projectId }, 'Listing subscribers');
    return this.storage.listSubscribers(projectId);
  }

  /**
   * Get a subscriber by ID.
   *
   * @param id - The subscriber ID
   * @returns The subscriber
   * @throws NotFoundException if subscriber not found
   */
  async getSubscriber(id: string): Promise<Subscriber> {
    this.logger.debug({ id }, 'Getting subscriber');
    const subscriber = await this.storage.getSubscriber(id);
    if (!subscriber) {
      throw new NotFoundException(`Subscriber not found: ${id}`);
    }
    return subscriber;
  }

  /**
   * Create a new subscriber.
   *
   * @param data - The subscriber creation data
   * @returns The created subscriber
   */
  async createSubscriber(data: CreateSubscriber): Promise<Subscriber> {
    this.logger.debug({ name: data.name, projectId: data.projectId }, 'Creating subscriber');
    const subscriber = await this.storage.createSubscriber(data);
    this.logger.info({ id: subscriber.id, name: subscriber.name }, 'Subscriber created');
    return subscriber;
  }

  /**
   * Update an existing subscriber.
   *
   * @param id - The subscriber ID
   * @param data - The update data
   * @returns The updated subscriber
   * @throws NotFoundException if subscriber not found
   */
  async updateSubscriber(id: string, data: UpdateSubscriber): Promise<Subscriber> {
    this.logger.debug({ id }, 'Updating subscriber');

    // Verify subscriber exists
    await this.getSubscriber(id);

    const subscriber = await this.storage.updateSubscriber(id, data);
    this.logger.info({ id: subscriber.id, name: subscriber.name }, 'Subscriber updated');
    return subscriber;
  }

  /**
   * Delete a subscriber.
   *
   * @param id - The subscriber ID
   * @throws NotFoundException if subscriber not found
   */
  async deleteSubscriber(id: string): Promise<void> {
    this.logger.debug({ id }, 'Deleting subscriber');

    // Verify subscriber exists
    const subscriber = await this.getSubscriber(id);

    await this.storage.deleteSubscriber(id);
    this.logger.info({ id, name: subscriber.name }, 'Subscriber deleted');
  }

  /**
   * Toggle a subscriber's enabled status.
   *
   * @param id - The subscriber ID
   * @param enabled - Whether the subscriber should be enabled
   * @returns The updated subscriber
   * @throws NotFoundException if subscriber not found
   */
  async toggleSubscriber(id: string, enabled: boolean): Promise<Subscriber> {
    this.logger.debug({ id, enabled }, 'Toggling subscriber');
    return this.updateSubscriber(id, { enabled });
  }

  /**
   * Find subscribers by event name.
   * Used by SubscriberExecutorService to find matching subscribers for an event.
   *
   * @param projectId - The project ID
   * @param eventName - The event name to match
   * @returns Array of matching subscribers
   */
  async findSubscribersByEventName(projectId: string, eventName: string): Promise<Subscriber[]> {
    this.logger.debug({ projectId, eventName }, 'Finding subscribers by event name');
    return this.storage.findSubscribersByEventName(projectId, eventName);
  }
}
