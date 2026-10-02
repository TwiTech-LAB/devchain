import { ImportContext } from '../import-context';
import { projectSettingsCodec } from './project-settings.codec';
import { presetsCodec } from './presets.codec';
import { watchersCodec } from './watchers.codec';
import { subscribersCodec } from './subscribers.codec';
import type { CodecApplyRuntime } from '../template-section-codec';
import { PROMPT_TRANSFER_POLICY } from '../../../../common/prompt-transfer';
import type { StorageService } from '../../../storage/interfaces/storage.interface';
import type { SettingsService } from '../../../settings/services/settings.service';

jest.mock('../../../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

type SettingsMock = jest.Mocked<
  Pick<
    SettingsService,
    | 'updateSettings'
    | 'getSettings'
    | 'setProjectPoolSettings'
    | 'setProjectPresets'
    | 'clearProjectPresets'
  >
>;
type StorageMock = jest.Mocked<Pick<StorageService, 'createSubscriber'>>;

function makeRt(
  overrides: Partial<CodecApplyRuntime> = {},
): CodecApplyRuntime & { settings: SettingsMock; storage: StorageMock } {
  const settings: SettingsMock = {
    updateSettings: jest.fn().mockResolvedValue(undefined),
    getSettings: jest.fn().mockReturnValue({}),
    setProjectPoolSettings: jest.fn().mockResolvedValue(undefined),
    setProjectPresets: jest.fn().mockResolvedValue(undefined),
    clearProjectPresets: jest.fn().mockResolvedValue(undefined),
  };
  const storage: StorageMock = {
    createSubscriber: jest.fn().mockResolvedValue({ id: 'sub-1' }),
  };
  // storage/settings are deliberately partial stubs of the injected services.
  return {
    projectId: 'proj-1',
    storage,
    settings,
    ...overrides,
  } as unknown as CodecApplyRuntime & {
    settings: SettingsMock;
    storage: StorageMock;
  };
}

// Build an ImportContext seeded with the data products the projectSettings codec reads.
function seedCtxForSettings(opts: {
  createdPrompts: Array<{ id: string; title: string }>;
  promptIdMap?: Record<string, string>;
  templateLabelToStatusId?: Map<string, string>;
}): ImportContext {
  return new ImportContext({
    createdPrompts: opts.createdPrompts,
    promptIdMap: opts.promptIdMap ?? {},
    templateLabelToStatusId: opts.templateLabelToStatusId ?? new Map(),
  });
}

describe('projectSettings codec — initialPrompt resolution', () => {
  it('title match: sets initialSessionPromptId from the title-matched created prompt', async () => {
    const rt = makeRt();
    const ctx = seedCtxForSettings({ createdPrompts: [{ id: 'new-1', title: 'Greeting' }] });
    const section = {
      projectSettings: undefined,
      initialPrompt: { title: 'Greeting' },
      prompts: [{ id: 'old-1', title: 'Greeting', content: '', tags: [] }],
    };

    const result = await projectSettingsCodec.apply(section, ctx, 'replace', rt);

    expect(rt.settings.updateSettings).toHaveBeenCalledWith({
      projectId: 'proj-1',
      initialSessionPromptId: 'new-1',
    });
    expect(result.log).toMatchObject({ initialPromptSet: true });
  });

  it('promptId fallback: resolves promptId -> title -> created-prompt id', async () => {
    // initialPrompt has only a promptId (no title); merge resolves it to a title via the
    // template prompts, then the title is matched against createdPrompts.
    const rt = makeRt();
    const ctx = seedCtxForSettings({
      createdPrompts: [{ id: 'new-1', title: 'Greeting' }],
      promptIdMap: { 'old-1': 'new-1' },
    });
    const section = {
      projectSettings: undefined,
      initialPrompt: { promptId: 'old-1' },
      prompts: [{ id: 'old-1', title: 'Greeting', content: '', tags: [] }],
    };

    const result = await projectSettingsCodec.apply(section, ctx, 'replace', rt);

    expect(rt.settings.updateSettings).toHaveBeenCalledWith({
      projectId: 'proj-1',
      initialSessionPromptId: 'new-1',
    });
    expect(result.log).toMatchObject({ initialPromptSet: true });
  });

  it.each([
    ['old-system', 'new-system'],
    ['old-custom', 'new-custom'],
  ])(
    'snapshot maps the selected same-title prompt %s to its exact new id',
    async (selectedOldId, expectedNewId) => {
      const rt = makeRt({
        promptTransferPolicy: PROMPT_TRANSFER_POLICY.Snapshot,
      });
      const ctx = seedCtxForSettings({
        createdPrompts: [
          { id: 'new-system', title: 'Shared' },
          { id: 'new-custom', title: 'Shared' },
        ],
        promptIdMap: {
          'old-system': 'new-system',
          'old-custom': 'new-custom',
        },
      });
      const section = {
        projectSettings: undefined,
        initialPrompt: { promptId: selectedOldId, title: 'Shared' },
        prompts: [
          { id: 'old-system', title: 'Shared', content: '', tags: [] },
          { id: 'old-custom', title: 'Shared', content: '', tags: [] },
        ],
      };

      const result = await projectSettingsCodec.apply(section, ctx, 'replace', rt);

      expect(rt.settings.updateSettings).toHaveBeenCalledWith({
        projectId: 'proj-1',
        initialSessionPromptId: expectedNewId,
      });
      expect(result.log).toMatchObject({ initialPromptSet: true });
    },
  );

  it('snapshot falls back to legacy title resolution when the old id has no mapping', async () => {
    const rt = makeRt({
      promptTransferPolicy: PROMPT_TRANSFER_POLICY.Snapshot,
    });
    const ctx = seedCtxForSettings({
      createdPrompts: [
        { id: 'new-system', title: 'Shared' },
        { id: 'new-custom', title: 'Shared' },
      ],
    });
    const section = {
      projectSettings: undefined,
      initialPrompt: { promptId: 'missing-old-id', title: 'Shared' },
      prompts: [],
    };

    await projectSettingsCodec.apply(section, ctx, 'replace', rt);

    expect(rt.settings.updateSettings).toHaveBeenCalledWith({
      projectId: 'proj-1',
      initialSessionPromptId: 'new-custom',
    });
  });

  it('template policy maps the selected same-title prompt to its exact new id', async () => {
    const rt = makeRt({
      promptTransferPolicy: PROMPT_TRANSFER_POLICY.Template,
    });
    const ctx = seedCtxForSettings({
      createdPrompts: [
        { id: 'new-system', title: 'Shared' },
        { id: 'new-custom', title: 'Shared' },
      ],
      promptIdMap: {
        'old-system': 'new-system',
        'old-custom': 'new-custom',
      },
    });
    const section = {
      projectSettings: undefined,
      initialPrompt: { promptId: 'old-system', title: 'Shared' },
      prompts: [
        { id: 'old-system', title: 'Shared', content: '', tags: [] },
        { id: 'old-custom', title: 'Shared', content: '', tags: [] },
      ],
    };

    await projectSettingsCodec.apply(section, ctx, 'replace', rt);

    expect(rt.settings.updateSettings).toHaveBeenCalledWith({
      projectId: 'proj-1',
      initialSessionPromptId: 'new-system',
    });
  });

  it('template policy retains last-title-wins fallback when the old id has no mapping', async () => {
    const rt = makeRt({
      promptTransferPolicy: PROMPT_TRANSFER_POLICY.Template,
    });
    const ctx = seedCtxForSettings({
      createdPrompts: [
        { id: 'new-system', title: 'Shared' },
        { id: 'new-custom', title: 'Shared' },
      ],
    });
    const section = {
      projectSettings: undefined,
      initialPrompt: { promptId: 'missing-old-id', title: 'Shared' },
      prompts: [],
    };

    await projectSettingsCodec.apply(section, ctx, 'replace', rt);

    expect(rt.settings.updateSettings).toHaveBeenCalledWith({
      projectId: 'proj-1',
      initialSessionPromptId: 'new-custom',
    });
  });

  it('missing prompt: title does not match any created prompt -> initialPromptSet false, no initialSessionPromptId write', async () => {
    const rt = makeRt();
    const ctx = seedCtxForSettings({ createdPrompts: [{ id: 'new-1', title: 'Other' }] });
    const section = {
      projectSettings: undefined,
      initialPrompt: { title: 'Nonexistent' },
      prompts: [{ id: 'old-1', title: 'Nonexistent', content: '', tags: [] }],
    };

    const result = await projectSettingsCodec.apply(section, ctx, 'replace', rt);

    expect(rt.settings.updateSettings).not.toHaveBeenCalledWith(
      expect.objectContaining({ initialSessionPromptId: expect.anything() }),
    );
    expect(result.log).toMatchObject({ initialPromptSet: false });
  });

  it('replace-mode: applies and reports its section id', async () => {
    const rt = makeRt();
    const ctx = seedCtxForSettings({ createdPrompts: [] });
    const section = { projectSettings: undefined, initialPrompt: null, prompts: [] };

    const result = await projectSettingsCodec.apply(section, ctx, 'replace', rt);

    expect(result.section).toBe('projectSettings');
  });

  it('skips gracefully when no settings service is provided', async () => {
    const rt = makeRt({ settings: undefined });
    const ctx = seedCtxForSettings({ createdPrompts: [] });
    const result = await projectSettingsCodec.apply(
      { projectSettings: undefined, initialPrompt: null, prompts: [] },
      ctx,
      'replace',
      rt,
    );
    expect(result.log).toMatchObject({ skipped: 'no settings service' });
  });
});

describe('presets codec — set-or-clear semantics', () => {
  it('sets presets when the template provides them', async () => {
    const rt = makeRt();
    const presets = [{ name: 'P1', agentConfigs: [] }];
    const result = await presetsCodec.apply(presets, new ImportContext(), 'replace', rt);

    expect(rt.settings.setProjectPresets).toHaveBeenCalledWith('proj-1', presets);
    expect(rt.settings.clearProjectPresets).not.toHaveBeenCalled();
    expect(result.log).toMatchObject({ action: 'set' });
  });

  it('clears stored presets when the template has none (logged)', async () => {
    const rt = makeRt();
    const result = await presetsCodec.apply([], new ImportContext(), 'replace', rt);

    expect(rt.settings.clearProjectPresets).toHaveBeenCalledWith('proj-1');
    expect(rt.settings.setProjectPresets).not.toHaveBeenCalled();
    expect(result.log).toMatchObject({ action: 'cleared' });
  });
});

describe('watchers codec — profile-scope remap survives', () => {
  it('resolves a profile-scope watcher whose target was family-substituted via profileNameRemapMap', async () => {
    const createWatcher = jest.fn().mockResolvedValue({ id: 'w-1' });
    const rt = makeRt({
      watchersService: { createWatcher },
      installedProviders: new Map([['claude', 'prov-1']]),
    });
    // profileNameToId holds the SELECTED (post-substitution) profile; the watcher references
    // the pre-substitution name, which the remap map points at the selected name.
    const profileNameToId = new Map([['coder claude', 'prof-claude']]);
    const profileNameRemapMap = new Map([['coder codex', 'coder claude']]);
    const ctx = new ImportContext({
      agentNameToId: { 'agent-a': 'agent-1' },
      profileNameToId,
      selectedProfilesByFamily: {
        profilesToCreate: [],
        agentProfileMap: new Map(),
        profileNameRemapMap,
        providerSubstitutions: new Map(),
      },
    });

    const watchers = [
      {
        name: 'w1',
        enabled: true,
        scope: 'profile' as const,
        scopeFilterName: 'Coder Codex',
        pollIntervalMs: 1000,
        viewportLines: 100,
        idleAfterSeconds: 0,
        condition: { type: 'contains' as const, pattern: 'x' },
        cooldownMs: 0,
        cooldownMode: 'time' as const,
        eventName: 'ev',
      },
    ];

    await watchersCodec.apply(watchers, ctx, 'replace', rt);

    expect(createWatcher).toHaveBeenCalledTimes(1);
    expect(createWatcher).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'profile', scopeFilterId: 'prof-claude' }),
    );
  });

  it('skips when no watchers service is provided', async () => {
    const rt = makeRt({ watchersService: undefined });
    const ctx = new ImportContext({
      agentNameToId: {},
      profileNameToId: new Map(),
      selectedProfilesByFamily: {
        profilesToCreate: [],
        agentProfileMap: new Map(),
        profileNameRemapMap: new Map(),
        providerSubstitutions: new Map(),
      },
    });
    const result = await watchersCodec.apply([], ctx, 'replace', rt);
    expect(result.log).toMatchObject({ watchers: 0 });
  });
});

describe('subscribers codec', () => {
  it('creates each subscriber via storage', async () => {
    const rt = makeRt();
    const subscribers = [
      {
        name: 's1',
        enabled: true,
        eventName: 'ev',
        eventFilter: null,
        actionType: 'log',
        actionInputs: {},
        delayMs: 0,
        cooldownMs: 0,
        retryOnError: false,
        groupName: null,
        position: 0,
        priority: 0,
      },
    ];
    const result = await subscribersCodec.apply(subscribers, new ImportContext(), 'replace', rt);

    expect(rt.storage.createSubscriber).toHaveBeenCalledTimes(1);
    expect(result.log).toMatchObject({ subscribers: 1 });
  });
});
