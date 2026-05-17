import { McpService } from './mcp.service';
import { DEFAULT_FEATURE_FLAGS } from '../../../common/config/feature-flags';
import { NotFoundError } from '../../../common/errors/error-types';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import type { Agent, Document, Prompt, Project, Skill } from '../../storage/models/domain.models';

const TEST_SESSION_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const TEST_PROJECT: Project = {
  id: 'project-1',
  name: 'Test Project',
  description: null,
  rootPath: '/test/project',
  isTemplate: false,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
};
const TEST_AGENT: Agent = {
  id: 'agent-1',
  projectId: 'project-1',
  profileId: 'profile-1',
  name: 'Test Agent',
  description: null,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
};

describe('McpService', () => {
  let service: McpService;
  let storage: jest.Mocked<StorageService>;
  let chatService: jest.Mocked<unknown>;
  let sessionsService: jest.Mocked<unknown>;
  let terminalGateway: jest.Mocked<unknown>;
  let epicsService: jest.Mocked<{ updateEpic: jest.Mock; createEpicForProject: jest.Mock }>;
  let settingsService: jest.Mocked<unknown>;
  let guestsService: jest.Mocked<unknown>;
  let skillsService: jest.Mocked<unknown>;
  let reviewsService: jest.Mocked<unknown>;
  let teamsService: jest.Mocked<unknown>;

  beforeEach(() => {
    storage = {
      getDocument: jest.fn(),
      listDocuments: jest.fn(),
      createDocument: jest.fn(),
      updateDocument: jest.fn(),
      listPrompts: jest.fn(),
      getPrompt: jest.fn(),
      listProjects: jest.fn(),
      createRecord: jest.fn(),
      updateRecord: jest.fn(),
      getRecord: jest.fn(),
      listRecords: jest.fn(),
      addTags: jest.fn(),
      removeTags: jest.fn(),
      findProjectByPath: jest.fn(), // Legacy - kept for existing test mocks
      listAgents: jest.fn(),
      getAgent: jest.fn(),
      getAgentByName: jest.fn(),
      getProject: jest.fn(),
      listStatuses: jest.fn(),
      findStatusByName: jest.fn(),
      listProjectEpics: jest.fn(),
      listAssignedEpics: jest.fn(),
      createEpicForProject: jest.fn(),
      listEpicComments: jest.fn(),
      listSubEpics: jest.fn(),
      listSubEpicsForParents: jest.fn(),
      getEpic: jest.fn(),
      createEpicComment: jest.fn(),
      getFeatureFlags: jest.fn().mockReturnValue(DEFAULT_FEATURE_FLAGS),
      listGuests: jest.fn().mockResolvedValue([]),
      getGuestByName: jest.fn().mockResolvedValue(null),
      getGuestsByIdPrefix: jest.fn().mockResolvedValue([]),
      getEpicsByIdPrefix: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<StorageService>;

    chatService = {
      createGroupThread: jest.fn(),
      getThread: jest.fn(),
      createMessage: jest.fn(),
      listMessages: jest.fn(),
      createDirectThread: jest.fn(),
    };

    sessionsService = {
      getAgentSession: jest.fn(),
      listActiveSessions: jest.fn().mockResolvedValue([
        {
          id: TEST_SESSION_ID,
          agentId: TEST_AGENT.id,
          tmuxSessionId: 'tmux-1',
          status: 'running',
          startedAt: '2024-01-01T00:00:00Z',
          endedAt: null,
          epicId: null,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
      ]),
      injectTextIntoSession: jest.fn().mockResolvedValue({ confirmed: true }),
      launchSession: jest.fn(),
      getAgentPresence: jest.fn().mockResolvedValue(new Map()),
    };

    // Default session context mocks (can be overridden in individual tests)
    storage.getAgent.mockResolvedValue(TEST_AGENT);
    (storage as unknown as { getProject: jest.Mock }).getProject.mockResolvedValue(TEST_PROJECT);

    terminalGateway = {
      sendTextToSession: jest.fn(),
      broadcastEvent: jest.fn(),
    };

    epicsService = {
      updateEpic: jest.fn(),
      createEpicForProject: jest.fn(),
    } as { updateEpic: jest.Mock; createEpicForProject: jest.Mock };

    settingsService = {
      // T3-FIX: Method name is getMessagePoolConfigForProject (not getMessagePoolConfig)
      getMessagePoolConfigForProject: jest.fn().mockReturnValue({
        enabled: true,
        delayMs: 10000,
        maxWaitMs: 30000,
        maxMessages: 10,
        separator: '\n---\n',
      }),
    };

    guestsService = {
      register: jest.fn(),
    };

    skillsService = {
      listDiscoverable: jest.fn(),
      getSkillBySlug: jest.fn(),
      logUsage: jest.fn(),
    };

    reviewsService = {};

    teamsService = {
      listTeams: jest.fn(),
      findTeamByExactName: jest.fn(),
      getTeam: jest.fn(),
      listTeamsByAgent: jest.fn().mockResolvedValue([]),
    };

    service = new McpService(
      storage,
      chatService as never,
      sessionsService as never,
      terminalGateway as never,
      epicsService as never,
      settingsService as never,
      guestsService as never,
      skillsService as never,
      reviewsService as never,
      teamsService as never,
      undefined as never,
      undefined as never,
      undefined as never,
    );
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  // --- Document dispatch tests ---
  // TODO(P3.2): migrate handler-internal document tests to document-tools handler spec
  it('inlines linked documents when includeLinks is inline', async () => {
    const rootDocument: Document = {
      id: '00000000-0000-0000-0000-000000000001',
      projectId: 'project-1',
      title: 'Root Doc',
      slug: 'root',
      contentMd: 'Hello [[child]] world',
      archived: false,
      version: 1,
      tags: [],
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-02T00:00:00Z',
    };

    const childDocument: Document = {
      id: '00000000-0000-0000-0000-000000000002',
      projectId: 'project-1',
      title: 'Child Doc',
      slug: 'child',
      contentMd: 'Child content',
      archived: false,
      version: 1,
      tags: [],
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-02T00:00:00Z',
    };

    storage.getDocument.mockImplementation(async (identifier) => {
      if ('id' in identifier && identifier.id === rootDocument.id) {
        return rootDocument;
      }
      if ('slug' in identifier && identifier.slug === 'child') {
        return childDocument;
      }
      throw new Error('not found');
    });

    const response = await service.handleToolCall('devchain.get_document', {
      id: rootDocument.id,
      includeLinks: 'inline',
    });

    expect(response.success).toBe(true);
    const payload = response.data as {
      document: { id: string };
      links: Array<{ slug: string; exists: boolean }>;
      resolved?: { contentMd: string };
    };

    expect(payload.document.id).toBe(rootDocument.id);
    expect(payload.links).toHaveLength(1);
    expect(payload.links[0]).toMatchObject({ slug: 'child', exists: true });
    expect(payload.resolved?.contentMd).toContain('Child content');
  });

  it('lists documents with filters', async () => {
    const listResult = {
      items: [
        {
          id: '00000000-0000-0000-0000-000000000010',
          projectId: 'project-1',
          title: 'Doc One',
          slug: 'doc-one',
          contentMd: 'Content',
          archived: false,
          version: 1,
          tags: ['ref'],
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-02T00:00:00Z',
        },
      ],
      total: 1,
      limit: 10,
      offset: 0,
    };

    storage.listDocuments.mockResolvedValue(
      listResult as unknown as Awaited<ReturnType<typeof storage.listDocuments>>,
    );
    storage.findProjectByPath.mockResolvedValue({
      id: 'project-1',
      name: 'Test Project',
      description: null,
      rootPath: '/repo/project',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-02T00:00:00Z',
    } as Project);

    const response = await service.handleToolCall('devchain.list_documents', {
      sessionId: TEST_SESSION_ID,
      q: 'Doc',
      tags: ['ref'],
      limit: 10,
      offset: 0,
    });

    expect(response.success).toBe(true);
    const data = response.data as {
      documents: Array<{ id: string; title: string }>;
      total: number;
      limit: number;
      offset: number;
    };
    expect(data.documents).toHaveLength(1);
    expect(data.documents[0].title).toBe('Doc One');
    expect(data.total).toBe(1);
  });

  it('rejects list documents when sessionId is too short', async () => {
    const response = await service.handleToolCall('devchain.list_documents', {
      sessionId: 'short',
    });

    expect(response.success).toBe(false);
    expect(response.error?.code).toBe('VALIDATION_ERROR');
  });

  // --- Prompt dispatch tests ---
  it('devchain_list_prompts requires valid sessionId and resolves project', async () => {
    storage.listPrompts.mockResolvedValue({ items: [], total: 0, limit: 0, offset: 0 });

    const ok = await service.handleToolCall('devchain_list_prompts', {
      sessionId: TEST_SESSION_ID,
    });
    expect(ok.success).toBe(true);
    expect(storage.listPrompts).toHaveBeenCalledWith({ projectId: 'project-1', q: undefined });

    // Short sessionId fails validation
    const bad = await service.handleToolCall('devchain_list_prompts', { sessionId: 'short' });
    expect(bad.success).toBe(false);
    expect(bad.error?.code).toBe('VALIDATION_ERROR');
  });

  it('devchain_get_prompt by name requires sessionId to resolve project', async () => {
    storage.findProjectByPath.mockResolvedValue({
      id: 'project-1',
      name: 'Demo',
      description: null,
      rootPath: '/abs/demo',
      isTemplate: false,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    } as Project);
    const prompt: Prompt = {
      id: 'p1',
      projectId: 'project-1',
      title: 'Welcome',
      content: 'Hello',
      version: 1,
      tags: [],
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    };
    const promptSummary = {
      id: prompt.id,
      projectId: prompt.projectId,
      title: prompt.title,
      contentPreview: prompt.content,
      version: prompt.version,
      tags: prompt.tags,
      createdAt: prompt.createdAt,
      updatedAt: prompt.updatedAt,
    };
    storage.listPrompts.mockResolvedValue({
      items: [promptSummary],
      total: 1,
      limit: 1,
      offset: 0,
    });
    storage.getPrompt.mockResolvedValue(prompt);

    const byName = await service.handleToolCall('devchain_get_prompt', {
      name: 'Welcome',
      sessionId: TEST_SESSION_ID,
    });
    expect(byName.success).toBe(true);
    expect((byName.data as { prompt: { id: string } }).prompt.id).toBe('p1');

    // sessionId is now required at DTO level when querying by name
    const missing = await service.handleToolCall('devchain_get_prompt', { name: 'Welcome' });
    expect(missing.success).toBe(false);
    expect(missing.error?.code).toBe('VALIDATION_ERROR');
  });

  // --- Skill dispatch tests ---
  // TODO(P3.2): migrate handler-internal skill tests to skill-tools handler spec
  describe('skill tools', () => {
    const makeSkill = (overrides: Partial<Skill> = {}): Skill => ({
      id: 'skill-1',
      slug: 'openai/code-review',
      name: 'code-review',
      displayName: 'Code Review',
      description: 'Review code changes',
      shortDescription: 'Review PRs',
      source: 'openai',
      sourceUrl: 'https://github.com/openai/skills',
      sourceCommit: 'abc123',
      category: 'engineering',
      license: 'MIT',
      compatibility: 'general',
      frontmatter: { tags: ['review'] },
      instructionContent: '# Do code review',
      contentPath: '/tmp/skills/openai/code-review/SKILL.md',
      resources: ['docs/checklist.md'],
      status: 'available',
      lastSyncedAt: '2024-01-01T00:00:00Z',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      ...overrides,
    });

    it('lists project skills for a resolved session', async () => {
      const skill = makeSkill();
      (skillsService as { listDiscoverable: jest.Mock }).listDiscoverable.mockResolvedValue([
        skill,
      ]);

      const response = await service.handleToolCall('devchain_list_skills', {
        sessionId: TEST_SESSION_ID,
        q: 'review',
      });

      expect(response.success).toBe(true);
      expect(
        (skillsService as { listDiscoverable: jest.Mock }).listDiscoverable,
      ).toHaveBeenCalledWith(TEST_PROJECT.id, { q: 'review' });
      const payload = response.data as {
        skills: Array<{
          slug: string;
          description: string;
        }>;
        total: number;
      };
      expect(payload.total).toBe(1);
      expect(payload.skills[0]).toEqual({
        slug: expect.any(String),
        description: expect.any(String),
      });
      expect(payload.skills[0].description).toBe(skill.shortDescription);
      expect(payload.skills[0]).not.toHaveProperty('name');
      expect(payload.skills[0]).not.toHaveProperty('displayName');
      expect(payload.skills[0]).not.toHaveProperty('source');
      expect(payload.skills[0]).not.toHaveProperty('category');
      expect(payload.skills[0]).not.toHaveProperty('shortDescription');
      expect(payload.skills[0]).not.toHaveProperty('lastSyncedAt');
    });

    it('gets a skill by slug and records usage with session actor context', async () => {
      const skill = makeSkill();
      (skillsService as { getSkillBySlug: jest.Mock }).getSkillBySlug.mockResolvedValue(skill);
      (skillsService as { logUsage: jest.Mock }).logUsage.mockResolvedValue({
        id: 'usage-1',
      });

      const response = await service.handleToolCall('devchain_get_skill', {
        sessionId: TEST_SESSION_ID,
        slug: 'OpenAI/Code-Review',
      });

      expect(response.success).toBe(true);
      expect((skillsService as { getSkillBySlug: jest.Mock }).getSkillBySlug).toHaveBeenCalledWith(
        'openai/code-review',
      );
      expect((skillsService as { logUsage: jest.Mock }).logUsage).toHaveBeenCalledWith(
        skill.id,
        skill.slug,
        TEST_PROJECT.id,
        TEST_AGENT.id,
        TEST_AGENT.name,
      );
      const payload = response.data as {
        slug: string;
        name: string;
        description: string | null;
        instructionContent: string | null;
        contentPath: string | null;
        resources: string[];
        sourceUrl: string | null;
        license: string | null;
        compatibility: string | null;
        status: string;
        frontmatter: Record<string, unknown> | null;
      };
      expect(payload).toMatchObject({
        slug: skill.slug,
        name: skill.name,
        description: skill.description,
        instructionContent: skill.instructionContent,
        contentPath: skill.contentPath,
        resources: skill.resources,
        sourceUrl: skill.sourceUrl,
        license: skill.license,
        compatibility: skill.compatibility,
        status: skill.status,
        frontmatter: skill.frontmatter,
      });
    });

    it('returns SKILL_NOT_FOUND for unknown skill slug', async () => {
      (skillsService as { getSkillBySlug: jest.Mock }).getSkillBySlug.mockRejectedValue(
        new NotFoundError('Skill', 'missing/skill'),
      );

      const response = await service.handleToolCall('devchain_get_skill', {
        sessionId: TEST_SESSION_ID,
        slug: 'missing/skill',
      });

      expect(response.success).toBe(false);
      expect(response.error?.code).toBe('SKILL_NOT_FOUND');
      expect((skillsService as { logUsage: jest.Mock }).logUsage).not.toHaveBeenCalled();
    });
  });
});
