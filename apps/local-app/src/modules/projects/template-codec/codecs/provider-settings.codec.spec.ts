/**
 * ProviderSettings codec unit tests — locks the EXACT threshold/probe/env matrix
 * (docs/template-roundtrip-compatibility-matrix.md row 19 + Architect round-2 note) through
 * the codec `apply` path (replace-into-existing). The probe callback is mocked so both the
 * success and failure branches are exercised deterministically.
 */
import type { StorageService } from '../../../storage/interfaces/storage.interface';
import { ImportContext } from '../import-context';
import type { CodecApplyRuntime } from '../template-section-codec';
import { providerSettingsCodec } from './provider-settings.codec';

type ProbeOutcome = { supported: boolean; status?: string };

interface MockProvider {
  id: string;
  name: string;
  binPath: string | null;
  autoCompactThreshold: number | null;
  autoCompactThreshold1m?: number | null;
  oneMillionContextEnabled?: boolean;
  env?: Record<string, string> | null;
}

function makeRuntime(
  providers: MockProvider[],
  probe1m?: (binPath: string) => Promise<ProbeOutcome>,
): { storage: { listProviders: jest.Mock; updateProvider: jest.Mock }; rt: CodecApplyRuntime } {
  const storage = {
    listProviders: jest.fn().mockResolvedValue({ items: providers }),
    updateProvider: jest.fn().mockResolvedValue(undefined),
  };
  const rt = {
    projectId: 'project-1',
    storage: storage as unknown as StorageService,
    ...(probe1m ? { probe1m } : {}),
  } as CodecApplyRuntime;
  return { storage, rt };
}

// Cast helper: build a providerSettings section without running full ExportSchema.parse.
const section = (
  settings: Array<Record<string, unknown>>,
): Parameters<typeof providerSettingsCodec.apply>[0] =>
  settings as unknown as Parameters<typeof providerSettingsCodec.apply>[0];

const ctx = () => new ImportContext();

describe('providerSettings codec — env merge', () => {
  const baseProvider: MockProvider = {
    id: 'provider-1',
    name: 'claude',
    binPath: '/usr/local/bin/claude',
    autoCompactThreshold: null,
    env: null,
  };

  it('applies template env when local provider has no env', async () => {
    const { storage, rt } = makeRuntime([baseProvider]);
    await providerSettingsCodec.apply(
      section([{ name: 'claude', env: { API_BASE: 'https://custom.api', LOG_LEVEL: 'debug' } }]),
      ctx(),
      'replace',
      rt,
    );
    expect(storage.updateProvider).toHaveBeenCalledWith(
      'provider-1',
      expect.objectContaining({ env: { API_BASE: 'https://custom.api', LOG_LEVEL: 'debug' } }),
    );
  });

  it('merges with local-wins semantics (local keys not overwritten)', async () => {
    const { storage, rt } = makeRuntime([
      { ...baseProvider, env: { API_BASE: 'local-value', EXISTING: 'keep' } },
    ]);
    await providerSettingsCodec.apply(
      section([{ name: 'claude', env: { API_BASE: 'template-value', NEW_KEY: 'added' } }]),
      ctx(),
      'replace',
      rt,
    );
    expect(storage.updateProvider).toHaveBeenCalledWith(
      'provider-1',
      expect.objectContaining({
        env: { API_BASE: 'local-value', EXISTING: 'keep', NEW_KEY: 'added' },
      }),
    );
  });

  it('skips update when all template keys already exist locally', async () => {
    const { storage, rt } = makeRuntime([{ ...baseProvider, env: { KEY_A: 'local' } }]);
    await providerSettingsCodec.apply(
      section([{ name: 'claude', env: { KEY_A: 'template' } }]),
      ctx(),
      'replace',
      rt,
    );
    expect(storage.updateProvider).not.toHaveBeenCalled();
  });

  it('preserves *** entries (redacted secrets kept so the user sees what to fill)', async () => {
    const { storage, rt } = makeRuntime([baseProvider]);
    await providerSettingsCodec.apply(
      section([{ name: 'claude', env: { API_KEY: '***', VISIBLE: 'value' } }]),
      ctx(),
      'replace',
      rt,
    );
    expect(storage.updateProvider).toHaveBeenCalledWith(
      'provider-1',
      expect.objectContaining({ env: { API_KEY: '***', VISIBLE: 'value' } }),
    );
  });

  it('does not update when template has no env field', async () => {
    const { storage, rt } = makeRuntime([baseProvider]);
    await providerSettingsCodec.apply(section([{ name: 'claude' }]), ctx(), 'replace', rt);
    expect(storage.updateProvider).not.toHaveBeenCalled();
  });
});

describe('providerSettings codec — autoCompactThreshold1m matrix', () => {
  const baseProvider: MockProvider = {
    id: 'provider-1',
    name: 'claude',
    binPath: '/usr/local/bin/claude',
    autoCompactThreshold: null,
  };

  it('legacy template: promotes old threshold to 1M value + standard 95 on probe success', async () => {
    const probe1m = jest.fn().mockResolvedValue({ supported: true, status: 'supported' });
    const { storage, rt } = makeRuntime([baseProvider], probe1m);
    await providerSettingsCodec.apply(
      section([{ name: 'claude', autoCompactThreshold: 50, oneMillionContextEnabled: true }]),
      ctx(),
      'replace',
      rt,
    );
    expect(storage.updateProvider).toHaveBeenCalledWith(
      'provider-1',
      expect.objectContaining({
        autoCompactThreshold1m: 50,
        autoCompactThreshold: 95,
        oneMillionContextEnabled: true,
      }),
    );
  });

  it('new template: uses both threshold fields as-is on probe success', async () => {
    const probe1m = jest.fn().mockResolvedValue({ supported: true, status: 'supported' });
    const { storage, rt } = makeRuntime([baseProvider], probe1m);
    await providerSettingsCodec.apply(
      section([
        {
          name: 'claude',
          autoCompactThreshold: 95,
          autoCompactThreshold1m: 40,
          oneMillionContextEnabled: true,
        },
      ]),
      ctx(),
      'replace',
      rt,
    );
    expect(storage.updateProvider).toHaveBeenCalledWith(
      'provider-1',
      expect.objectContaining({
        autoCompactThreshold1m: 40,
        autoCompactThreshold: 95,
        oneMillionContextEnabled: true,
      }),
    );
  });

  it('probe failure: clears 1M fields and forces standard threshold to 95', async () => {
    const probe1m = jest.fn().mockResolvedValue({ supported: false, status: 'unsupported' });
    const { storage, rt } = makeRuntime([baseProvider], probe1m);
    await providerSettingsCodec.apply(
      section([
        {
          name: 'claude',
          autoCompactThreshold: 50,
          autoCompactThreshold1m: 50,
          oneMillionContextEnabled: true,
        },
      ]),
      ctx(),
      'replace',
      rt,
    );
    expect(storage.updateProvider).toHaveBeenCalledWith(
      'provider-1',
      expect.objectContaining({
        autoCompactThreshold1m: null,
        autoCompactThreshold: 95,
        oneMillionContextEnabled: false,
      }),
    );
  });

  it('no binPath: disables 1M, forces standard threshold 95, does NOT probe', async () => {
    const probe1m = jest.fn();
    const { storage, rt } = makeRuntime([{ ...baseProvider, binPath: null }], probe1m);
    await providerSettingsCodec.apply(
      section([{ name: 'claude', autoCompactThreshold1m: 50, oneMillionContextEnabled: true }]),
      ctx(),
      'replace',
      rt,
    );
    expect(storage.updateProvider).toHaveBeenCalledWith(
      'provider-1',
      expect.objectContaining({
        autoCompactThreshold1m: null,
        autoCompactThreshold: 95,
        oneMillionContextEnabled: false,
      }),
    );
    expect(probe1m).not.toHaveBeenCalled();
  });

  it('probe success: preserves existing local standard threshold (not overwritten)', async () => {
    const probe1m = jest.fn().mockResolvedValue({ supported: true });
    const { storage, rt } = makeRuntime([{ ...baseProvider, autoCompactThreshold: 80 }], probe1m);
    await providerSettingsCodec.apply(
      section([
        {
          name: 'claude',
          autoCompactThreshold: 95,
          autoCompactThreshold1m: 50,
          oneMillionContextEnabled: true,
        },
      ]),
      ctx(),
      'replace',
      rt,
    );
    const updateCall = storage.updateProvider.mock.calls[0][1];
    expect(updateCall.autoCompactThreshold1m).toBe(50);
    expect(updateCall.autoCompactThreshold).toBeUndefined();
  });

  it('autoCompactThreshold imports only when local is null (local threshold preserved)', async () => {
    const { storage, rt } = makeRuntime([{ ...baseProvider, autoCompactThreshold: 80 }]);
    await providerSettingsCodec.apply(
      section([{ name: 'claude', autoCompactThreshold: 50, autoCompactThreshold1m: 60 }]),
      ctx(),
      'replace',
      rt,
    );
    const updateCall = storage.updateProvider.mock.calls[0][1];
    // 1m is imported; the standard threshold is NOT overwritten (local 80 wins).
    expect(updateCall.autoCompactThreshold1m).toBe(60);
    expect(updateCall.autoCompactThreshold).toBeUndefined();
  });

  it('autoCompactThreshold1m may overwrite when template carries it', async () => {
    const { storage, rt } = makeRuntime([{ ...baseProvider, autoCompactThreshold1m: 30 }]);
    await providerSettingsCodec.apply(
      section([{ name: 'claude', autoCompactThreshold1m: 60 }]),
      ctx(),
      'replace',
      rt,
    );
    expect(storage.updateProvider).toHaveBeenCalledWith(
      'provider-1',
      expect.objectContaining({ autoCompactThreshold1m: 60 }),
    );
  });

  it('returns a providersUpdated count and is a no-op for unknown providers', async () => {
    const { storage, rt } = makeRuntime([baseProvider]);
    const result = await providerSettingsCodec.apply(
      section([{ name: 'nonexistent', autoCompactThreshold: 50 }]),
      ctx(),
      'replace',
      rt,
    );
    expect(storage.updateProvider).not.toHaveBeenCalled();
    expect(result).toMatchObject({ section: 'providerSettings', log: { providersUpdated: 0 } });
  });

  it('empty/absent section short-circuits with no storage calls', async () => {
    const { storage, rt } = makeRuntime([baseProvider]);
    const result = await providerSettingsCodec.apply(section([]), ctx(), 'replace', rt);
    expect(storage.listProviders).not.toHaveBeenCalled();
    expect(result.section).toBe('providerSettings');
  });
});
