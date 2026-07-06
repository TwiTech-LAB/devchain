/**
 * Layer: module-unit (pure, mocked pool). Verifies the narrow read facade's
 * mobile-scoping + clientMessageId filtering + wire projection.
 */

import { SessionsMessageLogReadFacade } from './sessions-message-log-read.facade';
import type { SessionsMessagePoolService } from './sessions-message-pool.service';
import type { MessageLogEntry } from './message-pool.types';

const AGENT_ID = 'agent-1';
const PROJECT_ID = 'project-1';

function entry(over: Partial<MessageLogEntry>): MessageLogEntry {
  return {
    id: over.id ?? 'log-1',
    timestamp: over.timestamp ?? 100,
    projectId: PROJECT_ID,
    agentId: AGENT_ID,
    agentName: 'Coder',
    text: over.text ?? 'hi',
    source: over.source ?? 'mobile',
    status: over.status ?? 'delivered',
    immediate: true,
    ...over,
  };
}

describe('SessionsMessageLogReadFacade', () => {
  function build(log: MessageLogEntry[]) {
    const getMessageLog = jest.fn().mockImplementation((options?: { source?: string }) =>
      // Mirror the pool's source filter so the facade's own filtering is what's under test.
      options?.source ? log.filter((e) => e.source === options.source) : log,
    );
    const pool = { getMessageLog } as unknown as SessionsMessagePoolService;
    return { facade: new SessionsMessageLogReadFacade(pool), getMessageLog };
  }

  it('returns only requested clientMessageIds, scoped to mobile, projected to the wire shape', () => {
    const { facade, getMessageLog } = build([
      entry({ id: 'l1', clientMessageId: 'c1', status: 'delivered', deliveredAt: 200 }),
      entry({ id: 'l2', clientMessageId: 'c2', status: 'queued' }),
      entry({ id: 'l3', clientMessageId: 'c3', status: 'delivered' }), // not requested
      entry({ id: 'l4', clientMessageId: 'c1', source: 'mcp.direct' }), // wrong source, filtered by pool
    ]);

    const result = facade.queryPendingMobile(AGENT_ID, PROJECT_ID, ['c1', 'c2']);

    expect(getMessageLog).toHaveBeenCalledWith({
      agentId: AGENT_ID,
      projectId: PROJECT_ID,
      source: 'mobile',
    });
    expect(result).toEqual([
      {
        messageId: 'l1',
        clientMessageId: 'c1',
        text: 'hi',
        status: 'delivered',
        timestamp: 100,
        deliveredAt: 200,
      },
      {
        messageId: 'l2',
        clientMessageId: 'c2',
        text: 'hi',
        status: 'queued',
        timestamp: 100,
      },
    ]);
  });

  it('drops mobile entries that carry no clientMessageId', () => {
    const { facade } = build([entry({ id: 'l1', clientMessageId: undefined })]);
    expect(facade.queryPendingMobile(AGENT_ID, PROJECT_ID, ['c1'])).toEqual([]);
  });

  it('projects failureCode when present', () => {
    const { facade } = build([
      entry({
        id: 'l1',
        clientMessageId: 'c1',
        status: 'failed',
        failureCode: 'no_active_session',
      }),
    ]);
    expect(facade.queryPendingMobile(AGENT_ID, PROJECT_ID, ['c1'])[0]).toMatchObject({
      status: 'failed',
      failureCode: 'no_active_session',
    });
  });
});
