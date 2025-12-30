import { ChatService } from './chat.service';
import { NotFoundException } from '@nestjs/common';
import { ValidationError } from '../../../common/errors/error-types';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import { randomUUID } from 'crypto';
import {
  CreateDirectThreadSchema,
  CreateGroupThreadSchema,
  CreateMessageSchema,
} from '../dtos/chat.dto';
import type { ChatSettingsService } from './chat-settings.service';
import type { SessionsService } from '../../sessions/services/sessions.service';
import { DEFAULT_INVITE_TEMPLATE } from './invite-template.util';

// Mock the schema module
jest.mock('../../storage/db/schema', () => ({
  chatThreads: {
    id: 'chat_threads.id',
    projectId: 'chat_threads.project_id',
    createdByType: 'chat_threads.created_by_type',
    updatedAt: 'chat_threads.updated_at',
  },
  chatMembers: {
    threadId: 'chat_members.thread_id',
    agentId: 'chat_members.agent_id',
  },
  chatMessages: {
    id: 'chat_messages.id',
    threadId: 'chat_messages.thread_id',
    createdAt: 'chat_messages.created_at',
  },
  chatMessageTargets: {
    messageId: 'chat_message_targets.message_id',
    agentId: 'chat_message_targets.agent_id',
  },
  agents: {
    id: 'agents.id',
    projectId: 'agents.project_id',
    name: 'agents.name',
  },
}));

describe('ChatService', () => {
  let service: ChatService;
  let mockDb: Record<string, jest.Mock>;
  let mockEventEmitter: {
    emit: jest.Mock;
  };
  let mockChatSettingsService: {
    getInviteTemplate: jest.Mock;
    getStoredInviteTemplate: jest.Mock;
    updateInviteTemplate: jest.Mock;
  };

  beforeEach(() => {
    mockDb = {
      select: jest.fn(),
      insert: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    };

    mockEventEmitter = {
      emit: jest.fn(),
    };

    mockChatSettingsService = {
      getInviteTemplate: jest.fn().mockResolvedValue(DEFAULT_INVITE_TEMPLATE),
      getStoredInviteTemplate: jest.fn().mockResolvedValue(''),
      updateInviteTemplate: jest.fn(),
    };

    const mockSessionsService = {
      listActiveSessions: jest.fn().mockResolvedValue([]),
    };

    service = new ChatService(
      mockDb as unknown as BetterSQLite3Database,
      mockEventEmitter as unknown as EventEmitter2,
      mockChatSettingsService as unknown as ChatSettingsService,
      mockSessionsService as unknown as SessionsService,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('getThread', () => {
    it('should return a thread with members', async () => {
      const threadId = randomUUID();
      const projectId = randomUUID();
      const agentId = randomUUID();
      const now = new Date().toISOString();

      const threadData = {
        id: threadId,
        projectId,
        title: 'Test Thread',
        isGroup: true,
        createdByType: 'user',
        createdByUserId: null,
        createdByAgentId: null,
        createdAt: now,
        updatedAt: now,
      };

      const memberData = [
        {
          threadId,
          agentId,
          createdAt: now,
        },
      ];

      // Mock thread query
      const threadChain = {
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([threadData]),
      };

      // Mock members query
      const membersChain = {
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockResolvedValue(memberData),
      };

      mockDb.select
        .mockReturnValueOnce(threadChain) // First select for thread
        .mockReturnValueOnce(membersChain); // Second select for members

      const result = await service.getThread(threadId);

      expect(result.id).toBe(threadId);
      expect(result.members).toEqual([agentId]);
      expect(result.isGroup).toBe(true);
    });

    it('should throw NotFoundException when thread does not exist', async () => {
      const threadId = randomUUID();

      const threadChain = {
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([]),
      };

      mockDb.select.mockReturnValue(threadChain);

      await expect(service.getThread(threadId)).rejects.toThrow(NotFoundException);
      await expect(service.getThread(threadId)).rejects.toThrow(`Thread ${threadId} not found`);
    });
  });

  describe('createDirectThread', () => {
    it('should create a new direct thread', async () => {
      const projectId = randomUUID();
      const agentId = randomUUID();
      const threadId = randomUUID();
      const now = new Date().toISOString();

      // Mock existing threads check (none exist)
      const existingThreadsChain = {
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockResolvedValue([]),
      };

      // Mock thread insert
      const insertThreadChain = {
        values: jest.fn().mockResolvedValue(undefined),
      };

      // Mock member insert
      const insertMemberChain = {
        values: jest.fn().mockResolvedValue(undefined),
      };

      // Mock message insert for invite system message
      const insertMessageChain = {
        values: jest.fn().mockResolvedValue(undefined),
      };

      // Mock getThread call after creation
      const getThreadChain = {
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([
          {
            id: threadId,
            projectId,
            title: null,
            isGroup: false,
            createdByType: 'user',
            createdByUserId: null,
            createdByAgentId: null,
            createdAt: now,
            updatedAt: now,
          },
        ]),
      };

      const getMembersChain = {
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockResolvedValue([
          {
            threadId,
            agentId,
            createdAt: now,
          },
        ]),
      };

      // existing threads check
      mockDb.select.mockReturnValueOnce(existingThreadsChain);

      // agent lookup for invite (return empty to skip invite path)
      const getAgentChain = {
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([]),
      };
      mockDb.select.mockReturnValueOnce(getAgentChain);

      // getThread() after creation
      mockDb.select.mockReturnValueOnce(getThreadChain);
      mockDb.select.mockReturnValueOnce(getMembersChain);

      mockDb.insert
        .mockReturnValueOnce(insertThreadChain)
        .mockReturnValueOnce(insertMemberChain)
        .mockReturnValueOnce(insertMessageChain);

      // Update chain used by persistMessage when sending invite
      const updateThreadChain = {
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockResolvedValue(undefined),
      };
      mockDb.update.mockReturnValue(updateThreadChain);

      const result = await service.createDirectThread({
        projectId,
        agentId,
      });

      expect(result.isGroup).toBe(false);
      expect(result.members).toEqual([agentId]);
      expect(insertThreadChain.values).toHaveBeenCalledTimes(1);
      expect(insertMemberChain.values).toHaveBeenCalledTimes(1);
    });
  });

  describe('createGroupThread', () => {
    it('should create a group thread with multiple agents', async () => {
      const projectId = randomUUID();
      const agentIds = [randomUUID(), randomUUID(), randomUUID()];
      const title = 'Test Group';
      const threadId = randomUUID();
      const now = new Date().toISOString();

      // Mock insert chains
      const insertThreadChain = {
        values: jest.fn().mockResolvedValue(undefined),
      };

      const insertMembersChain = {
        values: jest.fn().mockResolvedValue(undefined),
      };

      // Mock getThread call
      const getThreadChain = {
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([
          {
            id: threadId,
            projectId,
            title,
            isGroup: true,
            createdByType: 'user',
            createdByUserId: null,
            createdByAgentId: null,
            createdAt: now,
            updatedAt: now,
          },
        ]),
      };

      const getMembersChain = {
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockResolvedValue(
          agentIds.map((agentId) => ({
            threadId,
            agentId,
            createdAt: now,
          })),
        ),
      };

      mockDb.insert.mockReturnValueOnce(insertThreadChain).mockReturnValueOnce(insertMembersChain);

      mockDb.select.mockReturnValueOnce(getThreadChain).mockReturnValueOnce(getMembersChain);

      const result = await service.createGroupThread({
        projectId,
        agentIds,
        title,
        createdByType: 'user',
      });

      expect(result.isGroup).toBe(true);
      expect(result.title).toBe(title);
      expect(result.members).toEqual(agentIds);
    });

    it('should throw ValidationError if less than 2 agents provided', async () => {
      const projectId = randomUUID();
      const agentIds = [randomUUID()];

      await expect(
        service.createGroupThread({
          projectId,
          agentIds,
          createdByType: 'user',
        }),
      ).rejects.toThrow(ValidationError);
    });
  });

  describe('createMessage', () => {
    it('should create a user message and broadcast event', async () => {
      const threadId = randomUUID();
      const projectId = randomUUID();
      const now = new Date().toISOString();

      // Mock getThread
      const getThreadChain = {
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([
          {
            id: threadId,
            projectId,
            title: 'Test',
            isGroup: false,
            createdByType: 'user',
            createdByUserId: null,
            createdByAgentId: null,
            createdAt: now,
            updatedAt: now,
          },
        ]),
      };

      const getMembersChain = {
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockResolvedValue([]),
      };

      // Mock message insert
      const insertMessageChain = {
        values: jest.fn().mockResolvedValue(undefined),
      };

      // Mock thread update
      const updateThreadChain = {
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockResolvedValue(undefined),
      };

      mockDb.select.mockReturnValueOnce(getThreadChain).mockReturnValueOnce(getMembersChain);

      mockDb.insert.mockReturnValue(insertMessageChain);
      mockDb.update.mockReturnValue(updateThreadChain);

      const result = await service.createMessage(threadId, {
        content: 'Hello world!',
        authorType: 'user',
      });

      expect(result.content).toBe('Hello world!');
      expect(result.authorType).toBe('user');
      expect(result.targets).toBeUndefined();
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'chat.message.created',
        expect.objectContaining({
          threadId,
          message: expect.objectContaining({
            content: 'Hello world!',
          }),
        }),
      );
    });

    it('should create a user message with targets', async () => {
      const threadId = randomUUID();
      const projectId = randomUUID();
      const targetAgentId = randomUUID();
      const now = new Date().toISOString();

      // Mock getThread
      const getThreadChain = {
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([
          {
            id: threadId,
            projectId,
            title: 'Test',
            isGroup: true,
            createdByType: 'user',
            createdByUserId: null,
            createdByAgentId: null,
            createdAt: now,
            updatedAt: now,
          },
        ]),
      };

      const getMembersChain = {
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockResolvedValue([]),
      };

      // Mock inserts
      const insertMessageChain = {
        values: jest.fn().mockResolvedValue(undefined),
      };

      const insertTargetsChain = {
        values: jest.fn().mockResolvedValue(undefined),
      };

      // Mock update
      const updateThreadChain = {
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockResolvedValue(undefined),
      };

      mockDb.select.mockReturnValueOnce(getThreadChain).mockReturnValueOnce(getMembersChain);

      mockDb.insert.mockReturnValueOnce(insertMessageChain).mockReturnValueOnce(insertTargetsChain);

      mockDb.update.mockReturnValue(updateThreadChain);

      const result = await service.createMessage(threadId, {
        content: '@Agent1 hello!',
        authorType: 'user',
        targets: [targetAgentId],
      });

      expect(result.targets).toEqual([targetAgentId]);
      expect(insertTargetsChain.values).toHaveBeenCalledTimes(1);
    });

    it('should ignore targets for agent-authored messages', async () => {
      const threadId = randomUUID();
      const projectId = randomUUID();
      const agentId = randomUUID();
      const now = new Date().toISOString();

      // Mock getThread
      const getThreadChain = {
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([
          {
            id: threadId,
            projectId,
            title: 'Test',
            isGroup: true,
            createdByType: 'agent',
            createdByUserId: null,
            createdByAgentId: agentId,
            createdAt: now,
            updatedAt: now,
          },
        ]),
      };

      const getMembersChain = {
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockResolvedValue([]),
      };

      const insertMessageChain = {
        values: jest.fn().mockResolvedValue(undefined),
      };

      const updateThreadChain = {
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockResolvedValue(undefined),
      };

      mockDb.select.mockReturnValueOnce(getThreadChain).mockReturnValueOnce(getMembersChain);

      mockDb.insert.mockReturnValue(insertMessageChain);
      mockDb.update.mockReturnValue(updateThreadChain);

      const result = await service.createMessage(threadId, {
        content: 'Agent message',
        authorType: 'agent',
        authorAgentId: agentId,
        targets: [randomUUID()], // This should be ignored
      });

      expect(result.targets).toBeUndefined();
    });

    it('should gracefully handle WebSocket broadcast errors', async () => {
      const threadId = randomUUID();
      const projectId = randomUUID();
      const now = new Date().toISOString();

      // Mock getThread
      const getThreadChain = {
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([
          {
            id: threadId,
            projectId,
            title: 'Test',
            isGroup: false,
            createdByType: 'user',
            createdByUserId: null,
            createdByAgentId: null,
            createdAt: now,
            updatedAt: now,
          },
        ]),
      };

      const getMembersChain = {
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockResolvedValue([]),
      };

      const insertMessageChain = {
        values: jest.fn().mockResolvedValue(undefined),
      };

      const updateThreadChain = {
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockResolvedValue(undefined),
      };

      mockDb.select.mockReturnValueOnce(getThreadChain).mockReturnValueOnce(getMembersChain);

      mockDb.insert.mockReturnValue(insertMessageChain);
      mockDb.update.mockReturnValue(updateThreadChain);

      // Make event emitter throw
      mockEventEmitter.emit.mockImplementation(() => {
        throw new Error('Event emitter error');
      });

      // Should not throw
      const result = await service.createMessage(threadId, {
        content: 'Test message',
        authorType: 'user',
      });

      expect(result).toBeDefined();
      expect(result.content).toBe('Test message');
    });
  });

  describe('purgeHistory', () => {
    it('deletes messages older than cutoff and optionally announces', async () => {
      const threadId = randomUUID();
      const projectId = randomUUID();
      const now = new Date().toISOString();
      const older = new Date(Date.now() - 1000 * 60).toISOString();

      // getThread existence check
      const getThreadChain = {
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([
          {
            id: threadId,
            projectId,
            title: null,
            isGroup: false,
            createdByType: 'user',
            createdByUserId: null,
            createdByAgentId: null,
            createdAt: now,
            updatedAt: now,
          },
        ]),
      };
      mockDb.select.mockReturnValueOnce(getThreadChain);

      // get members for getThread
      const getMembersChain = {
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockResolvedValue([]),
      };
      mockDb.select.mockReturnValueOnce(getMembersChain);

      // idsToDelete select
      const idsToDeleteChain = {
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockResolvedValue([{ id: 'm1' }, { id: 'm2' }]),
      };
      mockDb.select.mockReturnValueOnce(idsToDeleteChain);

      const deleteWhereChain = { where: jest.fn().mockResolvedValue(undefined) };
      mockDb.delete.mockReturnValue(deleteWhereChain);

      // Second getThread call (after purge) - thread query
      const getThreadChain2 = {
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([
          {
            id: threadId,
            projectId,
            title: null,
            isGroup: false,
            createdByType: 'user',
            createdByUserId: null,
            createdByAgentId: null,
            createdAt: now,
            updatedAt: now,
          },
        ]),
      };
      mockDb.select.mockReturnValueOnce(getThreadChain2);

      // Second getThread call - members query
      const getMembersChain2 = {
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockResolvedValue([]),
      };
      mockDb.select.mockReturnValueOnce(getMembersChain2);

      // persistMessage for announce
      const persistSpy = jest.spyOn(
        service as unknown as {
          persistMessage: (threadId: string, data: unknown) => Promise<void>;
        },
        'persistMessage',
      );
      persistSpy.mockResolvedValue(undefined);

      await service.purgeHistory(threadId, { before: older, announce: true });

      expect(mockDb.delete).toHaveBeenCalled();
      expect(deleteWhereChain.where).toHaveBeenCalled();
      expect(persistSpy).toHaveBeenCalledWith(
        threadId,
        expect.objectContaining({ authorType: 'system' }),
      );
    });
  });

  describe('DTO validation', () => {
    it('should validate CreateDirectThreadDto', () => {
      expect(() =>
        CreateDirectThreadSchema.parse({
          projectId: randomUUID(),
          agentId: randomUUID(),
        }),
      ).not.toThrow();

      expect(() =>
        CreateDirectThreadSchema.parse({
          projectId: 'invalid-uuid',
          agentId: randomUUID(),
        }),
      ).toThrow();
    });

    it('should validate CreateGroupThreadDto', () => {
      expect(() =>
        CreateGroupThreadSchema.parse({
          projectId: randomUUID(),
          agentIds: [randomUUID(), randomUUID()],
          createdByType: 'user',
        }),
      ).not.toThrow();

      expect(() =>
        CreateGroupThreadSchema.parse({
          projectId: randomUUID(),
          agentIds: [randomUUID()], // Less than 2
          createdByType: 'user',
        }),
      ).toThrow();
    });

    it('should validate CreateMessageDto', () => {
      expect(() =>
        CreateMessageSchema.parse({
          content: 'Hello',
          authorType: 'user',
        }),
      ).not.toThrow();

      expect(() =>
        CreateMessageSchema.parse({
          content: '', // Empty string
          authorType: 'user',
        }),
      ).toThrow();

      // T3-FIX: Schema max is 100000, not 10000
      expect(() =>
        CreateMessageSchema.parse({
          content: 'x'.repeat(100001), // Too long (exceeds 100000 limit)
          authorType: 'user',
        }),
      ).toThrow();
    });
  });
});
