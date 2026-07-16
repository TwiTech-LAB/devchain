import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  TunnelEventForwarderService,
  TUNNEL_FORWARDED_EVENTS,
  CONTENT_BEARING_PUSH_EVENTS,
} from './tunnel-event-forwarder.service';
import type { ActiveSessionLookup } from '../../sessions/services/active-session-lookup.service';
import type { TunnelClientService } from './tunnel-client.service';
import type {
  PushChannel,
  PushChannelMode,
  TunnelPushCryptoService,
} from './tunnel-push-crypto.service';

const flush = () => new Promise((r) => setImmediate(r));

/** A sentinel sealed-envelope shape the seal mock wraps the plaintext payload in. */
const sealedEnvelope = (payload: unknown) => ({
  v: 1,
  kid: 'pc-kid',
  alg: 'XC20P',
  nonce: 'n',
  ct: 'c',
  __plain: payload,
});

describe('TunnelEventForwarderService', () => {
  let emitter: EventEmitter2;
  let activeSessions: { getSessionProjectScope: jest.Mock };
  let tunnelClient: { canPush: jest.Mock; sendPush: jest.Mock; getInstanceId: jest.Mock };
  let pushCrypto: { resolvePushChannel: jest.Mock };
  let channelMode: PushChannelMode;
  let sealMock: jest.Mock;
  let service: TunnelEventForwarderService;

  beforeEach(() => {
    emitter = new EventEmitter2({ wildcard: false, maxListeners: 50 });
    activeSessions = {
      getSessionProjectScope: jest
        .fn()
        .mockResolvedValue({ sessionId: 's1', agentId: 'a1', projectId: 'p1' }),
    };
    tunnelClient = {
      canPush: jest.fn().mockReturnValue(true),
      sendPush: jest.fn(),
      getInstanceId: jest.fn().mockReturnValue('inst-1'),
    };
    // Default: NO E2EE-capable peer → plaintext. Hint frames flow plaintext; content-bearing
    // frames are withheld. Individual tests flip `channelMode` to exercise encrypted/blocked.
    channelMode = 'plaintext';
    sealMock = jest.fn(async (topic: string, eventType: string, payload: unknown) =>
      sealedEnvelope(payload),
    );
    pushCrypto = {
      resolvePushChannel: jest.fn(
        async (): Promise<PushChannel> =>
          channelMode === 'encrypted'
            ? { mode: 'encrypted', reason: 'both-capable', seal: sealMock as never }
            : {
                mode: channelMode,
                reason: channelMode === 'blocked' ? 'peer-incapable-required' : 'plaintext-mixed',
              },
      ),
    };

    service = new TunnelEventForwarderService(
      emitter,
      activeSessions as unknown as ActiveSessionLookup,
      tunnelClient as unknown as TunnelClientService,
      pushCrypto as unknown as TunnelPushCryptoService,
    );
    service.onModuleInit();
  });

  afterEach(() => service.onModuleDestroy());

  it('only registers the 8 allowlisted events', () => {
    expect(TUNNEL_FORWARDED_EVENTS).toEqual([
      'session.transcript.updated',
      'claude.hooks.ask_user_question.pending',
      'claude.hooks.ask_user_question.resolved',
      'session.presence.changed',
      'session.activity.changed',
      'agent.created',
      'agent.deleted',
      'chat.message.created',
    ]);
    for (const event of TUNNEL_FORWARDED_EVENTS) {
      expect(emitter.listeners(event)).toHaveLength(1);
    }
  });

  it('forwards session.transcript.updated as a {type:push,v:2} frame SEALED using the registry projection', async () => {
    // Transcript deltas are content-bearing, so this frame only ships when the lane can
    // encrypt; the seal wraps the registry-projected payload (routing fields stay cleartext).
    channelMode = 'encrypted';
    emitter.emit('session.transcript.updated', {
      kind: 'delta',
      sessionId: 's1',
      transcriptPath: '/secret/path',
      newMessageCount: 2,
      metrics: { totalTokens: 1 },
      cursor: 'c2',
      prevCursor: 'c1',
      replaceFromChunkIndex: 0,
      newChunkIds: ['chunk-1'],
      totalChunkCount: 3,
      deltaChunks: [{ id: 'chunk-1' }],
      deltaMessages: [{ role: 'assistant' }],
    });
    await flush();

    expect(tunnelClient.sendPush).toHaveBeenCalledTimes(1);
    const frame = tunnelClient.sendPush.mock.calls[0][0];
    expect(frame).toMatchObject({
      type: 'push',
      v: 2,
      topic: 'session/s1/transcript',
      eventType: 'updated',
    });
    // eventId is bridge-assigned — must not be set on the wire.
    expect(frame).not.toHaveProperty('eventId');
    // The sealed envelope wraps the registry projection: internal fields (transcriptPath)
    // stripped, content (deltaChunks/deltaMessages) present only INSIDE the sealed payload.
    expect(frame.payload).toMatchObject({ alg: 'XC20P' });
    expect(frame.payload.__plain).not.toHaveProperty('transcriptPath');
    expect(frame.payload.__plain).toMatchObject({ sessionId: 's1', newMessageCount: 2 });
  });

  it('forwards AskUserQuestion pending to session/{id} SEALED when the lane is encrypted', async () => {
    channelMode = 'encrypted';
    emitter.emit('claude.hooks.ask_user_question.pending', {
      projectId: 'p1',
      agentId: 'a1',
      sessionId: 's1',
      claudeSessionId: 'cs1',
      toolUseId: 'tu1',
      questions: [
        {
          question: 'q',
          header: 'h',
          multiSelect: false,
          options: [{ label: 'x', description: '' }],
        },
      ],
      createdAt: 1,
      expiresAt: 2,
    });
    await flush();

    expect(tunnelClient.sendPush).toHaveBeenCalledTimes(1);
    const frame = tunnelClient.sendPush.mock.calls[0][0];
    // Routing fields stay cleartext for the bridge; the payload is the sealed envelope.
    expect(frame).toMatchObject({
      type: 'push',
      v: 2,
      topic: 'session/s1',
      eventType: 'ask_user_question.pending',
    });
    expect(frame.payload).toMatchObject({ alg: 'XC20P', __plain: { toolUseId: 'tu1' } });
    // The seal bound the cleartext (topic, eventType) into the AAD.
    expect(sealMock).toHaveBeenCalledWith(
      'session/s1',
      'ask_user_question.pending',
      expect.objectContaining({ toolUseId: 'tu1' }),
    );
  });

  it('forwards session.presence.changed to agent/{id}', async () => {
    emitter.emit('session.presence.changed', { agentId: 'a1', online: true, sessionId: 's1' });
    await flush();

    expect(tunnelClient.sendPush).toHaveBeenCalledTimes(1);
    expect(tunnelClient.sendPush.mock.calls[0][0]).toMatchObject({
      topic: 'agent/a1',
      eventType: 'presence',
      payload: { online: true, sessionId: 's1', agentId: 'a1' },
    });
  });

  it('forwards session.activity.changed to session/{id} as a {type:push,v:2,activity} frame', async () => {
    emitter.emit('session.activity.changed', {
      sessionId: 's1',
      state: 'busy',
      lastActivityAt: 1234,
      busySince: 1000,
    });
    await flush();

    expect(activeSessions.getSessionProjectScope).toHaveBeenCalledWith('s1');
    expect(tunnelClient.sendPush).toHaveBeenCalledTimes(1);
    const frame = tunnelClient.sendPush.mock.calls[0][0];
    expect(frame).toMatchObject({
      type: 'push',
      v: 2,
      topic: 'session/s1',
      eventType: 'activity',
      payload: { state: 'busy', lastActivityAt: 1234, busySince: 1000 },
    });
    expect(frame).not.toHaveProperty('eventId');
  });

  it('drops a session.activity.changed frame whose session is not owned (cross-session/project)', async () => {
    activeSessions.getSessionProjectScope.mockResolvedValue(null);

    emitter.emit('session.activity.changed', { sessionId: 'foreign', state: 'idle' });
    await flush();

    expect(activeSessions.getSessionProjectScope).toHaveBeenCalledWith('foreign');
    expect(tunnelClient.sendPush).not.toHaveBeenCalled();
  });

  it('drops a session.activity.changed frame with a missing sessionId', async () => {
    emitter.emit('session.activity.changed', { state: 'busy' });
    await flush();

    expect(activeSessions.getSessionProjectScope).not.toHaveBeenCalled();
    expect(tunnelClient.sendPush).not.toHaveBeenCalled();
  });

  it('does NOT forward non-allowlisted events (epic/review/board)', async () => {
    emitter.emit('epic.created', { epicId: 'e1', projectId: 'p1', title: 'T', statusId: 's1' });
    emitter.emit('review.comment.created', { commentId: 'c1', reviewId: 'r1', projectId: 'p1' });
    emitter.emit('team.member.added', {
      teamId: 't1',
      projectId: 'p1',
      addedAgentId: 'a1',
      addedAgentName: 'A',
    });
    await flush();

    expect(tunnelClient.sendPush).not.toHaveBeenCalled();
  });

  it('drops a frame whose session is not owned (scope lookup returns null)', async () => {
    activeSessions.getSessionProjectScope.mockResolvedValue(null);

    emitter.emit('session.transcript.updated', {
      kind: 'delta',
      sessionId: 'unknown',
      transcriptPath: '/p',
      newMessageCount: 1,
      metrics: {},
      cursor: 'c2',
      prevCursor: 'c1',
      replaceFromChunkIndex: 0,
      newChunkIds: [],
      totalChunkCount: 1,
      deltaChunks: [],
      deltaMessages: [],
    });
    await flush();

    expect(activeSessions.getSessionProjectScope).toHaveBeenCalledWith('unknown');
    expect(tunnelClient.sendPush).not.toHaveBeenCalled();
  });

  it('drops an AskUserQuestion frame whose projectId does not match the owning session', async () => {
    activeSessions.getSessionProjectScope.mockResolvedValue({
      sessionId: 's1',
      agentId: 'a1',
      projectId: 'p1',
    });

    emitter.emit('claude.hooks.ask_user_question.resolved', {
      projectId: 'p-other',
      sessionId: 's1',
      toolUseId: 'tu1',
    });
    await flush();

    expect(tunnelClient.sendPush).not.toHaveBeenCalled();
  });

  it('drops AskUserQuestion / presence frames with a null sessionId scope key', async () => {
    emitter.emit('claude.hooks.ask_user_question.pending', {
      projectId: 'p1',
      agentId: 'a1',
      sessionId: null,
      claudeSessionId: 'cs1',
      toolUseId: 'tu1',
      questions: [
        {
          question: 'q',
          header: 'h',
          multiSelect: false,
          options: [{ label: 'x', description: '' }],
        },
      ],
      createdAt: 1,
      expiresAt: 2,
    });
    await flush();

    expect(tunnelClient.sendPush).not.toHaveBeenCalled();
  });

  it('still forwards offline presence with a null sessionId (agent-scoped, no DB lookup)', async () => {
    emitter.emit('session.presence.changed', { agentId: 'a1', online: false, sessionId: null });
    await flush();

    expect(activeSessions.getSessionProjectScope).not.toHaveBeenCalled();
    expect(tunnelClient.sendPush).toHaveBeenCalledTimes(1);
    expect(tunnelClient.sendPush.mock.calls[0][0]).toMatchObject({ topic: 'agent/a1' });
  });

  it('skips all work (no projection, no scope lookup) when the tunnel cannot push', async () => {
    tunnelClient.canPush.mockReturnValue(false);

    emitter.emit('session.transcript.updated', {
      kind: 'delta',
      sessionId: 's1',
      transcriptPath: '/p',
    });
    await flush();

    expect(activeSessions.getSessionProjectScope).not.toHaveBeenCalled();
    expect(tunnelClient.sendPush).not.toHaveBeenCalled();
  });

  // ── Phase 1 / Task 3: agent lifecycle (RC4) + thread chat (RC3) ──

  it('forwards agent.created as a project/<id>/state frame SEALED using the registry projection', async () => {
    // agent.created carries the agent NAME (content-bearing) — only ships sealed.
    channelMode = 'encrypted';
    emitter.emit('agent.created', { projectId: 'p1', agentId: 'a1', agentName: 'New Agent' });
    await flush();

    expect(tunnelClient.sendPush).toHaveBeenCalledTimes(1);
    const frame = tunnelClient.sendPush.mock.calls[0][0];
    expect(frame).toMatchObject({
      type: 'push',
      v: 2,
      topic: 'project/p1/state',
      eventType: 'agent.created',
    });
    expect(frame.payload).toMatchObject({
      alg: 'XC20P',
      __plain: { agentId: 'a1', agentName: 'New Agent' },
    });
    expect(frame).not.toHaveProperty('eventId');
  });

  it('forwards agent.deleted as a project/<id>/state frame SEALED (payload includes team fields when present)', async () => {
    channelMode = 'encrypted';
    emitter.emit('agent.deleted', {
      projectId: 'p1',
      agentId: 'a1',
      agentName: 'Old Agent',
      teamId: 't1',
      teamName: 'Team A',
    });
    await flush();

    expect(tunnelClient.sendPush).toHaveBeenCalledTimes(1);
    expect(tunnelClient.sendPush.mock.calls[0][0]).toMatchObject({
      topic: 'project/p1/state',
      eventType: 'agent.deleted',
      payload: {
        alg: 'XC20P',
        __plain: { agentId: 'a1', agentName: 'Old Agent', teamId: 't1', teamName: 'Team A' },
      },
    });
  });

  it('drops an agent.created/agent.deleted frame with a missing projectId (scope check fail-closed)', async () => {
    emitter.emit('agent.created', { agentId: 'a1', agentName: 'No Project' });
    await flush();

    expect(activeSessions.getSessionProjectScope).not.toHaveBeenCalled();
    expect(tunnelClient.sendPush).not.toHaveBeenCalled();

    emitter.emit('agent.deleted', { agentId: 'a1', agentName: 'No Project' });
    await flush();

    expect(tunnelClient.sendPush).not.toHaveBeenCalled();
  });

  it('forwards chat.message.created as a chat/<threadId> frame SEALED when the lane is encrypted', async () => {
    channelMode = 'encrypted';
    emitter.emit('chat.message.created', {
      threadId: 't1',
      message: { id: 'm1', role: 'user', content: 'hi' },
    });
    await flush();

    expect(tunnelClient.sendPush).toHaveBeenCalledTimes(1);
    const frame = tunnelClient.sendPush.mock.calls[0][0];
    expect(frame).toMatchObject({
      type: 'push',
      v: 2,
      topic: 'chat/t1',
      eventType: 'message.created',
    });
    expect(frame.payload).toMatchObject({
      alg: 'XC20P',
      __plain: { id: 'm1', role: 'user', content: 'hi' },
    });
    expect(frame).not.toHaveProperty('eventId');
  });

  it('drops a chat.message.created frame with a missing threadId (scope check fail-closed)', async () => {
    emitter.emit('chat.message.created', { message: { id: 'm1' } });
    await flush();

    expect(activeSessions.getSessionProjectScope).not.toHaveBeenCalled();
    expect(tunnelClient.sendPush).not.toHaveBeenCalled();
  });

  // ── Phase 3: E2EE push payload sealing + content-bearing guard ──

  it('declares exactly the content-bearing events (AUQ pending + chat + transcript deltas + agent names)', () => {
    expect([...CONTENT_BEARING_PUSH_EVENTS].sort()).toEqual(
      [
        'agent.created',
        'agent.deleted',
        'chat.message.created',
        'claude.hooks.ask_user_question.pending',
        'session.transcript.updated',
      ].sort(),
    );
  });

  it('WITHHOLDS AskUserQuestion pending (question text) when the peer is not E2EE-capable', async () => {
    channelMode = 'plaintext';
    emitter.emit('claude.hooks.ask_user_question.pending', {
      projectId: 'p1',
      agentId: 'a1',
      sessionId: 's1',
      claudeSessionId: 'cs1',
      toolUseId: 'tu1',
      questions: [
        {
          question: 'secret?',
          header: 'h',
          multiSelect: false,
          options: [{ label: 'x', description: '' }],
        },
      ],
      createdAt: 1,
      expiresAt: 2,
    });
    await flush();

    // Plaintext content must NEVER ship over push to a non-capable peer.
    expect(tunnelClient.sendPush).not.toHaveBeenCalled();
  });

  it('WITHHOLDS chat.message.created (message body) when the peer is not E2EE-capable', async () => {
    channelMode = 'plaintext';
    emitter.emit('chat.message.created', {
      threadId: 't1',
      message: { id: 'm1', content: 'secret' },
    });
    await flush();

    expect(tunnelClient.sendPush).not.toHaveBeenCalled();
  });

  it('WITHHOLDS session.transcript.updated (deltaChunks/deltaMessages) when the peer is not E2EE-capable', async () => {
    // Transcript deltas carry real content — never ship them on a plaintext push. Mobile
    // recovers the tail via the per-topic catch-up RPC (push is a hint, never the truth).
    channelMode = 'plaintext';
    emitter.emit('session.transcript.updated', {
      kind: 'delta',
      sessionId: 's1',
      transcriptPath: '/p',
      newMessageCount: 1,
      metrics: {},
      cursor: 'c2',
      prevCursor: 'c1',
      replaceFromChunkIndex: 0,
      newChunkIds: ['chunk-1'],
      totalChunkCount: 1,
      deltaChunks: [{ id: 'chunk-1', text: 'secret transcript body' }],
      deltaMessages: [{ role: 'assistant', content: 'secret' }],
    });
    await flush();

    expect(tunnelClient.sendPush).not.toHaveBeenCalled();
  });

  it('WITHHOLDS agent.created / agent.deleted (agent/team names) when the peer is not E2EE-capable', async () => {
    channelMode = 'plaintext';
    emitter.emit('agent.created', { projectId: 'p1', agentId: 'a1', agentName: 'Secret Agent' });
    emitter.emit('agent.deleted', {
      projectId: 'p1',
      agentId: 'a1',
      agentName: 'Secret Agent',
      teamId: 't1',
      teamName: 'Secret Team',
    });
    await flush();

    expect(tunnelClient.sendPush).not.toHaveBeenCalled();
  });

  it('still forwards a pure-HINT frame (activity) in plaintext to a non-capable peer', async () => {
    channelMode = 'plaintext';
    emitter.emit('session.activity.changed', {
      sessionId: 's1',
      state: 'busy',
      lastActivityAt: 1234,
      busySince: 1000,
    });
    await flush();

    expect(tunnelClient.sendPush).toHaveBeenCalledTimes(1);
    // A hint payload is NOT an envelope (no plaintext content, so it may ride plaintext).
    expect(tunnelClient.sendPush.mock.calls[0][0].payload).not.toHaveProperty('__plain');
    expect(tunnelClient.sendPush.mock.calls[0][0].payload).toMatchObject({ state: 'busy' });
  });

  it('seals HINT frames too when the lane is encrypted (whole lane sealed)', async () => {
    channelMode = 'encrypted';
    emitter.emit('session.presence.changed', { agentId: 'a1', online: true, sessionId: 's1' });
    await flush();

    expect(tunnelClient.sendPush).toHaveBeenCalledTimes(1);
    const frame = tunnelClient.sendPush.mock.calls[0][0];
    expect(frame).toMatchObject({ topic: 'agent/a1', eventType: 'presence' });
    expect(frame.payload).toMatchObject({ alg: 'XC20P', __plain: { online: true } });
  });

  it('BLOCKS everything (even hints) when E2EE is required but the peer is not capable', async () => {
    channelMode = 'blocked';
    emitter.emit('session.transcript.updated', {
      kind: 'delta',
      sessionId: 's1',
      transcriptPath: '/p',
      newMessageCount: 1,
      metrics: {},
      cursor: 'c2',
      prevCursor: 'c1',
      replaceFromChunkIndex: 0,
      newChunkIds: [],
      totalChunkCount: 1,
      deltaChunks: [],
      deltaMessages: [],
    });
    emitter.emit('claude.hooks.ask_user_question.pending', {
      projectId: 'p1',
      agentId: 'a1',
      sessionId: 's1',
      claudeSessionId: 'cs1',
      toolUseId: 'tu1',
      questions: [
        {
          question: 'q',
          header: 'h',
          multiSelect: false,
          options: [{ label: 'x', description: '' }],
        },
      ],
      createdAt: 1,
      expiresAt: 2,
    });
    await flush();

    expect(tunnelClient.sendPush).not.toHaveBeenCalled();
  });

  it('removes its listeners on destroy (no leak, web path untouched)', () => {
    service.onModuleDestroy();
    for (const event of TUNNEL_FORWARDED_EVENTS) {
      expect(emitter.listeners(event)).toHaveLength(0);
    }
  });
});
