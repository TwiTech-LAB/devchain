import { createLogger } from '../../../../common/logging/logger';
import { BaseStorageDelegate, type StorageDelegateContext } from './base-storage.delegate';

const logger = createLogger('SessionStorageDelegate');

export class SessionStorageDelegate extends BaseStorageDelegate {
  constructor(context: StorageDelegateContext) {
    super(context);
  }

  async parkSessionsFromAgents(agentIds: string[]): Promise<Map<string, string[]>> {
    if (agentIds.length === 0) {
      return new Map();
    }

    const { sessions } = await import('../../db/schema');
    const { inArray, and, sql } = await import('drizzle-orm');

    return this.txRunner.runImmediate(() => {
      const rows = this.db
        .select({ id: sessions.id, agentId: sessions.agentId })
        .from(sessions)
        .where(
          and(
            inArray(sessions.agentId, agentIds),
            sql`${sessions.status} IN ('stopped', 'failed')`,
          ),
        )
        .all();

      const result = new Map<string, string[]>();
      const allSessionIds: string[] = [];

      for (const row of rows) {
        const aid = row.agentId!;
        let list = result.get(aid);
        if (!list) {
          list = [];
          result.set(aid, list);
        }
        list.push(row.id);
        allSessionIds.push(row.id);
      }

      if (allSessionIds.length > 0) {
        const now = new Date().toISOString();
        this.db
          .update(sessions)
          .set({ agentId: null, updatedAt: now })
          .where(inArray(sessions.id, allSessionIds))
          .run();

        logger.info({ agentIds, parkedCount: allSessionIds.length }, 'Parked sessions from agents');
      }

      return result;
    });
  }

  async applySessionPlan(
    toReassign: Array<{ sessionId: string; newAgentId: string }>,
    toDelete: string[],
  ): Promise<void> {
    if (toReassign.length === 0 && toDelete.length === 0) {
      return;
    }

    const { sessions, chatThreadSessionInvites } = await import('../../db/schema');
    const { inArray } = await import('drizzle-orm');

    this.txRunner.runImmediate(() => {
      if (toDelete.length > 0) {
        this.db
          .delete(chatThreadSessionInvites)
          .where(inArray(chatThreadSessionInvites.sessionId, toDelete))
          .run();

        this.db.delete(sessions).where(inArray(sessions.id, toDelete)).run();

        logger.info({ deletedCount: toDelete.length }, 'Deleted sessions and their invites');
      }

      if (toReassign.length > 0) {
        const grouped = new Map<string, string[]>();
        for (const { sessionId, newAgentId } of toReassign) {
          let list = grouped.get(newAgentId);
          if (!list) {
            list = [];
            grouped.set(newAgentId, list);
          }
          list.push(sessionId);
        }

        const now = new Date().toISOString();
        for (const [newAgentId, sessionIds] of grouped) {
          this.db
            .update(sessions)
            .set({ agentId: newAgentId, updatedAt: now })
            .where(inArray(sessions.id, sessionIds))
            .run();
        }

        logger.info(
          { reassignedCount: toReassign.length, groupCount: grouped.size },
          'Reassigned sessions to new agents',
        );
      }
    });
  }
}
