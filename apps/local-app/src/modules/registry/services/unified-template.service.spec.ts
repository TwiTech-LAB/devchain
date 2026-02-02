// Mock modules before imports - order matters!
jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readdirSync: jest.fn(),
  readFileSync: jest.fn(),
}));

jest.mock('../../../common/config/env.config', () => ({
  getEnvConfig: jest.fn(() => ({})),
}));

// Mock settings service to break the import chain to better-sqlite3
jest.mock('../../settings/services/settings.service', () => ({
  SettingsService: jest.fn().mockImplementation(() => ({
    getRegistryConfig: jest.fn().mockReturnValue({
      url: 'https://test.registry.com',
      cacheDir: '/tmp/test-cache',
    }),
  })),
}));

// Now mock the cache service
jest.mock('./template-cache.service', () => ({
  TemplateCacheService: jest.fn(),
  CachedTemplateInfo: {},
  CachedTemplate: {},
}));

import { UnifiedTemplateService } from './unified-template.service';
import { TemplateCacheService } from './template-cache.service';
import { NotFoundError, ValidationError, StorageError } from '../../../common/errors/error-types';
import * as fs from 'fs';
import * as devchainShared from '@devchain/shared';

// Define CachedTemplate interface for test use
interface CachedTemplate {
  content: Record<string, unknown>;
  metadata: {
    slug: string;
    version: string;
    cachedAt: string;
    checksum: string;
    size: number;
  };
}

describe('UnifiedTemplateService', () => {
  let service: UnifiedTemplateService;
  let mockCacheService: jest.Mocked<TemplateCacheService>;

  const mockExistsSyncFn = fs.existsSync as jest.Mock;
  const mockReaddirSyncFn = fs.readdirSync as jest.Mock;
  const mockReadFileSyncFn = fs.readFileSync as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();

    // Create mock cache service
    mockCacheService = {
      listCached: jest.fn(),
      getTemplate: jest.fn(),
      isCached: jest.fn(),
    } as unknown as jest.Mocked<TemplateCacheService>;

    service = new UnifiedTemplateService(mockCacheService);

    // Default: templates directory exists
    mockExistsSyncFn.mockImplementation((p: string) => {
      if (p.includes('templates') && !p.endsWith('.json')) {
        return true;
      }
      return false;
    });
  });

  describe('listTemplates', () => {
    it('should return bundled templates when no downloaded templates exist', () => {
      mockReaddirSyncFn.mockReturnValue(['simple-codex.json', 'claude-opus.json']);
      mockCacheService.listCached.mockReturnValue([]);

      const result = service.listTemplates();

      expect(result).toHaveLength(2);
      expect(result).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            slug: 'simple-codex',
            name: 'Simple Codex',
            source: 'bundled',
            versions: null,
            latestVersion: null,
          }),
          expect.objectContaining({
            slug: 'claude-opus',
            name: 'Claude Opus',
            source: 'bundled',
            versions: null,
            latestVersion: null,
          }),
        ]),
      );
    });

    it('should return downloaded templates when no bundled templates exist', () => {
      mockExistsSyncFn.mockReturnValue(false); // No templates directory
      mockCacheService.listCached.mockReturnValue([
        { slug: 'my-template', versions: ['1.0.0', '2.0.0'], latestCached: '2.0.0' },
      ]);

      const result = service.listTemplates();

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        slug: 'my-template',
        name: 'My Template',
        description: null,
        source: 'registry',
        versions: ['1.0.0', '2.0.0'],
        latestVersion: '2.0.0',
      });
    });

    it('should merge bundled and downloaded templates', () => {
      mockReaddirSyncFn.mockReturnValue(['bundled-only.json']);
      mockCacheService.listCached.mockReturnValue([
        { slug: 'downloaded-only', versions: ['1.0.0'], latestCached: '1.0.0' },
      ]);

      const result = service.listTemplates();

      expect(result).toHaveLength(2);
      expect(result.find((t) => t.slug === 'bundled-only')).toBeDefined();
      expect(result.find((t) => t.slug === 'downloaded-only')).toBeDefined();
    });

    it('should deduplicate by slug, downloaded takes precedence', () => {
      mockReaddirSyncFn.mockReturnValue(['shared-template.json']);
      mockCacheService.listCached.mockReturnValue([
        { slug: 'shared-template', versions: ['1.0.0', '2.0.0'], latestCached: '2.0.0' },
      ]);

      const result = service.listTemplates();

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        slug: 'shared-template',
        name: 'Shared Template',
        description: null,
        source: 'registry', // Downloaded takes precedence
        versions: ['1.0.0', '2.0.0'],
        latestVersion: '2.0.0',
      });
    });

    it('should sort templates by name', () => {
      mockReaddirSyncFn.mockReturnValue(['zebra-template.json', 'alpha-template.json']);
      mockCacheService.listCached.mockReturnValue([]);

      const result = service.listTemplates();

      expect(result[0].slug).toBe('alpha-template');
      expect(result[1].slug).toBe('zebra-template');
    });

    it('should convert slug to title case correctly', () => {
      mockReaddirSyncFn.mockReturnValue(['claude-codex-advanced.json']);
      mockCacheService.listCached.mockReturnValue([]);

      const result = service.listTemplates();

      expect(result[0].name).toBe('Claude Codex Advanced');
    });

    it('should extract _manifest fields from bundled templates', () => {
      mockReaddirSyncFn.mockReturnValue(['my-template.json']);
      mockReadFileSyncFn.mockReturnValue(
        JSON.stringify({
          _manifest: {
            name: 'My Custom Template',
            description: 'A great template for testing',
            category: 'development',
            tags: ['ai', 'testing'],
            authorName: 'Test Author',
            isOfficial: true,
          },
          prompts: [],
          profiles: [],
        }),
      );
      mockCacheService.listCached.mockReturnValue([]);

      const result = service.listTemplates();

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        slug: 'my-template',
        name: 'My Custom Template',
        description: 'A great template for testing',
        source: 'bundled',
        versions: null,
        latestVersion: null,
        category: 'development',
        tags: ['ai', 'testing'],
        authorName: 'Test Author',
        isOfficial: true,
      });
    });

    it('should extract version from _manifest for bundled templates', () => {
      mockReaddirSyncFn.mockReturnValue(['versioned-template.json']);
      mockReadFileSyncFn.mockReturnValue(
        JSON.stringify({
          _manifest: {
            name: 'Versioned Template',
            description: 'Template with version',
            version: '1.0.0',
          },
          prompts: [],
          profiles: [],
        }),
      );
      mockCacheService.listCached.mockReturnValue([]);

      const result = service.listTemplates();

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        slug: 'versioned-template',
        name: 'Versioned Template',
        description: 'Template with version',
        source: 'bundled',
        versions: ['1.0.0'],
        latestVersion: '1.0.0',
      });
    });

    it('should return null versions when _manifest has no version field', () => {
      mockReaddirSyncFn.mockReturnValue(['no-version-template.json']);
      mockReadFileSyncFn.mockReturnValue(
        JSON.stringify({
          _manifest: {
            name: 'No Version Template',
            description: 'Template without version',
            // No version field
          },
          prompts: [],
          profiles: [],
        }),
      );
      mockCacheService.listCached.mockReturnValue([]);

      const result = service.listTemplates();

      expect(result).toHaveLength(1);
      expect(result[0].versions).toBeNull();
      expect(result[0].latestVersion).toBeNull();
    });

    it('should fallback to slug-derived name when _manifest is missing', () => {
      mockReaddirSyncFn.mockReturnValue(['fallback-template.json']);
      mockReadFileSyncFn.mockReturnValue(
        JSON.stringify({
          prompts: [],
          profiles: [],
          // No _manifest field
        }),
      );
      mockCacheService.listCached.mockReturnValue([]);

      const result = service.listTemplates();

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Fallback Template');
      expect(result[0].description).toBeNull();
      expect(result[0].category).toBeUndefined();
      expect(result[0].tags).toBeUndefined();
    });

    it('should fallback to slug-derived name when template parsing fails', () => {
      mockReaddirSyncFn.mockReturnValue(['broken-template.json']);
      mockReadFileSyncFn.mockReturnValue('{ invalid json }');
      mockCacheService.listCached.mockReturnValue([]);

      const result = service.listTemplates();

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        slug: 'broken-template',
        name: 'Broken Template',
        description: null,
        source: 'bundled',
        versions: null,
        latestVersion: null,
      });
    });

    it('should use _manifest.name over slug-derived name', () => {
      mockReaddirSyncFn.mockReturnValue(['my-slug.json']);
      mockReadFileSyncFn.mockReturnValue(
        JSON.stringify({
          _manifest: {
            name: 'Completely Different Name',
          },
          prompts: [],
        }),
      );
      mockCacheService.listCached.mockReturnValue([]);

      const result = service.listTemplates();

      expect(result[0].name).toBe('Completely Different Name');
    });
  });

  describe('getTemplate', () => {
    beforeEach(() => {
      mockExistsSyncFn.mockImplementation((p: string) => {
        if (p.includes('templates') && !p.endsWith('.json')) {
          return true;
        }
        if (p.endsWith('bundled-template.json')) {
          return true;
        }
        return false;
      });
    });

    it('should return downloaded template when version is specified', async () => {
      const mockCachedTemplate: CachedTemplate = {
        content: { name: 'Test Template', agents: [] },
        metadata: {
          slug: 'my-template',
          version: '1.0.0',
          cachedAt: '2024-01-01T00:00:00Z',
          checksum: 'abc123',
          size: 1000,
        },
      };
      mockCacheService.getTemplate.mockResolvedValue(mockCachedTemplate);

      const result = await service.getTemplate('my-template', '1.0.0');

      // Slug is injected into _manifest for template metadata tracking
      expect(result).toEqual({
        content: { name: 'Test Template', agents: [], _manifest: { slug: 'my-template' } },
        source: 'registry',
        version: '1.0.0',
      });
      expect(mockCacheService.getTemplate).toHaveBeenCalledWith('my-template', '1.0.0');
    });

    it('should throw NotFoundError when specified version not in cache', async () => {
      mockCacheService.getTemplate.mockResolvedValue(null);

      await expect(service.getTemplate('my-template', '1.0.0')).rejects.toThrow(NotFoundError);
    });

    it('should return latest downloaded version when no version specified and downloaded exists', async () => {
      mockCacheService.listCached.mockReturnValue([
        { slug: 'my-template', versions: ['1.0.0', '2.0.0'], latestCached: '2.0.0' },
      ]);
      const mockCachedTemplate: CachedTemplate = {
        content: { name: 'Latest Template' },
        metadata: {
          slug: 'my-template',
          version: '2.0.0',
          cachedAt: '2024-01-01T00:00:00Z',
          checksum: 'abc123',
          size: 1000,
        },
      };
      mockCacheService.getTemplate.mockResolvedValue(mockCachedTemplate);

      const result = await service.getTemplate('my-template');

      expect(result.version).toBe('2.0.0');
      expect(result.source).toBe('registry');
      expect(mockCacheService.getTemplate).toHaveBeenCalledWith('my-template', '2.0.0');
    });

    it('should return bundled template when no version specified and not downloaded', async () => {
      mockCacheService.listCached.mockReturnValue([]);
      mockExistsSyncFn.mockImplementation((p: string) => {
        if (p.includes('templates') && !p.endsWith('.json')) {
          return true;
        }
        if (p.endsWith('bundled-template.json')) {
          return true;
        }
        return false;
      });
      mockReadFileSyncFn.mockReturnValue('{"name": "Bundled Template"}');

      const result = await service.getTemplate('bundled-template');

      // Slug is injected into _manifest for template metadata tracking
      expect(result).toEqual({
        content: { name: 'Bundled Template', _manifest: { slug: 'bundled-template' } },
        source: 'bundled',
        version: null,
      });
    });

    it('should preserve _manifest in bundled template content and inject slug', async () => {
      mockCacheService.listCached.mockReturnValue([]);
      mockExistsSyncFn.mockImplementation((p: string) => {
        if (p.includes('templates') && !p.endsWith('.json')) {
          return true;
        }
        if (p.endsWith('manifest-template.json')) {
          return true;
        }
        return false;
      });
      const templateWithManifest = {
        _manifest: {
          name: 'Template With Manifest',
          description: 'Has embedded manifest',
          category: 'development',
          tags: ['test'],
          authorName: 'Test Author',
          isOfficial: false,
        },
        prompts: [{ title: 'Test', content: 'Hello' }],
        profiles: [],
      };
      mockReadFileSyncFn.mockReturnValue(JSON.stringify(templateWithManifest));

      const result = await service.getTemplate('manifest-template');

      expect(result.content._manifest).toBeDefined();
      expect((result.content._manifest as Record<string, unknown>).name).toBe(
        'Template With Manifest',
      );
      // Slug should be injected into _manifest for template metadata tracking
      expect((result.content._manifest as Record<string, unknown>).slug).toBe('manifest-template');
    });

    it('should throw NotFoundError for non-existent bundled template', async () => {
      mockCacheService.listCached.mockReturnValue([]);
      mockExistsSyncFn.mockImplementation((p: string) => {
        if (p.includes('templates') && !p.endsWith('.json')) {
          return true;
        }
        return false;
      });

      await expect(service.getTemplate('non-existent')).rejects.toThrow(NotFoundError);
    });

    it('should throw ValidationError when bundled template contains invalid JSON', async () => {
      mockCacheService.listCached.mockReturnValue([]);
      mockExistsSyncFn.mockImplementation((p: string) => {
        if (p.includes('templates') && !p.endsWith('.json')) {
          return true;
        }
        if (p.endsWith('malformed-template.json')) {
          return true;
        }
        return false;
      });
      mockReadFileSyncFn.mockReturnValue('{ invalid json }');

      await expect(service.getTemplate('malformed-template')).rejects.toThrow(ValidationError);
      await expect(service.getTemplate('malformed-template')).rejects.toThrow(/invalid JSON/);
    });

    it('should throw StorageError when bundled template file cannot be read', async () => {
      mockCacheService.listCached.mockReturnValue([]);
      mockExistsSyncFn.mockImplementation((p: string) => {
        if (p.includes('templates') && !p.endsWith('.json')) {
          return true;
        }
        if (p.endsWith('unreadable-template.json')) {
          return true;
        }
        return false;
      });

      // Simulate file read error (e.g., permission denied)
      const readError = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
      readError.code = 'EACCES';
      mockReadFileSyncFn.mockImplementation(() => {
        throw readError;
      });

      await expect(service.getTemplate('unreadable-template')).rejects.toThrow(StorageError);
      await expect(service.getTemplate('unreadable-template')).rejects.toThrow(/Failed to read/);
    });
  });

  describe('validation', () => {
    it('should reject invalid slug with special characters', async () => {
      await expect(service.getTemplate('../etc/passwd')).rejects.toThrow(ValidationError);
      await expect(service.getTemplate('template/nested')).rejects.toThrow(ValidationError);
      await expect(service.getTemplate('template.with.dots')).rejects.toThrow(ValidationError);
    });

    it('should accept valid slug (alphanumeric + hyphens)', async () => {
      mockCacheService.listCached.mockReturnValue([]);
      mockExistsSyncFn.mockReturnValue(false);

      // Should not throw ValidationError, will throw NotFoundError instead
      await expect(service.getTemplate('valid-slug')).rejects.toThrow(NotFoundError);
      await expect(service.getTemplate('valid123')).rejects.toThrow(NotFoundError);
      await expect(service.getTemplate('my-template-name')).rejects.toThrow(NotFoundError);
    });

    it('should allow slugs with underscores', async () => {
      mockCacheService.listCached.mockReturnValue([]);
      mockExistsSyncFn.mockReturnValue(false);

      // Underscores are now allowed in slugs
      // This should proceed to template lookup (and throw NotFoundError since not found)
      await expect(service.getTemplate('valid_slug')).rejects.toThrow(NotFoundError);
    });

    it('should reject invalid version format', async () => {
      await expect(service.getTemplate('my-template', 'invalid')).rejects.toThrow(ValidationError);
      await expect(service.getTemplate('my-template', '1.0')).rejects.toThrow(ValidationError);
      await expect(service.getTemplate('my-template', 'v1.0.0')).rejects.toThrow(ValidationError);
    });

    it('should allow prerelease and build metadata versions', async () => {
      // Prerelease and build metadata are now allowed
      // These should proceed to template lookup (and throw NotFoundError since not found)
      await expect(service.getTemplate('my-template', '1.0.0-alpha')).rejects.toThrow(
        NotFoundError,
      );
      await expect(service.getTemplate('my-template', '1.0.0+build')).rejects.toThrow(
        NotFoundError,
      );
    });

    it('should accept valid semver versions (major.minor.patch only)', async () => {
      mockCacheService.getTemplate.mockResolvedValue(null);

      // Should not throw ValidationError, will throw NotFoundError instead
      await expect(service.getTemplate('my-template', '1.0.0')).rejects.toThrow(NotFoundError);
      await expect(service.getTemplate('my-template', '2.10.3')).rejects.toThrow(NotFoundError);
      await expect(service.getTemplate('my-template', '0.0.1')).rejects.toThrow(NotFoundError);
    });
  });

  describe('hasTemplate', () => {
    it('should return true for downloaded template', () => {
      mockCacheService.listCached.mockReturnValue([
        { slug: 'my-template', versions: ['1.0.0'], latestCached: '1.0.0' },
      ]);

      expect(service.hasTemplate('my-template')).toBe(true);
    });

    it('should return true for bundled template', () => {
      mockCacheService.listCached.mockReturnValue([]);
      mockExistsSyncFn.mockImplementation((p: string) => {
        if (p.includes('templates') && !p.endsWith('.json')) {
          return true;
        }
        if (p.endsWith('bundled-template.json')) {
          return true;
        }
        return false;
      });

      expect(service.hasTemplate('bundled-template')).toBe(true);
    });

    it('should return false for non-existent template', () => {
      mockCacheService.listCached.mockReturnValue([]);
      mockExistsSyncFn.mockImplementation((p: string) => {
        if (p.includes('templates') && !p.endsWith('.json')) {
          return true;
        }
        return false;
      });

      expect(service.hasTemplate('non-existent')).toBe(false);
    });
  });

  describe('hasVersion', () => {
    it('should delegate to cache service', () => {
      mockCacheService.isCached.mockReturnValue(true);

      expect(service.hasVersion('my-template', '1.0.0')).toBe(true);
      expect(mockCacheService.isCached).toHaveBeenCalledWith('my-template', '1.0.0');
    });

    it('should validate slug and version', () => {
      expect(() => service.hasVersion('../bad', '1.0.0')).toThrow(ValidationError);
      expect(() => service.hasVersion('good', 'bad-version')).toThrow(ValidationError);
    });
  });

  describe('getTemplateFromFilePath', () => {
    const validTemplateContent = {
      version: 1,
      prompts: [],
      profiles: [],
      agents: [],
      statuses: [],
    };

    it('should return correct content and source: file for valid template', () => {
      mockExistsSyncFn.mockReturnValue(true);
      mockReadFileSyncFn.mockReturnValue(JSON.stringify(validTemplateContent));

      const result = service.getTemplateFromFilePath('/absolute/path/to/my-template.json');

      expect(result.source).toBe('file');
      expect(result.content).toMatchObject(validTemplateContent);
    });

    it('should return version from _manifest.version when present', () => {
      const templateWithVersion = {
        ...validTemplateContent,
        _manifest: { name: 'Test', version: '2.5.0' },
      };

      // Mock ExportSchema.parse to return valid parsed output
      jest.spyOn(devchainShared.ExportSchema, 'parse').mockReturnValue({
        ...templateWithVersion,
        watchers: [],
        subscribers: [],
      } as ReturnType<typeof devchainShared.ExportSchema.parse>);

      mockExistsSyncFn.mockReturnValue(true);
      mockReadFileSyncFn.mockReturnValue(JSON.stringify(templateWithVersion));

      const result = service.getTemplateFromFilePath('/path/to/template.json');

      expect(result.version).toBe('2.5.0');

      jest.restoreAllMocks();
    });

    it('should return null version when _manifest.version is absent', () => {
      mockExistsSyncFn.mockReturnValue(true);
      mockReadFileSyncFn.mockReturnValue(JSON.stringify(validTemplateContent));

      const result = service.getTemplateFromFilePath('/path/to/template.json');

      expect(result.version).toBeNull();
    });

    it('should derive slug from filename when _manifest.slug is absent', () => {
      mockExistsSyncFn.mockReturnValue(true);
      mockReadFileSyncFn.mockReturnValue(JSON.stringify(validTemplateContent));

      const result = service.getTemplateFromFilePath('/some/path/my-custom-template.json');

      const manifest = result.content._manifest as Record<string, unknown>;
      expect(manifest.slug).toBe('my-custom-template');
    });

    it('should use _manifest.slug when present', () => {
      const templateWithSlug = {
        ...validTemplateContent,
        _manifest: { slug: 'manifest-defined-slug', name: 'Test' },
      };

      // Mock ExportSchema.parse to return valid parsed output
      jest.spyOn(devchainShared.ExportSchema, 'parse').mockReturnValue({
        ...templateWithSlug,
        watchers: [],
        subscribers: [],
      } as ReturnType<typeof devchainShared.ExportSchema.parse>);

      mockExistsSyncFn.mockReturnValue(true);
      mockReadFileSyncFn.mockReturnValue(JSON.stringify(templateWithSlug));

      const result = service.getTemplateFromFilePath('/different/path/filename.json');

      const manifest = result.content._manifest as Record<string, unknown>;
      expect(manifest.slug).toBe('manifest-defined-slug');

      jest.restoreAllMocks();
    });

    it('should inject slug into existing _manifest when _manifest.slug is absent', () => {
      const templateWithPartialManifest = {
        ...validTemplateContent,
        _manifest: { name: 'Test Template', version: '1.0.0' },
      };

      // Mock ExportSchema.parse to return valid parsed output
      jest.spyOn(devchainShared.ExportSchema, 'parse').mockReturnValue({
        ...templateWithPartialManifest,
        watchers: [],
        subscribers: [],
      } as ReturnType<typeof devchainShared.ExportSchema.parse>);

      mockExistsSyncFn.mockReturnValue(true);
      mockReadFileSyncFn.mockReturnValue(JSON.stringify(templateWithPartialManifest));

      const result = service.getTemplateFromFilePath('/path/to/derived-slug.json');

      const manifest = result.content._manifest as Record<string, unknown>;
      expect(manifest.slug).toBe('derived-slug');
      expect(manifest.name).toBe('Test Template'); // Preserve existing fields
      expect(manifest.version).toBe('1.0.0');

      jest.restoreAllMocks();
    });

    it('should reject relative paths with ValidationError', () => {
      expect(() => service.getTemplateFromFilePath('relative/path.json')).toThrow(ValidationError);
      expect(() => service.getTemplateFromFilePath('relative/path.json')).toThrow(/absolute path/i);
    });

    it('should normalize paths before processing', () => {
      // Verify that path normalization occurs by testing a valid absolute path
      // Note: On Unix, normalize('/path/../etc/passwd') = '/etc/passwd' (no .. remains)
      // The path traversal check catches edge cases where .. might persist after normalization
      mockExistsSyncFn.mockReturnValue(true);
      mockReadFileSyncFn.mockReturnValue(JSON.stringify(validTemplateContent));

      // Path with redundant separators and dots should work after normalization
      const result = service.getTemplateFromFilePath('/path/./to/./template.json');

      expect(result.source).toBe('file');
    });

    it('should throw NotFoundError for non-existent file', () => {
      mockExistsSyncFn.mockReturnValue(false);

      expect(() => service.getTemplateFromFilePath('/path/to/nonexistent.json')).toThrow(
        NotFoundError,
      );
    });

    it('should throw ValidationError for invalid JSON', () => {
      mockExistsSyncFn.mockReturnValue(true);
      mockReadFileSyncFn.mockReturnValue('{ invalid json }');

      expect(() => service.getTemplateFromFilePath('/path/to/invalid.json')).toThrow(
        ValidationError,
      );
      expect(() => service.getTemplateFromFilePath('/path/to/invalid.json')).toThrow(
        /invalid JSON/i,
      );
    });

    it('should throw ValidationError for non-ExportSchema-compliant JSON', () => {
      const invalidSchema = {
        notAValidField: 'value',
        // Missing required fields like prompts, profiles, etc.
      };
      mockExistsSyncFn.mockReturnValue(true);
      mockReadFileSyncFn.mockReturnValue(JSON.stringify(invalidSchema));

      expect(() => service.getTemplateFromFilePath('/path/to/bad-schema.json')).toThrow(
        ValidationError,
      );
      expect(() => service.getTemplateFromFilePath('/path/to/bad-schema.json')).toThrow(/schema/i);
    });

    it('should throw StorageError for file read errors', () => {
      mockExistsSyncFn.mockReturnValue(true);
      const readError = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
      readError.code = 'EACCES';
      mockReadFileSyncFn.mockImplementation(() => {
        throw readError;
      });

      expect(() => service.getTemplateFromFilePath('/path/to/protected.json')).toThrow(
        StorageError,
      );
    });

    it('should not leak file paths in error messages for NotFoundError', () => {
      mockExistsSyncFn.mockReturnValue(false);

      try {
        service.getTemplateFromFilePath('/secret/path/to/template.json');
        fail('Expected NotFoundError');
      } catch (error) {
        expect(error).toBeInstanceOf(NotFoundError);
        const errorMessage = (error as Error).message;
        // Should not contain the actual path
        expect(errorMessage).not.toContain('/secret/path');
        expect(errorMessage).not.toContain('template.json');
      }
    });

    it('should not leak file paths in error messages for ValidationError', () => {
      mockExistsSyncFn.mockReturnValue(true);
      mockReadFileSyncFn.mockReturnValue('{ invalid json }');

      try {
        service.getTemplateFromFilePath('/private/location/file.json');
        fail('Expected ValidationError');
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
        const errorMessage = (error as Error).message;
        // Should not contain the actual path
        expect(errorMessage).not.toContain('/private/location');
        expect(errorMessage).not.toContain('file.json');
      }
    });

    it('should not leak file paths in error messages for StorageError', () => {
      mockExistsSyncFn.mockReturnValue(true);
      const readError = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
      readError.code = 'EACCES';
      mockReadFileSyncFn.mockImplementation(() => {
        throw readError;
      });

      try {
        service.getTemplateFromFilePath('/confidential/path/data.json');
        fail('Expected StorageError');
      } catch (error) {
        expect(error).toBeInstanceOf(StorageError);
        const errorMessage = (error as Error).message;
        // Should not contain the actual path
        expect(errorMessage).not.toContain('/confidential/path');
        expect(errorMessage).not.toContain('data.json');
      }
    });
  });
});
