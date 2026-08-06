/**
 * Layer: module-unit
 * Justification: exercises project tool registration, validation, context construction, and dispatch.
 */

import type { ProjectCommunicationService } from '../../project-communication/project-communication.service';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import { createMockAgent } from '../../../../test/factories/agent';
import { createMockProject } from '../../../../test/factories/project';
import { McpService } from './mcp.service';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const SOURCE_ID = '22222222-2222-4222-8222-222222222222';
const TARGET_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

describe('McpService project tool dispatch', () => {
  let storage: jest.Mocked<Pick<StorageService, 'getFeatureFlags' | 'getAgent' | 'getProject'>>;
  let sessionsService: { listActiveSessions: jest.Mock };
  let projectCommunicationService: jest.Mocked<
    Pick<ProjectCommunicationService, 'listTargets' | 'sendToProject'>
  >;
  let service: McpService;

  beforeEach(() => {
    storage = {
      getFeatureFlags: jest.fn().mockReturnValue({}),
      getAgent: jest.fn().mockResolvedValue(
        createMockAgent({
          id: 'source-owner',
          projectId: SOURCE_ID,
          isProjectOwner: true,
          name: 'Source Owner',
        }),
      ),
      getProject: jest.fn().mockResolvedValue(
        createMockProject({
          id: SOURCE_ID,
          name: 'Source',
          rootPath: '/private/source',
        }),
      ),
    };
    sessionsService = {
      listActiveSessions: jest.fn().mockResolvedValue([
        {
          id: SESSION_ID,
          agentId: 'source-owner',
          status: 'running',
          startedAt: '2026-01-01T00:00:00.000Z',
        },
      ]),
    };
    projectCommunicationService = {
      listTargets: jest.fn().mockResolvedValue({
        result: {
          projects: [
            {
              id: TARGET_ID,
              shortId: 'aaaaaaaa',
              name: 'Target',
              description: null,
              hasProjectOwner: true,
            },
          ],
          total: 1,
          limit: 100,
          offset: 0,
        },
      }),
      sendToProject: jest.fn().mockResolvedValue({
        result: {
          mode: 'project',
          targetProject: { id: TARGET_ID, shortId: 'aaaaaaaa', name: 'Target' },
          deliveryStatus: 'queued',
        },
      }),
    };

    service = createService(projectCommunicationService as ProjectCommunicationService);
  });

  function createService(projectCommunication?: ProjectCommunicationService): McpService {
    return new McpService(
      storage as unknown as StorageService,
      undefined,
      sessionsService as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      projectCommunication,
    );
  }

  it('dispatches devchain_projects_list with schema defaults and safe output', async () => {
    const result = await service.handleToolCall('devchain_projects_list', {
      sessionId: SESSION_ID,
    });

    expect(projectCommunicationService.listTargets).toHaveBeenCalledWith('source-owner', {
      limit: 100,
      offset: 0,
    });
    expect(result).toEqual({
      success: true,
      data: {
        projects: [
          {
            id: TARGET_ID,
            shortId: 'aaaaaaaa',
            name: 'Target',
            description: null,
            hasProjectOwner: true,
          },
        ],
        total: 1,
        limit: 100,
        offset: 0,
      },
    });
    expect(JSON.stringify(result)).not.toContain('rootPath');
  });

  it('dispatches recipientProjectId through the existing send tool', async () => {
    const result = await service.handleToolCall('devchain_send_message', {
      sessionId: SESSION_ID,
      recipientProjectId: 'aaaaaaaa',
      message: 'hello target',
    });

    expect(projectCommunicationService.sendToProject).toHaveBeenCalledWith({
      callerAgentId: 'source-owner',
      recipientProjectId: 'aaaaaaaa',
      message: 'hello target',
    });
    expect(result).toEqual({
      success: true,
      data: {
        mode: 'project',
        targetProject: { id: TARGET_ID, shortId: 'aaaaaaaa', name: 'Target' },
        deliveryStatus: 'queued',
      },
    });
  });

  it('rejects malformed and conflicting project routes before delegation', async () => {
    const malformed = await service.handleToolCall('devchain_send_message', {
      sessionId: SESSION_ID,
      recipientProjectId: 'aaaaaaaa-b-bbbb',
      message: 'hello',
    });
    const conflicting = await service.handleToolCall('devchain_send_message', {
      sessionId: SESSION_ID,
      recipientProjectId: 'aaaaaaaa',
      teamName: 'Platform',
      message: 'hello',
    });

    expect(malformed.error?.code).toBe('VALIDATION_ERROR');
    expect(conflicting.error?.code).toBe('VALIDATION_ERROR');
    expect(projectCommunicationService.sendToProject).not.toHaveBeenCalled();
  });

  it.each(['devchain_projects_list', 'devchain_send_message'])(
    'returns SERVICE_UNAVAILABLE for %s when the optional service is absent',
    async (tool) => {
      const standalone = createService();
      const result = await standalone.handleToolCall(
        tool,
        tool === 'devchain_projects_list'
          ? { sessionId: SESSION_ID }
          : { sessionId: SESSION_ID, recipientProjectId: 'aaaaaaaa', message: 'hello' },
      );

      expect(result).toEqual({
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: expect.any(String),
        },
      });
    },
  );
});
