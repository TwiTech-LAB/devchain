import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Query,
  Body,
  Inject,
  BadRequestException,
} from '@nestjs/common';
import { z } from 'zod';
import {
  StorageService,
  STORAGE_SERVICE,
  DocumentListFilters,
  ListResult,
} from '../../storage/interfaces/storage.interface';
import { Document, CreateDocument, UpdateDocument } from '../../storage/models/domain.models';
import { createLogger } from '../../../common/logging/logger';

const logger = createLogger('DocumentsController');

const CreateDocumentSchema = z.object({
  projectId: z.string().min(1).nullable().optional(),
  title: z.string().min(1),
  slug: z.string().min(1).optional(),
  contentMd: z.string(),
  tags: z.array(z.string()).optional(),
});

const UpdateDocumentSchema = z.object({
  title: z.string().min(1).optional(),
  slug: z.string().min(1).optional(),
  contentMd: z.string().optional(),
  tags: z.array(z.string()).optional(),
  version: z.number().int().optional(),
  archived: z.boolean().optional(),
});

@Controller('api/documents')
export class DocumentsController {
  constructor(@Inject(STORAGE_SERVICE) private readonly storage: StorageService) {}

  @Get()
  async listDocuments(
    @Query('projectId') projectId?: string,
    @Query('tag') tag?: string | string[],
    @Query('tags') tagsParam?: string,
    @Query('tagKey') tagKey?: string | string[],
    @Query('q') q?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<ListResult<Document>> {
    logger.info({ projectId, tag, tagsParam, tagKey, q, limit, offset }, 'GET /api/documents');

    const filters: DocumentListFilters = {};

    if (projectId !== undefined) {
      filters.projectId = projectId === '' ? null : projectId;
    }

    const combinedTags = [
      ...(Array.isArray(tag) ? tag : tag ? [tag] : []),
      ...(tagsParam ? tagsParam.split(',') : []),
    ]
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

    if (combinedTags.length) {
      filters.tags = Array.from(new Set(combinedTags));
    }

    const tagKeyValues = Array.isArray(tagKey) ? tagKey : tagKey ? [tagKey] : [];
    const normalizedTagKeys = tagKeyValues
      .flatMap((value) => value.split(','))
      .map((value) => value.trim())
      .filter((value) => value.length > 0);

    if (normalizedTagKeys.length) {
      filters.tagKeys = Array.from(new Set(normalizedTagKeys));
    }

    if (q) {
      filters.q = q;
    }

    if (limit) {
      const parsedLimit = parseInt(limit, 10);
      if (!Number.isNaN(parsedLimit)) {
        filters.limit = parsedLimit;
      }
    }

    if (offset) {
      const parsedOffset = parseInt(offset, 10);
      if (!Number.isNaN(parsedOffset)) {
        filters.offset = parsedOffset;
      }
    }

    return this.storage.listDocuments(filters);
  }

  @Get(':id')
  async getDocument(@Param('id') id: string): Promise<Document> {
    logger.info({ id }, 'GET /api/documents/:id');
    return this.storage.getDocument({ id });
  }

  @Get('by-slug')
  async getDocumentBySlug(
    @Query('slug') slug?: string,
    @Query('projectId') projectId?: string,
  ): Promise<Document> {
    logger.info({ slug, projectId }, 'GET /api/documents/by-slug');

    if (!slug) {
      throw new BadRequestException('slug query parameter is required');
    }

    if (projectId === undefined) {
      throw new BadRequestException('projectId query parameter is required');
    }

    const normalizedProjectId = projectId === '' ? null : projectId;
    return this.storage.getDocument({ slug, projectId: normalizedProjectId });
  }

  @Post()
  async createDocument(@Body() body: unknown): Promise<Document> {
    logger.info('POST /api/documents');
    const parsed = CreateDocumentSchema.parse(body);
    const data: CreateDocument = {
      projectId: parsed.projectId ?? null,
      title: parsed.title,
      slug: parsed.slug,
      contentMd: parsed.contentMd,
      tags: parsed.tags,
    };
    return this.storage.createDocument(data);
  }

  @Put(':id')
  async updateDocument(@Param('id') id: string, @Body() body: unknown): Promise<Document> {
    logger.info({ id }, 'PUT /api/documents/:id');
    const parsed = UpdateDocumentSchema.parse(body) as UpdateDocument;
    return this.storage.updateDocument(id, parsed);
  }

  @Delete(':id')
  async deleteDocument(@Param('id') id: string): Promise<void> {
    logger.info({ id }, 'DELETE /api/documents/:id');
    await this.storage.deleteDocument(id);
  }
}
