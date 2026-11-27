import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DEVCHAIN_CLI_PATH } from '../../../../common/devchain-cli-launcher';
import { GIT_SHIM_BIN, GIT_SHIM_ON_VM } from '../../../../common/git-shim-paths';
import { ValidationError } from '../../../../common/errors/error-types';
import { processIdsEnv } from '../../../../common/process-ids-env';
import type { Provider as NestProvider } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import type { EffortCapability } from '../../../providers/adapters/capabilities/effort.capability';
import type { HookCapability } from '../../../providers/adapters/capabilities/hook.capability';
import type {
  PrepareSessionForkLaunchInput,
  SessionForkCapability,
} from '../../../providers/adapters/capabilities/session-fork.capability';
import { ClaudeAdapter } from '../../../providers/adapters/claude.adapter';
import { CopilotAdapter } from '../../../providers/adapters/copilot.adapter';
import { OpencodeAdapter } from '../../../providers/adapters/opencode.adapter';
import type { ProviderAdapter } from '../../../providers/adapters/provider-adapter.interface';
import { ProviderCliVersionProbe } from '../../../providers/services/provider-cli-version-probe.service';
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
import { quoteShellArg } from '../../../terminal/services/terminal-io/quote-shell-arg';
import { RuntimeDirectoryService } from '../../../runtime-directory/runtime-directory.service';
import { ChildProcessExecutor } from '../../../terminal/services/process-executor/child-process-executor';
import {
  ProcessExecutor,
  type ProcessExecutorOptions,
} from '../../../terminal/services/process-executor/process-executor.port';
import { killFixturePid } from '../../../../../test/helpers/fixture-pid';
import { ProviderRuntimePreparationService } from './provider-runtime-preparation.service';
import type {
  NewProviderRuntimePlanInput,
  RestoreProviderRuntimePlanInput,
} from './provider-runtime-preparation.types';

jest.mock('../../../../common/logging/logger', () => {
  // Modules create their logger at import time, before a top-level const exists.
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return {
    ...jest.requireActual('../../../../common/logging/logger'),
    createLogger: () => logger,
  };
});

const mockLogger = jest
  .requireMock<{ createLogger: () => { warn: jest.Mock } }>('../../../../common/logging/logger')
  .createLogger();

type StorageMock = jest.Mocked<
  Pick<StorageService, 'getProviderEnvForProject' | 'getRemoteProjectBinding'>
>;

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

function createCodexOwnerMock() {
  const owner = new CodexPluginProfileMaterializerService();
  return {
    owner,
    prepare: jest.spyOn(owner, 'prepare'),
    prepareProfile: jest.spyOn(owner, 'prepareProfile').mockResolvedValue(null),
    buildHelperArgv: jest.spyOn(owner, 'buildHelperArgv'),
    awaitAcknowledgement: jest
      .spyOn(owner, 'awaitAcknowledgement')
      .mockResolvedValue('/private/target'),
    cleanupPrepared: jest.spyOn(owner, 'cleanupPrepared'),
    cleanupProfile: jest.spyOn(owner, 'cleanupProfile').mockResolvedValue(undefined),
  };
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
  let claude: {
    providerName: string;
    assertNoPolicyConflict: ClaudeLaunchSettingsMaterializerService['assertNoPolicyConflict'];
    prepare: jest.Mock;
    cleanupPrepared: jest.Mock;
  };
  let codex: ReturnType<typeof createCodexOwnerMock>;
  let tempRoot: string;
  let launchRoot: string;

  function compileModule(extraProviders: NestProvider[] = []): Promise<TestingModule> {
    return Test.createTestingModule({
      providers: [
        ProviderRuntimePreparationService,
        { provide: STORAGE_SERVICE, useValue: storage },
        { provide: ProviderPluginPolicyService, useValue: policy },
        { provide: RuntimeContextCaptureService, useValue: capture },
        { provide: ClaudeLaunchSettingsMaterializerService, useValue: claude },
        { provide: CodexPluginProfileMaterializerService, useValue: codex.owner },
        {
          provide: RuntimeDirectoryService,
          useValue: { resolve: async () => ({ path: launchRoot }) },
        },
        ...extraProviders,
      ],
    }).compile();
  }

  beforeEach(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'devchain-launch-script-'));
    // A home-like runtime root, so the typed line has a realistic path length.
    launchRoot = join(tempRoot, 'Users', 'firstname.lastname', '.devchain', 'runtime-context');
    storage = {
      getProviderEnvForProject: jest.fn().mockReturnValue(null),
      getRemoteProjectBinding: jest.fn().mockResolvedValue(null),
    };
    policy = { resolveAll: jest.fn().mockResolvedValue([]) };
    capture = {
      snapshot: jest.fn().mockReturnValue(null),
      rotateEpoch: jest.fn().mockReturnValue('epoch-1'),
      restoreSnapshot: jest.fn(),
      clear: jest.fn(),
    };
    claude = {
      providerName: 'claude',
      assertNoPolicyConflict:
        ClaudeLaunchSettingsMaterializerService.prototype.assertNoPolicyConflict,
      prepare: jest.fn().mockResolvedValue({
        optionArgs: [],
        runtimeEnv: {},
      }),
      cleanupPrepared: jest.fn().mockResolvedValue(undefined),
    };
    codex = createCodexOwnerMock();

    module = await compileModule();
    service = module.get(ProviderRuntimePreparationService);
  });

  afterEach(async () => {
    await module.close();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  describe('createPlan', () => {
    // Use the real copy and command validation to observe the file left by a rejected plan.
    it('discards the Claude child transcript when command validation fails', async () => {
      const adapter = new ClaudeAdapter();
      const savePoint = {
        providerSessionId: 'save-point',
        transcriptPath: join(tempRoot, 'save-point.jsonl'),
      };
      const source = `${JSON.stringify({ type: 'user', sessionId: savePoint.providerSessionId })}\n`;
      writeFileSync(savePoint.transcriptPath, source);
      const input = makeNewInput(adapter, {
        provider: { ...provider, name: 'claude' },
        configEnv: { INVALID: 'line one\nline two' },
      });

      await expect(
        service.createPlan({
          ...input,
          initialPrompt: undefined,
          mode: 'fork',
          adapter,
          savePoint,
          helperEnv: {},
        }),
      ).rejects.toThrow('Environment variable "INVALID" contains control characters');

      expect(existsSync(join(tempRoot, `${input.sessionId}.jsonl`))).toBe(false);
      expect(readFileSync(savePoint.transcriptPath, 'utf8')).toBe(source);
    });

    it('resolves model, effort, filtered env, policy, hook context, and config without mutation', async () => {
      const buildHookEnv = jest.fn(() => ({ DEVCHAIN_HOOK: 'bound' }));
      const applyEffort = jest.fn((argv: string[], env: Record<string, string>) => ({
        argv: [...argv, '--effort', 'agent-effort'],
        env,
      }));
      const adapter: TestAdapter & HookCapability & EffortCapability = {
        ...makeAdapter('claude'),
        hooksEnabled: true,
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
        projectId: 'project-1',
        profileOptionArgs: ['--model', 'agent-model', '--verbose', '--effort', 'agent-effort'],
        initialPrompt: 'hello',
        env: expect.objectContaining({
          DEVCHAIN_HOOK: 'bound',
          SHARED: 'config',
          PROVIDER: 'yes',
          CONFIG: 'yes',
        }),
      });
      expect(capture.rotateEpoch).not.toHaveBeenCalled();
      expect(claude.prepare).not.toHaveBeenCalled();
      expect(codex.prepare).not.toHaveBeenCalled();
    });

    describe('git shim gate (same rule as git-shim-registry.service.ts:104-108)', () => {
      let shimDir: string;
      let emptyDir: string;

      beforeEach(() => {
        shimDir = mkdtempSync(join(tmpdir(), 'devchain-shim-'));
        emptyDir = mkdtempSync(join(tmpdir(), 'devchain-no-shim-'));
        writeFileSync(join(shimDir, 'git'), '#!/bin/sh\n');
      });

      afterEach(() => {
        rmSync(shimDir, { recursive: true, force: true });
        rmSync(emptyDir, { recursive: true, force: true });
      });

      async function launchConfig(
        mode: 'new' | 'restore',
        { shimBin, onVm, bound }: { shimBin: string; onVm: boolean; bound: boolean },
      ) {
        storage.getRemoteProjectBinding.mockResolvedValue(
          bound ? ({ projectId: 'project-1' } as never) : null,
        );
        const gated = await compileModule([
          { provide: GIT_SHIM_BIN, useValue: shimBin },
          { provide: GIT_SHIM_ON_VM, useValue: () => onVm },
        ]);
        try {
          const preparation = gated.get(ProviderRuntimePreparationService);
          const adapter = makeAdapter();
          const plan = await preparation.createPlan(
            mode === 'new' ? makeNewInput(adapter) : makeRestoreInput(adapter),
          );
          return (await preparation.materialize(plan)).config;
        } finally {
          await gated.close();
        }
      }

      it.each(['new', 'restore'] as const)(
        'puts the shim on PATH only when it exists and the project is connected (%s)',
        async (mode) => {
          const pcUnbound = { shimBin: shimDir, onVm: false, bound: false };
          const pcBound = { shimBin: shimDir, onVm: false, bound: true };
          const vm = { shimBin: shimDir, onVm: true, bound: false };
          const shimMissing = { shimBin: emptyDir, onVm: true, bound: true };

          expect((await launchConfig(mode, pcUnbound)).pathPrependDirs).toEqual([]);
          const bound2 = await launchConfig(mode, pcBound);
          // The dir goes to the launch script's $PATH prepend, never a baked literal.
          expect([bound2.pathPrependDirs, bound2.env?.PATH]).toEqual([[shimDir], undefined]);
          expect((await launchConfig(mode, vm)).pathPrependDirs).toEqual([shimDir]);
          expect((await launchConfig(mode, shimMissing)).pathPrependDirs).toEqual([]);
        },
      );
    });

    it.each(['new', 'restore'] as const)(
      "writes this app's devchain launcher and puts its directory on PATH (%s)",
      async (mode) => {
        const cli = join(tempRoot, "it's", 'cli.js');
        const withCli = await compileModule([{ provide: DEVCHAIN_CLI_PATH, useValue: cli }]);
        try {
          const preparation = withCli.get(ProviderRuntimePreparationService);
          const adapter = makeAdapter();
          const plan = await preparation.createPlan(
            mode === 'new' ? makeNewInput(adapter) : makeRestoreInput(adapter),
          );
          const config = (await preparation.materialize(plan)).config;

          const bin = join(launchRoot, 'cli-bin');
          // The dir goes to the launch script's $PATH prepend, never a baked literal.
          expect([config.pathPrependDirs, config.env?.PATH]).toEqual([[bin], undefined]);
          const launcher = join(bin, 'devchain');
          expect(statSync(launcher).mode & 0o777).toBe(0o755);
          expect(readFileSync(launcher, 'utf8')).toBe(
            `#!/bin/sh\nexec ${quoteShellArg(process.execPath)} '${tempRoot}/it'\\''s/cli.js' "$@"\n`,
          );
        } finally {
          await withCli.close();
        }
      },
    );

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

    it.each([{ args: [] }, { args: ['--resume=different-session'] }])(
      'rejects restore plans without the exact provider identity in $args',
      async ({ args }) => {
        const adapter = makeAdapter();
        adapter.buildLaunchArgs.mockImplementation(({ profileOptionArgs }) => ({
          argv: [...args, ...profileOptionArgs],
        }));

        await expect(service.createPlan(makeRestoreInput(adapter))).rejects.toThrow(
          'Restore argv does not include provider session ID — adapter contract violation',
        );
        expect(capture.snapshot).not.toHaveBeenCalled();
        expect(capture.rotateEpoch).not.toHaveBeenCalled();
      },
    );

    // The real adapter confirms that planning accepts the CLI's single-argument resume form.
    it('plans a Copilot restore with the exact provider session ID in --resume=', async () => {
      const adapter = new CopilotAdapter(
        { ensure: jest.fn() } as never,
        { isAuthenticated: jest.fn() } as never,
      );
      const input = makeRestoreInput(adapter, { provider: { ...provider, name: 'copilot' } });

      const plan = await service.createPlan(input);
      const prepared = await service.materialize(plan);

      expect(prepared.config.argv).toEqual([`--resume=${input.providerSessionId}`]);
      await prepared.rollback();
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

    describe('adapters that require the CLI version', () => {
      const opencodeProvider: Provider = {
        ...provider,
        name: 'OpenCode',
        binPath: '/bin/opencode',
      };
      let probe: { probe: jest.Mock };
      let probedService: ProviderRuntimePreparationService;

      beforeEach(async () => {
        probe = { probe: jest.fn().mockResolvedValue('opencode v2.0.31') };
        const probedModule = await compileModule([
          { provide: ProviderCliVersionProbe, useValue: probe },
        ]);
        probedService = probedModule.get(ProviderRuntimePreparationService);
      });

      function opencodeRestoreInput() {
        return makeRestoreInput(new OpencodeAdapter(), {
          provider: opencodeProvider,
          providerBinPath: '/bin/opencode',
          providerSessionId: 'ses_abc',
          configModel: 'a/b',
        });
      }

      it('probes the binary and builds an OpenCode 2 restore that keeps its identity', async () => {
        const plan = await probedService.createPlan(opencodeRestoreInput());
        const { config } = await probedService.materialize(plan);

        expect(probe.probe).toHaveBeenCalledWith('opencode', '/bin/opencode');
        expect(config.argv).toEqual(['--session', 'ses_abc', '--standalone']);
        expect(JSON.parse(config.env!.OPENCODE_CONFIG_CONTENT)).toEqual({ model: 'a/b' });
      });

      // The fake fork uses real launch configuration without copying a transcript or spawning a CLI.
      it('preserves hook variables and model effort in the env returned by the fork', async () => {
        const opencode = new OpencodeAdapter();
        const adapter = {
          providerName: opencode.providerName,
          requiresCliVersion: opencode.requiresCliVersion,
          buildLaunchArgs: opencode.buildLaunchArgs.bind(opencode),
          applyEffort: opencode.applyEffort.bind(opencode),
          defaultEffortValues: opencode.defaultEffortValues,
          hooksEnabled: true,
          hooksProvideTranscriptPath: false,
          buildHookEnv: (context) => ({
            DEVCHAIN_HOOK_PROVIDER: 'test-hook',
            DEVCHAIN_TMUX_SESSION_NAME: context.tmuxSessionName,
          }),
          createSavePoint: jest.fn(),
          prepareForkLaunch: jest.fn(async (input: PrepareSessionForkLaunchInput) => {
            const providerSessionId = 'ses_child';
            return {
              ...opencode.buildLaunchArgs({ ...input, mode: 'restore', providerSessionId }),
              providerSessionId,
              transcriptPath: '/test/opencode.db',
            };
          }),
        } satisfies ProviderAdapter & HookCapability & EffortCapability & SessionForkCapability;
        const input = makeNewInput(adapter, {
          provider: opencodeProvider,
          providerBinPath: '/bin/opencode',
          configModel: 'openai/o3',
          configEffort: 'high',
        });
        const helperEnv = { PATH: '/test/opencode-bin' };
        const plan = await probedService.createPlan({
          ...input,
          mode: 'fork',
          adapter,
          initialPrompt: undefined,
          savePoint: { providerSessionId: 'ses_parent', transcriptPath: '/test/opencode.db' },
          cliVersion: 'opencode v2.0.31',
          helperEnv,
        });
        const { config } = await probedService.materialize(plan);

        const [forkInput] = adapter.prepareForkLaunch.mock.calls[0];
        expect(forkInput).toMatchObject({
          projectId: input.projectId,
          cliVersion: 'opencode v2.0.31',
        });
        expect(forkInput.helperEnv).not.toHaveProperty('DEVCHAIN_HOOK_PROVIDER');
        expect(forkInput.helperEnv).not.toHaveProperty('DEVCHAIN_TMUX_SESSION_NAME');
        expect(forkInput.helperEnv).toEqual(helperEnv);
        expect(probe.probe).not.toHaveBeenCalled();
        expect(config.argv).toEqual(['--session', 'ses_child', '--standalone']);
        expect(config.env).toMatchObject({
          DEVCHAIN_HOOK_PROVIDER: 'test-hook',
          DEVCHAIN_TMUX_SESSION_NAME: input.tmuxSessionName,
          DEVCHAIN_SESSION_ID: input.sessionId,
        });
        expect(JSON.parse(config.env!.OPENCODE_CONFIG_CONTENT)).toEqual({
          model: 'openai/o3',
          provider: { openai: { models: { o3: { options: { reasoningEffort: 'high' } } } } },
        });
      });

      it('rejects an unsupported version before materialization', async () => {
        probe.probe.mockResolvedValue('opencode v3.0.0');
        await expect(probedService.createPlan(opencodeRestoreInput())).rejects.toThrow(
          "Unsupported OpenCode version 'opencode v3.0.0' at /bin/opencode.",
        );
        expect(capture.rotateEpoch).not.toHaveBeenCalled();
      });

      it('fails closed when no probe is available', async () => {
        await expect(service.createPlan(opencodeRestoreInput())).rejects.toThrow(
          'the CLI version probe is unavailable',
        );
      });
    });

    describe('adapters with an optional CLI version', () => {
      let probe: { probe: jest.Mock };
      let probedService: ProviderRuntimePreparationService;
      let adapter: TestAdapter & {
        optionalCliVersion: true;
        createSavePoint: jest.Mock;
        prepareForkLaunch: jest.MockedFunction<SessionForkCapability['prepareForkLaunch']>;
      };

      beforeEach(async () => {
        probe = { probe: jest.fn().mockResolvedValue('1.5.18') };
        probedService = (
          await compileModule([{ provide: ProviderCliVersionProbe, useValue: probe }])
        ).get(ProviderRuntimePreparationService);
        adapter = {
          ...makeAdapter(),
          optionalCliVersion: true,
          createSavePoint: jest.fn(),
          prepareForkLaunch: jest.fn(async (_input: PrepareSessionForkLaunchInput) => ({
            argv: ['--resume', 'child-1'],
            providerSessionId: 'child-1',
            transcriptPath: '/test/child.db',
          })),
        };
        mockLogger.warn.mockClear();
      });

      const inputs = {
        new: () => makeNewInput(adapter),
        restore: () => makeRestoreInput(adapter),
        fork: (cliVersion?: string) => ({
          ...makeNewInput(adapter),
          mode: 'fork' as const,
          adapter,
          initialPrompt: undefined,
          savePoint: { providerSessionId: 'parent-1', transcriptPath: '/test/parent.db' },
          helperEnv: {},
          ...(cliVersion !== undefined && { cliVersion }),
        }),
      };
      /** The version the adapter received: `buildLaunchArgs` for new and restore, the fork call otherwise. */
      const launchVersion = (mode: keyof typeof inputs) =>
        mode === 'fork'
          ? adapter.prepareForkLaunch.mock.calls[0][0].cliVersion
          : adapter.buildLaunchArgs.mock.calls[0][0].cliVersion;

      it.each(['new', 'restore', 'fork'] as const)(
        'passes a probed version to the %s launch args',
        async (mode) => {
          await probedService.createPlan(inputs[mode]());

          expect(probe.probe).toHaveBeenCalledWith('other', '/usr/bin/other');
          expect(launchVersion(mode)).toBe('1.5.18');
          if (mode !== 'fork') {
            expect(adapter.buildLaunchArgs.mock.calls[0][0].providerBinPath).toBe('/usr/bin/other');
          }
          expect(mockLogger.warn).not.toHaveBeenCalled();
        },
      );

      it('uses the fork version from preflight without probing', async () => {
        await probedService.createPlan(inputs.fork('1.6.0'));

        expect(probe.probe).not.toHaveBeenCalled();
        expect(launchVersion('fork')).toBe('1.6.0');
      });

      const failures = [
        ['a failed probe', new ValidationError('Unable to read the agy version')],
        [
          'a timed-out probe',
          new ValidationError('Unable to read the agy version', {
            reason: 'version_probe_timeout',
          }),
        ],
        ['a missing binary', new ValidationError('Provider binary not found: /usr/bin/other')],
      ] as const;
      it.each(
        (['new', 'restore', 'fork'] as const).flatMap((mode) =>
          failures.map(([failure, error]) => ({ mode, failure, error })),
        ),
      )('plans the $mode launch without a version after $failure', async ({ mode, error }) => {
        probe.probe.mockRejectedValue(error);

        await expect(probedService.createPlan(inputs[mode]())).resolves.toBeDefined();

        expect(launchVersion(mode)).toBeUndefined();
        expect(mockLogger.warn).toHaveBeenCalledTimes(1);
        expect(mockLogger.warn).toHaveBeenCalledWith(
          expect.objectContaining({ providerName: 'other', mode, error }),
          'CLI version probe failed; launching without a CLI version',
        );
      });

      it('plans without a version when no probe is available', async () => {
        await expect(service.createPlan(inputs.new())).resolves.toBeDefined();

        expect(launchVersion('new')).toBeUndefined();
        expect(mockLogger.warn).toHaveBeenCalledTimes(1);
      });
    });

    // A real shell wrapper as the CLI: its background `sleep` keeps stdout open after the timeout.
    describe('a version probe that times out while a descendant holds stdout', () => {
      const PROBE_TIMEOUT_MS = 200;
      /** The probe timeout, the executor's 2 s kill grace, and room for a slow machine. */
      const BOUND_MS = PROBE_TIMEOUT_MS + 2000 + 1500;
      let bin: string;
      let probedService: ProviderRuntimePreparationService;

      beforeEach(async () => {
        bin = join(tempRoot, 'held-pipe-cli');
        writeFileSync(bin, '#!/bin/sh\nsleep 30 &\necho $! > "$0.pid"\nwait\n', { mode: 0o755 });
        const executor = new ChildProcessExecutor();
        const shortTimeout = {
          run: (options: ProcessExecutorOptions) =>
            executor.run({ ...options, timeout: PROBE_TIMEOUT_MS }),
        } as ProcessExecutor;
        probedService = (
          await compileModule([
            {
              provide: ProviderCliVersionProbe,
              useValue: new ProviderCliVersionProbe(shortTimeout),
            },
          ])
        ).get(ProviderRuntimePreparationService);
        mockLogger.warn.mockClear();
      });

      afterEach(() => {
        let pidText: string;
        try {
          pidText = readFileSync(`${bin}.pid`, 'utf8');
        } catch {
          return; // The wrapper did not start.
        }
        // An empty or partial PID file must never become `process.kill(0)`.
        killFixturePid(pidText);
      });

      it('plans an optional-probe launch without a version within the bound', async () => {
        const adapter = { ...makeAdapter(), optionalCliVersion: true as const };
        const started = Date.now();

        await probedService.createPlan(makeNewInput(adapter, { providerBinPath: bin }));

        expect(Date.now() - started).toBeLessThan(BOUND_MS);
        expect(adapter.buildLaunchArgs.mock.calls[0][0].cliVersion).toBeUndefined();
        expect(mockLogger.warn).toHaveBeenCalledTimes(1);
        expect(mockLogger.warn.mock.calls[0][0]).toMatchObject({
          error: { details: { reason: 'version_probe_timeout' } },
        });
      });

      it('fails an OpenCode launch closed with the timeout error within the bound', async () => {
        const started = Date.now();

        await expect(
          probedService.createPlan(
            makeRestoreInput(new OpencodeAdapter(), {
              provider: { ...provider, name: 'OpenCode', binPath: bin },
              providerBinPath: bin,
              providerSessionId: 'ses_abc',
            }),
          ),
        ).rejects.toMatchObject({ details: { reason: 'version_probe_timeout' } });
        expect(Date.now() - started).toBeLessThan(BOUND_MS);
      });
    });
  });

  describe('materialize', () => {
    describe('Vault', () => {
      const vaultDir = () => join(launchRoot, 'session-files', 'session-1', 'vault');

      it.each(['new', 'restore'] as const)(
        'writes a %s launch script with no Vault entry, and keeps files the resolve route wrote',
        async (mode) => {
          // A running `devchain vault exec` may be reading a file the resolve route wrote.
          mkdirSync(vaultDir(), { recursive: true });
          writeFileSync(join(vaultDir(), 'KEY_FILE'), 'in-use');
          const adapter = makeAdapter();

          const prepared = await service.materialize(
            await service.createPlan(
              mode === 'new' ? makeNewInput(adapter) : makeRestoreInput(adapter),
            ),
          );

          const script = readFileSync(prepared.typedArgs[1], 'utf8');
          expect(script).not.toMatch(/vault|KEY_FILE/i);
          expect(
            Object.keys(prepared.config.env ?? {}).filter((key) => /vault/i.test(key)),
          ).toEqual([]);
          await prepared.rollback();
          expect(readFileSync(join(vaultDir(), 'KEY_FILE'), 'utf8')).toBe('in-use');
        },
      );
    });

    it('preserves the base command when preparation is inactive and clears new capture on rollback', async () => {
      const adapter = makeAdapter();
      const plan = await service.createPlan(
        makeNewInput(adapter, { profileOptions: '--model raw-model' }),
      );

      const prepared = await service.materialize(plan);

      expect(adapter.buildLaunchArgs).toHaveBeenCalledTimes(1);
      expect(prepared.config.argv).toEqual(['--model', 'raw-model']);
      expect(claude.prepare).not.toHaveBeenCalled();
      expect(codex.prepare).not.toHaveBeenCalled();
      await expect(prepared.afterCommand()).resolves.toBeUndefined();
      expect(codex.awaitAcknowledgement).not.toHaveBeenCalled();

      await prepared.rollback();
      expect(claude.cleanupPrepared).not.toHaveBeenCalled();
      expect(capture.clear).toHaveBeenCalledWith('session-1');
      expect(capture.restoreSnapshot).not.toHaveBeenCalled();
    });

    it('types a short launch line for 10 KB of env and argv and keeps the real command in a private script', async () => {
      const bigValue = 'v'.repeat(10_240);
      const plan = await service.createPlan(
        makeNewInput(makeAdapter(), {
          profileOptions: `--note ${'a'.repeat(10_240)}`,
          configEnv: { BIG_ENV: bigValue },
        }),
      );

      const prepared = await service.materialize(plan);

      expect(prepared.config.commandArgs).toEqual(
        expect.arrayContaining([`BIG_ENV=${bigValue}`, '/usr/bin/other', 'a'.repeat(10_240)]),
      );
      const [shell, script] = prepared.typedArgs;
      expect(shell).toBe('/bin/sh');
      expect(dirname(script)).toBe(join(launchRoot, 'launch'));
      // 255 bytes is the POSIX minimum MAX_CANON, so the line fits every tty line buffer.
      const typedLine = prepared.typedArgs.map(quoteShellArg).join(' ');
      expect(Buffer.byteLength(typedLine, 'utf8')).toBeLessThanOrEqual(255);
      expect(readFileSync(script, 'utf8')).toBe(
        [
          '#!/bin/sh',
          '/bin/rm -f -- "$0"',
          `exec ${prepared.config.commandArgs.map(quoteShellArg).join(' ')}`,
          '',
        ].join('\n'),
      );
      expect(statSync(script).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(script)).mode & 0o777).toBe(0o700);
      expect(statSync(launchRoot).mode & 0o777).toBe(0o700);
    });

    it('removes the launch script on rollback, also when the script already deleted itself', async () => {
      const first = await service.materialize(
        await service.createPlan(makeNewInput(makeAdapter())),
      );
      expect(existsSync(first.typedArgs[1])).toBe(true);
      await first.rollback();
      expect(existsSync(first.typedArgs[1])).toBe(false);

      const second = await service.materialize(
        await service.createPlan(makeNewInput(makeAdapter())),
      );
      rmSync(second.typedArgs[1]);
      await expect(second.rollback()).resolves.toBeUndefined();
      expect(capture.clear).toHaveBeenCalledTimes(2);
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

      expect(capture.rotateEpoch.mock.invocationCallOrder[0]).toBeLessThan(
        claude.prepare.mock.invocationCallOrder[0],
      );
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
        DEVCHAIN_SESSION_ID: 'session-1',
        DEVCHAIN_PROJECT_ID: 'project-1',
        DEVCHAIN_AGENT_ID: 'agent-1',
        DEVCHAIN_API_URL: expect.stringMatching(/^http:\/\//),
      });
      expect(Object.isFrozen(prepared.config)).toBe(true);
      expect(Object.isFrozen(prepared.config.argv)).toBe(true);
      expect(claude.prepare).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: expect.objectContaining({ name: 'claude', claudeLaunchSettingsJson: '{}' }),
          profileOptionArgs: ['--model', 'opus', '--verbose'],
          pluginPolicy: [],
        }),
      );
    });

    it('wraps active Codex commands and binds acknowledgement to the prepared attempt', async () => {
      const adapter = makeAdapter('codex');
      const preparedCodex = makePreparedCodex();
      policy.resolveAll.mockResolvedValue([{ pluginId: 'plugin-a', enabled: true }]);
      codex.prepareProfile.mockResolvedValue(preparedCodex);
      codex.buildHelperArgv.mockImplementation((profile, binary, argv) => [
        profile.helperPath,
        '--nonce',
        profile.attemptNonce,
        '--',
        binary,
        ...argv,
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
      expect(claude.prepare).not.toHaveBeenCalled();

      const laterProfile = makePreparedCodex({
        sessionId: 'session-2',
        attemptNonce: 'nonce-abcdefghijklmnop',
      });
      codex.prepareProfile.mockResolvedValue(laterProfile);
      const later = await service.materialize(
        await service.createPlan(
          makeNewInput(adapter, {
            provider: { ...provider, name: 'codex', binPath: '/usr/bin/codex' },
            providerBinPath: '/usr/bin/codex',
            sessionId: 'session-2',
          }),
        ),
      );

      await prepared.afterCommand();
      expect(codex.awaitAcknowledgement).toHaveBeenCalledWith(preparedCodex, {
        projectId: 'project-1',
        attemptNonce: preparedCodex.attemptNonce,
      });
      await later.afterCommand();
      expect(codex.awaitAcknowledgement).toHaveBeenNthCalledWith(2, laterProfile, {
        projectId: 'project-1',
        attemptNonce: laterProfile.attemptNonce,
      });
      await prepared.rollback();
      expect(codex.cleanupProfile).toHaveBeenNthCalledWith(1, preparedCodex);
      await later.rollback();
      expect(codex.cleanupProfile).toHaveBeenNthCalledWith(2, laterProfile);
    });

    // A stub executable observes the final command's environment without starting Claude.
    it.each(['new', 'restore', 'fork'] as const)(
      'controls the Claude hook source despite conflicting configuration and inheritance (%s)',
      async (mode) => {
        const providerBinPath = join(tempRoot, 'claude');
        writeFileSync(
          providerBinPath,
          '#!/bin/sh\nprintf "%s\\n" "${DEVCHAIN_SESSION_START_SOURCE-unset}" "$SHARED"\n',
          { mode: 0o700 },
        );
        const adapter = new ClaudeAdapter();
        const savePoint = { providerSessionId: 'saved', transcriptPath: '/test/saved.jsonl' };
        jest.spyOn(adapter, 'prepareForkLaunch').mockResolvedValue({
          providerSessionId: 'session-1',
          transcriptPath: '/test/child.jsonl',
          argv: ['--resume', 'session-1'],
        });
        storage.getProviderEnvForProject.mockReturnValue({
          DEVCHAIN_SESSION_START_SOURCE: 'provider-override',
          SHARED: 'provider',
        });
        const input = makeNewInput(adapter, {
          provider: { ...provider, name: 'claude', binPath: providerBinPath },
          providerBinPath,
          configEnv: { DEVCHAIN_SESSION_START_SOURCE: 'profile-override', SHARED: 'profile' },
        });
        claude.prepare.mockResolvedValue({
          optionArgs: ['--settings', '/test/settings.json'],
          runtimeEnv: {},
        });

        const plan = await service.createPlan(
          mode === 'fork'
            ? { ...input, mode, initialPrompt: undefined, adapter, savePoint, helperEnv: {} }
            : mode === 'restore'
              ? { ...input, mode, initialPrompt: undefined, providerSessionId: 'original' }
              : input,
        );
        const prepared = await service.materialize(plan);

        expect(prepared.config.env?.DEVCHAIN_SESSION_START_SOURCE).toBe(
          mode === 'fork' ? 'fork' : undefined,
        );
        if (mode === 'fork') {
          expect(prepared.config.commandArgs).toContain('DEVCHAIN_SESSION_START_SOURCE=fork');
        } else {
          const markerIndex = prepared.config.commandArgs.indexOf('DEVCHAIN_SESSION_START_SOURCE');
          expect(prepared.config.commandArgs[markerIndex - 1]).toBe('-u');
        }
        const [command, ...args] = prepared.config.commandArgs;
        const output = execFileSync(command, args, {
          encoding: 'utf8',
          env: { ...process.env, DEVCHAIN_SESSION_START_SOURCE: 'fork' },
        });
        expect(output).toBe(`${mode === 'fork' ? 'fork' : 'unset'}\nprofile\n`);
      },
    );

    it('applies managed Codex options without losing the prepared fork environment', async () => {
      const binding = {
        providerSessionId: 'forked-thread',
        transcriptPath: '/rollouts/child.jsonl',
      };
      const savePoint = {
        providerSessionId: 'saved-thread',
        transcriptPath: '/rollouts/saved.jsonl',
      };
      const adapter = {
        ...makeAdapter('codex'),
        createSavePoint: jest.fn(),
        prepareForkLaunch: jest.fn(
          async ({ profileOptionArgs, env }: PrepareSessionForkLaunchInput) => ({
            ...binding,
            argv: ['resume', ...profileOptionArgs, binding.providerSessionId],
            env: { ...env, FORK_ADAPTER_VALUE: 'child' },
          }),
        ),
      };
      const input = makeNewInput(adapter, {
        provider: { ...provider, name: 'codex', binPath: '/usr/bin/codex' },
        providerBinPath: '/usr/bin/codex',
        profileOptions: '--model o3',
        configModel: 'o4',
        configEnv: { CODEX_HOME: '/workspace/codex-home' },
      });
      codex.prepareProfile.mockResolvedValue(makePreparedCodex());

      const plan = await service.createPlan({
        ...input,
        mode: 'fork',
        adapter,
        savePoint,
        helperEnv: { CODEX_HOME: '/workspace/codex-home' },
        initialPrompt: undefined,
      });
      const prepared = await service.materialize(plan);

      expect(plan.fork).toEqual(binding);
      expect(adapter.prepareForkLaunch).toHaveBeenCalledTimes(1);
      expect(adapter.prepareForkLaunch).toHaveBeenCalledWith(
        expect.objectContaining({
          ...savePoint,
          sessionId: input.sessionId,
          profileOptionArgs: ['--model', 'o4'],
          env: expect.objectContaining({ CODEX_HOME: '/workspace/codex-home' }),
        }),
      );
      expect(prepared.config.argv).toEqual([
        '--profile',
        'devchain-profile',
        'resume',
        '--model',
        'o4',
        binding.providerSessionId,
      ]);
      expect(prepared.config.env?.DEVCHAIN_SESSION_ID).toBe(input.sessionId);
      expect(prepared.config.env?.FORK_ADAPTER_VALUE).toBe('child');
      await prepared.rollback();
    });

    // Unit layer: the plan owns this wrapper, and a fake adapter can throw and reject on demand.
    it.each([
      ['commitBoundTranscript', 'rejects', 'Failed to commit bound fork transcript'],
      ['commitBoundTranscript', 'throws', 'Failed to commit bound fork transcript'],
      ['discardUnboundTranscript', 'rejects', 'Failed to discard unbound fork transcript'],
      ['discardUnboundTranscript', 'throws', 'Failed to discard unbound fork transcript'],
    ] as const)('logs and resolves when the adapter %s %s', async (callback, failure, message) => {
      mockLogger.warn.mockClear();
      const error = new Error('disk failure');
      const adapterCallback =
        failure === 'rejects'
          ? jest.fn().mockRejectedValue(error)
          : jest.fn(() => {
              throw error;
            });
      const adapter = {
        ...makeAdapter('codex'),
        createSavePoint: jest.fn(),
        prepareForkLaunch: jest.fn(async () => ({
          providerSessionId: 'forked-thread',
          transcriptPath: '/rollouts/child.jsonl',
          argv: ['resume', 'forked-thread'],
          [callback]: adapterCallback,
        })),
      };
      const input = makeNewInput(adapter, {
        provider: { ...provider, name: 'codex', binPath: '/usr/bin/codex' },
        providerBinPath: '/usr/bin/codex',
      });

      const plan = await service.createPlan({
        ...input,
        mode: 'fork',
        adapter,
        savePoint: { providerSessionId: 'saved-thread', transcriptPath: '/rollouts/saved.jsonl' },
        helperEnv: {},
        initialPrompt: undefined,
      });

      await expect(plan[callback]?.()).resolves.toBeUndefined();
      expect(adapterCallback).toHaveBeenCalledTimes(1);
      expect(mockLogger.warn).toHaveBeenCalledWith({ sessionId: input.sessionId, error }, message);
    });

    // Unit coverage observes composed owner callbacks and errors without launching provider processes.
    it('composes owner acknowledgements in order and propagates rejection before explicit rollback', async () => {
      claude.providerName = 'codex';
      const order: string[] = [];
      const acknowledgementError = new Error('foreign acknowledgement');
      claude.prepare.mockResolvedValue({
        optionArgs: [],
        runtimeEnv: {},
        afterCommand: async () => {
          order.push('first');
        },
      });
      codex.prepare.mockResolvedValue({
        optionArgs: [],
        runtimeEnv: {},
        afterCommand: async () => {
          order.push('second');
          throw acknowledgementError;
        },
      });
      const prepared = await service.materialize(
        await service.createPlan(
          makeNewInput(makeAdapter('codex'), { provider: { ...provider, name: 'codex' } }),
        ),
      );

      await expect(prepared.afterCommand()).rejects.toBe(acknowledgementError);

      expect(order).toEqual(['first', 'second']);
      expect(claude.cleanupPrepared).not.toHaveBeenCalled();
      expect(codex.cleanupPrepared).not.toHaveBeenCalled();
      expect(capture.clear).not.toHaveBeenCalled();
      await prepared.rollback();
      expect(capture.clear).toHaveBeenCalledWith('session-1');
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
      });
      const plan = await service.createPlan(
        makeRestoreInput(adapter, { provider: { ...provider, name: 'claude' } }),
      );

      await expect(service.materialize(plan)).rejects.toThrow(
        'Restore argv does not include provider session ID — adapter contract violation',
      );
      expect(claude.cleanupPrepared).toHaveBeenCalledWith(
        await claude.prepare.mock.results[0].value,
        'session-1',
      );
      expect(capture.restoreSnapshot).toHaveBeenCalledWith('session-1', null);
    });

    // Unit coverage uses two owners for one provider to verify the reverse-order compensation contract.
    it('attempts prepared owners in reverse order, then capture, after individual failures', async () => {
      const order: string[] = [];
      claude.providerName = 'codex';
      const preparedCodex = makePreparedCodex();
      policy.resolveAll.mockResolvedValue([{ pluginId: 'plugin-a', enabled: true }]);
      codex.prepareProfile.mockResolvedValue(preparedCodex);
      codex.buildHelperArgv.mockReturnValue(['/private/helper', '--', '/usr/bin/codex']);
      const cleanupError = new Error('codex cleanup failed');
      codex.cleanupPrepared.mockImplementation(async () => {
        order.push('codex');
        throw cleanupError;
      });
      claude.cleanupPrepared.mockImplementation(async () => {
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

    // Unit coverage injects a later owner failure without filesystem or process setup.
    it('compensates prepared owners and capture after a later materialization failure and rethrows the original', async () => {
      const materializationError = new Error('codex preparation failed');
      const order: string[] = [];
      claude.providerName = 'codex';
      codex.prepareProfile.mockImplementation(async () => {
        order.push('codex-prepare');
        throw materializationError;
      });
      claude.cleanupPrepared.mockImplementation(async () => {
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
