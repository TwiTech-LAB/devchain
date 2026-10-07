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
