import type { ArgumentsHost } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { SkillsController } from './skills.controller';
import { SkillSourceLifecycleService } from '../services/skill-source-lifecycle.service';
import { SkillsService } from '../services/skills.service';
import { AllExceptionsFilter } from '../../../common/filters/http-exception.filter';
import { SkillSourceAlwaysEnabledError } from '../../../common/errors/error-types';

describe('SkillsController', () => {
  let controller: SkillsController;
  let skillSourceLifecycle: {
    syncAll: jest.Mock;
    syncSource: jest.Mock;
  };
  let skillsService: {
    listSources: jest.Mock;
    setSourceEnabled: jest.Mock;
    setSourceProjectEnabled: jest.Mock;
    listDisabled: jest.Mock;
    disableAll: jest.Mock;
    enableAll: jest.Mock;
    disableSkill: jest.Mock;
    enableSkill: jest.Mock;
    listAllForProject: jest.Mock;
    listSkills: jest.Mock;
    resolveSkillSummariesBySlugs: jest.Mock;
    getSkillBySlug: jest.Mock;
    getSkill: jest.Mock;
  };

  const projectId = '00000000-0000-0000-0000-000000000001';
  const skillId = '00000000-0000-0000-0000-000000000002';

  beforeEach(async () => {
    skillSourceLifecycle = {
      syncAll: jest.fn(),
      syncSource: jest.fn(),
    };
    skillsService = {
      listSources: jest.fn().mockResolvedValue([]),
      setSourceEnabled: jest.fn().mockImplementation(async (name: string, enabled: boolean) => ({
        name,
        enabled,
      })),
      setSourceProjectEnabled: jest
        .fn()
        .mockImplementation(
          async (name: string, projectIdArg: string, projectEnabled: boolean) => ({
            name,
            projectId: projectIdArg,
            projectEnabled,
          }),
        ),
      listDisabled: jest.fn().mockResolvedValue([]),
      disableAll: jest.fn().mockResolvedValue(0),
      enableAll: jest.fn().mockResolvedValue(0),
      disableSkill: jest.fn().mockResolvedValue(undefined),
      enableSkill: jest.fn().mockResolvedValue(undefined),
      listAllForProject: jest.fn().mockResolvedValue([]),
      listSkills: jest.fn().mockResolvedValue([]),
      resolveSkillSummariesBySlugs: jest.fn().mockResolvedValue({}),
      getSkillBySlug: jest.fn(),
      getSkill: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [SkillsController],
      providers: [
        {
          provide: SkillsService,
          useValue: skillsService,
        },
        {
          provide: SkillSourceLifecycleService,
          useValue: skillSourceLifecycle,
        },
      ],
    }).compile();

    controller = module.get(SkillsController);
  });

  it.each([
    { name: 'all sources', sourceName: undefined, status: 'already_running', added: 0 },
    { name: 'one source', sourceName: 'openai', status: 'completed', added: 1 },
  ])('dispatches sync for $name', async ({ sourceName, status, added }) => {
    const sync = sourceName ? skillSourceLifecycle.syncSource : skillSourceLifecycle.syncAll;
    sync.mockResolvedValue({
      status,
      added,
      updated: 0,
      removed: 0,
      failed: 0,
      unchanged: 0,
      errors: [],
    });
    const result = await controller.syncSkills(sourceName ? { sourceName } : {});
    if (sourceName) expect(sync).toHaveBeenCalledWith(sourceName, { force: true });
    else expect(sync).toHaveBeenCalledWith({ force: true });
    expect(result.status).toBe(status);
    expect(result.added).toBe(added);
  });

  it('answers DevChain disables with HTTP 409 SKILL_SOURCE_ALWAYS_ENABLED', async () => {
    const respond = async (call: Promise<unknown>) => {
      const error = await call.then(
        () => undefined,
        (rejection: unknown) => rejection,
      );
      const send = jest.fn();
      const code = jest.fn(() => ({ send }));
      const host = {
        switchToHttp: () => ({
          getResponse: () => ({ sent: false, code }),
          getRequest: () => ({ id: 'request-1', method: 'POST', url: '/api/skills' }),
        }),
      } as unknown as ArgumentsHost;
      new AllExceptionsFilter().catch(error, host);
      return { status: (code.mock.calls[0] as unknown[])[0], body: send.mock.calls[0][0] };
    };
    const refusal = new SkillSourceAlwaysEnabledError('devchain');
    skillsService.setSourceEnabled.mockRejectedValue(refusal);
    skillsService.setSourceProjectEnabled.mockRejectedValue(refusal);
    skillsService.disableSkill.mockRejectedValue(refusal);

    for (const call of [
      controller.disableSource({ name: 'devchain' }),
      controller.disableSourceForProject({ name: 'devchain' }, { projectId }),
      controller.disableSkill({ id: skillId }, { projectId }),
    ]) {
      const { status, body } = await respond(call);
      expect(status).toBe(409);
      expect(body).toMatchObject({ statusCode: 409, code: 'SKILL_SOURCE_ALWAYS_ENABLED' });
    }
  });

  it('uses listAllForProject when projectId is provided', async () => {
    const expected = [{ id: skillId, disabled: true }];
    skillsService.listAllForProject.mockResolvedValue(expected);

    const result = await controller.listSkills({ projectId, q: 'review' });

    expect(skillsService.listAllForProject).toHaveBeenCalledWith(projectId, {
      q: 'review',
      source: undefined,
      category: undefined,
    });
    expect(result).toEqual(expected);
  });
});
