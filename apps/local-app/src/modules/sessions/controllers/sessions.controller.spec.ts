import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';

import { SessionsController } from './sessions.controller';
import type { SessionsService } from '../services/sessions.service';
import type { SessionRuntime } from '../services/session-runtime';
import type {
  SessionsMessagePoolService,
  MessageLogEntry,
} from '../services/sessions-message-pool.service';
import { createProjectWriteGateStub } from '../../storage/write-gate/testing/project-write-gate.stub';

// Valid UUIDs for testing
const VALID_PROJECT_ID = '550e8400-e29b-41d4-a716-446655440000';
const VALID_AGENT_ID = '660e8400-e29b-41d4-a716-446655440001';

describe('SessionsController', () => {
  let controller: SessionsController;
  let mockSessionsService: jest.Mocked<SessionsService>;
  let mockSessionRuntime: jest.Mocked<SessionRuntime>;
  let mockMessagePoolService: jest.Mocked<
    Pick<
      SessionsMessagePoolService,
      | 'getMessageLog'
      | 'getPoolDetails'
      | 'getMessageById'
      | 'releaseHumanHeldMessages'
      | 'forceDeferredDelivery'
    >
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

  beforeEach(() => {
    mockSessionsService = {
      terminateSession: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<SessionsService>;

    mockSessionRuntime = {
      launch: jest.fn(),
      restore: jest.fn(),
    } as unknown as jest.Mocked<SessionRuntime>;

    mockMessagePoolService = {
      getMessageLog: jest.fn().mockReturnValue([]),
      getPoolDetails: jest.fn().mockReturnValue([]),
      getMessageById: jest.fn().mockReturnValue(null),
      releaseHumanHeldMessages: jest.fn().mockResolvedValue({ status: 'released' }),
      forceDeferredDelivery: jest
        .fn()
        .mockResolvedValue({ status: 'delivered', deliveredCount: 1 }),
    };

    controller = new SessionsController(
      mockSessionsService as SessionsService,
      mockMessagePoolService as unknown as SessionsMessagePoolService,
      mockSessionRuntime as SessionRuntime,
      createProjectWriteGateStub() as never,
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

    it('should pass status filter to service (case insensitive)', () => {
      controller.getMessages(undefined, undefined, 'DELIVERED');

      expect(mockMessagePoolService.getMessageLog).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'delivered' }),
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

    it.each([
      {
        name: 'controller.getMessages',
        invoke: () => controller.getMessages(undefined, undefined, 'invalid_status'),
      },
      { name: 'controller.getPools', invoke: () => controller.getPools('not-a-uuid') },
    ])('maps invalid input in $name to bad request', ({ invoke }) => {
      expect(invoke).toThrow(BadRequestException);
    });
  });

  describe('POST /pools/:agentId/release-human-hold', () => {
    it('releases an eligible human-held lane in the requested project', async () => {
      await expect(
        controller.releaseHumanHold(VALID_AGENT_ID, { projectId: VALID_PROJECT_ID }),
      ).resolves.toEqual({ released: true });
      expect(mockMessagePoolService.releaseHumanHeldMessages).toHaveBeenCalledWith(
        VALID_AGENT_ID,
        VALID_PROJECT_ID,
      );
    });

    it('maps missing and not-ready lanes to explicit transport errors', async () => {
      mockMessagePoolService.releaseHumanHeldMessages.mockResolvedValueOnce({
        status: 'not_found',
      });
      await expect(
        controller.releaseHumanHold(VALID_AGENT_ID, { projectId: VALID_PROJECT_ID }),
      ).rejects.toBeInstanceOf(NotFoundException);

      mockMessagePoolService.releaseHumanHeldMessages.mockResolvedValueOnce({
        status: 'not_ready',
        eligibleAt: Date.now() + 1_000,
      });
      await expect(
        controller.releaseHumanHold(VALID_AGENT_ID, { projectId: VALID_PROJECT_ID }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('POST /pools/:agentId/force-deferred', () => {
    const VALID_SESSION_ID = '880e8400-e29b-41d4-a716-446655440003';
    const VALID_MSG_ID = '990e8400-e29b-41d4-a716-446655440004';

    it('returns the delivery result on success', async () => {
      await expect(
        controller.forceDeferred(VALID_AGENT_ID, {
          projectId: VALID_PROJECT_ID,
          sessionId: VALID_SESSION_ID,
          messageIds: [VALID_MSG_ID],
        }),
      ).resolves.toEqual({ status: 'delivered', deliveredCount: 1 });
      expect(mockMessagePoolService.forceDeferredDelivery).toHaveBeenCalledWith(
        VALID_AGENT_ID,
        VALID_PROJECT_ID,
        VALID_SESSION_ID,
        [VALID_MSG_ID],
      );
    });

    it('maps not_found to NotFoundException', async () => {
      mockMessagePoolService.forceDeferredDelivery.mockResolvedValueOnce({ status: 'not_found' });
      await expect(
        controller.forceDeferred(VALID_AGENT_ID, {
          projectId: VALID_PROJECT_ID,
          sessionId: VALID_SESSION_ID,
          messageIds: [VALID_MSG_ID],
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('maps conflict to ConflictException', async () => {
      mockMessagePoolService.forceDeferredDelivery.mockResolvedValueOnce({
        status: 'conflict',
        reason: 'Message batch has changed',
      });
      await expect(
        controller.forceDeferred(VALID_AGENT_ID, {
          projectId: VALID_PROJECT_ID,
          sessionId: VALID_SESSION_ID,
          messageIds: [VALID_MSG_ID],
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('GET /messages/:id', () => {
    it('should throw NotFoundException when message not found', () => {
      mockMessagePoolService.getMessageById = jest.fn().mockReturnValue(null);

      expect(() => {
        controller.getMessage(VALID_PROJECT_ID);
      }).toThrow(NotFoundException);
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

  describe('DELETE /sessions/:id (terminateSession)', () => {
    it('passes web-api user-requested provenance to the service', async () => {
      const result = await controller.terminateSession('session-1');

      expect(result).toEqual({ message: 'Session terminated successfully' });
      expect(mockSessionsService.terminateSession).toHaveBeenCalledWith('session-1', {
        source: 'web-api',
        reason: 'user-requested',
      });
    });
  });

  describe('DELETE /sessions/:id/record (deleteSessionRecord)', () => {
    const VALID_SESSION_ID = '880e8400-e29b-41d4-a716-446655440003';

    it('throws 400 when projectId is missing', async () => {
      await expect(controller.deleteSessionRecord(VALID_SESSION_ID, undefined)).rejects.toThrow(
        BadRequestException,
      );
    });
  });
});
