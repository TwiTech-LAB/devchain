import { NotFoundError, StorageError, ValidationError } from '../../../common/errors/error-types';
import { createLogger } from '../../../common/logging/logger';
import { resolveTemplatesDirectory } from '../../../common/templates-directory';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { basename, resolve, sep } from 'path';

const logger = createLogger('ProjectsService');

export interface ListedTemplateInfo {
  id: string;
  fileName: string;
}

export function findTemplatesDirectory(callerDir: string): string | null {
  const templatesDir = resolveTemplatesDirectory(callerDir);
  if (templatesDir) {
    logger.debug({ path: templatesDir }, 'Found templates directory');
    return templatesDir;
  }

  logger.warn('Templates directory not found in known locations');
  return null;
}

export function listTemplatesWithHelper(callerDir: string): ListedTemplateInfo[] {
  logger.info('listTemplates');

  const templatesDir = findTemplatesDirectory(callerDir);
  if (!templatesDir) {
    logger.error('Templates directory not found');
    throw new StorageError('Templates directory not found', {
      hint: 'Templates directory is not available in this deployment',
    });
  }

  try {
    const files = readdirSync(templatesDir);
    const jsonFiles = files.filter((file) => file.endsWith('.json'));

    const templates = jsonFiles.map((fileName) => ({
      id: fileName.replace(/\.json$/, ''),
      fileName,
    }));

    logger.info({ templatesDir, count: templates.length }, 'Listed project templates');
    return templates;
  } catch (error) {
    logger.error({ error, templatesDir }, 'Failed to read templates directory');
    throw new StorageError('Failed to read templates directory', {
      hint: 'Error accessing templates',
    });
  }
}

export function getTemplateContentWithHelper(callerDir: string, templateId: string): unknown {
  logger.info({ templateId }, 'getTemplateContent');

  const templatesDir = findTemplatesDirectory(callerDir);
  if (!templatesDir) {
    throw new StorageError('Templates directory not found', {
      hint: 'Templates directory is not available in this deployment',
    });
  }

  const templateIdRegex = /^[a-zA-Z0-9_-]+$/;
  if (!templateIdRegex.test(templateId)) {
    throw new ValidationError(
      'Invalid template ID: must contain only alphanumeric characters, hyphens, and underscores',
      { templateId },
    );
  }

  const resolvedTemplatesDir = resolve(templatesDir);
  const templatePath = resolve(templatesDir, `${templateId}.json`);

  if (!templatePath.startsWith(resolvedTemplatesDir + sep)) {
    logger.warn(
      { templateId, templatePath, templatesDir: resolvedTemplatesDir },
      'Path traversal attempt detected',
    );
    throw new ValidationError('Invalid template ID: path traversal not allowed', { templateId });
  }

  if (!existsSync(templatePath)) {
    throw new NotFoundError('Template', templateId);
  }

  try {
    const content = readFileSync(templatePath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    logger.error({ error, templatePath }, 'Failed to read template file');
    throw new StorageError('Failed to read template file', {
      hint: 'Template file exists but cannot be read or parsed',
    });
  }
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

export function deriveSlugFromPath(filePath: string): string {
  const filename = basename(filePath);
  const nameWithoutExt = filename.replace(/\.json$/i, '');
  return slugify(nameWithoutExt);
}
