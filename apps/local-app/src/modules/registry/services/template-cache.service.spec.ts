import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { TemplateCacheService } from './template-cache.service';
import { SettingsService } from '../../settings/services/settings.service';

describe('TemplateCacheService', () => {
  let service: TemplateCacheService;
  let tempDir: string;
  let mockSettingsService: jest.Mocked<SettingsService>;

  beforeEach(async () => {
    // Create temp directory for cache
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cache-test-'));

    // Mock settings service
    mockSettingsService = {
      getRegistryConfig: jest.fn().mockReturnValue({
        url: 'https://test.registry.com',
        cacheDir: tempDir,
      }),
    } as unknown as jest.Mocked<SettingsService>;

    service = new TemplateCacheService(mockSettingsService);
    await service.onModuleInit();
  });

  afterEach(async () => {
    // Cleanup temp directory
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('saveTemplate', () => {
    it('should save template and metadata to disk', async () => {
      const content = { prompts: [{ id: '1', title: 'Test' }], profiles: [] };
      const metadata = {
        cachedAt: new Date().toISOString(),
        checksum: 'abc123',
        size: 100,
      };

      await service.saveTemplate('test-template', '1.0.0', content, metadata);

      // Verify files exist
      const templatePath = path.join(
        tempDir,
        'templates',
        'test-template',
        '1.0.0',
        'template.json',
      );
      const metadataPath = path.join(
        tempDir,
        'templates',
        'test-template',
        '1.0.0',
        'metadata.json',
      );

      const savedContent = JSON.parse(await fs.readFile(templatePath, 'utf-8'));
      const savedMetadata = JSON.parse(await fs.readFile(metadataPath, 'utf-8'));

      expect(savedContent).toEqual(content);
      expect(savedMetadata.checksum).toBe('abc123');
      expect(savedMetadata.slug).toBe('test-template');
      expect(savedMetadata.version).toBe('1.0.0');
    });

    it('should update index', async () => {
      const content = { prompts: [] };
      const metadata = {
        cachedAt: new Date().toISOString(),
        checksum: 'abc123',
        size: 50,
      };

      await service.saveTemplate('test-template', '1.0.0', content, metadata);

      const index = service.getIndex();
      expect(index.templates['test-template']).toBeDefined();
      expect(index.templates['test-template'].versions['1.0.0']).toBeDefined();
      expect(index.templates['test-template'].latestVersion).toBe('1.0.0');
    });

    it('should handle multiple versions', async () => {
      const content = { prompts: [] };

      await service.saveTemplate('test-template', '1.0.0', content, {
        cachedAt: new Date().toISOString(),
        checksum: 'v1',
        size: 50,
      });

      await service.saveTemplate('test-template', '2.0.0', content, {
        cachedAt: new Date().toISOString(),
        checksum: 'v2',
        size: 60,
      });

      const index = service.getIndex();
      expect(Object.keys(index.templates['test-template'].versions)).toHaveLength(2);
      expect(index.templates['test-template'].latestVersion).toBe('2.0.0');
    });

    it('should extract display fields from _manifest to index', async () => {
      const content = {
        _manifest: {
          name: 'My Custom Template',
          description: 'A great template for testing',
          category: 'development',
          tags: ['ai', 'testing'],
          authorName: 'Test Author',
          isOfficial: true,
        },
        prompts: [{ id: '1', title: 'Test' }],
        profiles: [],
      };
      const metadata = {
        cachedAt: new Date().toISOString(),
        checksum: 'abc123',
        size: 100,
      };

      await service.saveTemplate('test-template', '1.0.0', content, metadata);

      const index = service.getIndex();
      expect(index.templates['test-template'].displayName).toBe('My Custom Template');
      expect(index.templates['test-template'].description).toBe('A great template for testing');
      expect(index.templates['test-template'].category).toBe('development');
      expect(index.templates['test-template'].tags).toEqual(['ai', 'testing']);
      expect(index.templates['test-template'].authorName).toBe('Test Author');
      expect(index.templates['test-template'].isOfficial).toBe(true);
    });

    it('should not add display fields when _manifest is missing', async () => {
      const content = {
        prompts: [{ id: '1', title: 'Test' }],
        profiles: [],
        // No _manifest field
      };
      const metadata = {
        cachedAt: new Date().toISOString(),
        checksum: 'abc123',
        size: 100,
      };

      await service.saveTemplate('test-template', '1.0.0', content, metadata);

      const index = service.getIndex();
      expect(index.templates['test-template'].displayName).toBeUndefined();
      expect(index.templates['test-template'].description).toBeUndefined();
      expect(index.templates['test-template'].category).toBeUndefined();
    });
  });

  describe('getTemplate', () => {
    it('should retrieve cached template', async () => {
      const content = { prompts: [{ id: '1', title: 'Test' }] };
      const metadata = {
        cachedAt: new Date().toISOString(),
        checksum: 'abc123',
        size: 100,
      };

      await service.saveTemplate('test-template', '1.0.0', content, metadata);

      const result = await service.getTemplate('test-template', '1.0.0');

      expect(result).not.toBeNull();
      expect(result?.content).toEqual(content);
      expect(result?.metadata.slug).toBe('test-template');
      expect(result?.metadata.version).toBe('1.0.0');
    });

    it('should return null for missing template', async () => {
      const result = await service.getTemplate('non-existent', '1.0.0');
      expect(result).toBeNull();
    });

    it('should return null for missing version', async () => {
      await service.saveTemplate(
        'test-template',
        '1.0.0',
        { prompts: [] },
        {
          cachedAt: new Date().toISOString(),
          checksum: 'abc',
          size: 10,
        },
      );

      const result = await service.getTemplate('test-template', '2.0.0');
      expect(result).toBeNull();
    });

    it('should return null for corrupted template JSON', async () => {
      // Save a valid template first
      await service.saveTemplate(
        'test-template',
        '1.0.0',
        { prompts: [] },
        {
          cachedAt: new Date().toISOString(),
          checksum: 'abc',
          size: 10,
        },
      );

      // Corrupt the template file
      const templatePath = path.join(
        tempDir,
        'templates',
        'test-template',
        '1.0.0',
        'template.json',
      );
      await fs.writeFile(templatePath, 'not valid json {{{');

      // Should return null for corrupted file
      const result = await service.getTemplate('test-template', '1.0.0');
      expect(result).toBeNull();
    });
  });

  describe('isCached', () => {
    it('should check index for cached status', async () => {
      expect(service.isCached('test-template', '1.0.0')).toBe(false);

      await service.saveTemplate(
        'test-template',
        '1.0.0',
        { prompts: [] },
        {
          cachedAt: new Date().toISOString(),
          checksum: 'abc',
          size: 10,
        },
      );

      expect(service.isCached('test-template', '1.0.0')).toBe(true);
      expect(service.isCached('test-template', '2.0.0')).toBe(false);
    });
  });

  describe('listCached', () => {
    it('should list all cached templates', async () => {
      await service.saveTemplate(
        'template-1',
        '1.0.0',
        { prompts: [] },
        {
          cachedAt: new Date().toISOString(),
          checksum: 'a',
          size: 10,
        },
      );

      await service.saveTemplate(
        'template-2',
        '2.0.0',
        { prompts: [] },
        {
          cachedAt: new Date().toISOString(),
          checksum: 'b',
          size: 20,
        },
      );

      const cached = service.listCached();

      expect(cached).toHaveLength(2);
      expect(cached.map((t) => t.slug).sort()).toEqual(['template-1', 'template-2']);
    });

    it('should return empty array when no templates cached', () => {
      const cached = service.listCached();
      expect(cached).toHaveLength(0);
    });

    it('should include display fields from _manifest', async () => {
      const content = {
        _manifest: {
          name: 'My Template',
          description: 'A description',
          category: 'development',
          tags: ['test'],
          authorName: 'Author',
          isOfficial: false,
        },
        prompts: [],
      };

      await service.saveTemplate('test-template', '1.0.0', content, {
        cachedAt: new Date().toISOString(),
        checksum: 'abc',
        size: 50,
      });

      const cached = service.listCached();

      expect(cached).toHaveLength(1);
      expect(cached[0].displayName).toBe('My Template');
      expect(cached[0].description).toBe('A description');
      expect(cached[0].category).toBe('development');
      expect(cached[0].tags).toEqual(['test']);
      expect(cached[0].authorName).toBe('Author');
      expect(cached[0].isOfficial).toBe(false);
    });

    it('should return undefined display fields when _manifest is missing', async () => {
      await service.saveTemplate(
        'test-template',
        '1.0.0',
        { prompts: [] },
        {
          cachedAt: new Date().toISOString(),
          checksum: 'abc',
          size: 50,
        },
      );

      const cached = service.listCached();

      expect(cached).toHaveLength(1);
      expect(cached[0].displayName).toBeUndefined();
      expect(cached[0].description).toBeUndefined();
      expect(cached[0].category).toBeUndefined();
    });
  });

  describe('removeVersion', () => {
    it('should remove specific version from cache', async () => {
      await service.saveTemplate(
        'test-template',
        '1.0.0',
        { prompts: [] },
        {
          cachedAt: new Date().toISOString(),
          checksum: 'v1',
          size: 10,
        },
      );

      await service.saveTemplate(
        'test-template',
        '2.0.0',
        { prompts: [] },
        {
          cachedAt: new Date().toISOString(),
          checksum: 'v2',
          size: 20,
        },
      );

      await service.removeVersion('test-template', '1.0.0');

      expect(service.isCached('test-template', '1.0.0')).toBe(false);
      expect(service.isCached('test-template', '2.0.0')).toBe(true);

      const index = service.getIndex();
      expect(index.templates['test-template'].latestVersion).toBe('2.0.0');
    });

    it('should remove template entry when last version removed', async () => {
      await service.saveTemplate(
        'test-template',
        '1.0.0',
        { prompts: [] },
        {
          cachedAt: new Date().toISOString(),
          checksum: 'v1',
          size: 10,
        },
      );

      await service.removeVersion('test-template', '1.0.0');

      const index = service.getIndex();
      expect(index.templates['test-template']).toBeUndefined();
    });
  });

  describe('clearCache', () => {
    it('should remove all cached files', async () => {
      await service.saveTemplate(
        'template-1',
        '1.0.0',
        { prompts: [] },
        {
          cachedAt: new Date().toISOString(),
          checksum: 'a',
          size: 10,
        },
      );

      await service.saveTemplate(
        'template-2',
        '2.0.0',
        { prompts: [] },
        {
          cachedAt: new Date().toISOString(),
          checksum: 'b',
          size: 20,
        },
      );

      await service.clearCache();

      expect(service.listCached()).toHaveLength(0);

      // Verify files are removed
      const templatesDir = path.join(tempDir, 'templates');
      try {
        await fs.access(templatesDir);
        // If no error, directory still exists - check it's empty or doesn't exist
        const entries = await fs.readdir(templatesDir).catch(() => []);
        expect(entries).toHaveLength(0);
      } catch {
        // Directory doesn't exist, which is expected
      }
    });

    it('should reset index', async () => {
      await service.saveTemplate(
        'test-template',
        '1.0.0',
        { prompts: [] },
        {
          cachedAt: new Date().toISOString(),
          checksum: 'a',
          size: 10,
        },
      );

      await service.clearCache();

      const index = service.getIndex();
      expect(Object.keys(index.templates)).toHaveLength(0);
    });
  });

  describe('getCacheSize', () => {
    it('should return total size of cached templates', async () => {
      const content = { prompts: [], profiles: [], agents: [] };
      await service.saveTemplate('test-template', '1.0.0', content, {
        cachedAt: new Date().toISOString(),
        checksum: 'a',
        size: 100,
      });

      const size = await service.getCacheSize();
      expect(size).toBeGreaterThan(0);
    });

    it('should return 0 for empty cache', async () => {
      const size = await service.getCacheSize();
      expect(size).toBe(0);
    });

    it('should handle multiple templates and versions', async () => {
      await service.saveTemplate(
        'template-1',
        '1.0.0',
        { prompts: [] },
        {
          cachedAt: new Date().toISOString(),
          checksum: 'a',
          size: 50,
        },
      );
      await service.saveTemplate(
        'template-1',
        '2.0.0',
        { prompts: [] },
        {
          cachedAt: new Date().toISOString(),
          checksum: 'b',
          size: 60,
        },
      );
      await service.saveTemplate(
        'template-2',
        '1.0.0',
        { prompts: [] },
        {
          cachedAt: new Date().toISOString(),
          checksum: 'c',
          size: 70,
        },
      );

      const size = await service.getCacheSize();
      // Each version has template.json + metadata.json files
      expect(size).toBeGreaterThan(0);
    });
  });

  describe('getCacheDir', () => {
    it('should return configured cache directory', () => {
      expect(service.getCacheDir()).toBe(tempDir);
    });
  });

  describe('persistence', () => {
    it('should persist and reload index across service instances', async () => {
      await service.saveTemplate(
        'test-template',
        '1.0.0',
        { prompts: [] },
        {
          cachedAt: new Date().toISOString(),
          checksum: 'abc',
          size: 10,
        },
      );

      // Create new service instance
      const service2 = new TemplateCacheService(mockSettingsService);
      await service2.onModuleInit();

      expect(service2.isCached('test-template', '1.0.0')).toBe(true);
      expect(service2.listCached()).toHaveLength(1);
    });

    it('should handle corrupted index JSON gracefully', async () => {
      // Write corrupted index file
      const indexPath = path.join(tempDir, 'index.json');
      await fs.mkdir(tempDir, { recursive: true });
      await fs.writeFile(indexPath, 'not valid json {{{');

      // Create new service instance - should use empty index
      const service2 = new TemplateCacheService(mockSettingsService);
      await service2.onModuleInit();

      // Should still work with empty index
      expect(service2.listCached()).toHaveLength(0);
      expect(service2.isCached('any', '1.0.0')).toBe(false);
    });
  });

  describe('semver version handling', () => {
    it('should correctly identify 10.0.0 as newer than 9.0.0', async () => {
      const content = { prompts: [] };

      // Add 9.0.0 first
      await service.saveTemplate('test-template', '9.0.0', content, {
        cachedAt: new Date().toISOString(),
        checksum: 'v9',
        size: 10,
      });

      // Add 10.0.0 - should be identified as latest
      await service.saveTemplate('test-template', '10.0.0', content, {
        cachedAt: new Date().toISOString(),
        checksum: 'v10',
        size: 10,
      });

      const index = service.getIndex();
      expect(index.templates['test-template'].latestVersion).toBe('10.0.0');

      // Also check listCached returns correct latestCached
      const cached = service.listCached();
      const template = cached.find((t) => t.slug === 'test-template');
      expect(template?.latestCached).toBe('10.0.0');
    });

    it('should handle versions added out of order', async () => {
      const content = { prompts: [] };

      // Add versions out of semver order
      await service.saveTemplate('test-template', '2.0.0', content, {
        cachedAt: new Date().toISOString(),
        checksum: 'v2',
        size: 10,
      });

      await service.saveTemplate('test-template', '1.0.0', content, {
        cachedAt: new Date().toISOString(),
        checksum: 'v1',
        size: 10,
      });

      await service.saveTemplate('test-template', '10.0.0', content, {
        cachedAt: new Date().toISOString(),
        checksum: 'v10',
        size: 10,
      });

      const index = service.getIndex();
      expect(index.templates['test-template'].latestVersion).toBe('10.0.0');
    });

    it('should handle pre-release versions correctly (1.0.0 > 1.0.0-beta)', async () => {
      const content = { prompts: [] };

      await service.saveTemplate('test-template', '1.0.0-beta', content, {
        cachedAt: new Date().toISOString(),
        checksum: 'beta',
        size: 10,
      });

      await service.saveTemplate('test-template', '1.0.0', content, {
        cachedAt: new Date().toISOString(),
        checksum: 'stable',
        size: 10,
      });

      const index = service.getIndex();
      // 1.0.0 should be latest (pre-release has lower precedence)
      expect(index.templates['test-template'].latestVersion).toBe('1.0.0');
    });

    it('should update latestVersion correctly after removing latest version', async () => {
      const content = { prompts: [] };

      await service.saveTemplate('test-template', '1.0.0', content, {
        cachedAt: new Date().toISOString(),
        checksum: 'v1',
        size: 10,
      });

      await service.saveTemplate('test-template', '9.0.0', content, {
        cachedAt: new Date().toISOString(),
        checksum: 'v9',
        size: 10,
      });

      await service.saveTemplate('test-template', '10.0.0', content, {
        cachedAt: new Date().toISOString(),
        checksum: 'v10',
        size: 10,
      });

      // Remove latest (10.0.0)
      await service.removeVersion('test-template', '10.0.0');

      const index = service.getIndex();
      // Should now be 9.0.0, not 1.0.0 (which would be lexicographically "largest")
      expect(index.templates['test-template'].latestVersion).toBe('9.0.0');
    });

    it('should handle patch version ordering correctly', async () => {
      const content = { prompts: [] };

      await service.saveTemplate('test-template', '1.0.9', content, {
        cachedAt: new Date().toISOString(),
        checksum: 'v1.0.9',
        size: 10,
      });

      await service.saveTemplate('test-template', '1.0.10', content, {
        cachedAt: new Date().toISOString(),
        checksum: 'v1.0.10',
        size: 10,
      });

      const index = service.getIndex();
      expect(index.templates['test-template'].latestVersion).toBe('1.0.10');
    });
  });
});
