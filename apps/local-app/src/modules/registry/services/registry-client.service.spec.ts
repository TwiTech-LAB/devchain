import { RegistryClientService } from './registry-client.service';
import { RegistryError, ChecksumMismatchError } from '../dtos/registry-error';
import * as crypto from 'crypto';
import { SettingsService } from '../../settings/services/settings.service';

// Mock fetch globally
const mockFetch = jest.fn();
global.fetch = mockFetch;

// Mock SettingsService
const mockSettingsService = {
  getRegistryConfig: jest.fn().mockReturnValue({
    url: 'https://templates.devchain.twitechlab.com',
    cacheDir: '',
    checkUpdatesOnStartup: true,
  }),
} as unknown as SettingsService;

describe('RegistryClientService', () => {
  let service: RegistryClientService;

  beforeEach(() => {
    jest.clearAllMocks();
    (mockSettingsService.getRegistryConfig as jest.Mock).mockReturnValue({
      url: 'https://templates.devchain.twitechlab.com',
      cacheDir: '',
      checkUpdatesOnStartup: true,
    });
    service = new RegistryClientService(mockSettingsService);
  });

  describe('listTemplates', () => {
    it('should fetch templates from registry', async () => {
      const mockResponse = {
        templates: [{ slug: 'test-template', name: 'Test Template', latestVersion: '1.0.0' }],
        total: 1,
        page: 1,
        limit: 20,
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await service.listTemplates();

      expect(result).toEqual(mockResponse);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/templates'),
        expect.any(Object),
      );
    });

    it('should pass search and filter params', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ templates: [], total: 0 }),
      });

      await service.listTemplates({
        search: 'test',
        category: 'development',
        tags: ['ai', 'automation'],
        page: 2,
        limit: 10,
        sort: 'downloads',
        order: 'desc',
      });

      const calledUrl = mockFetch.mock.calls[0][0];
      expect(calledUrl).toContain('search=test');
      expect(calledUrl).toContain('category=development');
      expect(calledUrl).toContain('tags=ai%2Cautomation');
      expect(calledUrl).toContain('page=2');
      expect(calledUrl).toContain('limit=10');
      expect(calledUrl).toContain('sort=downloads');
      expect(calledUrl).toContain('order=desc');
    });

    it('should handle network errors', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      await expect(service.listTemplates()).rejects.toThrow(RegistryError);
    });

    it('should throw RegistryError on non-ok response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      await expect(service.listTemplates()).rejects.toThrow(RegistryError);
    });

    it('should handle request timeout', async () => {
      const abortError = new Error('Aborted');
      abortError.name = 'AbortError';
      mockFetch.mockRejectedValueOnce(abortError);

      await expect(service.listTemplates()).rejects.toThrow(RegistryError);
    });
  });

  describe('getTemplate', () => {
    it('should fetch template details with versions', async () => {
      const mockTemplate = {
        template: {
          slug: 'test-template',
          name: 'Test Template',
          description: 'A test template',
        },
        versions: [
          { version: '1.0.0', isLatest: true, publishedAt: '2024-01-01' },
          { version: '0.9.0', isLatest: false, publishedAt: '2023-12-01' },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockTemplate,
      });

      const result = await service.getTemplate('test-template');

      expect(result).toEqual(mockTemplate);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/templates/test-template'),
        expect.any(Object),
      );
    });

    it('should return null for 404', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      const result = await service.getTemplate('non-existent');

      expect(result).toBeNull();
    });

    it('should throw RegistryError on other errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      await expect(service.getTemplate('test')).rejects.toThrow(RegistryError);
    });
  });

  describe('downloadTemplate', () => {
    it('should download and verify checksum from raw response bytes', async () => {
      const content = { prompts: [], profiles: [] };
      // Server stores checksum of pretty-printed JSON
      const rawText = JSON.stringify(content, null, 2);
      const checksum = crypto.createHash('sha256').update(rawText).digest('hex');

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: {
          get: (name: string) => (name === 'X-Checksum-SHA256' ? checksum : null),
        },
        text: async () => rawText,
      });

      const result = await service.downloadTemplate('test-template', '1.0.0');

      expect(result.content).toEqual(content);
      expect(result.checksum).toBe(checksum);
      expect(result.slug).toBe('test-template');
      expect(result.version).toBe('1.0.0');
    });

    it('should verify checksum matches regardless of JSON formatting', async () => {
      // Simulate server returning pretty-printed JSON
      const content = { prompts: [{ id: '1', title: 'Test' }], profiles: [] };
      const prettyPrintedJson = JSON.stringify(content, null, 2);
      const checksum = crypto.createHash('sha256').update(prettyPrintedJson).digest('hex');

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: {
          get: (name: string) => (name === 'X-Checksum-SHA256' ? checksum : null),
        },
        text: async () => prettyPrintedJson,
      });

      const result = await service.downloadTemplate('test-template', '1.0.0');

      // Checksum should match the raw response
      expect(result.checksum).toBe(checksum);
      // Content should be parsed correctly
      expect(result.content).toEqual(content);
    });

    it('should throw on checksum mismatch', async () => {
      const content = { prompts: [], profiles: [] };
      const rawText = JSON.stringify(content, null, 2);
      const wrongChecksum = 'wrong-checksum-value';

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: {
          get: (name: string) => (name === 'X-Checksum-SHA256' ? wrongChecksum : null),
        },
        text: async () => rawText,
      });

      await expect(service.downloadTemplate('test-template', '1.0.0')).rejects.toThrow(
        ChecksumMismatchError,
      );
    });

    it('should work without checksum header', async () => {
      const content = { prompts: [], profiles: [] };
      const rawText = JSON.stringify(content, null, 2);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: {
          get: () => null,
        },
        text: async () => rawText,
      });

      const result = await service.downloadTemplate('test-template', '1.0.0');

      expect(result.content).toEqual(content);
      expect(result.checksum).toBeDefined();
    });

    it('should throw RegistryError for 404', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      await expect(service.downloadTemplate('test', '1.0.0')).rejects.toThrow(RegistryError);
    });

    it('should throw RegistryError for server errors (500)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      await expect(service.downloadTemplate('test', '1.0.0')).rejects.toThrow(RegistryError);
      await expect(service.downloadTemplate('test', '1.0.0')).rejects.toThrow(
        /Failed to download template/,
      );
    });

    it('should throw RegistryError for invalid JSON response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: {
          get: () => null,
        },
        text: async () => 'not valid json {{{',
      });

      await expect(service.downloadTemplate('test', '1.0.0')).rejects.toThrow(RegistryError);
    });

    it('should handle request timeout', async () => {
      const abortError = new Error('Aborted');
      abortError.name = 'AbortError';
      mockFetch.mockRejectedValueOnce(abortError);

      await expect(service.downloadTemplate('test', '1.0.0')).rejects.toThrow(RegistryError);
    });
  });

  describe('checkForUpdates', () => {
    it('should return updates for outdated templates', async () => {
      const remoteTemplate = {
        template: { slug: 'test-template' },
        versions: [
          { version: '2.0.0', isLatest: true, changelog: 'New features' },
          { version: '1.0.0', isLatest: false },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => remoteTemplate,
      });

      const installed = [{ slug: 'test-template', version: '1.0.0' }];
      const updates = await service.checkForUpdates(installed);

      expect(updates).toHaveLength(1);
      expect(updates[0]).toEqual({
        slug: 'test-template',
        currentVersion: '1.0.0',
        latestVersion: '2.0.0',
        changelog: 'New features',
      });
    });

    it('should return empty for up-to-date templates', async () => {
      const remoteTemplate = {
        template: { slug: 'test-template' },
        versions: [{ version: '1.0.0', isLatest: true }],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => remoteTemplate,
      });

      const installed = [{ slug: 'test-template', version: '1.0.0' }];
      const updates = await service.checkForUpdates(installed);

      expect(updates).toHaveLength(0);
    });

    it('should handle individual template errors gracefully', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error')).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          template: { slug: 'template-2' },
          versions: [{ version: '2.0.0', isLatest: true }],
        }),
      });

      const installed = [
        { slug: 'template-1', version: '1.0.0' },
        { slug: 'template-2', version: '1.0.0' },
      ];
      const updates = await service.checkForUpdates(installed);

      // Should still return update for template-2 despite template-1 failing
      expect(updates).toHaveLength(1);
      expect(updates[0].slug).toBe('template-2');
    });

    it('should skip templates not found in registry', async () => {
      // Return 404 for template-1, success for template-2
      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            template: { slug: 'template-2' },
            versions: [{ version: '2.0.0', isLatest: true }],
          }),
        });

      const installed = [
        { slug: 'not-in-registry', version: '1.0.0' },
        { slug: 'template-2', version: '1.0.0' },
      ];
      const updates = await service.checkForUpdates(installed);

      // Should only return update for template-2
      expect(updates).toHaveLength(1);
      expect(updates[0].slug).toBe('template-2');
    });

    it('should skip templates with invalid semver versions', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          template: { slug: 'test-template' },
          versions: [{ version: 'invalid-version', isLatest: true }],
        }),
      });

      const installed = [{ slug: 'test-template', version: '1.0.0' }];
      const updates = await service.checkForUpdates(installed);

      // Should skip due to invalid remote version
      expect(updates).toHaveLength(0);
    });

    it('should skip when installed version is invalid semver', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          template: { slug: 'test-template' },
          versions: [{ version: '2.0.0', isLatest: true }],
        }),
      });

      const installed = [{ slug: 'test-template', version: 'not-a-version' }];
      const updates = await service.checkForUpdates(installed);

      // Should skip due to invalid installed version
      expect(updates).toHaveLength(0);
    });

    it('should skip when no latest version exists', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          template: { slug: 'test-template' },
          versions: [{ version: '1.0.0', isLatest: false }], // No isLatest=true
        }),
      });

      const installed = [{ slug: 'test-template', version: '0.9.0' }];
      const updates = await service.checkForUpdates(installed);

      expect(updates).toHaveLength(0);
    });
  });

  describe('isAvailable', () => {
    it('should return true when registry is healthy', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });

      const result = await service.isAvailable();

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/health'),
        expect.any(Object),
      );
    });

    it('should return false on timeout', async () => {
      const abortError = new Error('Aborted');
      abortError.name = 'AbortError';
      mockFetch.mockRejectedValueOnce(abortError);

      const result = await service.isAvailable();

      expect(result).toBe(false);
    });

    it('should return false on network error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const result = await service.isAvailable();

      expect(result).toBe(false);
    });

    it('should return false on non-ok response', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false });

      const result = await service.isAvailable();

      expect(result).toBe(false);
    });
  });

  describe('getRegistryUrl', () => {
    it('should return the configured registry URL from settings', () => {
      const url = service.getRegistryUrl();
      expect(url).toBe('https://templates.devchain.twitechlab.com');
      expect(mockSettingsService.getRegistryConfig).toHaveBeenCalled();
    });

    it('should reflect URL changes from settings immediately', () => {
      // Initial URL
      expect(service.getRegistryUrl()).toBe('https://templates.devchain.twitechlab.com');

      // Simulate settings change
      (mockSettingsService.getRegistryConfig as jest.Mock).mockReturnValue({
        url: 'https://custom-registry.example.com',
        cacheDir: '',
        checkUpdatesOnStartup: true,
      });

      // Should reflect new URL immediately
      expect(service.getRegistryUrl()).toBe('https://custom-registry.example.com');
    });

    it('should use custom URL from settings for API calls', async () => {
      (mockSettingsService.getRegistryConfig as jest.Mock).mockReturnValue({
        url: 'https://custom-registry.example.com',
        cacheDir: '',
        checkUpdatesOnStartup: true,
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ templates: [], total: 0 }),
      });

      await service.listTemplates();

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('https://custom-registry.example.com'),
        expect.any(Object),
      );
    });
  });
});
