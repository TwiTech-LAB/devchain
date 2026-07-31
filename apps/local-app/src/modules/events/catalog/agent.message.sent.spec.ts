import { agentMessageSentEvent } from './agent.message.sent';

const directPayload = {
  projectId: 'project-1',
  senderAgentId: 'agent-sender',
  senderAgentName: 'Alpha',
  routingKind: 'direct' as const,
  recipients: [{ agentId: 'agent-1', agentName: 'Beta', status: 'queued' as const }],
  recipientCount: 1,
  deliveryStatus: 'queued' as const,
};

describe('agentMessageSentEvent schema', () => {
  it('accepts direct, explicit-group, and team-group routing variants', () => {
    expect(agentMessageSentEvent.schema.safeParse(directPayload).success).toBe(true);
    expect(
      agentMessageSentEvent.schema.safeParse({
        ...directPayload,
        routingKind: 'group',
        groupKind: 'explicit',
      }).success,
    ).toBe(true);
    expect(
      agentMessageSentEvent.schema.safeParse({
        ...directPayload,
        routingKind: 'group',
        groupKind: 'team',
        teamId: 'team-1',
        teamName: 'Builders',
        teamDeliveryMode: 'lead',
      }).success,
    ).toBe(true);
  });

  it('requires team metadata only for team-group routing', () => {
    expect(
      agentMessageSentEvent.schema.safeParse({
        ...directPayload,
        routingKind: 'group',
        groupKind: 'team',
      }).success,
    ).toBe(false);
    expect(
      agentMessageSentEvent.schema.safeParse({
        ...directPayload,
        teamId: 'team-1',
        teamName: 'Builders',
        teamDeliveryMode: 'lead',
      }).success,
    ).toBe(false);
  });

  it('rejects an independently incorrect recipient count', () => {
    expect(
      agentMessageSentEvent.schema.safeParse({
        ...directPayload,
        recipientCount: 2,
      }).success,
    ).toBe(false);
  });

  it('rejects duplicate recipients and message content', () => {
    expect(
      agentMessageSentEvent.schema.safeParse({
        ...directPayload,
        recipients: [...directPayload.recipients, directPayload.recipients[0]],
        recipientCount: 2,
      }).success,
    ).toBe(false);
    expect(
      agentMessageSentEvent.schema.safeParse({
        ...directPayload,
        body: 'must not persist',
      }).success,
    ).toBe(false);
  });
});
