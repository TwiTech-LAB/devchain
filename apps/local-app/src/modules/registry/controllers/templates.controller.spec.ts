import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { TemplatesController } from './templates.controller';
import { UnifiedTemplateService, UnifiedTemplateInfo } from '../services/unified-template.service';
import { TemplateCacheService } from '../services/template-cache.service';
import { ValidationError, NotFoundError, ForbiddenError } from '../../../common/errors/error-types';

describe('TemplatesController', () => {
  let controller: TemplatesController;
  let mockUnifiedTemplateService: jest.Mocked<UnifiedTemplateService>;
  let mockCacheService: jest.Mocked<TemplateCacheService>;

  const mockTemplates: UnifiedTemplateInfo[] = [
    {
      slug: 'bundled-template',
      name: 'Bundled Template',
      description: null,
      source: 'bundled',
      versions: null,
      latestVersion: null,
    },
    {
      slug: 'registry-template',
      name: 'Registry Template',
      description: null,
      source: 'registry',
      versions: ['1.0.0', '2.0.0'],
      latestVersion: '2.0.0',
    },
  ];

  beforeEach(async () => {
    mockUnifiedTemplateService = {
      listTemplates: jest.fn(),
      getTemplate: jest.fn(),
      getTemplateFromFilePath: jest.fn(),
      hasTemplate: jest.fn(),
      hasVersion: jest.fn(),
    } as unknown as jest.Mocked<UnifiedTemplateService>;

    mockCacheService = {
      isCached: jest.fn(),
      removeVersion: jest.fn(),
    } as unknown as jest.Mocked<TemplateCacheService>;

    const module: TestingModule = await Test.createTestingModule({
      controllers: [TemplatesController],
      providers: [
        { provide: UnifiedTemplateService, useValue: mockUnifiedTemplateService },
        { provide: TemplateCacheService, useValue: mockCacheService },
      ],
    }).compile();

    controller = module.get<TemplatesController>(TemplatesController);
  });

  describe('getTemplate', () => {
    it('should return registry template details with versions', async () => {
      mockUnifiedTemplateService.listTemplates.mockReturnValue(mockTemplates);
      mockUnifiedTemplateService.getTemplate.mockResolvedValue({
        content: { name: 'Registry Template' },
        source: 'registry',
        version: '2.0.0',
      });

      const result = await controller.getTemplate('registry-template');

      expect(result).toEqual({
        slug: 'registry-template',
        name: 'Registry Template',
        description: null,
        source: 'registry',
        versions: ['1.0.0', '2.0.0'],
        latestVersion: '2.0.0',
        content: { name: 'Registry Template' },
      });
    });

    it.each([
      {
        name: 'controller.getTemplate BadRequestException',
        mock: () => mockUnifiedTemplateService.getTemplate,
        error: new ValidationError('Invalid template slug'),
        invoke: () => controller.getTemplate('../bad-slug'),
        exception: BadRequestException,
      },
      {
        name: 'controller.getTemplate NotFoundException',
        mock: () => mockUnifiedTemplateService.getTemplate,
        error: new NotFoundError('Template', 'non-existent'),
        invoke: () => controller.getTemplate('non-existent'),
        exception: NotFoundException,
      },
      {
        name: 'controller.getTemplateVersion BadRequestException',
        mock: () => mockUnifiedTemplateService.getTemplate,
        error: new ValidationError('Invalid version format'),
        invoke: () => controller.getTemplateVersion('my-template', 'invalid'),
        exception: BadRequestException,
      },
      {
        name: 'controller.getTemplateVersion NotFoundException',
        mock: () => mockUnifiedTemplateService.getTemplate,
        error: new NotFoundError('Template', 'my-template@999.0.0'),
        invoke: () => controller.getTemplateVersion('my-template', '999.0.0'),
        exception: NotFoundException,
      },
      {
        name: 'controller.previewTemplate NotFoundException',
        mock: () => mockUnifiedTemplateService.getTemplateFromFilePath,
        error: new NotFoundError('Template file', '/missing'),
        invoke: () => controller.previewTemplate({ templatePath: '/missing/file.json' }),
        exception: NotFoundException,
      },
    ])('maps $name', async ({ mock, error, invoke, exception }) => {
      mockUnifiedTemplateService.listTemplates.mockReturnValue([]);
      mock().mockImplementation(() => {
        throw error;
      });
      await expect(invoke()).rejects.toThrow(exception);
    });
  });

  describe('deleteTemplateVersion', () => {
    it('should delete cached version successfully', async () => {
      mockCacheService.isCached.mockReturnValue(true);
      mockCacheService.removeVersion.mockResolvedValue(undefined);

      const result = await controller.deleteTemplateVersion('my-template', '1.0.0');

      expect(result).toEqual({
        success: true,
        message: 'Template version my-template@1.0.0 removed from cache',
      });
      expect(mockCacheService.removeVersion).toHaveBeenCalledWith('my-template', '1.0.0');
    });

    it('should throw BadRequestException for invalid slug (path traversal)', async () => {
      await expect(controller.deleteTemplateVersion('../bad', '1.0.0')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException for slug with special characters', async () => {
      await expect(controller.deleteTemplateVersion('slug.with.dots', '1.0.0')).rejects.toThrow(
        BadRequestException,
      );
      await expect(controller.deleteTemplateVersion('slug/path', '1.0.0')).rejects.toThrow(
        BadRequestException,
      );
      await expect(controller.deleteTemplateVersion('slug@version', '1.0.0')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException for invalid version format', async () => {
      await expect(controller.deleteTemplateVersion('my-template', 'invalid')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw NotFoundException for non-cached version', async () => {
      mockCacheService.isCached.mockReturnValue(false);

      await expect(controller.deleteTemplateVersion('my-template', '1.0.0')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('POST /preview', () => {
    const validContent = {
      version: 1,
      exportedAt: '2024-01-01T00:00:00Z',
      statuses: [{ label: 'New', color: '#000', position: 0 }],
      profiles: [],
      agents: [],
      prompts: [],
    };

    it('returns parsed payload for slug-based template', async () => {
      mockUnifiedTemplateService.getTemplate.mockResolvedValue({
        content: validContent,
        source: 'bundled',
        version: null,
      });

      const result = await controller.previewTemplate({ slug: 'teams-dev' });
      expect(result).toHaveProperty('statuses');
      expect(mockUnifiedTemplateService.getTemplate).toHaveBeenCalledWith('teams-dev', undefined);
    });

    it('returns parsed payload for templatePath-based template', async () => {
      mockUnifiedTemplateService.getTemplateFromFilePath.mockReturnValue({
        content: validContent,
        source: 'file',
        version: null,
      });

      const result = await controller.previewTemplate({ templatePath: '/tmp/test.json' });
      expect(result).toHaveProperty('statuses');
      expect(mockUnifiedTemplateService.getTemplateFromFilePath).toHaveBeenCalledWith(
        '/tmp/test.json',
      );
    });

    it('throws 400 when invalid template content', async () => {
      mockUnifiedTemplateService.getTemplate.mockResolvedValue({
        content: { invalid: true },
        source: 'bundled',
        version: null,
      });

      await expect(controller.previewTemplate({ slug: 'bad' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it.each([
      { name: 'both sources', body: { slug: 'x', templatePath: '/tmp/y.json' } },
      { name: 'neither source', body: {} },
    ])('rejects preview with $name', async ({ body }) => {
      await expect(controller.previewTemplate(body)).rejects.toThrow(BadRequestException);
    });

    it('throws 403 for path traversal attempt', async () => {
      mockUnifiedTemplateService.getTemplateFromFilePath.mockImplementation(() => {
        throw new ForbiddenError('Path traversal rejected');
      });

      await expect(controller.previewTemplate({ templatePath: '/etc/../secrets' })).rejects.toThrow(
        ForbiddenException,
      );
    });
  });
});
