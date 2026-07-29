import type { StorageService } from '../../../storage/interfaces/storage.interface';
import { ImportContext } from '../import-context';
import type { CodecApplyRuntime } from '../template-section-codec';
import {
  buildProviderSettings,
  providerSettingsCodec,
  type ProviderExportRow,
} from './provider-settings.codec';

interface MockProvider {
  id: string;
  name: string;
  autoCompactThreshold: number | null;
  env?: Record<string, string> | null;
}

function makeRuntime(providers: MockProvider[]): {
  storage: { listProviders: jest.Mock; updateProvider: jest.Mock };
  rt: CodecApplyRuntime;
} {
  const storage = {
    listProviders: jest.fn().mockResolvedValue({ items: providers }),
    updateProvider: jest.fn().mockResolvedValue(undefined),
  };
  return {
    storage,
    rt: {
      projectId: 'project-1',
      storage: storage as unknown as StorageService,
    },
  };
}

const section = (
  settings: Array<Record<string, unknown>>,
): Parameters<typeof providerSettingsCodec.apply>[0] =>
  settings as Parameters<typeof providerSettingsCodec.apply>[0];

const ctx = () => new ImportContext();

describe('providerSettings codec — threshold import', () => {
  const baseProvider: MockProvider = {
    id: 'provider-1',
    name: 'claude',
    autoCompactThreshold: null,
    env: null,
  };

  it('imports the ordinary threshold when the local default is absent', async () => {
    const { storage, rt } = makeRuntime([baseProvider]);

    await providerSettingsCodec.apply(
      section([{ name: 'claude', autoCompactThreshold: 95 }]),
      ctx(),
      'replace',
      rt,
    );

    expect(storage.updateProvider).toHaveBeenCalledWith('provider-1', {
      autoCompactThreshold: 95,
    });
  });

  it('preserves an existing local ordinary threshold', async () => {
    const { storage, rt } = makeRuntime([{ ...baseProvider, autoCompactThreshold: 80 }]);

    await providerSettingsCodec.apply(
      section([{ name: 'claude', autoCompactThreshold: 95 }]),
      ctx(),
      'replace',
      rt,
    );

    expect(storage.updateProvider).not.toHaveBeenCalled();
  });

  it('returns a zero update count for an unknown provider', async () => {
    const { storage, rt } = makeRuntime([baseProvider]);

    const result = await providerSettingsCodec.apply(
      section([{ name: 'missing', autoCompactThreshold: 95 }]),
      ctx(),
      'replace',
      rt,
    );

    expect(storage.updateProvider).not.toHaveBeenCalled();
    expect(result).toEqual({ section: 'providerSettings', log: { providersUpdated: 0 } });
  });
});

describe('providerSettings codec — env merge', () => {
  const baseProvider: MockProvider = {
    id: 'provider-1',
    name: 'claude',
    autoCompactThreshold: null,
    env: null,
  };

  it('merges with local-wins semantics', async () => {
    const { storage, rt } = makeRuntime([
      { ...baseProvider, env: { API_BASE: 'local-value', EXISTING: 'keep' } },
    ]);

    await providerSettingsCodec.apply(
      section([{ name: 'claude', env: { API_BASE: 'template-value', NEW_KEY: 'added' } }]),
      ctx(),
      'replace',
      rt,
    );

    expect(storage.updateProvider).toHaveBeenCalledWith('provider-1', {
      env: { API_BASE: 'local-value', EXISTING: 'keep', NEW_KEY: 'added' },
    });
  });

  it('drops only the exact retired Claude provider-level window before merge', async () => {
    const { storage, rt } = makeRuntime([baseProvider]);

    await providerSettingsCodec.apply(
      section([
        {
          name: 'claude',
          env: {
            CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000',
            CLAUDE_CODE_DISABLE_1M_CONTEXT: '1',
            KEEP: 'value',
          },
        },
      ]),
      ctx(),
      'replace',
      rt,
    );

    expect(storage.updateProvider).toHaveBeenCalledWith('provider-1', {
      env: { CLAUDE_CODE_DISABLE_1M_CONTEXT: '1', KEEP: 'value' },
    });
  });

  it.each(['999999', '1000001', '450000'])(
    'preserves a non-retired Claude window value %s',
    async (window) => {
      const { storage, rt } = makeRuntime([baseProvider]);

      await providerSettingsCodec.apply(
        section([{ name: 'claude', env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: window } }]),
        ctx(),
        'replace',
        rt,
      );

      expect(storage.updateProvider).toHaveBeenCalledWith('provider-1', {
        env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: window },
      });
    },
  );

  it('preserves the same window for non-Claude providers', async () => {
    const provider = { ...baseProvider, id: 'glm-provider', name: 'glm' };
    const { storage, rt } = makeRuntime([provider]);

    await providerSettingsCodec.apply(
      section([{ name: 'glm', env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000' } }]),
      ctx(),
      'replace',
      rt,
    );

    expect(storage.updateProvider).toHaveBeenCalledWith('glm-provider', {
      env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000' },
    });
  });

  it('is a no-op when the retired window is the only imported value', async () => {
    const { storage, rt } = makeRuntime([baseProvider]);

    await providerSettingsCodec.apply(
      section([{ name: 'claude', env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000' } }]),
      ctx(),
      'replace',
      rt,
    );

    expect(storage.updateProvider).not.toHaveBeenCalled();
  });
});

describe('buildProviderSettings', () => {
  it('emits only current provider-setting fields', () => {
    const provider: ProviderExportRow & { claudeLaunchSettingsJson: string } = {
      id: 'provider-1',
      name: 'claude',
      autoCompactThreshold: 95,
      claudeLaunchSettingsJson: '{"statusLine":{"type":"command"}}',
      env: { KEEP: 'value' },
    };

    const result = buildProviderSettings(
      new Map([[provider.id, provider]]),
      'project-1',
      new Map(),
      {
        filterEnvByScope: (env) => env,
        sanitizeEnvMap: (env) => env ?? null,
      },
    );

    expect(result).toEqual([{ name: 'claude', autoCompactThreshold: 95, env: { KEEP: 'value' } }]);
    expect(result[0]).not.toHaveProperty('claudeLaunchSettingsJson');
  });
});
