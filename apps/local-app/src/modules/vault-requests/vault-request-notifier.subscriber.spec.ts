/**
 * The agent's notice when the user answers its Vault request. Unit layer: the message
 * pool call is the contract (a delivery to a terminal), so a recording delivery service
 * is the cheapest proof of who gets which line.
 */
jest.mock('../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

import type { AgentMessageDeliveryService } from '../agent-message-delivery/agent-message-delivery.service';
import { VaultRequestNotifierSubscriber } from './vault-request-notifier.subscriber';
import type { VaultRequestStore } from './vault-request.store';

describe('VaultRequestNotifierSubscriber', () => {
  const resolved = (status: 'fulfilled' | 'denied' | 'expired', reason: string | null = null) => ({
    requestId: '11111111-1111-4111-8111-111111111111',
    projectId: 'A',
    sessionId: 'session-1',
    agentId: 'agent-1',
    name: 'API_TOKEN',
    status,
    reason,
  });

  function subscriber(remoteOrigin: string | null = null) {
    const deliver = jest.fn().mockResolvedValue({ status: 'delivered', results: [] });
    const notifier = new VaultRequestNotifierSubscriber(
      { deliver } as unknown as AgentMessageDeliveryService,
      { remoteOrigin: () => remoteOrigin } as unknown as VaultRequestStore,
    );
    return { notifier, deliver };
  }

  it.each([
    [
      'fulfilled',
      'Secret API_TOKEN is available — use devchain vault exec --only API_TOKEN -- <cmd>',
    ],
    ['denied', 'The user denied your request for secret API_TOKEN.'],
  ] as const)('tells the agent through its pool when the request is %s', async (status, body) => {
    const { notifier, deliver } = subscriber();

    await notifier.onResolved(resolved(status));

    expect(deliver).toHaveBeenCalledWith(
      ['agent-1'],
      expect.objectContaining({ kind: 'pooled', body, projectId: 'A', senderName: 'System' }),
      expect.objectContaining({ requireActiveSession: true }),
    );
  });

  it("adds the user's reason to a denial", async () => {
    const { notifier, deliver } = subscriber();

    await notifier.onResolved(resolved('denied', 'Use the staging key'));

    expect(deliver.mock.calls[0][1].body).toBe(
      'The user denied your request for secret API_TOKEN. Reason: Use the staging key',
    );
  });

  it('sends nothing for an expired request', async () => {
    const { notifier, deliver } = subscriber();

    await notifier.onResolved(resolved('expired'));

    expect(deliver).not.toHaveBeenCalled();
  });

  it.each(['fulfilled', 'denied'] as const)(
    'leaves a %s request from a remote VM to that VM',
    async (status) => {
      const { notifier, deliver } = subscriber('remote-1');

      await notifier.onResolved(resolved(status));

      expect(deliver).not.toHaveBeenCalled();
    },
  );
});
