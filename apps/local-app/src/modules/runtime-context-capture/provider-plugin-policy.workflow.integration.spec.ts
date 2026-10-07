import { processIdsEnv } from '../../common/process-ids-env';
import { createTestDatabase } from '../../common/test/test-database.helper';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { ClaudeAdapter } from '../providers/adapters/claude.adapter';
import { CodexAdapter } from '../providers/adapters/codex.adapter';
import type { ProviderAdapter } from '../providers/adapters/provider-adapter.interface';
import { ProviderPluginPolicyService } from '../providers/services/provider-plugin-policy.service';
import { ProviderRuntimePreparationService } from '../sessions/services/provider-runtime-preparation';
import type {
  NewProviderRuntimePlanInput,
  RestoreProviderRuntimePlanInput,
} from '../sessions/services/provider-runtime-preparation';
import { LocalStorageService } from '../storage/local/local-storage.service';
import type { Provider } from '../storage/models/domain.models';
import { ClaudeLaunchSettingsMaterializerService } from './claude-launch-settings-materializer.service';
import { CodexPluginProfileMaterializerService } from './codex-plugin-profile-materializer.service';
import { RuntimeContextCaptureService } from './runtime-context-capture.service';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const RESTORE_PROVIDER_SESSION_ID = 'provider-session-plugin-policy-workflow';
const MODES = ['new', 'restore'] as const;

describe('provider plugin policy preparation workflow integration', () => {
  let sqlite: Database.Database;
  let storage: LocalStorageService;
  let policyService: ProviderPluginPolicyService;
  let preparationService: ProviderRuntimePreparationService;
  let temporaryRoot: string;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'devchain-plugin-policy-workflow-'));
    const database = createTestDatabase();
    sqlite = database.sqlite;
    const db = database.db;
    storage = new LocalStorageService(db);
    policyService = new ProviderPluginPolicyService(storage);
    preparationService = new ProviderRuntimePreparationService(
      storage,
      policyService,
      new RuntimeContextCaptureService(db),
      new ClaudeLaunchSettingsMaterializerService(join(temporaryRoot, 'claude-private')),
      new CodexPluginProfileMaterializerService(join(temporaryRoot, 'codex-private')),
    );

    sqlite
      .prepare(
        `INSERT INTO projects
          (id, name, root_path, is_template, is_private, created_at, updated_at)
         VALUES (?, ?, ?, 0, 0, ?, ?)`,
      )
      .run(PROJECT_ID, 'Plugin Policy Project', temporaryRoot, 'created', 'updated');
  });

  afterEach(async () => {
    sqlite.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it.each(MODES)('applies resolved Claude policy through staged %s preparation', async (mode) => {
    const provider = await storage.createProvider({
      name: 'claude',
      claudeLaunchSettingsJson: JSON.stringify({
        theme: 'dark',
        enabledPlugins: {
          'native-only@market': true,
          'managed-alpha@market': true,
        },
      }),
    });
    await seedEffectivePolicy(provider.id);

    const prepared = await prepare(mode, provider, new ClaudeAdapter(), {
      profileOptions: '--model claude-sonnet-4 --verbose',
    });
    const settingsIndex = prepared.config.argv.indexOf('--settings');

    expect(settingsIndex).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(await readFile(prepared.config.argv[settingsIndex + 1], 'utf8'))).toEqual({
      theme: 'dark',
      enabledPlugins: {
        'native-only@market': true,
        'managed-alpha@market': false,
        'managed-beta@market': false,
        'project-only@market': true,
      },
    });
    expect(prepared.config.argv).toEqual(
      mode === 'new'
        ? [
            '--settings',
            prepared.config.argv[settingsIndex + 1],
            '--model',
            'claude-sonnet-4',
            '--verbose',
          ]
        : [
            '--resume',
            RESTORE_PROVIDER_SESSION_ID,
            '--settings',
            prepared.config.argv[settingsIndex + 1],
            '--model',
            'claude-sonnet-4',
            '--verbose',
          ],
    );

    await expect(prepared.afterCommand()).resolves.toBeUndefined();
    await prepared.rollback();
  });

  it.each(MODES)('applies resolved Codex policy through staged %s preparation', async (mode) => {
    const provider = await storage.createProvider({ name: 'codex' });
    await seedEffectivePolicy(provider.id);

    const prepared = await prepare(mode, provider, new CodexAdapter(), {
      profileOptions: '--model "gpt model with spaces" --search',
    });
    const profileIndex = prepared.config.argv.indexOf('--profile');
    const profileName = prepared.config.argv[profileIndex + 1];

    expect(profileIndex).toBeGreaterThanOrEqual(0);
    expect(profileName).toMatch(/^devchain-[a-f0-9]{16}-[a-f0-9]{16}$/);
    expect(prepared.config.argv).toEqual(
      mode === 'new'
        ? [
            '--profile',
            profileName,
            '--model',
            'gpt model with spaces',
            '--search',
            '-c',
            'check_for_update_on_startup=false',
            '-c',
            'tui.alternate_screen="never"',
          ]
        : [
            'resume',
            '--profile',
            profileName,
            '--model',
            'gpt model with spaces',
            '--search',
            '-c',
            'check_for_update_on_startup=false',
            '-c',
            'tui.alternate_screen="never"',
            RESTORE_PROVIDER_SESSION_ID,
          ],
    );
    expect(prepared.config.commandArgs).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/\/devchain-codex-profile-helper-[a-f0-9]{64}$/),
      ]),
    );

    await prepared.rollback();
  });

  it.each(MODES)(
    'preserves the base command for staged %s preparation without policy',
    async (mode) => {
      const provider = await storage.createProvider({ name: 'codex' });

      const prepared = await prepare(mode, provider, new CodexAdapter(), {
        profileOptions: '--model gpt-5',
      });
      const expectedArgv =
        mode === 'new'
          ? [
              '--model',
              'gpt-5',
              '-c',
              'check_for_update_on_startup=false',
              '-c',
              'tui.alternate_screen="never"',
            ]
          : [
              'resume',
              '--model',
              'gpt-5',
              '-c',
              'check_for_update_on_startup=false',
              '-c',
              'tui.alternate_screen="never"',
              RESTORE_PROVIDER_SESSION_ID,
            ];

      expect(prepared.config.argv).toEqual(expectedArgv);
      expect(prepared.config.commandArgs).toEqual([
        'env',
        '-u',
        'DEVCHAIN_CONTEXT_WINDOW_TOKENS',
        ...Object.entries(processIdsEnv()).map(([key, value]) => `${key}=${value}`),
        '/usr/bin/codex',
        ...expectedArgv,
      ]);
      await expect(prepared.afterCommand()).resolves.toBeUndefined();
      await prepared.rollback();
    },
  );

  async function seedEffectivePolicy(providerId: string): Promise<void> {
    await policyService.setDefault(providerId, 'managed-alpha@market', true);
    await policyService.setDefault(providerId, 'managed-beta@market', false);
    await policyService.setProjectOverride(PROJECT_ID, providerId, 'managed-alpha@market', false);
    await policyService.setProjectOverride(PROJECT_ID, providerId, 'project-only@market', true);
  }

  async function prepare(
    mode: (typeof MODES)[number],
    provider: Provider,
    adapter: ProviderAdapter,
    overrides: Pick<NewProviderRuntimePlanInput, 'profileOptions'>,
  ) {
    const sessionId = `session-plugin-policy-${provider.name}-${mode}`;
    const shared = {
      adapter,
      provider,
      providerBinPath: `/usr/bin/${provider.name}`,
      projectId: PROJECT_ID,
      projectName: 'Plugin Policy Project',
      projectRootPath: temporaryRoot,
      agentId: 'agent-plugin-policy-workflow',
      agentModelOverride: null,
      agentEffortOverride: null,
      configModel: null,
      configEffort: null,
      configEnv: null,
      sessionId,
      tmuxSessionName: `tmux-${provider.name}-${mode}`,
      ...overrides,
    };
    const input: NewProviderRuntimePlanInput | RestoreProviderRuntimePlanInput =
      mode === 'new'
        ? { ...shared, mode }
        : { ...shared, mode, providerSessionId: RESTORE_PROVIDER_SESSION_ID };

    return preparationService.materialize(await preparationService.createPlan(input));
  }
});
