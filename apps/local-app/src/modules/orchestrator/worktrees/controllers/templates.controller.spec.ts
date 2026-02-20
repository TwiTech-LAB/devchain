import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { OrchestratorTemplatesController } from './templates.controller';

jest.mock('../../../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

describe('OrchestratorTemplatesController', () => {
  const originalTemplatesDir = process.env.TEMPLATES_DIR;

  beforeEach(() => {
    delete process.env.TEMPLATES_DIR;
  });

  afterAll(() => {
    if (typeof originalTemplatesDir === 'string') {
      process.env.TEMPLATES_DIR = originalTemplatesDir;
    } else {
      delete process.env.TEMPLATES_DIR;
    }
  });

  it('lists templates from TEMPLATES_DIR and returns expected envelope', async () => {
    const templatesDir = await mkdtemp(join(tmpdir(), 'orchestrator-templates-'));

    try {
      await writeFile(
        join(templatesDir, 'z-template.json'),
        JSON.stringify({
          _manifest: {
            name: 'Z Template',
            description: 'z desc',
          },
        }),
      );
      await writeFile(
        join(templatesDir, 'a-template.json'),
        JSON.stringify({
          _manifest: {
            name: 'A Template',
          },
        }),
      );
      await writeFile(join(templatesDir, 'README.md'), '# not a template\n');

      process.env.TEMPLATES_DIR = templatesDir;
      const controller = new OrchestratorTemplatesController();
      const result = await controller.listTemplates();

      expect(result).toEqual({
        templates: [
          { slug: 'a-template', name: 'A Template', description: null },
          { slug: 'z-template', name: 'Z Template', description: 'z desc' },
        ],
        total: 2,
      });
    } finally {
      await rm(templatesDir, { recursive: true, force: true });
    }
  });

  it('returns empty list when templates directory does not exist', async () => {
    process.env.TEMPLATES_DIR = join(tmpdir(), `missing-templates-${Date.now()}`);
    const controller = new OrchestratorTemplatesController();

    await expect(controller.listTemplates()).resolves.toEqual({
      templates: [],
      total: 0,
    });
  });

  it('lists bundled templates from disk when TEMPLATES_DIR targets app templates', async () => {
    process.env.TEMPLATES_DIR = join(__dirname, '../../../../../templates');
    const controller = new OrchestratorTemplatesController();

    const result = await controller.listTemplates();

    expect(result.templates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ slug: '3-agents-dev' }),
        expect.objectContaining({ slug: '5-agents-dev' }),
      ]),
    );
    expect(result.total).toBeGreaterThanOrEqual(2);
  });

  it('skips invalid json files and preserves valid entries', async () => {
    const templatesDir = await mkdtemp(join(tmpdir(), 'orchestrator-templates-invalid-'));

    try {
      await writeFile(
        join(templatesDir, 'valid.json'),
        JSON.stringify({
          _manifest: { name: 'Valid Template', description: 'valid' },
        }),
      );
      await writeFile(join(templatesDir, 'broken.json'), '{ this is not valid json');

      process.env.TEMPLATES_DIR = templatesDir;
      const controller = new OrchestratorTemplatesController();
      const result = await controller.listTemplates();

      expect(result).toEqual({
        templates: [{ slug: 'valid', name: 'Valid Template', description: 'valid' }],
        total: 1,
      });
    } finally {
      await rm(templatesDir, { recursive: true, force: true });
    }
  });
});
