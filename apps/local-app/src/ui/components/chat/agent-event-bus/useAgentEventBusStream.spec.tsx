import { act, renderHook } from '@testing-library/react';
import type { Socket } from 'socket.io-client';
import { useAppSocket } from '@/ui/hooks/useAppSocket';
import {
  isAgentMessageEventPayload,
  isSessionStartedEventPayload,
  parseAgentEventBusEnvelope,
  useAgentEventBusStream,
  type AgentMessageEventPayload,
} from './useAgentEventBusStream';

jest.mock('@/ui/hooks/useAppSocket', () => ({
  useAppSocket: jest.fn(),
}));

type MessageHandler = (envelope: unknown) => void;

interface MockSocket {
  socket: Socket;
  on: jest.Mock;
  off: jest.Mock;
  emitMessage: (envelope: unknown) => void;
}

function createMockSocket(): MockSocket {
  const messageHandlers = new Set<MessageHandler>();
  const on = jest.fn((event: string, handler: MessageHandler) => {
    if (event === 'message') messageHandlers.add(handler);
  });
  const off = jest.fn((event: string, handler: MessageHandler) => {
    if (event === 'message') messageHandlers.delete(handler);
  });

  return {
    socket: { on, off } as unknown as Socket,
    on,
    off,
    emitMessage: (envelope) => {
      act(() => {
        for (const handler of [...messageHandlers]) handler(envelope);
      });
    },
  };
}

function envelope(
  payload: unknown,
  topic = 'project/project-1/agent-messages',
  type = 'sent',
): unknown {
  return { topic, type, payload, ts: '2026-07-31T00:00:00.000Z' };
}

const directPayload: AgentMessageEventPayload = {
  senderAgentId: 'sender-1',
  routingKind: 'direct',
  recipients: [{ agentId: 'recipient-1', status: 'delivered' }],
};

// Layer: pure unit. Calling the strict parsers directly is the cheapest reliable
// proof of exact payload/envelope acceptance without mounting a hook or socket.
describe('strict event-bus payload parsing', () => {
  it('accepts the narrow direct and team frame shapes', () => {
    expect(isAgentMessageEventPayload(directPayload)).toBe(true);
    expect(
      isAgentMessageEventPayload({
        senderAgentId: 'sender-1',
        routingKind: 'group',
        teamId: 'team-1',
        recipients: [
          { agentId: 'recipient-1', status: 'queued' },
          { agentId: 'recipient-2', status: 'failed' },
        ],
      }),
    ).toBe(true);
  });

  it.each([
    ['missing sender', { routingKind: 'direct', recipients: directPayload.recipients }],
    ['wrong routing kind', { ...directPayload, routingKind: 'thread' }],
    ['team on direct route', { ...directPayload, teamId: 'team-1' }],
    ['empty recipients', { ...directPayload, recipients: [] }],
    [
      'malformed recipient',
      { ...directPayload, recipients: [{ agentId: 'recipient-1', status: 'unknown' }] },
    ],
    [
      'duplicate recipients',
      {
        ...directPayload,
        recipients: [
          { agentId: 'recipient-1', status: 'delivered' },
          { agentId: 'recipient-1', status: 'failed' },
        ],
      },
    ],
    ['sender name leakage', { ...directPayload, senderAgentName: 'Sender' }],
    ['message leakage', { ...directPayload, message: 'secret' }],
    [
      'recipient name leakage',
      {
        ...directPayload,
        recipients: [{ agentId: 'recipient-1', agentName: 'Recipient', status: 'delivered' }],
      },
    ],
  ])('rejects %s', (_caseName, value) => {
    expect(isAgentMessageEventPayload(value)).toBe(false);
  });

  it('accepts only the exact session-started payload projection', () => {
    expect(isSessionStartedEventPayload({ agentId: 'agent-1' })).toBe(true);
    expect(isSessionStartedEventPayload({ agentId: '' })).toBe(false);
    expect(isSessionStartedEventPayload({ agentId: 'agent-1', sessionId: 'secret' })).toBe(false);
  });

  it('parses only exact envelopes into the discriminated client union', () => {
    expect(
      parseAgentEventBusEnvelope(envelope(directPayload), 'project/project-1/agent-messages'),
    ).toEqual({ kind: 'agent-message', ...directPayload });
    expect(
      parseAgentEventBusEnvelope(
        envelope({ agentId: 'agent-1' }, undefined, 'session.starting'),
        'project/project-1/agent-messages',
      ),
    ).toEqual({ kind: 'session-started', agentId: 'agent-1' });
    expect(
      parseAgentEventBusEnvelope(
        { ...(envelope(directPayload) as Record<string, unknown>), extra: true },
        'project/project-1/agent-messages',
      ),
    ).toBeNull();
    expect(
      parseAgentEventBusEnvelope(
        { ...(envelope(directPayload) as Record<string, unknown>), ts: 'not-a-date' },
        'project/project-1/agent-messages',
      ),
    ).toBeNull();
    expect(
      parseAgentEventBusEnvelope(
        { ...(envelope(directPayload) as Record<string, unknown>), ts: '1' },
        'project/project-1/agent-messages',
      ),
    ).toBeNull();
  });
});

// Layer: UI hook unit (jsdom). renderHook with a Socket-shaped in-memory mock is
// the cheapest reliable proof of listener binding and project/socket scope
// epochs; a live Socket.IO server would not strengthen these client invariants.
describe('useAgentEventBusStream', () => {
  const useAppSocketMock = useAppSocket as jest.MockedFunction<typeof useAppSocket>;
  let selectedSocket: MockSocket;

  beforeEach(() => {
    selectedSocket = createMockSocket();
    useAppSocketMock.mockImplementation(() => selectedSocket.socket);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('hands valid exact-scope frames to the callback and returns the selected socket', () => {
    const onFrame = jest.fn();
    const { result } = renderHook(() => useAgentEventBusStream('project-1', onFrame));

    expect(result.current).toBe(selectedSocket.socket);
    expect(useAppSocketMock).toHaveBeenCalledWith({}, []);

    selectedSocket.emitMessage(envelope(directPayload));

    expect(onFrame).toHaveBeenCalledWith({ kind: 'agent-message', ...directPayload });

    selectedSocket.emitMessage(envelope({ agentId: 'agent-1' }, undefined, 'session.starting'));
    expect(onFrame).toHaveBeenLastCalledWith({ kind: 'session-started', agentId: 'agent-1' });
  });

  it('accepts nothing while project scope is unresolved', () => {
    const onFrame = jest.fn();
    renderHook(() => useAgentEventBusStream(null, onFrame));

    expect(selectedSocket.on).not.toHaveBeenCalledWith('message', expect.any(Function));
    selectedSocket.emitMessage(envelope(directPayload));
    expect(onFrame).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong project topic', envelope(directPayload, 'project/project-2/agent-messages')],
    ['near-match topic', envelope(directPayload, 'project/project-1/agent-messages/extra')],
    ['wrong type', envelope(directPayload, undefined, 'created')],
    ['non-object envelope', null],
    ['malformed payload', envelope({ ...directPayload, message: 'secret' })],
    [
      'extra session field',
      envelope({ agentId: 'agent-1', sessionId: 'secret' }, undefined, 'session.starting'),
    ],
  ])('rejects %s', (_caseName, event) => {
    const onFrame = jest.fn();
    renderHook(() => useAgentEventBusStream('project-1', onFrame));

    selectedSocket.emitMessage(event);

    expect(onFrame).not.toHaveBeenCalled();
  });

  it('uses the latest callback without rebinding the socket listener', () => {
    const firstHandler = jest.fn();
    const secondHandler = jest.fn();
    const { rerender } = renderHook(({ onFrame }) => useAgentEventBusStream('project-1', onFrame), {
      initialProps: { onFrame: firstHandler },
    });

    rerender({ onFrame: secondHandler });
    selectedSocket.emitMessage(envelope(directPayload));

    expect(selectedSocket.on).toHaveBeenCalledTimes(1);
    expect(firstHandler).not.toHaveBeenCalled();
    expect(secondHandler).toHaveBeenCalledWith({ kind: 'agent-message', ...directPayload });
  });

  it('rebinds on project change and rejects a stale listener callback', () => {
    const onFrame = jest.fn();
    const { rerender } = renderHook(({ projectId }) => useAgentEventBusStream(projectId, onFrame), {
      initialProps: { projectId: 'project-1' },
    });
    const staleListener = selectedSocket.on.mock.calls[0][1] as MessageHandler;

    rerender({ projectId: 'project-2' });
    act(() => staleListener(envelope(directPayload)));
    selectedSocket.emitMessage(envelope(directPayload, 'project/project-2/agent-messages'));

    expect(selectedSocket.off).toHaveBeenCalledWith('message', staleListener);
    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(onFrame).toHaveBeenCalledWith({ kind: 'agent-message', ...directPayload });
  });

  it('rebinds when the runtime-selected socket object changes and rejects the old listener', () => {
    const firstSocket = selectedSocket;
    const onFrame = jest.fn();
    const { rerender, result } = renderHook(
      ({ revision }) => {
        void revision;
        return useAgentEventBusStream('project-1', onFrame);
      },
      { initialProps: { revision: 0 } },
    );
    const staleListener = firstSocket.on.mock.calls[0][1] as MessageHandler;

    selectedSocket = createMockSocket();
    rerender({ revision: 1 });
    act(() => staleListener(envelope(directPayload)));
    selectedSocket.emitMessage(envelope(directPayload));

    expect(result.current).toBe(selectedSocket.socket);
    expect(firstSocket.off).toHaveBeenCalledWith('message', staleListener);
    expect(onFrame).toHaveBeenCalledTimes(1);
  });

  it('removes its single listener on unmount', () => {
    const { unmount } = renderHook(() => useAgentEventBusStream('project-1', jest.fn()));
    const listener = selectedSocket.on.mock.calls[0][1] as MessageHandler;

    expect(selectedSocket.on).toHaveBeenCalledTimes(1);
    unmount();

    expect(selectedSocket.off).toHaveBeenCalledWith('message', listener);
  });
});
