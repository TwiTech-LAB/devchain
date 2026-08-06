import { spawnSync } from 'child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { ClaudeAdapter } from '../providers/adapters/claude.adapter';
import { CodexAdapter } from '../providers/adapters/codex.adapter';
import { ProviderPluginPolicyService } from '../providers/services/provider-plugin-policy.service';
import { resolve as resolveLaunchConfig } from '../sessions/services/provider-launch-config';
import { LocalStorageService } from '../storage/local/local-storage.service';
import { ClaudeLaunchSettingsMaterializerService } from './claude-launch-settings-materializer.service';
import { CodexPluginProfileMaterializerService } from './codex-plugin-profile-materializer.service';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = 'session-plugin-policy-workflow';
const ATTEMPT_NONCE = 'attempt_nonce_workflow_1234567890';

describe('provider plugin policy launch workflow integration', () => {
  let sqlite: Database.Database;
  let storage: LocalStorageService;
  let policyService: ProviderPluginPolicyService;
  let temporaryRoot: string;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'devchain-plugin-policy-workflow-'));
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: join(__dirname, '../../../drizzle') });
    storage = new LocalStorageService(db);
    policyService = new ProviderPluginPolicyService(storage);

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

  it('carries resolved precedence through Claude settings and exact Codex restore exec', async () => {
    const claudeProvider = await storage.createProvider({ name: 'claude' });
    const codexProvider = await storage.createProvider({ name: 'codex' });
    for (const providerId of [claudeProvider.id, codexProvider.id]) {
      await policyService.setDefault(providerId, 'managed-alpha@market', true);
      await policyService.setDefault(providerId, 'managed-beta@market', false);
      await policyService.setProjectOverride(PROJECT_ID, providerId, 'managed-alpha@market', false);
      await policyService.setProjectOverride(PROJECT_ID, providerId, 'project-only@market', true);
    }

    const claudePolicy = await policyService.resolveAll(PROJECT_ID, claudeProvider.id);
    const codexPolicy = await policyService.resolveAll(PROJECT_ID, codexProvider.id);
    const expectedEffectivePolicy = [
      expect.objectContaining({
        pluginId: 'managed-alpha@market',
        enabled: false,
        source: 'project',
      }),
      expect.objectContaining({
        pluginId: 'managed-beta@market',
        enabled: false,
        source: 'default',
      }),
      expect.objectContaining({
        pluginId: 'project-only@market',
        enabled: true,
        source: 'project',
      }),
    ];
    expect(claudePolicy).toEqual(expectedEffectivePolicy);
    expect(codexPolicy).toEqual(expectedEffectivePolicy);

    const claudeMaterializer = new ClaudeLaunchSettingsMaterializerService(
      join(temporaryRoot, 'claude-private'),
    );
    const claudeBaseSettingsPath = join(temporaryRoot, 'claude-base-settings.json');
    const claudeBaseSettings = JSON.stringify({
      theme: 'dark',
      enabledPlugins: {
        'native-only@market': true,
        'managed-alpha@market': true,
      },
    });
    await writeFile(claudeBaseSettingsPath, claudeBaseSettings);
    const claudeBaseSettingsBytes = await readFile(claudeBaseSettingsPath);
    const preparedClaude = await claudeMaterializer.prepare({
      providerName: 'claude',
      settingsJson: claudeBaseSettings,
      profileOptionArgs: [],
      providerEnv: null,
      configEnv: null,
      sessionId: SESSION_ID,
      epoch: 'epoch-1',
      projectRootPath: temporaryRoot,
      pluginPolicy: claudePolicy,
      policyRequired: true,
    });
    const materializedClaudeSettings = JSON.parse(
      await readFile(preparedClaude.optionArgs[1], 'utf8'),
    );
    expect(materializedClaudeSettings).toEqual({
      theme: 'dark',
      enabledPlugins: {
        'native-only@market': true,
        'managed-alpha@market': false,
        'managed-beta@market': false,
        'project-only@market': true,
      },
    });
    expect(await readFile(claudeBaseSettingsPath)).toEqual(claudeBaseSettingsBytes);

    const claudeNew = resolveLaunchConfig({
      mode: 'new',
      adapter: new ClaudeAdapter(),
      profileOptions: '--model claude-sonnet-4 --verbose',
      modelOverride: null,
      providerBinPath: '/usr/bin/claude',
      providerEnv: null,
      configEnv: null,
      provider: {},
      providerOptionArgs: preparedClaude.optionArgs,
    });
    const claudeRestore = resolveLaunchConfig({
      mode: 'restore',
      providerSessionId: 'claude-provider-session',
      adapter: new ClaudeAdapter(),
      profileOptions: '--model claude-sonnet-4 --verbose',
      modelOverride: null,
      providerBinPath: '/usr/bin/claude',
      providerEnv: null,
      configEnv: null,
      provider: {},
      providerOptionArgs: preparedClaude.optionArgs,
    });
    expect(claudeNew.argv).toEqual([
      ...preparedClaude.optionArgs,
      '--model',
      'claude-sonnet-4',
      '--verbose',
    ]);
    expect(claudeRestore.argv).toEqual([
      '--resume',
      'claude-provider-session',
      ...preparedClaude.optionArgs,
      '--model',
      'claude-sonnet-4',
      '--verbose',
    ]);

    const codexHome = join(temporaryRoot, 'codex-home');
    const codexPrivate = join(temporaryRoot, 'codex-private');
    await mkdir(codexHome, { recursive: true });
    const baseConfigPath = join(codexHome, 'config.toml');
    await writeFile(baseConfigPath, 'model = "base-model"\n');
    const baseConfigBytes = await readFile(baseConfigPath);
    const codexMaterializer = new CodexPluginProfileMaterializerService(codexPrivate);
    const preparedCodex = await codexMaterializer.prepare({
      projectId: PROJECT_ID,
      projectName: 'Plugin Policy Project',
      sessionId: SESSION_ID,
      pluginPolicy: codexPolicy,
      attemptNonce: ATTEMPT_NONCE,
    });
    if (!preparedCodex) throw new Error('Expected a managed Codex profile');

    const codexRestore = resolveLaunchConfig({
      mode: 'restore',
      providerSessionId: 'codex-provider-session',
      adapter: new CodexAdapter(),
      profileOptions: '--model "gpt model with spaces" --search',
      modelOverride: null,
      providerBinPath: '/usr/bin/codex',
      providerEnv: null,
      configEnv: null,
      provider: {},
      providerOptionArgs: preparedCodex.providerOptionArgs,
    });
    expect(codexRestore.argv).toEqual([
      '-c',
      'check_for_update_on_startup=false',
      'resume',
      '--profile',
      preparedCodex.profileName,
      '--model',
      'gpt model with spaces',
      '--search',
      'codex-provider-session',
    ]);

    const fakeCodex = join(temporaryRoot, 'fake-codex');
    await writeFile(
      fakeCodex,
      '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n',
      { mode: 0o700 },
    );
    await chmod(fakeCodex, 0o700);
    const helperArgv = codexMaterializer.buildHelperArgv(
      preparedCodex,
      fakeCodex,
      codexRestore.argv,
      { projectId: PROJECT_ID, attemptNonce: ATTEMPT_NONCE },
    );
    const helperResult = spawnSync(helperArgv[0], helperArgv.slice(1), {
      cwd: temporaryRoot,
      env: { ...process.env, CODEX_HOME: codexHome },
      encoding: 'utf8',
    });

    expect(helperResult.status).toBe(0);
    expect(JSON.parse(helperResult.stdout)).toEqual(codexRestore.argv);
    await expect(
      codexMaterializer.awaitAcknowledgement(preparedCodex, {
        projectId: PROJECT_ID,
        attemptNonce: ATTEMPT_NONCE,
      }),
    ).resolves.toBe(join(codexHome, `${preparedCodex.profileName}.config.toml`));
    expect(await readFile(baseConfigPath)).toEqual(baseConfigBytes);
    await codexMaterializer.cleanupPrepared(preparedCodex);
  });

  it('leaves launch composition unchanged when storage has no explicit policy', async () => {
    const claudeProvider = await storage.createProvider({ name: 'claude' });
    const codexProvider = await storage.createProvider({ name: 'codex' });
    const claudePolicy = await policyService.resolveAll(PROJECT_ID, claudeProvider.id);
    const codexPolicy = await policyService.resolveAll(PROJECT_ID, codexProvider.id);

    expect(claudePolicy).toEqual([]);
    expect(codexPolicy).toEqual([]);
    await expect(
      new CodexPluginProfileMaterializerService(join(temporaryRoot, 'codex-private')).prepare({
        projectId: PROJECT_ID,
        projectName: 'Plugin Policy Project',
        sessionId: SESSION_ID,
        pluginPolicy: codexPolicy,
        attemptNonce: ATTEMPT_NONCE,
      }),
    ).resolves.toBeNull();

    const preparedClaude = await new ClaudeLaunchSettingsMaterializerService(
      join(temporaryRoot, 'claude-private'),
    ).prepare({
      providerName: 'claude',
      settingsJson: null,
      profileOptionArgs: [],
      providerEnv: null,
      configEnv: null,
      sessionId: SESSION_ID,
      epoch: 'epoch-1',
      projectRootPath: temporaryRoot,
      pluginPolicy: claudePolicy,
    });
    expect(preparedClaude.optionArgs).toEqual([]);

    const unmanagedCodex = resolveLaunchConfig({
      mode: 'new',
      adapter: new CodexAdapter(),
      profileOptions: '--model gpt-5',
      modelOverride: null,
      providerBinPath: '/usr/bin/codex',
      providerEnv: null,
      configEnv: null,
      provider: {},
    });
    expect(unmanagedCodex.argv).toEqual([
      '-c',
      'check_for_update_on_startup=false',
      '--model',
      'gpt-5',
    ]);
  });
});
