import type { StorageService } from '../../storage/interfaces/storage.interface';
import { importProviderSettings } from './project-import';

jest.mock('../../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

describe('importProviderSettings — autoCompactThreshold1m compat', () => {
  let storage: {
    listProviders: jest.Mock;
    updateProvider: jest.Mock;
  };

  const baseProvider = {
    id: 'provider-1',
    name: 'claude',
    binPath: '/usr/local/bin/claude',
    autoCompactThreshold: null,
  };

  const makePayload = (
    providerSettings: Array<{
      name: string;
      autoCompactThreshold?: number | null;
      autoCompactThreshold1m?: number | null;
      oneMillionContextEnabled?: boolean;
    }>,
  ) =>
    ({
      providerSettings,
      _manifest: { slug: 'test' },
      profiles: [],
      agents: [],
      statuses: [],
      prompts: [],
      documents: [],
      skills: [],
      hooks: [],
    }) as unknown as Parameters<typeof importProviderSettings>[0];

  beforeEach(() => {
    storage = {
      listProviders: jest.fn().mockResolvedValue({ items: [baseProvider] }),
      updateProvider: jest.fn().mockResolvedValue(undefined),
    };
  });

  it('legacy template: promotes old threshold to 1M value and sets standard to 95 on probe success', async () => {
    // Legacy template: 1M enabled but no autoCompactThreshold1m field
    const payload = makePayload([
      { name: 'claude', autoCompactThreshold: 50, oneMillionContextEnabled: true },
    ]);
    const probe1m = jest.fn().mockResolvedValue({ supported: true, status: 'supported' });

    await importProviderSettings(payload, storage as unknown as StorageService, { probe1m });

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
    // New template: both autoCompactThreshold and autoCompactThreshold1m present
    const payload = makePayload([
      {
        name: 'claude',
        autoCompactThreshold: 95,
        autoCompactThreshold1m: 40,
        oneMillionContextEnabled: true,
      },
    ]);
    const probe1m = jest.fn().mockResolvedValue({ supported: true, status: 'supported' });

    await importProviderSettings(payload, storage as unknown as StorageService, { probe1m });

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
    const payload = makePayload([
      {
        name: 'claude',
        autoCompactThreshold: 50,
        autoCompactThreshold1m: 50,
        oneMillionContextEnabled: true,
      },
    ]);
    const probe1m = jest.fn().mockResolvedValue({ supported: false, status: 'unsupported' });

    await importProviderSettings(payload, storage as unknown as StorageService, { probe1m });

    expect(storage.updateProvider).toHaveBeenCalledWith(
      'provider-1',
      expect.objectContaining({
        autoCompactThreshold1m: null,
        autoCompactThreshold: 95,
        oneMillionContextEnabled: false,
      }),
    );
  });

  it('no binPath: disables 1M and forces standard threshold to 95', async () => {
    storage.listProviders.mockResolvedValue({
      items: [{ ...baseProvider, binPath: null }],
    });

    const payload = makePayload([
      { name: 'claude', autoCompactThreshold1m: 50, oneMillionContextEnabled: true },
    ]);
    const probe1m = jest.fn();

    await importProviderSettings(payload, storage as unknown as StorageService, { probe1m });

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

  it('probe success: preserves existing local standard threshold', async () => {
    storage.listProviders.mockResolvedValue({
      items: [{ ...baseProvider, autoCompactThreshold: 80 }],
    });

    const payload = makePayload([
      {
        name: 'claude',
        autoCompactThreshold: 95,
        autoCompactThreshold1m: 50,
        oneMillionContextEnabled: true,
      },
    ]);
    const probe1m = jest.fn().mockResolvedValue({ supported: true });

    await importProviderSettings(payload, storage as unknown as StorageService, { probe1m });

    const updateCall = storage.updateProvider.mock.calls[0][1];
    expect(updateCall.autoCompactThreshold1m).toBe(50);
    expect(updateCall.autoCompactThreshold).toBeUndefined(); // preserved, not overwritten
  });

  it('probe failure: preserves existing local standard threshold', async () => {
    storage.listProviders.mockResolvedValue({
      items: [{ ...baseProvider, autoCompactThreshold: 80 }],
    });

    const payload = makePayload([
      { name: 'claude', autoCompactThreshold1m: 50, oneMillionContextEnabled: true },
    ]);
    const probe1m = jest.fn().mockResolvedValue({ supported: false });

    await importProviderSettings(payload, storage as unknown as StorageService, { probe1m });

    const updateCall = storage.updateProvider.mock.calls[0][1];
    expect(updateCall.autoCompactThreshold1m).toBeNull();
    expect(updateCall.autoCompactThreshold).toBeUndefined(); // preserved, not overwritten
  });

  it('legacy template + probe success: preserves existing local standard threshold', async () => {
    storage.listProviders.mockResolvedValue({
      items: [{ ...baseProvider, autoCompactThreshold: 80 }],
    });

    // Legacy template: 1M enabled but no autoCompactThreshold1m
    const payload = makePayload([
      { name: 'claude', autoCompactThreshold: 50, oneMillionContextEnabled: true },
    ]);
    const probe1m = jest.fn().mockResolvedValue({ supported: true });

    await importProviderSettings(payload, storage as unknown as StorageService, { probe1m });

    const updateCall = storage.updateProvider.mock.calls[0][1];
    expect(updateCall.autoCompactThreshold1m).toBe(50); // legacy value promoted
    expect(updateCall.autoCompactThreshold).toBeUndefined(); // preserved, not overwritten
    expect(updateCall.oneMillionContextEnabled).toBe(true);
  });

  it('legacy template + probe failure: preserves existing local standard threshold', async () => {
    storage.listProviders.mockResolvedValue({
      items: [{ ...baseProvider, autoCompactThreshold: 80 }],
    });

    const payload = makePayload([
      { name: 'claude', autoCompactThreshold: 50, oneMillionContextEnabled: true },
    ]);
    const probe1m = jest.fn().mockResolvedValue({ supported: false });

    await importProviderSettings(payload, storage as unknown as StorageService, { probe1m });

    const updateCall = storage.updateProvider.mock.calls[0][1];
    expect(updateCall.autoCompactThreshold1m).toBeNull();
    expect(updateCall.autoCompactThreshold).toBeUndefined(); // preserved, not overwritten
    expect(updateCall.oneMillionContextEnabled).toBe(false);
  });

  it('no-probe: preserves existing local standard threshold', async () => {
    storage.listProviders.mockResolvedValue({
      items: [{ ...baseProvider, binPath: null, autoCompactThreshold: 80 }],
    });

    const payload = makePayload([
      { name: 'claude', autoCompactThreshold1m: 50, oneMillionContextEnabled: true },
    ]);

    await importProviderSettings(payload, storage as unknown as StorageService);

    const updateCall = storage.updateProvider.mock.calls[0][1];
    expect(updateCall.autoCompactThreshold1m).toBeNull();
    expect(updateCall.autoCompactThreshold).toBeUndefined(); // preserved, not overwritten
  });
});
