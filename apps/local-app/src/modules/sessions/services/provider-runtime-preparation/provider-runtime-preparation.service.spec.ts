import { processIdsEnv } from '../../../../common/process-ids-env';
import { Test, type TestingModule } from '@nestjs/testing';
import type { EffortCapability } from '../../../providers/adapters/capabilities/effort.capability';
import type { HookCapability } from '../../../providers/adapters/capabilities/hook.capability';
import type { ProviderAdapter } from '../../../providers/adapters/provider-adapter.interface';
import { ProviderPluginPolicyService } from '../../../providers/services/provider-plugin-policy.service';
import { ClaudeLaunchSettingsMaterializerService } from '../../../runtime-context-capture/claude-launch-settings-materializer.service';
import {
  CodexPluginProfileMaterializerService,
  type PreparedCodexPluginProfile,
} from '../../../runtime-context-capture/codex-plugin-profile-materializer.service';
import { RuntimeContextCaptureService } from '../../../runtime-context-capture/runtime-context-capture.service';
import type { RuntimeContextCaptureSnapshot } from '../../../runtime-context-capture/runtime-context-capture.types';
import {
  STORAGE_SERVICE,
  type StorageService,
} from '../../../storage/interfaces/storage.interface';
import type { Provider } from '../../../storage/models/domain.models';
import { ProviderRuntimePreparationService } from './provider-runtime-preparation.service';
import type {
  NewProviderRuntimePlanInput,
  RestoreProviderRuntimePlanInput,
} from './provider-runtime-preparation.types';

type StorageMock = jest.Mocked<Pick<StorageService, 'getProviderEnvForProject'>>;

interface TestAdapter extends ProviderAdapter {
  buildLaunchArgs: jest.MockedFunction<ProviderAdapter['buildLaunchArgs']>;
}

const provider: Provider = {
  id: 'provider-1',
  name: 'other',
  binPath: '/usr/bin/other',
  mcpConfigured: false,
  mcpEndpoint: null,
  mcpRegisteredAt: null,
  autoCompactThreshold: null,
  claudeLaunchSettingsJson: null,
  env: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function makeAdapter(providerName = 'other'): TestAdapter {
  return {
    providerName,
    buildLaunchArgs: jest.fn((input) => ({
      argv:
        input.mode === 'restore'
          ? ['--resume', input.providerSessionId!, ...input.profileOptionArgs]
          : [...input.profileOptionArgs],
    })),
  };
}

function makeNewInput(
  adapter: ProviderAdapter,
  overrides: Partial<NewProviderRuntimePlanInput> = {},
): NewProviderRuntimePlanInput {
  return {
    mode: 'new',
    adapter,
    provider,
    providerBinPath: '/usr/bin/other',
    projectId: 'project-1',
    projectName: 'Project One',
    projectRootPath: '/workspace/project-one',
    agentId: 'agent-1',
    agentModelOverride: null,
    agentEffortOverride: null,
    configModel: null,
    configEffort: null,
    profileOptions: null,
    configEnv: null,
    sessionId: 'session-1',
    tmuxSessionName: 'tmux-session-1',
    ...overrides,
  };
}

function makeRestoreInput(
  adapter: ProviderAdapter,
  overrides: Partial<RestoreProviderRuntimePlanInput> = {},
): RestoreProviderRuntimePlanInput {
  return {
    mode: 'restore',
    adapter,
    provider,
    providerBinPath: '/usr/bin/other',
    projectId: 'project-1',
    projectName: 'Project One',
    projectRootPath: '/workspace/project-one',
    agentId: 'agent-1',
    agentModelOverride: null,
    agentEffortOverride: null,
    configModel: null,
    configEffort: null,
    profileOptions: null,
    configEnv: null,
    sessionId: 'session-1',
    tmuxSessionName: 'tmux-session-1',
    providerSessionId: 'provider-session-1',
    ...overrides,
  };
}

function makePreparedCodex(overrides: Partial<PreparedCodexPluginProfile> = {}) {
  return {
    profileName: 'devchain-profile',
    projectDigest: 'a'.repeat(64),
    policyHash: 'b'.repeat(64),
    sourceRevisionPath: '/private/source.toml',
    helperPath: '/private/helper',
    sessionId: 'session-1',
    attemptNonce: 'nonce-1234567890123456',
    referencePath: '/private/reference.json',
    locatorPath: '/private/locator.json',
    acknowledgementPath: '/private/ack.json',
    providerOptionArgs: ['--profile', 'devchain-profile'],
    ...overrides,
  } satisfies PreparedCodexPluginProfile;
}

describe('ProviderRuntimePreparationService', () => {
  let module: TestingModule;
  let service: ProviderRuntimePreparationService;
  let storage: StorageMock;
  let policy: { resolveAll: jest.Mock };
  let capture: {
    snapshot: jest.Mock;
    rotateEpoch: jest.Mock;
    restoreSnapshot: jest.Mock;
    clear: jest.Mock;
  };
  let claude: { prepare: jest.Mock; cleanupSession: jest.Mock };
  let codex: {
    prepare: jest.Mock;
    buildHelperArgv: jest.Mock;
    awaitAcknowledgement: jest.Mock;
    cleanupPrepared: jest.Mock;
  };

  beforeEach(async () => {
    storage = { getProviderEnvForProject: jest.fn().mockReturnValue(null) };
    policy = { resolveAll: jest.fn().mockResolvedValue([]) };
    capture = {
      snapshot: jest.fn().mockReturnValue(null),
      rotateEpoch: jest.fn().mockReturnValue('epoch-1'),
      restoreSnapshot: jest.fn(),
      clear: jest.fn(),
    };
    claude = {
      prepare: jest.fn().mockResolvedValue({
        optionArgs: [],
        runtimeEnv: {},
        captureEnabled: false,
      }),
      cleanupSession: jest.fn().mockResolvedValue(undefined),
    };
    codex = {
      prepare: jest.fn().mockResolvedValue(null),
      buildHelperArgv: jest.fn(),
      awaitAcknowledgement: jest.fn().mockResolvedValue('/private/target'),
      cleanupPrepared: jest.fn().mockResolvedValue(undefined),
    };

    module = await Test.createTestingModule({
      providers: [
        ProviderRuntimePreparationService,
        { provide: STORAGE_SERVICE, useValue: storage },
        { provide: ProviderPluginPolicyService, useValue: policy },
        { provide: RuntimeContextCaptureService, useValue: capture },
        { provide: ClaudeLaunchSettingsMaterializerService, useValue: claude },
        { provide: CodexPluginProfileMaterializerService, useValue: codex },
      ],
    }).compile();
    service = module.get(ProviderRuntimePreparationService);
  });

  afterEach(async () => {
    await module.close();
  });

  describe('createPlan', () => {
    it('resolves model, effort, filtered env, policy, hook context, and config without mutation', async () => {
      const buildHookEnv = jest.fn(() => ({ DEVCHAIN_HOOK: 'bound' }));
      const applyEffort = jest.fn((argv: string[], env: Record<string, string>) => ({
        argv: [...argv, '--effort', 'agent-effort'],
        env,
      }));
      const adapter: TestAdapter & HookCapability & EffortCapability = {
        ...makeAdapter('claude'),
        hooksEnabled: true,
        hooksEventName: 'Notification',
        hooksProvideTranscriptPath: true,
        buildHookEnv,
        defaultEffortValues: [],
        applyEffort,
      };
      storage.getProviderEnvForProject.mockReturnValue({ SHARED: 'provider', PROVIDER: 'yes' });
      policy.resolveAll.mockResolvedValue([{ pluginId: 'plugin-a', enabled: true }]);

      await service.createPlan(
        makeNewInput(adapter, {
          provider: { ...provider, name: 'claude' },
          agentModelOverride: 'agent-model',
          agentEffortOverride: 'agent-effort',
          configModel: 'config-model',
          configEffort: 'config-effort',
          profileOptions: '--model raw-model --verbose',
          configEnv: { SHARED: 'config', CONFIG: 'yes' },
          initialPrompt: 'hello',
        }),
      );

      expect(storage.getProviderEnvForProject).toHaveBeenCalledWith('provider-1', 'project-1');
      expect(policy.resolveAll).toHaveBeenCalledWith('project-1', 'provider-1');
      expect(buildHookEnv).toHaveBeenCalledWith({
        apiUrl: expect.stringMatching(/^http:\/\//),
        projectId: 'project-1',
        agentId: 'agent-1',
        sessionId: 'session-1',
        tmuxSessionName: 'tmux-session-1',
      });
      expect(applyEffort).toHaveBeenCalledWith(
        ['--model', 'agent-model', '--verbose'],
        { DEVCHAIN_HOOK: 'bound', SHARED: 'config', PROVIDER: 'yes', CONFIG: 'yes' },
        'agent-effort',
        'agent-model',
      );
      expect(adapter.buildLaunchArgs).toHaveBeenCalledWith({
        mode: 'new',
        providerSessionId: undefined,
        sessionId: 'session-1',
        profileOptionArgs: ['--model', 'agent-model', '--verbose', '--effort', 'agent-effort'],
        initialPrompt: 'hello',
      });
      expect(capture.rotateEpoch).not.toHaveBeenCalled();
      expect(claude.prepare).not.toHaveBeenCalled();
      expect(codex.prepare).not.toHaveBeenCalled();
    });

    it.each([
      ['claude', '--settings user.json', 'Profile-supplied --settings'],
      ['codex', '--profile user-profile', 'Profile-supplied Codex profile selector'],
      ['codex', '-puser-profile', 'Profile-supplied Codex profile selector'],
    ])('rejects %s policy ownership conflicts during planning', async (name, options, message) => {
      policy.resolveAll.mockResolvedValue([{ pluginId: 'plugin-a', enabled: true }]);

      await expect(
        service.createPlan(
          makeNewInput(makeAdapter(name), {
            provider: { ...provider, name },
            profileOptions: options,
          }),
        ),
      ).rejects.toThrow(message);
      expect(capture.rotateEpoch).not.toHaveBeenCalled();
    });

    it('rejects restore plans whose base argv omits provider identity', async () => {
      const adapter = makeAdapter();
      adapter.buildLaunchArgs.mockImplementation(({ profileOptionArgs }) => ({
        argv: [...profileOptionArgs],
      }));

      await expect(service.createPlan(makeRestoreInput(adapter))).rejects.toThrow(
        'Restore argv does not include provider session ID — adapter contract violation',
      );
      expect(capture.snapshot).not.toHaveBeenCalled();
      expect(capture.rotateEpoch).not.toHaveBeenCalled();
    });

    it('propagates policy and profile parsing failures before materialization', async () => {
      policy.resolveAll.mockRejectedValueOnce(new Error('policy unavailable'));
      await expect(service.createPlan(makeNewInput(makeAdapter()))).rejects.toThrow(
        'policy unavailable',
      );

      await expect(
        service.createPlan(makeNewInput(makeAdapter(), { profileOptions: '"unterminated' })),
      ).rejects.toThrow('unterminated quote');
      expect(capture.rotateEpoch).not.toHaveBeenCalled();
    });
  });

  describe('materialize', () => {
    it('preserves the base command when preparation is inactive and clears new capture on rollback', async () => {
      const adapter = makeAdapter();
      const plan = await service.createPlan(
        makeNewInput(adapter, { profileOptions: '--model raw-model' }),
      );

      const prepared = await service.materialize(plan);

      expect(adapter.buildLaunchArgs).toHaveBeenCalledTimes(1);
      expect(prepared.config.argv).toEqual(['--model', 'raw-model']);
      expect(capture.rotateEpoch.mock.invocationCallOrder[0]).toBeLessThan(
        claude.prepare.mock.invocationCallOrder[0],
      );
      await expect(prepared.afterCommand()).resolves.toBeUndefined();
      expect(codex.awaitAcknowledgement).not.toHaveBeenCalled();

      await prepared.rollback();
      expect(claude.cleanupSession).toHaveBeenCalledWith('session-1');
      expect(capture.clear).toHaveBeenCalledWith('session-1');
      expect(capture.restoreSnapshot).not.toHaveBeenCalled();
    });

    it('restores the exact prior capture snapshot on restore rollback', async () => {
      const prior: RuntimeContextCaptureSnapshot = {
        epoch: 'prior-epoch',
        state: {
          sessionId: 'session-1',
          epoch: 'prior-epoch',
          sequence: 7,
          claudeSessionId: 'claude-session',
          modelId: 'opus',
          contextWindowTokens: 200_000,
        },
        configuredOverride: { modelId: 'opus', contextWindowTokens: 200_000 },
      };
      capture.snapshot.mockReturnValue(prior);
      const plan = await service.createPlan(makeRestoreInput(makeAdapter()));

      const prepared = await service.materialize(plan);
      await prepared.rollback();

      expect(capture.snapshot).toHaveBeenCalledWith('session-1');
      expect(capture.restoreSnapshot).toHaveBeenCalledWith('session-1', prior);
      expect(capture.clear).not.toHaveBeenCalled();
    });

    it('re-resolves an active Claude overlay from the frozen base input with current precedence', async () => {
      const adapter = makeAdapter('claude');
      storage.getProviderEnvForProject.mockReturnValue({ SHARED: 'provider', PROVIDER: 'yes' });
      claude.prepare.mockResolvedValue({
        optionArgs: ['--settings', '/private/settings.json'],
        runtimeEnv: { SHARED: 'runtime', RUNTIME: 'yes' },
        captureEnabled: true,
      });
      const input = makeNewInput(adapter, {
        provider: {
          ...provider,
          name: 'claude',
          binPath: '/usr/bin/claude',
          claudeLaunchSettingsJson: '{}',
        },
        providerBinPath: '/usr/bin/claude',
        profileOptions: '--model opus --verbose',
        configEnv: { SHARED: 'config', CONFIG: 'yes' },
      });
      const plan = await service.createPlan(input);
      input.configEnv!.SHARED = 'mutated';
      input.provider.claudeLaunchSettingsJson = 'mutated';

      const prepared = await service.materialize(plan);

      expect(adapter.buildLaunchArgs).toHaveBeenCalledTimes(2);
      expect(prepared.config.argv).toEqual([
        '--settings',
        '/private/settings.json',
        '--model',
        'opus',
        '--verbose',
      ]);
      expect(prepared.config.env).toEqual({
        ...processIdsEnv(),
        SHARED: 'runtime',
        PROVIDER: 'yes',
        CONFIG: 'yes',
        RUNTIME: 'yes',
      });
      expect(Object.isFrozen(prepared.config)).toBe(true);
      expect(Object.isFrozen(prepared.config.argv)).toBe(true);
      expect(claude.prepare).toHaveBeenCalledWith(
        expect.objectContaining({
          providerName: 'claude',
          settingsJson: '{}',
          profileOptionArgs: ['--model', 'opus', '--verbose'],
          pluginPolicy: [],
          policyRequired: false,
        }),
      );
    });

    it('wraps active Codex commands and binds acknowledgement to the prepared attempt', async () => {
      const adapter = makeAdapter('codex');
      const preparedCodex = makePreparedCodex();
      policy.resolveAll.mockResolvedValue([{ pluginId: 'plugin-a', enabled: true }]);
      codex.prepare.mockResolvedValue(preparedCodex);
      codex.buildHelperArgv.mockReturnValue([
        '/private/helper',
        '--nonce',
        preparedCodex.attemptNonce,
        '--',
        '/usr/bin/codex',
        '--profile',
        'devchain-profile',
      ]);
      const plan = await service.createPlan(
        makeNewInput(adapter, {
          provider: { ...provider, name: 'codex', binPath: '/usr/bin/codex' },
          providerBinPath: '/usr/bin/codex',
          profileOptions: '--model o3',
        }),
      );

      const prepared = await service.materialize(plan);
      expect(prepared.config.argv).toEqual(['--profile', 'devchain-profile', '--model', 'o3']);
      expect(prepared.config.commandArgs).toEqual(
        expect.arrayContaining(['/private/helper', '--nonce', preparedCodex.attemptNonce]),
      );

      await prepared.afterCommand();
      expect(codex.awaitAcknowledgement).toHaveBeenCalledWith(preparedCodex, {
        projectId: 'project-1',
        attemptNonce: preparedCodex.attemptNonce,
      });
    });

    it('rejects an active restore overlay that loses provider identity', async () => {
      const adapter = makeAdapter('claude');
      adapter.buildLaunchArgs
        .mockImplementationOnce(({ providerSessionId, profileOptionArgs }) => ({
          argv: ['--resume', providerSessionId!, ...profileOptionArgs],
        }))
        .mockImplementationOnce(({ profileOptionArgs }) => ({ argv: [...profileOptionArgs] }));
      claude.prepare.mockResolvedValue({
        optionArgs: ['--settings', '/private/settings.json'],
        runtimeEnv: {},
        captureEnabled: false,
      });
      const plan = await service.createPlan(
        makeRestoreInput(adapter, { provider: { ...provider, name: 'claude' } }),
      );

      await expect(service.materialize(plan)).rejects.toThrow(
        'Restore argv does not include provider session ID — adapter contract violation',
      );
      expect(claude.cleanupSession).toHaveBeenCalledWith('session-1');
      expect(capture.restoreSnapshot).toHaveBeenCalledWith('session-1', null);
    });

    it('attempts Codex, Claude, and capture rollback in order after individual failures', async () => {
      const order: string[] = [];
      const preparedCodex = makePreparedCodex();
      policy.resolveAll.mockResolvedValue([{ pluginId: 'plugin-a', enabled: true }]);
      codex.prepare.mockResolvedValue(preparedCodex);
      codex.buildHelperArgv.mockReturnValue(['/private/helper', '--', '/usr/bin/codex']);
      const cleanupError = new Error('codex cleanup failed');
      codex.cleanupPrepared.mockImplementation(async () => {
        order.push('codex');
        throw cleanupError;
      });
      claude.cleanupSession.mockImplementation(async () => {
        order.push('claude');
        throw new Error('claude cleanup failed');
      });
      capture.clear.mockImplementation(() => {
        order.push('capture');
        throw new Error('capture cleanup failed');
      });
      const plan = await service.createPlan(
        makeNewInput(makeAdapter('codex'), {
          provider: { ...provider, name: 'codex', binPath: '/usr/bin/codex' },
          providerBinPath: '/usr/bin/codex',
        }),
      );
      const prepared = await service.materialize(plan);

      await expect(prepared.rollback()).rejects.toBe(cleanupError);
      expect(order).toEqual(['codex', 'claude', 'capture']);
    });

    it('compensates Claude and capture after a later materialization failure and rethrows the original', async () => {
      const materializationError = new Error('codex preparation failed');
      const order: string[] = [];
      codex.prepare.mockImplementation(async () => {
        order.push('codex-prepare');
        throw materializationError;
      });
      claude.cleanupSession.mockImplementation(async () => {
        order.push('claude-cleanup');
      });
      capture.clear.mockImplementation(() => {
        order.push('capture-clear');
      });
      const plan = await service.createPlan(
        makeNewInput(makeAdapter('codex'), {
          provider: { ...provider, name: 'codex', binPath: '/usr/bin/codex' },
          providerBinPath: '/usr/bin/codex',
        }),
      );

      await expect(service.materialize(plan)).rejects.toBe(materializationError);
      expect(order).toEqual(['codex-prepare', 'claude-cleanup', 'capture-clear']);
    });
  });
});
