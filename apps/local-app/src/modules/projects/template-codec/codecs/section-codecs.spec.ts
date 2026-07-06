import { ImportContext } from '../import-context';
import { projectSettingsCodec } from './project-settings.codec';
import { presetsCodec } from './presets.codec';
import { watchersCodec } from './watchers.codec';
import { subscribersCodec } from './subscribers.codec';
import type { CodecApplyRuntime } from '../template-section-codec';

jest.mock('../../../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

type AnyRec = Record<string, unknown>;

function makeRt(overrides: Partial<CodecApplyRuntime> = {}): CodecApplyRuntime {
  return {
    projectId: 'proj-1',
    storage: { createSubscriber: jest.fn().mockResolvedValue({ id: 'sub-1' }) } as AnyRec,
    settings: {
      updateSettings: jest.fn().mockResolvedValue(undefined),
      getSettings: jest.fn().mockReturnValue({}),
      setProjectPoolSettings: jest.fn().mockResolvedValue(undefined),
      setProjectPresets: jest.fn().mockResolvedValue(undefined),
      clearProjectPresets: jest.fn().mockResolvedValue(undefined),
    } as AnyRec,
    ...overrides,
  } as CodecApplyRuntime;
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
      prompts: [{ id: 'old-1', title: 'Greeting' }],
    };

    const result = await projectSettingsCodec.apply(section, ctx, 'replace', rt);

    const settings = rt.settings as AnyRec;
    expect(settings.updateSettings).toHaveBeenCalledWith({
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
      prompts: [{ id: 'old-1', title: 'Greeting' }],
    };

    const result = await projectSettingsCodec.apply(section, ctx, 'replace', rt);

    const settings = rt.settings as AnyRec;
    expect(settings.updateSettings).toHaveBeenCalledWith({
      projectId: 'proj-1',
      initialSessionPromptId: 'new-1',
    });
    expect(result.log).toMatchObject({ initialPromptSet: true });
  });

  it('missing prompt: title does not match any created prompt -> initialPromptSet false, no initialSessionPromptId write', async () => {
    const rt = makeRt();
    const ctx = seedCtxForSettings({ createdPrompts: [{ id: 'new-1', title: 'Other' }] });
    const section = {
      projectSettings: undefined,
      initialPrompt: { title: 'Nonexistent' },
      prompts: [{ id: 'old-1', title: 'Nonexistent' }],
    };

    const result = await projectSettingsCodec.apply(section, ctx, 'replace', rt);

    const settings = rt.settings as AnyRec;
    expect(settings.updateSettings).not.toHaveBeenCalledWith(
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

    const settings = rt.settings as AnyRec;
    expect(settings.setProjectPresets).toHaveBeenCalledWith('proj-1', presets);
    expect(settings.clearProjectPresets).not.toHaveBeenCalled();
    expect(result.log).toMatchObject({ action: 'set' });
  });

  it('clears stored presets when the template has none (logged)', async () => {
    const rt = makeRt();
    const result = await presetsCodec.apply([], new ImportContext(), 'replace', rt);

    const settings = rt.settings as AnyRec;
    expect(settings.clearProjectPresets).toHaveBeenCalledWith('proj-1');
    expect(settings.setProjectPresets).not.toHaveBeenCalled();
    expect(result.log).toMatchObject({ action: 'cleared' });
  });
});

describe('watchers codec — profile-scope remap survives', () => {
  it('resolves a profile-scope watcher whose target was family-substituted via profileNameRemapMap', async () => {
    const createWatcher = jest.fn().mockResolvedValue({ id: 'w-1' });
    const rt = makeRt({
      watchersService: { createWatcher } as AnyRec,
      available: new Map([['claude', 'prov-1']]),
    });
    // profileNameToId holds the SELECTED (post-substitution) profile; the watcher references
    // the pre-substitution name, which the remap map points at the selected name.
    const profileNameToId = new Map([['coder claude', 'prof-claude']]);
    const profileNameRemapMap = new Map([['coder codex', 'coder claude']]);
    const ctx = new ImportContext({
      agentNameToId: { 'agent-a': 'agent-1' },
      profileNameToId,
      selectedProfilesByFamily: { profileNameRemapMap } as AnyRec,
    });

    const watchers = [
      {
        name: 'w1',
        enabled: true,
        scope: 'profile',
        scopeFilterName: 'Coder Codex',
        pollIntervalMs: 1000,
        viewportLines: 100,
        condition: { type: 'contains' as const, pattern: 'x' },
        cooldownMs: 0,
        cooldownMode: 'time' as const,
        eventName: 'ev',
      },
    ];

    await watchersCodec.apply(watchers as AnyRec, ctx, 'replace', rt);

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
      selectedProfilesByFamily: { profileNameRemapMap: new Map() } as AnyRec,
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
    const result = await subscribersCodec.apply(
      subscribers as AnyRec,
      new ImportContext(),
      'replace',
      rt,
    );

    const storage = rt.storage as AnyRec;
    expect(storage.createSubscriber).toHaveBeenCalledTimes(1);
    expect(result.log).toMatchObject({ subscribers: 1 });
  });
});
