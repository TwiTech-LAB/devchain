import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tar from 'tar';
import { StorageError, ValidationError } from '../../../common/errors/error-types';
import {
  GitHubDirectorySkillSourceAdapter,
  type GitHubDirectorySkillSourceConfig,
} from './github-directory-skill-source.adapter';

describe('GitHubDirectorySkillSourceAdapter', () => {
  const temporaryDirectories: string[] = [];

  async function makeTemporaryDirectory(prefix: string): Promise<string> {
    const directory = await fs.mkdtemp(join(tmpdir(), prefix));
    temporaryDirectories.push(directory);
    return directory;
  }

  function makeAdapter(
    overrides: Partial<GitHubDirectorySkillSourceConfig> = {},
  ): GitHubDirectorySkillSourceAdapter {
    return new GitHubDirectorySkillSourceAdapter({
      sourceName: 'configured-source',
      repoOwner: 'repo-owner',
      repoName: 'repo-name',
      branch: 'main',
      skillsRoot: 'apps/local-app/skills',
      ...overrides,
    });
  }

  function useExtractedRepository(
    adapter: GitHubDirectorySkillSourceAdapter,
    extractedRepoRoot: string,
    dispose = jest.fn().mockResolvedValue(undefined),
  ): jest.Mock {
    jest
      .spyOn(
        adapter as unknown as { prepareExtractedRepository: () => Promise<unknown> },
        'prepareExtractedRepository',
      )
      .mockResolvedValue({ extractedRepoRoot, dispose });
    return dispose;
  }

  afterEach(async () => {
    jest.restoreAllMocks();
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => fs.rm(directory, { recursive: true, force: true })),
    );
  });

  it.each([
    '',
    '/skills',
    'skills/',
    'skills//nested',
    'skills/./nested',
    'skills/../nested',
    'skills\\nested',
    `skills/${String.fromCharCode(0)}nested`,
    'C:/skills',
  ])('rejects invalid repository-relative skillsRoot %p', (skillsRoot) => {
    expect(() => makeAdapter({ skillsRoot })).toThrow(ValidationError);
  });

  it('scans only direct, non-hidden child directories under the exact configured root', async () => {
    const extractedRepoRoot = await makeTemporaryDirectory('github-directory-source-');
    const skillsRoot = join(extractedRepoRoot, 'apps', 'local-app', 'skills');
    await fs.mkdir(join(skillsRoot, 'alpha'), { recursive: true });
    await fs.writeFile(
      join(skillsRoot, 'alpha', 'SKILL.md'),
      '---\nname: Alpha\ndescription: Alpha skill\n---\nAlpha instructions',
      'utf-8',
    );
    await fs.mkdir(join(skillsRoot, 'group', 'nested'), { recursive: true });
    await fs.writeFile(
      join(skillsRoot, 'group', 'nested', 'SKILL.md'),
      '---\nname: Nested\ndescription: Must not be discovered\n---\nNested instructions',
      'utf-8',
    );
    await fs.mkdir(join(skillsRoot, '.hidden'), { recursive: true });
    await fs.writeFile(
      join(skillsRoot, '.hidden', 'SKILL.md'),
      '---\nname: Hidden\ndescription: Must not be discovered\n---\nHidden instructions',
      'utf-8',
    );
    await fs.writeFile(join(skillsRoot, 'README.md'), 'not a skill directory', 'utf-8');
    await fs.mkdir(join(extractedRepoRoot, 'skills', 'wrong-root'), { recursive: true });
    await fs.writeFile(
      join(extractedRepoRoot, 'skills', 'wrong-root', 'SKILL.md'),
      '---\nname: Wrong root\ndescription: Must not be discovered\n---\nWrong root',
      'utf-8',
    );

    const adapter = makeAdapter();
    useExtractedRepository(adapter, extractedRepoRoot);

    const context = await adapter.createSyncContext();

    expect([...context.manifests.keys()]).toEqual(['alpha']);
    expect(context.manifests.get('alpha')).toMatchObject({
      name: 'Alpha',
      description: 'Alpha skill',
      instructionContent: 'Alpha instructions',
      sourceUrl: 'https://github.com/repo-owner/repo-name/tree/main/apps/local-app/skills/alpha',
    });
    await context.dispose();
  });

  it('isolates malformed or missing SKILL.md files without dropping valid siblings', async () => {
    const extractedRepoRoot = await makeTemporaryDirectory('github-directory-isolation-');
    const skillsRoot = join(extractedRepoRoot, 'apps', 'local-app', 'skills');
    await fs.mkdir(join(skillsRoot, 'valid'), { recursive: true });
    await fs.writeFile(
      join(skillsRoot, 'valid', 'SKILL.md'),
      '---\nname: Valid\ndescription: Valid skill\n---\nValid instructions',
      'utf-8',
    );
    await fs.mkdir(join(skillsRoot, 'malformed'), { recursive: true });
    await fs.writeFile(
      join(skillsRoot, 'malformed', 'SKILL.md'),
      '---\nname: [unterminated\n---\nMalformed instructions',
      'utf-8',
    );
    await fs.mkdir(join(skillsRoot, 'missing'), { recursive: true });

    const adapter = makeAdapter();
    useExtractedRepository(adapter, extractedRepoRoot);

    const context = await adapter.createSyncContext();

    expect([...context.manifests.keys()]).toEqual(['valid']);
    await context.dispose();
  });

  it('encodes every root and skill path segment separately in source URLs', async () => {
    const extractedRepoRoot = await makeTemporaryDirectory('github-directory-url-');
    const skillsRoot = join(extractedRepoRoot, 'skill library', 'team#one');
    await fs.mkdir(join(skillsRoot, 'code review'), { recursive: true });
    await fs.writeFile(
      join(skillsRoot, 'code review', 'SKILL.md'),
      '---\nname: Code Review\ndescription: Review code\n---\nInstructions',
      'utf-8',
    );

    const adapter = makeAdapter({ skillsRoot: 'skill library/team#one' });
    useExtractedRepository(adapter, extractedRepoRoot);

    const context = await adapter.createSyncContext();

    expect(context.manifests.get('code review')?.sourceUrl).toBe(
      'https://github.com/repo-owner/repo-name/tree/main/skill%20library/team%23one/code%20review',
    );
    await context.dispose();
  });

  it('copies the whole selected skill directory from the configured root', async () => {
    const extractedRepoRoot = await makeTemporaryDirectory('github-directory-copy-source-');
    const targetRoot = await makeTemporaryDirectory('github-directory-copy-target-');
    const skillDirectory = join(extractedRepoRoot, 'apps', 'local-app', 'skills', 'alpha');
    await fs.mkdir(join(skillDirectory, 'references'), { recursive: true });
    await fs.writeFile(
      join(skillDirectory, 'SKILL.md'),
      '---\nname: Alpha\ndescription: Alpha skill\n---\nAlpha instructions',
      'utf-8',
    );
    await fs.writeFile(join(skillDirectory, 'references', 'guide.md'), 'guide', 'utf-8');

    const adapter = makeAdapter();
    useExtractedRepository(adapter, extractedRepoRoot);
    const context = await adapter.createSyncContext();

    const destination = await context.downloadSkill('alpha', targetRoot);

    expect(destination).toBe(join(targetRoot, 'configured-source', 'alpha'));
    await expect(fs.readFile(join(destination, 'SKILL.md'), 'utf-8')).resolves.toContain(
      'Alpha instructions',
    );
    await expect(fs.readFile(join(destination, 'references', 'guide.md'), 'utf-8')).resolves.toBe(
      'guide',
    );
    await context.dispose();
  });

  it('rejects sync-context creation and disposes the archive when skillsRoot is missing', async () => {
    const extractedRepoRoot = await makeTemporaryDirectory('github-directory-missing-');
    const adapter = makeAdapter();
    const dispose = useExtractedRepository(adapter, extractedRepoRoot);

    await expect(adapter.createSyncContext()).rejects.toThrow(StorageError);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('rejects a skillsRoot symlink that escapes the extracted repository', async () => {
    const extractedRepoRoot = await makeTemporaryDirectory('github-directory-contained-');
    const outsideRoot = await makeTemporaryDirectory('github-directory-outside-');
    await fs.mkdir(join(extractedRepoRoot, 'apps', 'local-app'), { recursive: true });
    await fs.symlink(outsideRoot, join(extractedRepoRoot, 'apps', 'local-app', 'skills'));
    const adapter = makeAdapter();
    const dispose = useExtractedRepository(adapter, extractedRepoRoot);

    await expect(adapter.createSyncContext()).rejects.toThrow(ValidationError);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('keeps public metadata URL separate from GitHub commit and archive transport', async () => {
    const fixtureRoot = await makeTemporaryDirectory('github-directory-transport-fixture-');
    const repositoryDirectory = join(fixtureRoot, 'repository-root');
    const skillDirectory = join(repositoryDirectory, 'nested', 'skills', 'alpha');
    await fs.mkdir(skillDirectory, { recursive: true });
    await fs.writeFile(
      join(skillDirectory, 'SKILL.md'),
      '---\nname: Alpha\ndescription: Alpha skill\n---\nAlpha instructions',
      'utf-8',
    );
    const archivePath = join(fixtureRoot, 'repository.tar.gz');
    await tar.c({ cwd: fixtureRoot, file: archivePath, gzip: true }, ['repository-root']);
    const archive = await fs.readFile(archivePath);
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/commits/')) {
        return new Response(JSON.stringify({ sha: 'commit-sha' }), { status: 200 });
      }
      if (url.includes('/tarball/')) {
        return new Response(archive, { status: 200 });
      }
      return new Response(null, { status: 404 });
    });
    const adapter = makeAdapter({
      repoOwner: 'transport-owner',
      repoName: 'transport-repo',
      branch: 'feature/skills',
      skillsRoot: 'nested/skills',
      publicRepoUrl:
        'https://github.com/metadata-owner/metadata-repo/tree/metadata-branch/public/path',
    });

    await expect(adapter.getLatestCommit()).resolves.toBe('commit-sha');
    const context = await adapter.createSyncContext();

    expect(adapter.repoUrl).toBe(
      'https://github.com/metadata-owner/metadata-repo/tree/metadata-branch/public/path',
    );
    expect(context.manifests.get('alpha')?.sourceUrl).toBe(
      'https://github.com/transport-owner/transport-repo/tree/feature%2Fskills/nested/skills/alpha',
    );
    expect(fetchSpy.mock.calls.map(([input]) => String(input))).toEqual([
      'https://api.github.com/repos/transport-owner/transport-repo/commits/feature%2Fskills',
      'https://api.github.com/repos/transport-owner/transport-repo/tarball/feature%2Fskills',
    ]);
    await context.dispose();
  });

  describe('failed GitHub requests', () => {
    const originalToken = process.env.GITHUB_TOKEN;

    beforeEach(() => {
      delete process.env.GITHUB_TOKEN;
    });

    afterEach(() => {
      if (originalToken === undefined) {
        delete process.env.GITHUB_TOKEN;
      } else {
        process.env.GITHUB_TOKEN = originalToken;
      }
    });

    function mockResponse(status: number, headers: Record<string, string>): void {
      jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(new Response(JSON.stringify({ message: 'x' }), { status, headers }));
    }

    it('names an exhausted unauthenticated rate limit and its reset time', async () => {
      mockResponse(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1790170658' });

      const error = await makeAdapter()
        .getLatestCommit()
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(StorageError);
      expect((error as StorageError).message).toContain(
        'GitHub API rate limit reached (60 requests per hour without a token).',
      );
      expect((error as StorageError).message).toContain('It resets at');
      expect((error as StorageError).message).toContain('The stored skills stay available.');
      expect((error as StorageError).details).toMatchObject({
        status: 403,
        rateLimited: true,
        resetAt: new Date(1790170658 * 1000).toISOString(),
      });
    });

    it('names the token limit when a token is configured', async () => {
      mockResponse(429, { 'x-ratelimit-remaining': '0' });

      const error = await makeAdapter({ githubToken: 'token' })
        .getLatestCommit()
        .catch((caught: unknown) => caught);

      expect((error as StorageError).message).toBe(
        'GitHub API rate limit reached for this token. The stored skills stay available.',
      );
      expect((error as StorageError).details).toMatchObject({ rateLimited: true, resetAt: null });
    });

    it('keeps the generic message for a 403 with rate limit remaining', async () => {
      mockResponse(403, { 'x-ratelimit-remaining': '12' });

      const error = await makeAdapter()
        .getLatestCommit()
        .catch((caught: unknown) => caught);

      expect((error as StorageError).message).toBe(
        'Failed to fetch latest GitHub commit for skill source.',
      );
      expect((error as StorageError).details).not.toHaveProperty('rateLimited');
    });
  });
});
