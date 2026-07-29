import { ImportContext } from '../import-context';
import { buildExportProfiles, profilesCodec } from './profiles.codec';
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

describe('profiles codec — context-window env round-trip', () => {
  const configuredEnv = { DEVCHAIN_CONTEXT_WINDOW_TOKENS: '750000' };

  it('exports the key through the existing providerConfig env field', () => {
    const result = buildExportProfiles(
      {
        items: [
          {
            id: 'p1',
            name: 'P',
            familySlug: null,
            instructions: null,
            temperature: null,
            maxTokens: null,
          },
        ],
      },
      {
        allConfigsByProfile: new Map([
          [
            'p1',
            [
              {
                id: 'cfg-1',
                name: 'default',
                providerId: 'prov-1',
                description: null,
                options: null,
                env: configuredEnv,
                model: 'custom/model',
                effort: null,
                position: 0,
              },
            ],
          ],
        ]),
        providersMap: new Map([['prov-1', { id: 'prov-1', name: 'claude' }]]),
        configIdToInfo: new Map(),
      },
      (env) => env ?? null,
    );

    expect(result[0].providerConfigs[0].env).toEqual(configuredEnv);
  });

  it.each(['replace', 'create'] as const)(
    'imports the key through the existing providerConfig env field in %s mode',
    async (mode) => {
      const createProfileProviderConfig = jest.fn().mockResolvedValue({ id: 'cfg-1' });
      const rt = makeRt(createProfileProviderConfig);
      const profilesToCreate = [
        {
          id: 'p1',
          name: 'P',
          provider: { name: 'claude' },
          providerConfigs: [
            {
              name: 'default',
              providerName: 'claude',
              env: configuredEnv,
            },
          ],
        },
      ];

      await profilesCodec.apply([] as AnyRec, seedCtx(profilesToCreate), mode, rt);

      expect(createProfileProviderConfig).toHaveBeenCalledWith(
        expect.objectContaining({ env: configuredEnv }),
      );
    },
  );
});
