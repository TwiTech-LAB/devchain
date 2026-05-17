import type { SettingsDto, RegistryTemplateMetadataDto } from '../../dtos/settings.dto';
import { RegistrySettingsDelegate } from './registry-settings.delegate';

describe('RegistrySettingsDelegate', () => {
  let delegate: RegistrySettingsDelegate;
  let settings: SettingsDto;
  let updateSettingsMock: jest.Mock;

  beforeEach(() => {
    settings = {};
    updateSettingsMock = jest.fn(async (s: SettingsDto) => {
      Object.assign(settings, s);
      return settings;
    });
    delegate = new RegistrySettingsDelegate({
      getSettings: () => settings,
      updateSettings: updateSettingsMock,
    });
  });

  describe('getRegistryConfig', () => {
    it('returns default URL when no setting or env', () => {
      delete process.env.REGISTRY_URL;
      const config = delegate.getRegistryConfig();
      expect(config.url).toBe('https://a1-devchain.twitechlab.com');
      expect(config.cacheDir).toBe('');
      expect(config.checkUpdatesOnStartup).toBe(true);
    });

    it('uses env var over default', () => {
      process.env.REGISTRY_URL = 'https://env-registry.example.com';
      const config = delegate.getRegistryConfig();
      expect(config.url).toBe('https://env-registry.example.com');
      delete process.env.REGISTRY_URL;
    });

    it('uses DB setting over env var', () => {
      process.env.REGISTRY_URL = 'https://env-registry.example.com';
      settings.registry = { url: 'https://db-registry.example.com' };
      const config = delegate.getRegistryConfig();
      expect(config.url).toBe('https://db-registry.example.com');
      delete process.env.REGISTRY_URL;
    });

    it('returns configured cacheDir and checkUpdatesOnStartup', () => {
      settings.registry = {
        cacheDir: '/tmp/cache',
        checkUpdatesOnStartup: false,
      };
      const config = delegate.getRegistryConfig();
      expect(config.cacheDir).toBe('/tmp/cache');
      expect(config.checkUpdatesOnStartup).toBe(false);
    });
  });

  describe('setRegistryConfig', () => {
    it('merges config with existing registry settings', async () => {
      settings.registry = { url: 'https://old.example.com', checkUpdatesOnStartup: true };
      await delegate.setRegistryConfig({ url: 'https://new.example.com' });
      expect(updateSettingsMock).toHaveBeenCalledWith(
        expect.objectContaining({
          registry: expect.objectContaining({
            url: 'https://new.example.com',
            checkUpdatesOnStartup: true,
          }),
        }),
      );
    });
  });

  describe('template metadata', () => {
    const metadata: RegistryTemplateMetadataDto = {
      templateSlug: 'test-template',
      installedVersion: '1.0.0',
      lastUpdateCheckAt: '2026-01-01T00:00:00Z',
    };

    it('returns null for unknown project', () => {
      expect(delegate.getProjectTemplateMetadata('unknown')).toBeNull();
    });

    it('stores and retrieves template metadata', async () => {
      await delegate.setProjectTemplateMetadata('proj-1', metadata);
      settings.registryTemplates = { 'proj-1': metadata };
      expect(delegate.getProjectTemplateMetadata('proj-1')).toEqual(metadata);
    });

    it('clears template metadata', async () => {
      settings.registryTemplates = { 'proj-1': metadata, 'proj-2': metadata };
      await delegate.clearProjectTemplateMetadata('proj-1');
      expect(updateSettingsMock).toHaveBeenCalledWith(
        expect.objectContaining({
          registryTemplates: { 'proj-2': metadata },
        }),
      );
    });

    it('lists all tracked projects', () => {
      settings.registryTemplates = { 'proj-1': metadata, 'proj-2': metadata };
      const tracked = delegate.getAllTrackedProjects();
      expect(tracked).toHaveLength(2);
      expect(tracked[0].projectId).toBe('proj-1');
    });

    it('returns metadata map', () => {
      settings.registryTemplates = { 'proj-1': metadata };
      const map = delegate.getAllProjectTemplateMetadataMap();
      expect(map.get('proj-1')).toEqual(metadata);
      expect(map.size).toBe(1);
    });

    it('updates lastUpdateCheckAt', async () => {
      settings.registryTemplates = { 'proj-1': metadata };
      await delegate.updateLastUpdateCheck('proj-1');
      expect(updateSettingsMock).toHaveBeenCalledWith(
        expect.objectContaining({
          registryTemplates: expect.objectContaining({
            'proj-1': expect.objectContaining({
              templateSlug: 'test-template',
              lastUpdateCheckAt: expect.any(String),
            }),
          }),
        }),
      );
    });

    it('skips update for untracked project', async () => {
      await delegate.updateLastUpdateCheck('unknown');
      expect(updateSettingsMock).not.toHaveBeenCalled();
    });
  });
});
