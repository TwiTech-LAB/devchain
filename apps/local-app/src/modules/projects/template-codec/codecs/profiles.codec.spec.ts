import { ImportContext } from '../import-context';
import { profilesCodec } from './profiles.codec';
import type { CodecApplyRuntime } from '../template-section-codec';

jest.mock('../../../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

type AnyRec = Record<string, unknown>;

function makeRt(createProfileProviderConfig: jest.Mock): CodecApplyRuntime {
  return {
    projectId: 'proj-1',
    storage: {
      createAgentProfile: jest
        .fn()
        .mockImplementation((data: { name: string }) =>
          Promise.resolve({ id: `new-${data.name}` }),
        ),
      createProfileProviderConfig,
    } as AnyRec,
    installedProviders: new Map([['claude', 'prov-1']]),
  } as CodecApplyRuntime;
}

// The profiles codec reads `selectedProfilesByFamily.profilesToCreate` (NOT its picked section),
// so the fixture lives on the ImportContext.
function seedCtx(profilesToCreate: AnyRec[]): ImportContext {
  return new ImportContext({
    selectedProfilesByFamily: {
      profilesToCreate,
      agentProfileMap: new Map(),
      profileNameRemapMap: new Map(),
      providerSubstitutions: new Map(),
    } as AnyRec,
  });
}

describe('profiles codec — providerConfig position pass-through', () => {
  it('passes explicit (non-array-order / sparse) positions verbatim to storage', async () => {
    const createProfileProviderConfig = jest
      .fn()
      .mockImplementation((data: { name: string }) => Promise.resolve({ id: `cfg-${data.name}` }));
    const rt = makeRt(createProfileProviderConfig);

    const profilesToCreate = [
      {
        id: 'p1',
        name: 'P',
        provider: { name: 'claude' },
        providerConfigs: [
          { name: 'a', providerName: 'claude', position: 5 },
          { name: 'b', providerName: 'claude', position: 1 },
          { name: 'c', providerName: 'claude', position: 9 },
        ],
      },
    ];

    await profilesCodec.apply([] as AnyRec, seedCtx(profilesToCreate), 'replace', rt);

    expect(createProfileProviderConfig).toHaveBeenCalledTimes(3);
    const positions = createProfileProviderConfig.mock.calls.map(
      (call) => (call[0] as { position?: number }).position,
    );
    // Sparse, non-array-order positions are preserved exactly (not re-numbered or auto-assigned).
    expect(positions).toEqual([5, 1, 9]);
  });

  it('applies in create mode too (both import paths share this codec)', async () => {
    const createProfileProviderConfig = jest.fn().mockResolvedValue({ id: 'cfg-x' });
    const rt = makeRt(createProfileProviderConfig);

    const profilesToCreate = [
      {
        id: 'p1',
        name: 'P',
        provider: { name: 'claude' },
        providerConfigs: [{ name: 'a', providerName: 'claude', position: 7 }],
      },
    ];

    await profilesCodec.apply([] as AnyRec, seedCtx(profilesToCreate), 'create', rt);

    expect(createProfileProviderConfig).toHaveBeenCalledWith(
      expect.objectContaining({ position: 7 }),
    );
  });

  it('legacy: absent position is passed as undefined so storage keeps its max+1 auto-assign', async () => {
    const createProfileProviderConfig = jest.fn().mockResolvedValue({ id: 'cfg' });
    const rt = makeRt(createProfileProviderConfig);

    const profilesToCreate = [
      {
        id: 'p1',
        name: 'P',
        provider: { name: 'claude' },
        providerConfigs: [
          { name: 'a', providerName: 'claude' }, // no position — legacy template
        ],
      },
    ];

    await profilesCodec.apply([] as AnyRec, seedCtx(profilesToCreate), 'replace', rt);

    expect(createProfileProviderConfig).toHaveBeenCalledTimes(1);
    const callArg = createProfileProviderConfig.mock.calls[0][0] as { position?: number };
    expect(callArg.position).toBeUndefined();
  });
});
