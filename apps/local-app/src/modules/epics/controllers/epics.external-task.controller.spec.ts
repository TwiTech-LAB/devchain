import { EpicsController } from './epics.controller';
import type { EpicsService } from '../services/epics.service';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { IntegrationAdmissionGuard } from '../../../common/guards/integration-admission.guard';

// Layer: controller unit. This is the cheapest boundary that can prove the HTTP
// projection omits internal aggregate/link fields while service semantics stay mocked.
describe('EpicsController external task routes', () => {
  const service = {
    importExternalTask: jest.fn(),
    getEpicById: jest.fn(),
    listExternalTaskSources: jest.fn(),
    listExternalTaskSourcesBatch: jest.fn(),
  };
  const controller = new EpicsController(service as unknown as EpicsService);
  const body = {
    projectId: '11111111-1111-4111-8111-111111111111',
    statusId: '22222222-2222-4222-8222-222222222222',
    agentId: null,
    title: 'Imported title',
    description: null,
    remote: {
      provider: 'jira',
      scopeKey: 'acme.atlassian.net',
      taskId: 'ENG-1',
      remoteKey: 'ENG-1',
      title: 'Remote title',
      description: null,
      webUrl: 'https://acme.atlassian.net/browse/ENG-1',
      workAreaId: '42',
      workAreaName: 'Delivery',
      statusName: 'In Progress',
    },
  };

  beforeEach(() => jest.clearAllMocks());

  it('applies integration admission to import and source reads', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, controller.importExternalTask)).toContain(
      IntegrationAdmissionGuard,
    );
    expect(Reflect.getMetadata(GUARDS_METADATA, controller.getExternalSources)).toContain(
      IntegrationAdmissionGuard,
    );
    expect(Reflect.getMetadata(GUARDS_METADATA, controller.getExternalSourcesBatch)).toContain(
      IntegrationAdmissionGuard,
    );
  });

  it.each([true, false])(
    'projects the %s import result to the exact public response',
    async (created) => {
      service.importExternalTask.mockResolvedValue({
        epic: {
          id: 'epic-1',
          projectId: body.projectId,
          statusId: body.statusId,
          title: 'Internal aggregate field',
        },
        externalTaskLink: { id: 'internal-link-1', sourceSnapshot: { secret: 'internal' } },
        created,
      });

      await expect(controller.importExternalTask(body)).resolves.toEqual({
        epic: { id: 'epic-1', projectId: body.projectId },
        created,
      });

      expect(service.importExternalTask).toHaveBeenCalledWith({
        projectId: body.projectId,
        statusId: body.statusId,
        title: body.title,
        description: null,
        remote: body.remote,
      });
    },
  );

  it('rejects agent assignment and non-provider source URLs', async () => {
    await expect(controller.importExternalTask({ ...body, agentId: 'agent-1' })).rejects.toThrow();
    await expect(
      controller.importExternalTask({
        ...body,
        remote: { ...body.remote, webUrl: 'javascript:alert(1)' },
      }),
    ).rejects.toThrow();
    expect(service.importExternalTask).not.toHaveBeenCalled();
  });

  it('returns safe stored source projections for an existing Epic', async () => {
    service.getEpicById.mockResolvedValue({ id: 'epic-1' });
    service.listExternalTaskSources.mockResolvedValue([
      { provider: 'jira', remoteTaskId: 'ENG-1' },
    ]);

    await expect(controller.getExternalSources('epic-1')).resolves.toEqual({
      items: [{ provider: 'jira', remoteTaskId: 'ENG-1' }],
    });
  });

  it('dispatches the bounded batch source read with the requested Epic IDs', async () => {
    service.listExternalTaskSourcesBatch.mockResolvedValue([
      { epicId: 'epic-1', provider: 'jira', remoteTaskId: 'ENG-1' },
    ]);
    const epicIds = ['11111111-1111-4111-8111-111111111111'];

    await expect(controller.getExternalSourcesBatch({ epicIds })).resolves.toEqual({
      items: [{ epicId: 'epic-1', provider: 'jira', remoteTaskId: 'ENG-1' }],
    });
    expect(service.listExternalTaskSourcesBatch).toHaveBeenCalledWith(epicIds);
  });

  it.each([
    ['empty batch', { epicIds: [] }],
    ['missing epicIds', {}],
    ['non-UUID id', { epicIds: ['11111111-1111-4111-8111-111111111111', 'not-a-uuid'] }],
    [
      'over-limit batch',
      { epicIds: Array.from({ length: 1_001 }, () => '11111111-1111-4111-8111-111111111111') },
    ],
    ['extra body field', { epicIds: ['11111111-1111-4111-8111-111111111111'], limit: '10' }],
  ])('rejects a %s before dispatch', async (_case, body) => {
    await expect(controller.getExternalSourcesBatch(body)).rejects.toThrow();
    expect(service.listExternalTaskSourcesBatch).not.toHaveBeenCalled();
  });

  it('projects only the public batch shape even if the service returns storage fields', async () => {
    service.listExternalTaskSourcesBatch.mockResolvedValue([
      {
        epicId: 'epic-1',
        provider: 'jira',
        remoteTaskId: 'ENG-1',
        remoteKey: 'ENG-1',
        title: 'Remote title',
        workAreaName: 'Delivery',
        statusName: 'In Progress',
        webUrl: 'https://acme.atlassian.net/browse/ENG-1',
        linkedAt: '2026-08-19T10:00:00.000Z',
      },
    ]);

    const response = await controller.getExternalSourcesBatch({
      epicIds: ['11111111-1111-4111-8111-111111111111'],
    });

    expect(JSON.stringify(response)).not.toMatch(
      /connectionId|remoteScopeKey|sourceSnapshot|credential/,
    );
  });
});
