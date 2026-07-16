import { Test, TestingModule } from '@nestjs/testing';
import { ProjectsService } from './projects.service';
import { ProjectProviderProvisioningService } from './project-provider-provisioning.service';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { SessionsService } from '../../sessions/services/sessions.service';
import { SettingsService } from '../../settings/services/settings.service';
import { WatchersService } from '../../watchers/services/watchers.service';
import { WatcherRunnerService } from '../../watchers/services/watcher-runner.service';
import { UnifiedTemplateService } from '../../registry/services/unified-template.service';
import { TeamsService } from '../../teams/services/teams.service';
import { ProcessExecutor } from '../../terminal/services/process-executor/process-executor.port';
import { FakeProcessExecutor } from '../../terminal/services/process-executor/fake-process-executor';
import { ExportSchema } from '@devchain/shared';
import { ZodError } from 'zod';
import { ValidationError } from '../../../common/errors/error-types';

jest.mock('../../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

jest.mock('../../providers/utils/probe-1m', () => ({
  probe1mSupport: jest.fn(),
}));

/**
 * A valid ExportSchema payload with two providers in one family, a config-only provider
 * (codex appears only inside providerConfigs), one agent, and two presets.
 */
function buildValidPayload() {
  return {
    version: 1,
    profiles: [
      {
        id: '00000000-0000-4000-8000-000000000001',
        name: 'Reasoner',
        provider: { name: 'claude' },
        familySlug: 'reasoning',
        providerConfigs: [
          { name: 'default', providerName: 'claude' },
          { name: 'codex-alt', providerName: 'codex' },
        ],
      },
    ],
    agents: [
      {
        id: '00000000-0000-4000-8000-000000000010',
        name: 'Coder',
        profileId: '00000000-0000-4000-8000-000000000001',
      },
    ],
    presets: [
      {
        name: 'claude-preset',
        agentConfigs: [{ agentName: 'Coder', providerConfigName: 'default' }],
      },
      {
        name: 'codex-preset',
        agentConfigs: [{ agentName: 'Coder', providerConfigName: 'codex-alt' }],
      },
    ],
  };
}

describe('ProjectsService.setupPreview', () => {
  let service: ProjectsService;
  let storage: { listProviders: jest.Mock };
  let unifiedTemplateService: {
    getTemplate: jest.Mock;
    getTemplateFromFilePath: jest.Mock;
  };

  beforeEach(async () => {
    storage = {
      // Only 'claude' is installed locally; 'codex' is referenced but unavailable.
      listProviders: jest.fn().mockResolvedValue({
        items: [{ id: 'prov-claude', name: 'claude' }],
        total: 1,
        limit: 100,
        offset: 0,
      }),
    };

    unifiedTemplateService = {
      getTemplate: jest.fn(),
      getTemplateFromFilePath: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProjectsService,
        { provide: STORAGE_SERVICE, useValue: storage },
        { provide: SessionsService, useValue: {} },
        { provide: SettingsService, useValue: {} },
        { provide: WatchersService, useValue: {} },
        { provide: WatcherRunnerService, useValue: {} },
        { provide: UnifiedTemplateService, useValue: unifiedTemplateService },
        { provide: TeamsService, useValue: {} },
        {
          provide: ProjectProviderProvisioningService,
          useValue: { provisionProject: jest.fn().mockResolvedValue({ warnings: [] }) },
        },
        { provide: ProcessExecutor, useValue: new FakeProcessExecutor() },
      ],
    }).compile();

    service = module.get<ProjectsService>(ProjectsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('resolves by slug via unifiedTemplateService and enriches', async () => {
    const payload = buildValidPayload();
    unifiedTemplateService.getTemplate.mockResolvedValue({ content: payload });

    const result = await service.setupPreview({ slug: 'my-template', version: '1.0.0' });

    expect(unifiedTemplateService.getTemplate).toHaveBeenCalledWith('my-template', '1.0.0');
    expect(result.payload.profiles).toHaveLength(1);
    assertEnrichment(result);
  });

  it('resolves by templatePath via getTemplateFromFilePath and enriches', async () => {
    const payload = buildValidPayload();
    unifiedTemplateService.getTemplateFromFilePath.mockReturnValue({ content: payload });

    const result = await service.setupPreview({ templatePath: '/abs/template.json' });

    expect(unifiedTemplateService.getTemplateFromFilePath).toHaveBeenCalledWith(
      '/abs/template.json',
    );
    expect(unifiedTemplateService.getTemplate).not.toHaveBeenCalled();
    assertEnrichment(result);
  });

  it('resolves by rawContent directly (no template service call) and enriches', async () => {
    const payload = buildValidPayload();

    const result = await service.setupPreview({ rawContent: payload });

    expect(unifiedTemplateService.getTemplate).not.toHaveBeenCalled();
    expect(unifiedTemplateService.getTemplateFromFilePath).not.toHaveBeenCalled();
    assertEnrichment(result);
  });

  it('throws ZodError for invalid rawContent (surfaces as 400 with details by the filter)', async () => {
    // profiles[].provider.name is required; omitting it must fail ExportSchema.parse.
    await expect(
      service.setupPreview({
        rawContent: { profiles: [{ name: 'NoProvider' }] },
      }),
    ).rejects.toBeInstanceOf(ZodError);

    expect(unifiedTemplateService.getTemplate).not.toHaveBeenCalled();
  });

  it('passes through parsed payload byte-for-byte (parsed payload equals ExportSchema.parse)', async () => {
    const payload = buildValidPayload();

    const result = await service.setupPreview({ rawContent: payload });

    expect(result.payload).toEqual(ExportSchema.parse(payload));
  });

  /** Shared enrichment assertions for all three source modes. */
  function assertEnrichment(result: Awaited<ReturnType<typeof service.setupPreview>>) {
    // providerSummary: claude (default, available, 1 agent) + codex (config-only, unavailable, 0 agents).
    const byName = new Map(result.providerSummary.map((p) => [p.name, p]));
    expect(byName.get('claude')).toEqual({
      name: 'claude',
      available: true,
      families: ['reasoning'],
      agentCount: 1,
    });
    expect(byName.get('codex')).toEqual({
      name: 'codex',
      available: false,
      families: ['reasoning'],
      agentCount: 0,
    });

    // familyAlternatives reuse computeFamilyAlternatives: one family, claude default + codex alt.
    expect(result.familyAlternatives).toHaveLength(1);
    expect(result.familyAlternatives[0].familySlug).toBe('reasoning');
    expect(result.familyAlternatives[0].defaultProvider).toBe('claude');
    expect(result.familyAlternatives[0].availableProviders).toEqual(['claude']);

    // Per-preset referenced providers: claude-preset → [claude]; codex-preset → [codex].
    const covByPreset = new Map(result.presetProviderCoverage.map((c) => [c.presetName, c]));
    expect(covByPreset.get('claude-preset')?.referencedProviders).toEqual(['claude']);
    expect(covByPreset.get('claude-preset')?.coversAllAgents).toBe(true);
    expect(covByPreset.get('codex-preset')?.referencedProviders).toEqual(['codex']);
    // codex is not installed → preset does not cover all agents.
    expect(covByPreset.get('codex-preset')?.coversAllAgents).toBe(false);

    // localAvailability surfaces installed providers so the UI never recomputes.
    expect(result.localAvailability.installedProviders).toEqual([
      { id: 'prov-claude', name: 'claude' },
    ]);
  }
});

describe('ProjectsService — selectedProviderNames validation', () => {
  let service: ProjectsService;

  beforeEach(async () => {
    const storage = {
      // Only 'claude' is installed locally.
      listProviders: jest.fn().mockResolvedValue({
        items: [{ id: 'prov-claude', name: 'Claude' }],
        total: 1,
        limit: 100,
        offset: 0,
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProjectsService,
        { provide: STORAGE_SERVICE, useValue: storage },
        { provide: SessionsService, useValue: {} },
        { provide: SettingsService, useValue: {} },
        { provide: WatchersService, useValue: {} },
        { provide: WatcherRunnerService, useValue: {} },
        { provide: UnifiedTemplateService, useValue: {} },
        { provide: TeamsService, useValue: {} },
        {
          provide: ProjectProviderProvisioningService,
          useValue: { provisionProject: jest.fn().mockResolvedValue({ warnings: [] }) },
        },
        { provide: ProcessExecutor, useValue: new FakeProcessExecutor() },
      ],
    }).compile();

    service = module.get<ProjectsService>(ProjectsService);
  });

  afterEach(() => jest.clearAllMocks());

  it('createFromTemplate rejects an unknown provider name (400 before any template load)', async () => {
    await expect(
      service.createFromTemplate({
        name: 'X',
        rootPath: '/tmp/x',
        slug: 'my-template',
        selectedProviderNames: ['claude', 'ghost'],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('importProject rejects an unknown provider name (400 before any import work)', async () => {
    await expect(
      service.importProject({
        projectId: 'p1',
        payload: {},
        selectedProviderNames: ['ghost'],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('accepts a known provider name case-insensitively (passes validation, delegates onward)', async () => {
    // 'CLAUDE' matches installed 'Claude'; validation passes, so the call proceeds past the guard
    // into importProject work (which then fails on the empty payload — proving the guard let it through).
    await expect(
      service.importProject({
        projectId: 'p1',
        payload: {},
        selectedProviderNames: ['CLAUDE'],
        dryRun: true,
      }),
    ).rejects.not.toBeInstanceOf(ValidationError);
  });
});
