import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SessionsController } from './sessions.controller';
import type { SessionsService } from '../services/sessions.service';
import type {
  SessionsMessagePoolService,
  MessageLogEntry,
  PoolDetails,
} from '../services/sessions-message-pool.service';

// Valid UUIDs for testing
const VALID_PROJECT_ID = '550e8400-e29b-41d4-a716-446655440000';
const VALID_AGENT_ID = '660e8400-e29b-41d4-a716-446655440001';
const VALID_AGENT_ID_2 = '770e8400-e29b-41d4-a716-446655440002';

describe('SessionsController', () => {
  let controller: SessionsController;
  let mockSessionsService: jest.Mocked<SessionsService>;
  let mockMessagePoolService: jest.Mocked<
    Pick<SessionsMessagePoolService, 'getMessageLog' | 'getPoolDetails' | 'getMessageById'>
  >;

  const createMockLogEntry = (overrides: Partial<MessageLogEntry> = {}): MessageLogEntry => ({
    id: 'msg-1',
    timestamp: Date.now(),
    projectId: VALID_PROJECT_ID,
    agentId: VALID_AGENT_ID,
    agentName: 'Test Agent',
    text: 'Test message',
    source: 'test.source',
    status: 'delivered',
    immediate: false,
    ...overrides,
  });

  const createMockPoolDetails = (overrides: Partial<PoolDetails> = {}): PoolDetails => ({
    agentId: VALID_AGENT_ID,
    agentName: 'Test Agent',
    projectId: VALID_PROJECT_ID,
    messageCount: 2,
    waitingMs: 5000,
    messages: [{ id: 'msg-1', preview: 'Hello', source: 'test', timestamp: Date.now() }],
    ...overrides,
  });

  beforeEach(() => {
    mockSessionsService = {} as jest.Mocked<SessionsService>;

    mockMessagePoolService = {
      getMessageLog: jest.fn().mockReturnValue([]),
      getPoolDetails: jest.fn().mockReturnValue([]),
      getMessageById: jest.fn().mockReturnValue(null),
    };

    controller = new SessionsController(
      mockSessionsService as SessionsService,
      mockMessagePoolService as unknown as SessionsMessagePoolService,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /messages', () => {
    it('should return messages with total count', () => {
      const messages = [createMockLogEntry(), createMockLogEntry({ id: 'msg-2' })];
      mockMessagePoolService.getMessageLog.mockReturnValue(messages);

      const result = controller.getMessages();

      expect(result.messages).toHaveLength(2);
      expect(result.total).toBe(2);
    });

    it('should pass projectId filter to service', () => {
      controller.getMessages(VALID_PROJECT_ID);

      expect(mockMessagePoolService.getMessageLog).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: VALID_PROJECT_ID }),
      );
    });

    it('should pass agentId filter to service', () => {
      controller.getMessages(undefined, VALID_AGENT_ID);

      expect(mockMessagePoolService.getMessageLog).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: VALID_AGENT_ID }),
      );
    });

    it('should pass status filter to service (case insensitive)', () => {
      controller.getMessages(undefined, undefined, 'DELIVERED');

      expect(mockMessagePoolService.getMessageLog).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'delivered' }),
      );
    });

    it('should pass source filter to service', () => {
      controller.getMessages(undefined, undefined, undefined, 'epic.assigned');

      expect(mockMessagePoolService.getMessageLog).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'epic.assigned' }),
      );
    });

    it('should use default limit of 100', () => {
      const manyMessages = Array.from({ length: 150 }, (_, i) =>
        createMockLogEntry({ id: `msg-${i}` }),
      );
      mockMessagePoolService.getMessageLog.mockReturnValue(manyMessages);

      const result = controller.getMessages();

      expect(result.messages).toHaveLength(100);
      expect(result.total).toBe(150);
    });

    it('should respect custom limit', () => {
      const manyMessages = Array.from({ length: 50 }, (_, i) =>
        createMockLogEntry({ id: `msg-${i}` }),
      );
      mockMessagePoolService.getMessageLog.mockReturnValue(manyMessages);

      const result = controller.getMessages(undefined, undefined, undefined, undefined, '25');

      expect(result.messages).toHaveLength(25);
      expect(result.total).toBe(50);
    });

    it('should cap limit at 500', () => {
      const manyMessages = Array.from({ length: 600 }, (_, i) =>
        createMockLogEntry({ id: `msg-${i}` }),
      );
      mockMessagePoolService.getMessageLog.mockReturnValue(manyMessages);

      const result = controller.getMessages(undefined, undefined, undefined, undefined, '1000');

      expect(result.messages).toHaveLength(500);
      expect(result.total).toBe(600);
    });

    it('should handle invalid limit gracefully (use default)', () => {
      const messages = [createMockLogEntry()];
      mockMessagePoolService.getMessageLog.mockReturnValue(messages);

      const result = controller.getMessages(undefined, undefined, undefined, undefined, 'invalid');

      expect(result.messages).toHaveLength(1);
    });

    it('should throw BadRequestException for invalid status', () => {
      expect(() => {
        controller.getMessages(undefined, undefined, 'invalid_status');
      }).toThrow(BadRequestException);
    });

    it('should combine multiple filters', () => {
      controller.getMessages(VALID_PROJECT_ID, VALID_AGENT_ID, 'queued', 'chat.message', '50');

      expect(mockMessagePoolService.getMessageLog).toHaveBeenCalledWith({
        projectId: VALID_PROJECT_ID,
        agentId: VALID_AGENT_ID,
        status: 'queued',
        source: 'chat.message',
      });
    });

    it('should throw BadRequestException for invalid projectId', () => {
      expect(() => {
        controller.getMessages('not-a-uuid');
      }).toThrow(BadRequestException);
    });

    it('should throw BadRequestException for invalid agentId', () => {
      expect(() => {
        controller.getMessages(undefined, 'not-a-uuid');
      }).toThrow(BadRequestException);
    });

    it('should throw BadRequestException with descriptive message for invalid UUID', () => {
      try {
        controller.getMessages('invalid-uuid');
        fail('Expected BadRequestException to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(BadRequestException);
        expect((error as BadRequestException).message).toContain('projectId must be a valid UUID');
      }
    });
  });

  describe('GET /pools', () => {
    it('should return pools array', () => {
      const pools = [createMockPoolDetails()];
      mockMessagePoolService.getPoolDetails.mockReturnValue(pools);

      const result = controller.getPools();

      expect(result.pools).toHaveLength(1);
      expect(result.pools[0].agentId).toBe(VALID_AGENT_ID);
    });

    it('should return empty pools array when no pools exist', () => {
      mockMessagePoolService.getPoolDetails.mockReturnValue([]);

      const result = controller.getPools();

      expect(result.pools).toHaveLength(0);
    });

    it('should pass projectId filter to service', () => {
      controller.getPools(VALID_PROJECT_ID);

      expect(mockMessagePoolService.getPoolDetails).toHaveBeenCalledWith(VALID_PROJECT_ID);
    });

    it('should call service with undefined when no projectId provided', () => {
      controller.getPools();

      expect(mockMessagePoolService.getPoolDetails).toHaveBeenCalledWith(undefined);
    });

    it('should return multiple pools', () => {
      const pools = [
        createMockPoolDetails({ agentId: VALID_AGENT_ID }),
        createMockPoolDetails({ agentId: VALID_AGENT_ID_2 }),
      ];
      mockMessagePoolService.getPoolDetails.mockReturnValue(pools);

      const result = controller.getPools();

      expect(result.pools).toHaveLength(2);
    });

    it('should throw BadRequestException for invalid projectId', () => {
      expect(() => {
        controller.getPools('not-a-uuid');
      }).toThrow(BadRequestException);
    });

    it('should throw BadRequestException with descriptive message for invalid UUID', () => {
      try {
        controller.getPools('invalid-uuid');
        fail('Expected BadRequestException to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(BadRequestException);
        expect((error as BadRequestException).message).toContain('projectId must be a valid UUID');
      }
    });
  });

  describe('GET /messages/:id', () => {
    it('should return message details when found', () => {
      const mockMessage = createMockLogEntry({ id: VALID_PROJECT_ID });
      mockMessagePoolService.getMessageById = jest.fn().mockReturnValue(mockMessage);

      const result = controller.getMessage(VALID_PROJECT_ID);

      expect(result.message).toEqual(mockMessage);
      expect(mockMessagePoolService.getMessageById).toHaveBeenCalledWith(VALID_PROJECT_ID);
    });

    it('should throw NotFoundException when message not found', () => {
      mockMessagePoolService.getMessageById = jest.fn().mockReturnValue(null);

      expect(() => {
        controller.getMessage(VALID_PROJECT_ID);
      }).toThrow(NotFoundException);
    });

    it('should throw BadRequestException for invalid UUID', () => {
      expect(() => {
        controller.getMessage('not-a-uuid');
      }).toThrow(BadRequestException);
    });
  });

  describe('GET /messages (preview transformation)', () => {
    it('should return messages with preview field instead of text', () => {
      const mockMessages = [
        createMockLogEntry({ text: 'Short message' }),
        createMockLogEntry({
          text: 'A'.repeat(150), // Long message > 100 chars
        }),
      ];
      mockMessagePoolService.getMessageLog.mockReturnValue(mockMessages);

      const result = controller.getMessages();

      // Check that preview is returned, not text
      expect(result.messages[0]).toHaveProperty('preview');
      expect(result.messages[0]).not.toHaveProperty('text');
      expect(result.messages[0].preview).toBe('Short message');

      // Check truncation for long messages
      expect(result.messages[1].preview).toHaveLength(103); // 100 + '...'
      expect(result.messages[1].preview).toMatch(/\.\.\.$/);
    });
  });
});
