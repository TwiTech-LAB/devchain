import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { TemplatesController } from './templates.controller';
import { UnifiedTemplateService, UnifiedTemplateInfo } from '../services/unified-template.service';
import { TemplateCacheService } from '../services/template-cache.service';
import { ValidationError, NotFoundError } from '../../../common/errors/error-types';

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

  describe('listTemplates', () => {
    it('should return list of templates with total count', () => {
      mockUnifiedTemplateService.listTemplates.mockReturnValue(mockTemplates);

      const result = controller.listTemplates();

      expect(result).toEqual({
        templates: mockTemplates,
        total: 2,
      });
      expect(mockUnifiedTemplateService.listTemplates).toHaveBeenCalled();
    });

    it('should return empty list when no templates exist', () => {
      mockUnifiedTemplateService.listTemplates.mockReturnValue([]);

      const result = controller.listTemplates();

      expect(result).toEqual({
        templates: [],
        total: 0,
      });
    });
  });

  describe('getTemplate', () => {
    it('should return bundled template details', async () => {
      mockUnifiedTemplateService.listTemplates.mockReturnValue(mockTemplates);
      mockUnifiedTemplateService.getTemplate.mockResolvedValue({
        content: { name: 'Bundled Template' },
        source: 'bundled',
        version: null,
      });

      const result = await controller.getTemplate('bundled-template');

      expect(result).toEqual({
        slug: 'bundled-template',
        name: 'Bundled Template',
        description: null,
        source: 'bundled',
        versions: null,
        latestVersion: null,
        content: { name: 'Bundled Template' },
      });
    });

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

    it('should throw BadRequestException for invalid slug', async () => {
      mockUnifiedTemplateService.listTemplates.mockReturnValue([]);
      mockUnifiedTemplateService.getTemplate.mockRejectedValue(
        new ValidationError('Invalid template slug'),
      );

      await expect(controller.getTemplate('../bad-slug')).rejects.toThrow(BadRequestException);
    });

    it('should throw NotFoundException for non-existent template', async () => {
      mockUnifiedTemplateService.listTemplates.mockReturnValue([]);
      mockUnifiedTemplateService.getTemplate.mockRejectedValue(
        new NotFoundError('Template', 'non-existent'),
      );

      await expect(controller.getTemplate('non-existent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('getTemplateVersion', () => {
    it('should return specific version content', async () => {
      mockUnifiedTemplateService.getTemplate.mockResolvedValue({
        content: { name: 'Template v1.0.0' },
        source: 'registry',
        version: '1.0.0',
      });

      const result = await controller.getTemplateVersion('my-template', '1.0.0');

      expect(result).toEqual({
        slug: 'my-template',
        version: '1.0.0',
        source: 'registry',
        content: { name: 'Template v1.0.0' },
      });
      expect(mockUnifiedTemplateService.getTemplate).toHaveBeenCalledWith('my-template', '1.0.0');
    });

    it('should throw BadRequestException for invalid version format', async () => {
      mockUnifiedTemplateService.getTemplate.mockRejectedValue(
        new ValidationError('Invalid version format'),
      );

      await expect(controller.getTemplateVersion('my-template', 'invalid')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw NotFoundException for non-existent version', async () => {
      mockUnifiedTemplateService.getTemplate.mockRejectedValue(
        new NotFoundError('Template', 'my-template@999.0.0'),
      );

      await expect(controller.getTemplateVersion('my-template', '999.0.0')).rejects.toThrow(
        NotFoundException,
      );
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

    it('should allow slugs with underscores', async () => {
      // Underscores are now allowed in slugs
      // This should proceed to cache check (and throw NotFoundException since not cached)
      await expect(controller.deleteTemplateVersion('valid_slug', '1.0.0')).rejects.toThrow(
        NotFoundException,
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
});
