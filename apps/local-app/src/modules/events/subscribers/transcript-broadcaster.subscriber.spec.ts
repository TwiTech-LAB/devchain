import { Test, TestingModule } from '@nestjs/testing';
import { TranscriptBroadcasterSubscriber } from './transcript-broadcaster.subscriber';
import { TerminalGateway } from '../../terminal/gateways/terminal.gateway';
import type { SessionTranscriptDiscoveredEventPayload } from '../catalog/session.transcript.discovered';
import type { SessionTranscriptUpdatedEventPayload } from '../catalog/session.transcript.updated';
import type { SessionTranscriptEndedEventPayload } from '../catalog/session.transcript.ended';

describe('TranscriptBroadcasterSubscriber', () => {
  let subscriber: TranscriptBroadcasterSubscriber;
  let mockTerminalGateway: { broadcastEvent: jest.Mock };

  beforeEach(async () => {
    mockTerminalGateway = {
      broadcastEvent: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TranscriptBroadcasterSubscriber,
        {
          provide: TerminalGateway,
          useValue: mockTerminalGateway,
        },
      ],
    }).compile();

    subscriber = module.get<TranscriptBroadcasterSubscriber>(TranscriptBroadcasterSubscriber);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // discovered
  // -------------------------------------------------------------------------

  describe('handleTranscriptDiscovered', () => {
    const payload: SessionTranscriptDiscoveredEventPayload = {
      sessionId: 'session-123',
      agentId: 'agent-456',
      projectId: 'project-789',
      transcriptPath: '/home/user/.claude/projects/test/abc.jsonl',
      providerName: 'claude',
    };

    it('broadcasts envelope with correct topic and type', async () => {
      await subscriber.handleTranscriptDiscovered(payload);

      expect(mockTerminalGateway.broadcastEvent).toHaveBeenCalledWith(
        'session/session-123/transcript',
        'discovered',
        {
          sessionId: 'session-123',
          providerName: 'claude',
        },
      );
    });

    it('broadcasts exactly once', async () => {
      await subscriber.handleTranscriptDiscovered(payload);

      expect(mockTerminalGateway.broadcastEvent).toHaveBeenCalledTimes(1);
    });

    it('handles errors gracefully', async () => {
      mockTerminalGateway.broadcastEvent.mockImplementation(() => {
        throw new Error('Broadcast failed');
      });

      await expect(subscriber.handleTranscriptDiscovered(payload)).resolves.not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // updated
  // -------------------------------------------------------------------------

  describe('handleTranscriptUpdated', () => {
    const payload: SessionTranscriptUpdatedEventPayload = {
      sessionId: 'session-123',
      transcriptPath: '/home/user/.claude/projects/test/abc.jsonl',
      newMessageCount: 5,
      metrics: {
        totalTokens: 1000,
        inputTokens: 600,
        outputTokens: 400,
        costUsd: 0.05,
        messageCount: 10,
      },
    };

    it('broadcasts envelope with correct topic, type, and payload', async () => {
      await subscriber.handleTranscriptUpdated(payload);

      expect(mockTerminalGateway.broadcastEvent).toHaveBeenCalledWith(
        'session/session-123/transcript',
        'updated',
        {
          sessionId: 'session-123',
          newMessageCount: 5,
          metrics: {
            totalTokens: 1000,
            inputTokens: 600,
            outputTokens: 400,
            costUsd: 0.05,
            messageCount: 10,
          },
        },
      );
    });

    it('broadcasts exactly once', async () => {
      await subscriber.handleTranscriptUpdated(payload);

      expect(mockTerminalGateway.broadcastEvent).toHaveBeenCalledTimes(1);
    });

    it('handles errors gracefully', async () => {
      mockTerminalGateway.broadcastEvent.mockImplementation(() => {
        throw new Error('Broadcast failed');
      });

      await expect(subscriber.handleTranscriptUpdated(payload)).resolves.not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // ended
  // -------------------------------------------------------------------------

  describe('handleTranscriptEnded', () => {
    const payload: SessionTranscriptEndedEventPayload = {
      sessionId: 'session-123',
      transcriptPath: '/home/user/.claude/projects/test/abc.jsonl',
      finalMetrics: {
        totalTokens: 2000,
        inputTokens: 1200,
        outputTokens: 800,
        costUsd: 0.1,
        messageCount: 20,
      },
      endReason: 'session.stopped',
    };

    it('broadcasts envelope with correct topic, type, and payload', async () => {
      await subscriber.handleTranscriptEnded(payload);

      expect(mockTerminalGateway.broadcastEvent).toHaveBeenCalledWith(
        'session/session-123/transcript',
        'ended',
        {
          sessionId: 'session-123',
          finalMetrics: {
            totalTokens: 2000,
            inputTokens: 1200,
            outputTokens: 800,
            costUsd: 0.1,
            messageCount: 20,
          },
          endReason: 'session.stopped',
        },
      );
    });

    it('broadcasts with watcher.closed end reason', async () => {
      const closedPayload = { ...payload, endReason: 'watcher.closed' as const };

      await subscriber.handleTranscriptEnded(closedPayload);

      expect(mockTerminalGateway.broadcastEvent).toHaveBeenCalledWith(
        'session/session-123/transcript',
        'ended',
        expect.objectContaining({ endReason: 'watcher.closed' }),
      );
    });

    it('broadcasts with file.deleted end reason', async () => {
      const deletedPayload = { ...payload, endReason: 'file.deleted' as const };

      await subscriber.handleTranscriptEnded(deletedPayload);

      expect(mockTerminalGateway.broadcastEvent).toHaveBeenCalledWith(
        'session/session-123/transcript',
        'ended',
        expect.objectContaining({ endReason: 'file.deleted' }),
      );
    });

    it('broadcasts exactly once', async () => {
      await subscriber.handleTranscriptEnded(payload);

      expect(mockTerminalGateway.broadcastEvent).toHaveBeenCalledTimes(1);
    });

    it('handles errors gracefully', async () => {
      mockTerminalGateway.broadcastEvent.mockImplementation(() => {
        throw new Error('Broadcast failed');
      });

      await expect(subscriber.handleTranscriptEnded(payload)).resolves.not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Envelope format consistency
  // -------------------------------------------------------------------------

  describe('envelope format', () => {
    it('all handlers use session/{id}/transcript topic pattern', async () => {
      const sessionId = 'test-session-42';

      await subscriber.handleTranscriptDiscovered({
        sessionId,
        agentId: 'a',
        projectId: 'p',
        transcriptPath: '/tmp/t.jsonl',
        providerName: 'claude',
      });

      await subscriber.handleTranscriptUpdated({
        sessionId,
        transcriptPath: '/tmp/t.jsonl',
        newMessageCount: 1,
        metrics: { totalTokens: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, messageCount: 0 },
      });

      await subscriber.handleTranscriptEnded({
        sessionId,
        transcriptPath: '/tmp/t.jsonl',
        finalMetrics: {
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          messageCount: 0,
        },
        endReason: 'session.stopped',
      });

      const calls = mockTerminalGateway.broadcastEvent.mock.calls;
      expect(calls).toHaveLength(3);

      // All calls should use the same topic pattern
      for (const call of calls) {
        expect(call[0]).toBe(`session/${sessionId}/transcript`);
      }

      // Verify types
      expect(calls[0][1]).toBe('discovered');
      expect(calls[1][1]).toBe('updated');
      expect(calls[2][1]).toBe('ended');
    });
  });
});
