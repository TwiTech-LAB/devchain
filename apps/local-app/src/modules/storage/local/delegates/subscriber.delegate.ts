import type { CreateSubscriber, Subscriber, UpdateSubscriber } from '../../models/domain.models';
import { NotFoundError } from '../../../../common/errors/error-types';
import { BaseStorageDelegate, type StorageDelegateContext } from './base-storage.delegate';

export class SubscriberStorageDelegate extends BaseStorageDelegate {
  constructor(context: StorageDelegateContext) {
    super(context);
  }

  async listSubscribers(projectId: string): Promise<Subscriber[]> {
    const { automationSubscribers } = await import('../../db/schema');
    const { eq, desc } = await import('drizzle-orm');

    const rows = await this.db
      .select()
      .from(automationSubscribers)
      .where(eq(automationSubscribers.projectId, projectId))
      .orderBy(desc(automationSubscribers.createdAt));

    return rows.map((row) => ({
      ...row,
      eventFilter: row.eventFilter as Subscriber['eventFilter'],
      actionInputs: row.actionInputs as Subscriber['actionInputs'],
    })) as Subscriber[];
  }

  async getSubscriber(id: string): Promise<Subscriber | null> {
    const { automationSubscribers } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');

    const result = await this.db
      .select()
      .from(automationSubscribers)
      .where(eq(automationSubscribers.id, id))
      .limit(1);

    if (!result[0]) {
      return null;
    }

    return {
      ...result[0],
      eventFilter: result[0].eventFilter as Subscriber['eventFilter'],
      actionInputs: result[0].actionInputs as Subscriber['actionInputs'],
    } as Subscriber;
  }

  async createSubscriber(data: CreateSubscriber): Promise<Subscriber> {
    const { randomUUID } = await import('crypto');
    const now = new Date().toISOString();
    const { automationSubscribers } = await import('../../db/schema');

    const subscriber: Subscriber = {
      id: randomUUID(),
      ...data,
      createdAt: now,
      updatedAt: now,
    };

    await this.db.insert(automationSubscribers).values({
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
    });

    return subscriber;
  }

  async updateSubscriber(id: string, data: UpdateSubscriber): Promise<Subscriber> {
    const { automationSubscribers } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');
    const now = new Date().toISOString();

    const existing = await this.getSubscriber(id);
    if (!existing) {
      throw new NotFoundError('Subscriber', id);
    }

    await this.db
      .update(automationSubscribers)
      .set({ ...data, updatedAt: now })
      .where(eq(automationSubscribers.id, id));

    const updated = await this.getSubscriber(id);
    if (!updated) {
      throw new NotFoundError('Subscriber', id);
    }
    return updated;
  }

  async deleteSubscriber(id: string): Promise<void> {
    const { automationSubscribers } = await import('../../db/schema');
    const { eq } = await import('drizzle-orm');
    await this.db.delete(automationSubscribers).where(eq(automationSubscribers.id, id));
  }

  async findSubscribersByEventName(projectId: string, eventName: string): Promise<Subscriber[]> {
    const { automationSubscribers } = await import('../../db/schema');
    const { eq, and, desc } = await import('drizzle-orm');

    const rows = await this.db
      .select()
      .from(automationSubscribers)
      .where(
        and(
          eq(automationSubscribers.projectId, projectId),
          eq(automationSubscribers.eventName, eventName),
          eq(automationSubscribers.enabled, true),
        ),
      )
      .orderBy(desc(automationSubscribers.createdAt));

    return rows.map((row) => ({
      ...row,
      eventFilter: row.eventFilter as Subscriber['eventFilter'],
      actionInputs: row.actionInputs as Subscriber['actionInputs'],
    })) as Subscriber[];
  }
}
