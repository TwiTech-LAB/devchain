import { ValidationError } from '../../../../common/errors/error-types';
import { ServiceUnavailableError } from '../../../../common/errors/service-unavailable.error';
import type { Skill } from '../../../storage/models/domain.models';
import type { SkillToolContext } from './skill-context';
import {
  handleGetSkill,
  handleListSkills,
  handleSkillsUsageStats,
  handleSkillsSetEnabled,
  handleSkillsSetSourceEnabled,
  handleSkillsSync,
} from './skill-tools';

const SESSION_ID = '00000000-0000-0000-0000-000000000001';
const SKILL: Skill = {
  id: 'skill-1',
  slug: 'source/testing',
  name: 'testing',
  displayName: 'Testing',
  description: 'Test skill',
  shortDescription: 'Tests',
  source: 'source',
  sourceUrl: null,
  sourceCommit: null,
  category: null,
  license: null,
  compatibility: null,
  frontmatter: null,
  instructionContent: 'Instructions',
  contentPath: null,
  resources: [],
  status: 'available',
  lastSyncedAt: null,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
};

function createContext(): SkillToolContext {
  return {
    skillsService: {
      listDiscoverable: jest.fn().mockResolvedValue([SKILL]),
      listAllStoredForProject: jest.fn().mockResolvedValue([
        {
          ...SKILL,
          disabled: true,
          skillDisabled: true,
          sourceProjectEnabled: false,
          sourceGloballyEnabled: true,
        },
      ]),
      resolveDiscoverableSkill: jest.fn().mockResolvedValue({ status: 'resolved', skill: SKILL }),
      logUsage: jest.fn().mockResolvedValue(undefined),
      setSkillsEnabled: jest
        .fn()
        .mockResolvedValue({ updated: ['source/testing'], unchanged: [], notFound: [] }),
      setSourceProjectEnabledForMcp: jest.fn().mockResolvedValue({
        status: 'ok',
        name: 'source',
        projectId: 'project-1',
        projectEnabled: true,
      }),
      getCompleteUsageStats: jest.fn().mockResolvedValue({
        summary: {
          totalEvents: 2,
          distinctSkills: 1,
          firstEventAt: '2026-01-01T00:00:00.000Z',
          lastEventAt: '2026-02-01T00:00:00.000Z',
        },
        skills: [
          {
            skillId: 'skill-1',
            skillSlug: 'source/testing',
            usageCount: 2,
            firstAccessedAt: '2026-01-01T00:00:00.000Z',
            lastAccessedAt: '2026-02-01T00:00:00.000Z',
            skillName: 'testing',
            skillDisplayName: 'Testing',
          },
        ],
      }),
      getSkillsEpicReferences: jest
        .fn()
        .mockResolvedValue([{ slug: 'source/testing', total: 1, byStatus: { 'In Progress': 1 } }]),
    } as SkillToolContext['skillsService'],
    skillSourceLifecycleService: {
      syncSource: jest.fn(),
      syncAll: jest.fn(),
    } as SkillToolContext['skillSourceLifecycleService'],
    resolveSessionContext: jest.fn().mockResolvedValue({
      success: true,
      data: {
        type: 'agent',
        session: { id: SESSION_ID, agentId: 'agent-1', status: 'running', startedAt: '' },
        agent: { id: 'agent-1', name: 'Coder', projectId: 'project-1' },
        project: { id: 'project-1', name: 'Project', rootPath: '/project' },
      },
    }),
  };
}

describe('skill-tools handlers', () => {
  it('lists discoverable project skills with the query', async () => {
    const ctx = createContext();

    await expect(
      handleListSkills(ctx, { sessionId: SESSION_ID, q: 'test' }),
    ).resolves.toMatchObject({
      success: true,
      data: { total: 1, skills: [{ slug: 'source/testing' }] },
    });
    expect(ctx.skillsService.listDiscoverable).toHaveBeenCalledWith('project-1', { q: 'test' });
  });

  it('returns PROJECT_NOT_FOUND when the session has no project', async () => {
    const ctx = createContext();
    (ctx.resolveSessionContext as jest.Mock).mockResolvedValue({
      success: true,
      data: { type: 'agent', agent: null, project: null },
    });

    await expect(handleListSkills(ctx, { sessionId: SESSION_ID })).resolves.toMatchObject({
      success: false,
      error: { code: 'PROJECT_NOT_FOUND' },
    });
  });

  it('normalizes a slug and records usage with agent actor context', async () => {
    const ctx = createContext();

    await expect(
      handleGetSkill(ctx, { sessionId: SESSION_ID, slug: ' SOURCE/TESTING ' }),
    ).resolves.toMatchObject({ success: true, data: { slug: 'source/testing' } });
    expect(ctx.skillsService.resolveDiscoverableSkill).toHaveBeenCalledWith(
      'project-1',
      ' SOURCE/TESTING ',
    );
    expect(ctx.skillsService.logUsage).toHaveBeenCalledWith(
      'skill-1',
      'source/testing',
      'project-1',
      'agent-1',
      'Coder',
    );
  });

  it('returns frontmatter without the duplicated top-level keys and keeps the stored value', async () => {
    const frontmatter = {
      name: 'testing',
      description: 'Test skill',
      license: 'MIT',
      compatibility: null,
      resources: ['guides/one.md'],
      version: '1.2.0',
    };
    const ctx = createContext();
    (ctx.skillsService.resolveDiscoverableSkill as jest.Mock).mockResolvedValue({
      status: 'resolved',
      skill: { ...SKILL, license: 'MIT', resources: ['guides/one.md'], frontmatter },
    });

    const result = await handleGetSkill(ctx, { sessionId: SESSION_ID, slug: 'source/testing' });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      name: 'testing',
      license: 'MIT',
      resources: ['guides/one.md'],
      frontmatter: { version: '1.2.0' },
    });
    expect(frontmatter).toEqual({
      name: 'testing',
      description: 'Test skill',
      license: 'MIT',
      compatibility: null,
      resources: ['guides/one.md'],
      version: '1.2.0',
    });
  });

  it('maps a missing skill to SKILL_NOT_FOUND without logging usage', async () => {
    const ctx = createContext();
    (ctx.skillsService.resolveDiscoverableSkill as jest.Mock).mockResolvedValue({
      status: 'not_found',
    });

    await expect(
      handleGetSkill(ctx, { sessionId: SESSION_ID, slug: 'missing' }),
    ).resolves.toMatchObject({ success: false, error: { code: 'SKILL_NOT_FOUND' } });
    expect(ctx.skillsService.logUsage).not.toHaveBeenCalled();
  });

  it('maps a disabled skill to SKILL_DISABLED with enabled alternatives', async () => {
    const ctx = createContext();
    (ctx.skillsService.resolveDiscoverableSkill as jest.Mock).mockResolvedValue({
      status: 'disabled',
      enabledAlternatives: ['source-alt/testing'],
    });

    await expect(
      handleGetSkill(ctx, { sessionId: SESSION_ID, slug: 'source/testing' }),
    ).resolves.toEqual({
      success: false,
      error: {
        code: 'SKILL_DISABLED',
        message: 'Skill source/testing is disabled for this project.',
        data: { enabledAlternatives: ['source-alt/testing'] },
      },
    });
    expect(ctx.skillsService.logUsage).not.toHaveBeenCalled();
  });

  it('maps an ambiguous bare name to AMBIGUOUS_SKILL with candidates', async () => {
    const ctx = createContext();
    (ctx.skillsService.resolveDiscoverableSkill as jest.Mock).mockResolvedValue({
      status: 'ambiguous',
      candidates: ['source/testing', 'source-alt/testing'],
    });

    await expect(handleGetSkill(ctx, { sessionId: SESSION_ID, slug: 'TESTING' })).resolves.toEqual({
      success: false,
      error: {
        code: 'AMBIGUOUS_SKILL',
        message: 'Skill testing matched multiple enabled skills.',
        data: { candidates: ['source/testing', 'source-alt/testing'] },
      },
    });
    expect(ctx.skillsService.logUsage).not.toHaveBeenCalled();
  });

  it('preserves skill validation details', async () => {
    const ctx = createContext();
    (ctx.skillsService.resolveDiscoverableSkill as jest.Mock).mockRejectedValue(
      new ValidationError('bad slug', { slug: 'bad' }),
    );

    await expect(handleGetSkill(ctx, { sessionId: SESSION_ID, slug: 'bad' })).resolves.toEqual({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'bad slug', data: { slug: 'bad' } },
    });
  });

  it('maps unavailable skill operations from the get path', async () => {
    const ctx = createContext();
    (ctx.skillsService.resolveDiscoverableSkill as jest.Mock).mockRejectedValue(
      new ServiceUnavailableError('SkillsService'),
    );

    await expect(
      handleGetSkill(ctx, { sessionId: SESSION_ID, slug: 'source/testing' }),
    ).resolves.toMatchObject({
      success: false,
      error: { code: 'SERVICE_UNAVAILABLE' },
    });
  });

  it('maps unavailable skill operations', async () => {
    const ctx = createContext();
    (ctx.skillsService.listDiscoverable as jest.Mock).mockRejectedValue(
      new ServiceUnavailableError('SkillsService'),
    );

    await expect(handleListSkills(ctx, { sessionId: SESSION_ID })).resolves.toMatchObject({
      success: false,
      error: { code: 'SERVICE_UNAVAILABLE' },
    });
  });

  describe('handleSkillsUsageStats', () => {
    it('returns the complete unpaged usage stats with epic references for the session project', async () => {
      const ctx = createContext();

      await expect(handleSkillsUsageStats(ctx, { sessionId: SESSION_ID })).resolves.toEqual({
        success: true,
        data: {
          summary: {
            totalEvents: 2,
            distinctSkills: 1,
            firstEventAt: '2026-01-01T00:00:00.000Z',
            lastEventAt: '2026-02-01T00:00:00.000Z',
          },
          skills: [
            {
              slug: 'source/testing',
              name: 'testing',
              displayName: 'Testing',
              usageCount: 2,
              firstAccessedAt: '2026-01-01T00:00:00.000Z',
              lastAccessedAt: '2026-02-01T00:00:00.000Z',
            },
          ],
          complete: true,
          epicReferences: [{ slug: 'source/testing', total: 1, byStatus: { 'In Progress': 1 } }],
        },
      });
      expect(ctx.skillsService.getCompleteUsageStats).toHaveBeenCalledWith({
        projectId: 'project-1',
        from: undefined,
        to: undefined,
      });
      expect(ctx.skillsService.getSkillsEpicReferences).toHaveBeenCalledWith('project-1');
    });

    it('passes from/to to the usage query but computes epic references without a window', async () => {
      const ctx = createContext();
      const from = '2026-03-01T00:00:00.000Z';
      const to = '2026-04-01T00:00:00.000Z';

      await handleSkillsUsageStats(ctx, { sessionId: SESSION_ID, from, to });

      expect(ctx.skillsService.getCompleteUsageStats).toHaveBeenCalledWith({
        projectId: 'project-1',
        from,
        to,
      });
      expect(ctx.skillsService.getSkillsEpicReferences).toHaveBeenCalledWith('project-1');
    });

    it('returns PROJECT_NOT_FOUND when the session has no project', async () => {
      const ctx = createContext();
      (ctx.resolveSessionContext as jest.Mock).mockResolvedValue({
        success: true,
        data: { type: 'agent', agent: null, project: null },
      });

      await expect(handleSkillsUsageStats(ctx, { sessionId: SESSION_ID })).resolves.toMatchObject({
        success: false,
        error: { code: 'PROJECT_NOT_FOUND' },
      });
    });

    it('maps unavailable skill operations', async () => {
      const ctx = createContext();
      (ctx.skillsService.getCompleteUsageStats as jest.Mock).mockRejectedValue(
        new ServiceUnavailableError('SkillsService'),
      );

      await expect(handleSkillsUsageStats(ctx, { sessionId: SESSION_ID })).resolves.toMatchObject({
        success: false,
        error: { code: 'SERVICE_UNAVAILABLE' },
      });
    });
  });

  describe('handleListSkills includeDisabled', () => {
    it('lists all stored skills with the four state flags when includeDisabled is true', async () => {
      const ctx = createContext();

      await expect(
        handleListSkills(ctx, { sessionId: SESSION_ID, includeDisabled: true }),
      ).resolves.toMatchObject({
        success: true,
        data: {
          total: 1,
          skills: [
            {
              slug: 'source/testing',
              disabled: true,
              skillDisabled: true,
              sourceProjectEnabled: false,
              sourceGloballyEnabled: true,
            },
          ],
        },
      });
      expect(ctx.skillsService.listAllStoredForProject).toHaveBeenCalledWith('project-1', {
        q: undefined,
      });
      expect(ctx.skillsService.listDiscoverable).not.toHaveBeenCalled();
    });

    it('passes q to the stored-catalog listing', async () => {
      const ctx = createContext();

      await handleListSkills(ctx, { sessionId: SESSION_ID, includeDisabled: true, q: 'test' });

      expect(ctx.skillsService.listAllStoredForProject).toHaveBeenCalledWith('project-1', {
        q: 'test',
      });
    });

    it('omits the state flags in the default mode', async () => {
      const ctx = createContext();

      const result = await handleListSkills(ctx, { sessionId: SESSION_ID });

      expect(result.success).toBe(true);
      expect((result.data as { skills: unknown[] }).skills[0]).not.toHaveProperty('disabled');
      expect((result.data as { skills: unknown[] }).skills[0]).not.toHaveProperty('skillDisabled');
      expect((result.data as { skills: unknown[] }).skills[0]).not.toHaveProperty(
        'sourceProjectEnabled',
      );
      expect((result.data as { skills: unknown[] }).skills[0]).not.toHaveProperty(
        'sourceGloballyEnabled',
      );
      expect(ctx.skillsService.listAllStoredForProject).not.toHaveBeenCalled();
    });
  });

  describe('handleSkillsSetEnabled', () => {
    it('delegates the batch toggle and returns only the count of changed slugs', async () => {
      const ctx = createContext();
      (ctx.skillsService.setSkillsEnabled as jest.Mock).mockResolvedValue({
        updated: ['source/testing'],
        unchanged: ['source/other'],
        notFound: ['source/missing'],
      });

      await expect(
        handleSkillsSetEnabled(ctx, {
          sessionId: SESSION_ID,
          slugs: ['source/testing', 'source/other', 'source/missing'],
          enabled: false,
        }),
      ).resolves.toEqual({
        success: true,
        data: {
          updatedCount: 1,
          unchanged: ['source/other'],
          notFound: ['source/missing'],
        },
      });
      expect(ctx.skillsService.setSkillsEnabled).toHaveBeenCalledWith(
        'project-1',
        ['source/testing', 'source/other', 'source/missing'],
        false,
      );
    });

    it('rejects guest sessions with AGENT_CONTEXT_REQUIRED before any write', async () => {
      const ctx = createContext();
      (ctx.resolveSessionContext as jest.Mock).mockResolvedValue({
        success: true,
        data: {
          type: 'guest',
          guest: { id: 'guest-1', name: 'Guest', projectId: 'project-1', tmuxSessionId: 's-1' },
          project: { id: 'project-1', name: 'Project', rootPath: '/project' },
        },
      });

      await expect(
        handleSkillsSetEnabled(ctx, {
          sessionId: SESSION_ID,
          slugs: ['source/testing'],
          enabled: false,
        }),
      ).resolves.toMatchObject({
        success: false,
        error: { code: 'AGENT_CONTEXT_REQUIRED' },
      });
      expect(ctx.skillsService.setSkillsEnabled).not.toHaveBeenCalled();
    });

    it('rejects agent sessions without agent context', async () => {
      const ctx = createContext();
      (ctx.resolveSessionContext as jest.Mock).mockResolvedValue({
        success: true,
        data: {
          type: 'agent',
          agent: null,
          project: { id: 'project-1', name: 'P', rootPath: '/p' },
        },
      });

      await expect(
        handleSkillsSetEnabled(ctx, {
          sessionId: SESSION_ID,
          slugs: ['source/testing'],
          enabled: true,
        }),
      ).resolves.toMatchObject({
        success: false,
        error: { code: 'AGENT_CONTEXT_REQUIRED' },
      });
      expect(ctx.skillsService.setSkillsEnabled).not.toHaveBeenCalled();
    });

    it('returns PROJECT_NOT_FOUND when the session has no project', async () => {
      const ctx = createContext();
      (ctx.resolveSessionContext as jest.Mock).mockResolvedValue({
        success: true,
        data: { type: 'agent', agent: null, project: null },
      });

      await expect(
        handleSkillsSetEnabled(ctx, {
          sessionId: SESSION_ID,
          slugs: ['source/testing'],
          enabled: false,
        }),
      ).resolves.toMatchObject({
        success: false,
        error: { code: 'PROJECT_NOT_FOUND' },
      });
    });

    it('maps unavailable skill operations', async () => {
      const ctx = createContext();
      (ctx.skillsService.setSkillsEnabled as jest.Mock).mockRejectedValue(
        new ServiceUnavailableError('SkillsService'),
      );

      await expect(
        handleSkillsSetEnabled(ctx, {
          sessionId: SESSION_ID,
          slugs: ['source/testing'],
          enabled: false,
        }),
      ).resolves.toMatchObject({
        success: false,
        error: { code: 'SERVICE_UNAVAILABLE' },
      });
    });
  });

  describe('handleSkillsSetSourceEnabled', () => {
    it('delegates the project source toggle to the service', async () => {
      const ctx = createContext();

      await expect(
        handleSkillsSetSourceEnabled(ctx, {
          sessionId: SESSION_ID,
          sourceName: 'src',
          enabled: true,
        }),
      ).resolves.toEqual({
        success: true,
        data: { name: 'source', projectId: 'project-1', projectEnabled: true },
      });
      expect(ctx.skillsService.setSourceProjectEnabledForMcp).toHaveBeenCalledWith(
        'project-1',
        'src',
        true,
      );
    });

    it('maps an unknown source to SOURCE_NOT_FOUND without a write', async () => {
      const ctx = createContext();
      (ctx.skillsService.setSourceProjectEnabledForMcp as jest.Mock).mockResolvedValue({
        status: 'source_not_found',
        name: 'nope',
      });

      await expect(
        handleSkillsSetSourceEnabled(ctx, {
          sessionId: SESSION_ID,
          sourceName: 'nope',
          enabled: true,
        }),
      ).resolves.toEqual({
        success: false,
        error: {
          code: 'SOURCE_NOT_FOUND',
          message: 'Skill source "nope" was not found.',
        },
      });
    });

    it('maps a globally disabled source to SOURCE_DISABLED_GLOBALLY without a write', async () => {
      const ctx = createContext();
      (ctx.skillsService.setSourceProjectEnabledForMcp as jest.Mock).mockResolvedValue({
        status: 'source_disabled_globally',
        name: 'frozen-src',
      });

      await expect(
        handleSkillsSetSourceEnabled(ctx, {
          sessionId: SESSION_ID,
          sourceName: 'frozen-src',
          enabled: true,
        }),
      ).resolves.toEqual({
        success: false,
        error: {
          code: 'SOURCE_DISABLED_GLOBALLY',
          message: 'Skill source frozen-src is disabled globally; a project toggle has no effect.',
        },
      });
    });

    it('rejects guest sessions with AGENT_CONTEXT_REQUIRED before any write', async () => {
      const ctx = createContext();
      (ctx.resolveSessionContext as jest.Mock).mockResolvedValue({
        success: true,
        data: {
          type: 'guest',
          guest: { id: 'guest-1', name: 'Guest', projectId: 'project-1', tmuxSessionId: 's-1' },
          project: { id: 'project-1', name: 'Project', rootPath: '/project' },
        },
      });

      await expect(
        handleSkillsSetSourceEnabled(ctx, {
          sessionId: SESSION_ID,
          sourceName: 'src',
          enabled: true,
        }),
      ).resolves.toMatchObject({
        success: false,
        error: { code: 'AGENT_CONTEXT_REQUIRED' },
      });
      expect(ctx.skillsService.setSourceProjectEnabledForMcp).not.toHaveBeenCalled();
    });

    it('returns PROJECT_NOT_FOUND when the session has no project', async () => {
      const ctx = createContext();
      (ctx.resolveSessionContext as jest.Mock).mockResolvedValue({
        success: true,
        data: { type: 'agent', agent: null, project: null },
      });

      await expect(
        handleSkillsSetSourceEnabled(ctx, {
          sessionId: SESSION_ID,
          sourceName: 'src',
          enabled: true,
        }),
      ).resolves.toMatchObject({
        success: false,
        error: { code: 'PROJECT_NOT_FOUND' },
      });
    });

    it('maps unavailable skill operations', async () => {
      const ctx = createContext();
      (ctx.skillsService.setSourceProjectEnabledForMcp as jest.Mock).mockRejectedValue(
        new ServiceUnavailableError('SkillsService'),
      );

      await expect(
        handleSkillsSetSourceEnabled(ctx, {
          sessionId: SESSION_ID,
          sourceName: 'src',
          enabled: true,
        }),
      ).resolves.toMatchObject({
        success: false,
        error: { code: 'SERVICE_UNAVAILABLE' },
      });
    });
  });

  describe('handleSkillsSync', () => {
    const completedResult = {
      status: 'completed' as const,
      added: 2,
      updated: 1,
      removed: 0,
      failed: 0,
      unchanged: 3,
      errors: [],
    };

    it('syncs a named source and returns the SyncResult unchanged', async () => {
      const ctx = createContext();
      (ctx.skillSourceLifecycleService.syncSource as jest.Mock).mockResolvedValue(completedResult);

      await expect(
        handleSkillsSync(ctx, { sessionId: SESSION_ID, sourceName: 'devchain-local' }),
      ).resolves.toEqual({ success: true, data: completedResult });
      expect(ctx.skillSourceLifecycleService.syncSource).toHaveBeenCalledWith('devchain-local');
      expect(ctx.skillSourceLifecycleService.syncAll).not.toHaveBeenCalled();
    });

    it('syncs every source when sourceName is absent', async () => {
      const ctx = createContext();
      (ctx.skillSourceLifecycleService.syncAll as jest.Mock).mockResolvedValue(completedResult);

      await expect(handleSkillsSync(ctx, { sessionId: SESSION_ID })).resolves.toEqual({
        success: true,
        data: completedResult,
      });
      expect(ctx.skillSourceLifecycleService.syncAll).toHaveBeenCalled();
      expect(ctx.skillSourceLifecycleService.syncSource).not.toHaveBeenCalled();
    });

    it('returns the already_running result as a success envelope', async () => {
      const ctx = createContext();
      const alreadyRunning = {
        status: 'already_running' as const,
        added: 0,
        updated: 0,
        removed: 0,
        failed: 0,
        unchanged: 0,
        errors: [],
      };
      (ctx.skillSourceLifecycleService.syncAll as jest.Mock).mockResolvedValue(alreadyRunning);

      await expect(handleSkillsSync(ctx, { sessionId: SESSION_ID })).resolves.toEqual({
        success: true,
        data: alreadyRunning,
      });
    });

    it('maps an unknown source to SOURCE_NOT_FOUND', async () => {
      const ctx = createContext();
      (ctx.skillSourceLifecycleService.syncSource as jest.Mock).mockRejectedValue(
        new ValidationError('Unknown skill source: nope', { sourceName: 'nope' }),
      );

      await expect(
        handleSkillsSync(ctx, { sessionId: SESSION_ID, sourceName: 'nope' }),
      ).resolves.toEqual({
        success: false,
        error: {
          code: 'SOURCE_NOT_FOUND',
          message: 'Unknown skill source: nope',
        },
      });
    });

    it('rejects guest sessions with AGENT_CONTEXT_REQUIRED before any sync', async () => {
      const ctx = createContext();
      (ctx.resolveSessionContext as jest.Mock).mockResolvedValue({
        success: true,
        data: {
          type: 'guest',
          guest: { id: 'guest-1', name: 'Guest', projectId: 'project-1', tmuxSessionId: 's-1' },
          project: { id: 'project-1', name: 'Project', rootPath: '/project' },
        },
      });

      await expect(handleSkillsSync(ctx, { sessionId: SESSION_ID })).resolves.toMatchObject({
        success: false,
        error: { code: 'AGENT_CONTEXT_REQUIRED' },
      });
      expect(ctx.skillSourceLifecycleService.syncAll).not.toHaveBeenCalled();
      expect(ctx.skillSourceLifecycleService.syncSource).not.toHaveBeenCalled();
    });

    it('maps unavailable skill operations', async () => {
      const ctx = createContext();
      (ctx.skillSourceLifecycleService.syncAll as jest.Mock).mockRejectedValue(
        new ServiceUnavailableError('SkillSourceLifecycleService'),
      );

      await expect(handleSkillsSync(ctx, { sessionId: SESSION_ID })).resolves.toMatchObject({
        success: false,
        error: { code: 'SERVICE_UNAVAILABLE' },
      });
    });
  });
});
