import { ChatMessageDeliverySubscriber } from './chat-message-delivery.subscriber';
import type { AgentMessageDeliveryService } from '../agent-message-delivery.service';

describe('ChatMessageDeliverySubscriber', () => {
  afterEach(() => {
    jest.resetAllMocks();
  });

  function buildSubscriber() {
    const deliver = jest.fn().mockResolvedValue({ status: 'queued', results: [] });

    const delivery = {
      deliver,
    } as unknown as AgentMessageDeliveryService;

    const subscriber = new ChatMessageDeliverySubscriber(delivery);

    return { subscriber, delivery: { deliver } };
  }

  it('does not deliver for system messages', async () => {
    const { subscriber, delivery } = buildSubscriber();

    await subscriber.handleChatMessageCreated({
      threadId: 'thread-1',
      projectId: 'project-1',
      recipientIds: ['agent-1'],
      message: {
        id: 'msg-1',
        threadId: 'thread-1',
        authorType: 'system',
        authorAgentId: null,
        content: 'system event',
        createdAt: new Date().toISOString(),
      },
    });

    expect(delivery.deliver).not.toHaveBeenCalled();
  });

  it('does not deliver for agent-authored messages', async () => {
    const { subscriber, delivery } = buildSubscriber();

    await subscriber.handleChatMessageCreated({
      threadId: 'thread-1',
      projectId: 'project-1',
      recipientIds: ['agent-1'],
      message: {
        id: 'msg-1',
        threadId: 'thread-1',
        authorType: 'agent',
        authorAgentId: 'agent-2',
        content: 'Hello from agent',
        createdAt: new Date().toISOString(),
      },
    });

    expect(delivery.deliver).not.toHaveBeenCalled();
  });

  it('delivers user messages via AgentMessageDelivery with correct shape', async () => {
    const { subscriber, delivery } = buildSubscriber();

    await subscriber.handleChatMessageCreated({
      threadId: 'thread-1',
      projectId: 'project-1',
      recipientIds: ['agent-1'],
      message: {
        id: 'msg-1',
        threadId: 'thread-1',
        authorType: 'user',
        authorAgentId: null,
        content: 'Hello',
        createdAt: new Date().toISOString(),
      },
    });

    expect(delivery.deliver).toHaveBeenCalledTimes(1);
    expect(delivery.deliver).toHaveBeenCalledWith(['agent-1'], {
      kind: 'chat.user',
      body: 'Hello',
      source: 'chat.message',
      projectId: 'project-1',
      senderName: 'User',
      senderType: 'user',
      threadId: 'thread-1',
      messageId: 'msg-1',
      senderAgentId: undefined,
    });
  });

  it('delivers to provided recipientIds', async () => {
    const { subscriber, delivery } = buildSubscriber();

    await subscriber.handleChatMessageCreated({
      threadId: 'thread-1',
      projectId: 'project-1',
      recipientIds: ['agent-2'],
      message: {
        id: 'msg-1',
        threadId: 'thread-1',
        authorType: 'user',
        authorAgentId: null,
        content: 'Hello @Beta',
        targets: ['agent-2'],
        createdAt: new Date().toISOString(),
      },
    });

    expect(delivery.deliver).toHaveBeenCalledWith(
      ['agent-2'],
      expect.objectContaining({
        kind: 'chat.user',
        body: 'Hello @Beta',
        source: 'chat.message',
        projectId: 'project-1',
        senderName: 'User',
        senderType: 'user',
      }),
    );
  });

  it('broadcasts to all recipientIds from payload', async () => {
    const { subscriber, delivery } = buildSubscriber();

    await subscriber.handleChatMessageCreated({
      threadId: 'thread-1',
      projectId: 'project-1',
      recipientIds: ['agent-1', 'agent-2'],
      message: {
        id: 'msg-1',
        threadId: 'thread-1',
        authorType: 'user',
        authorAgentId: null,
        content: 'Hello everyone',
        createdAt: new Date().toISOString(),
      },
    });

    expect(delivery.deliver).toHaveBeenCalledWith(
      ['agent-1', 'agent-2'],
      expect.objectContaining({
        kind: 'chat.user',
        body: 'Hello everyone',
        projectId: 'project-1',
        senderName: 'User',
        senderType: 'user',
      }),
    );
  });

  it('does not deliver when recipientIds is empty', async () => {
    const { subscriber, delivery } = buildSubscriber();

    await subscriber.handleChatMessageCreated({
      threadId: 'thread-1',
      projectId: 'project-1',
      recipientIds: [],
      message: {
        id: 'msg-1',
        threadId: 'thread-1',
        authorType: 'user',
        authorAgentId: null,
        content: 'Hello',
        createdAt: new Date().toISOString(),
      },
    });

    expect(delivery.deliver).not.toHaveBeenCalled();
  });

  it('does not deliver when projectId is missing', async () => {
    const { subscriber, delivery } = buildSubscriber();

    await subscriber.handleChatMessageCreated({
      threadId: 'thread-1',
      recipientIds: ['agent-1'],
      message: {
        id: 'msg-1',
        threadId: 'thread-1',
        authorType: 'user',
        authorAgentId: null,
        content: 'Hello',
        createdAt: new Date().toISOString(),
      },
    });

    expect(delivery.deliver).not.toHaveBeenCalled();
  });

  it('does not throw when delivery fails', async () => {
    const { subscriber, delivery } = buildSubscriber();
    delivery.deliver.mockRejectedValue(new Error('Delivery failed'));

    await expect(
      subscriber.handleChatMessageCreated({
        threadId: 'thread-1',
        projectId: 'project-1',
        recipientIds: ['agent-1'],
        message: {
          id: 'msg-1',
          threadId: 'thread-1',
          authorType: 'user',
          authorAgentId: null,
          content: 'Hello',
          createdAt: new Date().toISOString(),
        },
      }),
    ).resolves.not.toThrow();
  });
});
