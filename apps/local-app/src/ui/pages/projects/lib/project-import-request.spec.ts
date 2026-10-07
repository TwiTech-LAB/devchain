import { createFileImportRequest, createTemplateImportRequest } from './project-import-request';

describe('project import request construction', () => {
  it.each([
    {
      source: 'bundled' as const,
      slug: 'starter',
      version: '9.9.9',
      expected: { slug: 'starter' },
    },
    {
      source: 'registry' as const,
      slug: 'downloaded',
      version: '2.1.0',
      expected: { slug: 'downloaded', version: '2.1.0' },
    },
  ])('builds $source template request', ({ source, slug, version, expected }) => {
    expect(createTemplateImportRequest(slug, source, version)).toEqual(expected);
  });

  it('parses file content into rawContent', async () => {
    const rawContent = { manifest: { slug: 'file' }, agents: [] };
    await expect(
      createFileImportRequest({ text: async () => JSON.stringify(rawContent) }),
    ).resolves.toEqual({ rawContent });
  });
});
