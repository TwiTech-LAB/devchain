import { MessageActivityStreamService } from './message-activity-stream.service';
import type { TerminalGateway } from '../../terminal/gateways/terminal.gateway';
import type { MessageLogEntry, PoolDetails } from './sessions-message-pool.service';

describe('MessageActivityStreamService', () => {
  let service: MessageActivityStreamService;
  let mockGateway: jest.Mocked<Pick<TerminalGateway, 'broadcastEvent'>>;

  beforeEach(() => {
    mockGateway = {
      broadcastEvent: jest.fn(),
    };

    service = new MessageActivityStreamService(mockGateway as unknown as TerminalGateway);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('broadcastEnqueued', () => {
    it('should broadcast enqueued event to messages/activity topic', () => {
      const entry: MessageLogEntry = {
        id: 'msg-1',
        timestamp: Date.now(),
        projectId: 'project-1',
        agentId: 'agent-1',
        agentName: 'Test Agent',
        text: 'Hello world',
        source: 'test.source',
        status: 'queued',
        immediate: false,
      };

      service.broadcastEnqueued(entry);

      expect(mockGateway.broadcastEvent).toHaveBeenCalledWith(
        'messages/activity',
        'enqueued',
        entry,
      );
    });
  });

  describe('broadcastDelivered', () => {
    it('should broadcast delivered event with batchId and entries', () => {
      const entries: MessageLogEntry[] = [
        {
          id: 'msg-1',
          timestamp: Date.now(),
          projectId: 'project-1',
          agentId: 'agent-1',
          agentName: 'Test Agent',
          text: 'Message 1',
          source: 'test',
          status: 'delivered',
          batchId: 'batch-1',
          deliveredAt: Date.now(),
          immediate: false,
        },
        {
          id: 'msg-2',
          timestamp: Date.now(),
          projectId: 'project-1',
          agentId: 'agent-1',
          agentName: 'Test Agent',
          text: 'Message 2',
          source: 'test',
          status: 'delivered',
          batchId: 'batch-1',
          deliveredAt: Date.now(),
          immediate: false,
        },
      ];

      service.broadcastDelivered('batch-1', entries);

      expect(mockGateway.broadcastEvent).toHaveBeenCalledWith('messages/activity', 'delivered', {
        batchId: 'batch-1',
        entries,
      });
    });
  });

  describe('broadcastFailed', () => {
    it('should broadcast failed event with entry', () => {
      const entry: MessageLogEntry = {
        id: 'msg-1',
        timestamp: Date.now(),
        projectId: 'project-1',
        agentId: 'agent-1',
        agentName: 'Test Agent',
        text: 'Failed message',
        source: 'test',
        status: 'failed',
        error: 'No active session',
        immediate: false,
      };

      service.broadcastFailed(entry);

      expect(mockGateway.broadcastEvent).toHaveBeenCalledWith('messages/activity', 'failed', entry);
    });
  });

  describe('broadcastPoolsUpdated', () => {
    it('should broadcast pools update to messages/pools topic', () => {
      const pools: PoolDetails[] = [
        {
          agentId: 'agent-1',
          agentName: 'Test Agent',
          projectId: 'project-1',
          messageCount: 2,
          waitingMs: 5000,
          messages: [
            { id: 'msg-1', preview: 'Hello', source: 'test', timestamp: Date.now() },
            { id: 'msg-2', preview: 'World', source: 'test', timestamp: Date.now() },
          ],
        },
      ];

      service.broadcastPoolsUpdated(pools);

      expect(mockGateway.broadcastEvent).toHaveBeenCalledWith('messages/pools', 'updated', pools);
    });

    it('should broadcast empty pools array', () => {
      service.broadcastPoolsUpdated([]);

      expect(mockGateway.broadcastEvent).toHaveBeenCalledWith('messages/pools', 'updated', []);
    });
  });

  describe('error handling', () => {
    it('should catch and log errors without throwing', () => {
      mockGateway.broadcastEvent.mockImplementation(() => {
        throw new Error('WebSocket error');
      });

      // Should not throw
      expect(() => {
        service.broadcastEnqueued({
          id: 'msg-1',
          timestamp: Date.now(),
          projectId: 'project-1',
          agentId: 'agent-1',
          agentName: 'Test Agent',
          text: 'Test',
          source: 'test',
          status: 'queued',
          immediate: false,
        });
      }).not.toThrow();
    });
  });
});
