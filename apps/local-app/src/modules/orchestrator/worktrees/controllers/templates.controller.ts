import { Controller, Get } from '@nestjs/common';
import { readdir, readFile } from 'fs/promises';
import { join, resolve } from 'path';
import { createLogger } from '../../../../common/logging/logger';

const logger = createLogger('OrchestratorTemplatesController');

interface OrchestratorTemplateListItem {
  slug: string;
  name: string;
  description: string | null;
}

interface OrchestratorTemplateListResponse {
  templates: OrchestratorTemplateListItem[];
  total: number;
}

@Controller('api')
export class OrchestratorTemplatesController {
  @Get('templates')
  async listTemplates(): Promise<OrchestratorTemplateListResponse> {
    logger.info('GET /api/templates');
    const templatesDir = this.resolveTemplatesDir();

    let fileNames: string[];
    try {
      fileNames = await readdir(templatesDir);
    } catch (error) {
      logger.warn({ error, templatesDir }, 'Templates directory unavailable; returning empty list');
      return { templates: [], total: 0 };
    }

    const templateFiles = fileNames.filter((fileName) => fileName.endsWith('.json'));
    const templates: OrchestratorTemplateListItem[] = [];

    for (const fileName of templateFiles) {
      const template = await this.readTemplateMetadata(templatesDir, fileName);
      if (template) {
        templates.push(template);
      }
    }

    templates.sort((a, b) => a.name.localeCompare(b.name));
    return {
      templates,
      total: templates.length,
    };
  }

  private resolveTemplatesDir(): string {
    const envDir = process.env.TEMPLATES_DIR?.trim();
    if (envDir) {
      return resolve(envDir);
    }

    return resolve(__dirname, '..', '..', '..', '..', 'templates');
  }

  private async readTemplateMetadata(
    templatesDir: string,
    fileName: string,
  ): Promise<OrchestratorTemplateListItem | null> {
    const slug = fileName.replace(/\.json$/i, '');
    const filePath = join(templatesDir, fileName);

    try {
      const rawContent = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(rawContent) as {
        _manifest?: { name?: unknown; description?: unknown };
        name?: unknown;
        description?: unknown;
      };

      const manifest =
        parsed._manifest && typeof parsed._manifest === 'object' ? parsed._manifest : undefined;

      const nameFromManifest = typeof manifest?.name === 'string' ? manifest.name.trim() : '';
      const nameFromRoot = typeof parsed.name === 'string' ? parsed.name.trim() : '';
      const resolvedName = nameFromManifest || nameFromRoot || slug;

      const descriptionFromManifest =
        typeof manifest?.description === 'string' ? manifest.description : null;
      const descriptionFromRoot =
        typeof parsed.description === 'string' ? parsed.description : null;

      return {
        slug,
        name: resolvedName,
        description: descriptionFromManifest ?? descriptionFromRoot ?? null,
      };
    } catch (error) {
      logger.warn({ error, filePath }, 'Skipping unreadable template metadata file');
      return null;
    }
  }
}
