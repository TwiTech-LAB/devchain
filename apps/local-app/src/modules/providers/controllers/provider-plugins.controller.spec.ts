import { ProviderPluginsController } from './provider-plugins.controller';
import type { ProviderPluginsService } from '../services/provider-plugins.service';

describe('ProviderPluginsController (module unit: provider-agnostic delegation)', () => {
  let controller: ProviderPluginsController;
  let service: {
    listCatalog: jest.Mock;
    refreshCatalog: jest.Mock;
    install: jest.Mock;
  };

  beforeEach(() => {
    service = {
      listCatalog: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      refreshCatalog: jest.fn().mockResolvedValue({ items: [], total: 0 }),
      install: jest.fn().mockResolvedValue({
        success: true,
        providerId: 'provider-1',
        providerName: 'claude',
        pluginId: 'sample@market',
      }),
    };
    controller = new ProviderPluginsController(service as unknown as ProviderPluginsService);
  });

  it('delegates catalog reads without provider-specific branching', async () => {
    await expect(controller.listCatalog()).resolves.toEqual({ items: [], total: 0 });
    expect(service.listCatalog).toHaveBeenCalledWith();
  });

  it('delegates explicit refresh requests', async () => {
    await expect(controller.refreshCatalog()).resolves.toEqual({ items: [], total: 0 });
    expect(service.refreshCatalog).toHaveBeenCalledWith();
  });

  it('validates, trims, and delegates install requests', async () => {
    await controller.install({ providerId: ' provider-1 ', pluginId: ' sample@market ' });

    expect(service.install).toHaveBeenCalledWith('provider-1', 'sample@market');
  });

  it('rejects unknown request fields and malformed plugin selectors', () => {
    expect(() =>
      controller.install({
        providerId: 'provider-1',
        pluginId: 'sample@market',
        enable: true,
      }),
    ).toThrow();
    expect(() =>
      controller.install({ providerId: 'provider-1', pluginId: 'bad\nselector' }),
    ).toThrow();
    expect(service.install).not.toHaveBeenCalled();
  });
});
