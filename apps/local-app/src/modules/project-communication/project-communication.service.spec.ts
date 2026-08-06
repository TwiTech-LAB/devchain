/**
 * Layer: module-unit
 * Justification: verifies the authorization, storage-read, and delivery orchestration boundary.
 */

import { Logger } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { resetEnvConfig } from '../../common/config/env.config';
import { NotFoundError } from '../../common/errors/error-types';
import { AgentMessageDeliveryService } from '../agent-message-delivery/agent-message-delivery.service';
import type { DeliveryOutcome } from '../agent-message-delivery/dtos/delivery.types';
import { STORAGE_SERVICE, type StorageService } from '../storage/interfaces/storage.interface';
import { createMockAgent } from '../../../test/factories/agent';
import { createMockProject } from '../../../test/factories/project';
import { ProjectCommunicationService } from './project-communication.service';

const SOURCE_ID = '11111111-1111-4111-8111-111111111111';
const TARGET_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TEMPLATE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

type CommunicationStorage = Pick<
  StorageService,
  'getAgent' | 'getProject' | 'listProjects' | 'getProjectsByIdPrefix' | 'listProjectOwners'
>;

describe('ProjectCommunicationService', () => {
  let service: ProjectCommunicationService;
  let storage: jest.Mocked<CommunicationStorage>;
  let delivery: jest.Mocked<Pick<AgentMessageDeliveryService, 'deliverAgentMessage'>>;

  const source = createMockProject({ id: SOURCE_ID, name: 'Source', rootPath: '/private/source' });
  const caller = createMockAgent({
    id: 'caller-agent',
    projectId: SOURCE_ID,
    isProjectOwner: true,
    name: 'Source Owner',
  });
  const target = createMockProject({ id: TARGET_ID, name: 'Target', rootPath: '/private/target' });
  const targetOwner = createMockAgent({
    id: 'target-owner',
    projectId: TARGET_ID,
    isProjectOwner: true,
    name: 'Target Owner',
  });

  beforeEach(async () => {
    process.env.DEVCHAIN_MODE = 'main';
    process.env.CONTAINER_PROJECT_ID = SOURCE_ID;
    resetEnvConfig();

    storage = {
      getAgent: jest.fn().mockResolvedValue(caller),
      getProject: jest.fn().mockResolvedValue(source),
      listProjects: jest.fn().mockResolvedValue({
        items: [source],
        total: 1,
        limit: 100,
        offset: 0,
      }),
      getProjectsByIdPrefix: jest.fn().mockResolvedValue([target]),
      listProjectOwners: jest.fn().mockResolvedValue([targetOwner]),
    };
    delivery = {
      deliverAgentMessage: jest.fn().mockResolvedValue({
        status: 'queued',
        results: [{ agentId: targetOwner.id, status: 'queued' }],
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProjectCommunicationService,
        { provide: STORAGE_SERVICE, useValue: storage },
        { provide: AgentMessageDeliveryService, useValue: delivery },
      ],
    }).compile();

    service = module.get(ProjectCommunicationService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.CONTAINER_PROJECT_ID;
    delete process.env.DEVCHAIN_MODE;
    resetEnvConfig();
  });

  describe('authorization', () => {
    it('rejects guest context with a stable code and no storage or delivery side effect', async () => {
      await expect(service.listTargets(null, { limit: 10, offset: 0 })).resolves.toEqual({
        error: {
          code: 'AGENT_CONTEXT_REQUIRED',
          message: 'A current agent session is required',
        },
      });

      expect(storage.getAgent).not.toHaveBeenCalled();
      expect(delivery.deliverAgentMessage).not.toHaveBeenCalled();
    });

    it('maps a deleted caller to the same stable agent-context error', async () => {
      storage.getAgent.mockRejectedValue(new NotFoundError('Agent', caller.id));

      await expect(
        service.sendToProject({
          callerAgentId: caller.id,
          recipientProjectId: TARGET_ID.slice(0, 8),
          message: 'hello',
        }),
      ).resolves.toEqual({
        error: {
          code: 'AGENT_CONTEXT_REQUIRED',
          message: 'A current agent session is required',
        },
      });
      expect(delivery.deliverAgentMessage).not.toHaveBeenCalled();
    });

    it('re-reads and rejects a caller who is no longer the project owner', async () => {
      storage.getAgent.mockResolvedValue({ ...caller, isProjectOwner: false });

      const result = await service.listTargets(caller.id, { limit: 10, offset: 0 });

      expect(storage.getAgent).toHaveBeenCalledWith(caller.id);
      expect(result).toEqual({
        error: {
          code: 'FORBIDDEN_NOT_PROJECT_OWNER',
          message: 'Only the current Project Owner can communicate across projects',
        },
      });
      expect(storage.listProjects).not.toHaveBeenCalled();
    });
  });

  describe('container scope', () => {
    it('disables cross-project operations in a normal container-scoped runtime', async () => {
      process.env.DEVCHAIN_MODE = 'normal';
      resetEnvConfig();

      const result = await service.sendToProject({
        callerAgentId: caller.id,
        recipientProjectId: TARGET_ID,
        message: 'hello',
      });

      expect(result).toEqual({
        error: {
          code: 'CROSS_PROJECT_UNAVAILABLE',
          message: 'Cross-project communication is unavailable in this runtime',
        },
      });
      expect(storage.getProjectsByIdPrefix).not.toHaveBeenCalled();
    });

    it('intentionally ignores CONTAINER_PROJECT_ID in main mode', async () => {
      const result = await service.sendToProject({
        callerAgentId: caller.id,
        recipientProjectId: TARGET_ID,
        message: 'hello',
      });

      expect(result).toMatchObject({ result: { mode: 'project', deliveryStatus: 'queued' } });
      expect(delivery.deliverAgentMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe('listTargets', () => {
    it('collects a complete snapshot, maps safe fields, sorts, then paginates', async () => {
      const alphaHighId = createMockProject({
        id: OTHER_ID,
        name: 'alpha',
        description: 'second alpha',
        rootPath: '/private/alpha-high',
      });
      const alphaLowId = createMockProject({
        id: TARGET_ID,
        name: 'Alpha',
        description: 'first alpha',
        rootPath: '/private/alpha-low',
      });
      const ownerless = createMockProject({
        id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        name: 'Zulu',
        description: null,
        rootPath: '/private/ownerless',
      });
      const template = createMockProject({
        id: TEMPLATE_ID,
        name: 'Template',
        isTemplate: true,
        rootPath: '/private/template',
      });
      storage.listProjects
        .mockResolvedValueOnce({
          items: [ownerless, source, template],
          total: 5,
          limit: 3,
          offset: 0,
        })
        .mockResolvedValueOnce({
          items: [alphaHighId, alphaLowId],
          total: 5,
          limit: 3,
          offset: 3,
        });
      storage.listProjectOwners.mockResolvedValue([targetOwner]);

      const result = await service.listTargets(caller.id, { limit: 2, offset: 1 });

      expect(storage.listProjects).toHaveBeenNthCalledWith(1, { limit: 100, offset: 0 });
      expect(storage.listProjects).toHaveBeenNthCalledWith(2, { limit: 100, offset: 3 });
      expect(storage.listProjectOwners).toHaveBeenCalledTimes(1);
      expect(storage.listProjectOwners).toHaveBeenCalledWith([
        ownerless.id,
        alphaHighId.id,
        alphaLowId.id,
      ]);
      expect(result).toEqual({
        result: {
          projects: [
            {
              id: OTHER_ID,
              shortId: OTHER_ID.slice(0, 8),
              name: 'alpha',
              description: 'second alpha',
              hasProjectOwner: false,
            },
            {
              id: ownerless.id,
              shortId: ownerless.id.slice(0, 8),
              name: 'Zulu',
              description: null,
              hasProjectOwner: false,
            },
          ],
          total: 3,
          limit: 2,
          offset: 1,
        },
      });
      expect(JSON.stringify(result)).not.toContain('rootPath');
    });
  });

  describe('sendToProject', () => {
    const send = (recipientProjectId = TARGET_ID, message = 'hello') =>
      service.sendToProject({ callerAgentId: caller.id, recipientProjectId, message });

    it.each([
      ['SAME_PROJECT', [source]],
      ['PROJECT_NOT_FOUND', []],
      [
        'AMBIGUOUS_PROJECT',
        [target, createMockProject({ id: OTHER_ID, name: 'Other', rootPath: '/private/other' })],
      ],
    ] as const)('rejects %s resolution without a delivery side effect', async (code, matches) => {
      storage.getProjectsByIdPrefix.mockResolvedValue([...matches]);

      const result = await send(code === 'SAME_PROJECT' ? SOURCE_ID.toUpperCase() : 'aaaaaaaa');

      expect(result).toMatchObject({ error: { code } });
      expect(delivery.deliverAgentMessage).not.toHaveBeenCalled();
    });

    it('rejects a template source before resolving the target', async () => {
      storage.getProject.mockResolvedValue({ ...source, isTemplate: true });

      await expect(send()).resolves.toMatchObject({
        error: { code: 'SOURCE_TEMPLATE_NOT_ALLOWED' },
      });
      expect(storage.getProjectsByIdPrefix).not.toHaveBeenCalled();
      expect(delivery.deliverAgentMessage).not.toHaveBeenCalled();
    });

    it('rejects a template target without selecting an owner', async () => {
      storage.getProjectsByIdPrefix.mockResolvedValue([{ ...target, isTemplate: true }]);

      await expect(send()).resolves.toMatchObject({
        error: { code: 'TARGET_TEMPLATE_NOT_ALLOWED' },
      });
      expect(storage.listProjectOwners).not.toHaveBeenCalled();
      expect(delivery.deliverAgentMessage).not.toHaveBeenCalled();
    });

    it('rejects an ownerless target without delivery', async () => {
      storage.listProjectOwners.mockResolvedValue([]);

      await expect(send()).resolves.toMatchObject({
        error: { code: 'TARGET_PROJECT_OWNER_NOT_FOUND' },
      });
      expect(delivery.deliverAgentMessage).not.toHaveBeenCalled();
    });

    it('resolves the current target owner immediately before one source-aware delivery', async () => {
      const newlyAssignedOwner = { ...targetOwner, id: 'new-owner', name: 'New Owner' };
      storage.listProjectOwners.mockResolvedValue([newlyAssignedOwner]);

      const result = await send(TARGET_ID.slice(0, 8), 'project hello');

      expect(storage.listProjectOwners).toHaveBeenCalledWith([TARGET_ID]);
      expect(storage.listProjectOwners.mock.invocationCallOrder[0]).toBeLessThan(
        delivery.deliverAgentMessage.mock.invocationCallOrder[0],
      );
      expect(delivery.deliverAgentMessage).toHaveBeenCalledTimes(1);
      expect(delivery.deliverAgentMessage).toHaveBeenCalledWith(
        [{ agentId: newlyAssignedOwner.id, agentName: newlyAssignedOwner.name }],
        {
          routingKind: 'project',
          sourceProjectId: SOURCE_ID,
          sourceProjectName: source.name,
          targetProjectId: TARGET_ID,
          targetProjectName: target.name,
        },
        {
          kind: 'mcp.project',
          body: 'project hello',
          source: 'mcp.send_message',
          projectId: TARGET_ID,
          senderName: caller.name,
          senderType: 'agent',
          senderAgentId: caller.id,
          sourceProjectId: SOURCE_ID,
          sourceProjectName: source.name,
        },
      );
      expect(result).toEqual({
        result: {
          mode: 'project',
          targetProject: {
            id: TARGET_ID,
            shortId: TARGET_ID.slice(0, 8),
            name: target.name,
          },
          deliveryStatus: 'queued',
        },
      });
    });

    it('sanitizes a failed delivery and never tries an alternate recipient', async () => {
      const failed: DeliveryOutcome = {
        status: 'failed',
        results: [
          {
            agentId: targetOwner.id,
            status: 'failed',
            error: 'launch failed at /private/target/.devchain',
          },
        ],
      };
      delivery.deliverAgentMessage.mockResolvedValue(failed);

      const result = await send();

      expect(delivery.deliverAgentMessage).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        result: {
          mode: 'project',
          targetProject: {
            id: TARGET_ID,
            shortId: TARGET_ID.slice(0, 8),
            name: target.name,
          },
          deliveryStatus: 'failed',
          error: {
            code: 'DELIVERY_FAILED',
            message: 'Message delivery to the target Project Owner failed',
          },
        },
      });
      expect(JSON.stringify(result)).not.toContain('/private');
    });

    it('sanitizes thrown delivery failures in both the result and logs', async () => {
      const loggerSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      delivery.deliverAgentMessage.mockRejectedValue(
        new Error('launch failed at /private/target/.devchain'),
      );

      const result = await send();

      expect(result).toEqual({
        error: {
          code: 'PROJECT_COMMUNICATION_FAILED',
          message: 'Unable to deliver the cross-project message',
        },
      });
      expect(JSON.stringify(loggerSpy.mock.calls)).not.toContain('/private');
      expect(loggerSpy).toHaveBeenCalledWith({
        code: 'PROJECT_COMMUNICATION_FAILED',
        callerAgentId: caller.id,
        targetProjectId: target.id,
      });
    });
  });
});
