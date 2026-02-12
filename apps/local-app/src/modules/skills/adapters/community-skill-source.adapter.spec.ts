import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StorageError } from '../../../common/errors/error-types';
import type { CommunitySkillSource } from '../../storage/models/domain.models';
import { CommunitySkillSourceAdapter } from './community-skill-source.adapter';

describe('CommunitySkillSourceAdapter', () => {
  const source: CommunitySkillSource = {
    id: 'source-1',
    name: 'jeffallan',
    repoOwner: 'jeffallan',
    repoName: 'claude-skills',
    branch: 'main',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uses community source config in constructor', () => {
    const adapter = new CommunitySkillSourceAdapter(source);
    expect(adapter.sourceName).toBe('jeffallan');
    expect(adapter.repoUrl).toBe('https://github.com/jeffallan/claude-skills');
  });

  it('discovers skill names from skills directory, filtering hidden and non-directories', async () => {
    const adapter = new CommunitySkillSourceAdapter(source);
    const root = await fs.mkdtemp(join(tmpdir(), 'community-skill-source-'));
    const skillsRoot = join(root, 'skills');
    await fs.mkdir(skillsRoot, { recursive: true });
    await fs.mkdir(join(skillsRoot, 'zeta'));
    await fs.mkdir(join(skillsRoot, '.hidden'));
    await fs.mkdir(join(skillsRoot, 'alpha'));
    await fs.writeFile(join(skillsRoot, 'README.md'), 'docs', 'utf-8');

    try {
      const skillNames = await (
        adapter as unknown as {
          listSkillNamesFromExtractedRepo: (root: string) => Promise<string[]>;
        }
      ).listSkillNamesFromExtractedRepo(root);

      expect(skillNames).toEqual(['alpha', 'zeta']);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('throws StorageError when skills directory is missing', async () => {
    const adapter = new CommunitySkillSourceAdapter(source);

    await expect(
      (
        adapter as unknown as {
          listSkillNamesFromExtractedRepo: (root: string) => Promise<string[]>;
        }
      ).listSkillNamesFromExtractedRepo('/tmp/repo-does-not-exist'),
    ).rejects.toThrow(StorageError);
  });

  it('creates sync context manifests and sourceUrl using standard skills path', async () => {
    const adapter = new CommunitySkillSourceAdapter(source);
    const disposeRepo = jest.fn().mockResolvedValue(undefined);

    jest
      .spyOn(
        adapter as unknown as { prepareExtractedRepository: () => Promise<unknown> },
        'prepareExtractedRepository',
      )
      .mockResolvedValue({
        extractedRepoRoot: '/tmp/repo',
        dispose: disposeRepo,
      });
    jest
      .spyOn(
        adapter as unknown as {
          listSkillNamesFromExtractedRepo: (root: string) => Promise<string[]>;
        },
        'listSkillNamesFromExtractedRepo',
      )
      .mockResolvedValue(['code-review']);
    jest
      .spyOn(
        adapter as unknown as {
          resolveSkillDirectory: (root: string, skill: string) => Promise<string>;
        },
        'resolveSkillDirectory',
      )
      .mockResolvedValue('/tmp/repo/skills/code-review');
    jest
      .spyOn(
        adapter as unknown as { parseSkillMarkdown: (dir: string) => Promise<unknown> },
        'parseSkillMarkdown',
      )
      .mockResolvedValue({
        frontmatter: {
          name: 'Code Review',
          description: 'Review code',
          resources: ['https://example.test/resource'],
        },
        instructionContent: 'Do the review',
      });
    const downloadSpy = jest
      .spyOn(
        adapter as unknown as {
          downloadSkillFromExtractedRepo: (
            skillName: string,
            targetPath: string,
            extractedRepoRoot: string,
          ) => Promise<string>;
        },
        'downloadSkillFromExtractedRepo',
      )
      .mockResolvedValue('/tmp/output/code-review');

    const context = await adapter.createSyncContext();
    const manifest = context.manifests.get('code-review');

    expect(manifest).toMatchObject({
      name: 'Code Review',
      description: 'Review code',
      instructionContent: 'Do the review',
      resources: ['https://example.test/resource'],
      sourceUrl: 'https://github.com/jeffallan/claude-skills/tree/main/skills/code-review',
    });

    await context.downloadSkill('code-review', '/tmp/output');
    expect(downloadSpy).toHaveBeenCalledWith('code-review', '/tmp/output', '/tmp/repo');

    await context.dispose();
    await context.dispose();
    expect(disposeRepo).toHaveBeenCalledTimes(1);
  });

  it('skips skills when SKILL.md parsing returns null', async () => {
    const adapter = new CommunitySkillSourceAdapter(source);

    jest
      .spyOn(
        adapter as unknown as { prepareExtractedRepository: () => Promise<unknown> },
        'prepareExtractedRepository',
      )
      .mockResolvedValue({
        extractedRepoRoot: '/tmp/repo',
        dispose: jest.fn().mockResolvedValue(undefined),
      });
    jest
      .spyOn(
        adapter as unknown as {
          listSkillNamesFromExtractedRepo: (root: string) => Promise<string[]>;
        },
        'listSkillNamesFromExtractedRepo',
      )
      .mockResolvedValue(['missing-skill']);
    jest
      .spyOn(
        adapter as unknown as {
          resolveSkillDirectory: (root: string, skill: string) => Promise<string>;
        },
        'resolveSkillDirectory',
      )
      .mockResolvedValue('/tmp/repo/skills/missing-skill');
    jest
      .spyOn(
        adapter as unknown as { parseSkillMarkdown: (dir: string) => Promise<unknown> },
        'parseSkillMarkdown',
      )
      .mockResolvedValue(null);

    const context = await adapter.createSyncContext();
    expect(context.manifests.size).toBe(0);
    await context.dispose();
  });

  it('resolves strictly from skills/<name> even when root directory matches', async () => {
    const adapter = new CommunitySkillSourceAdapter(source);
    const root = await fs.mkdtemp(join(tmpdir(), 'community-skill-source-path-'));
    const rootLevelSkillDir = join(root, 'code-review');
    const skillsLevelSkillDir = join(root, 'skills', 'code-review');
    await fs.mkdir(rootLevelSkillDir, { recursive: true });
    await fs.mkdir(skillsLevelSkillDir, { recursive: true });

    try {
      const resolved = await (
        adapter as unknown as {
          resolveSkillDirectory: (repoRoot: string, skillName: string) => Promise<string>;
        }
      ).resolveSkillDirectory(root, 'code-review');

      expect(resolved).toBe(skillsLevelSkillDir);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('resolves correctly when skill exists only at skills/<name>', async () => {
    const adapter = new CommunitySkillSourceAdapter(source);
    const root = await fs.mkdtemp(join(tmpdir(), 'community-skill-source-path-'));
    const skillsLevelSkillDir = join(root, 'skills', 'code-review');
    await fs.mkdir(skillsLevelSkillDir, { recursive: true });

    try {
      const resolved = await (
        adapter as unknown as {
          resolveSkillDirectory: (repoRoot: string, skillName: string) => Promise<string>;
        }
      ).resolveSkillDirectory(root, 'code-review');

      expect(resolved).toBe(skillsLevelSkillDir);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('does not fallback to root-level directory when skills/<name> is missing', async () => {
    const adapter = new CommunitySkillSourceAdapter(source);
    const root = await fs.mkdtemp(join(tmpdir(), 'community-skill-source-path-'));
    await fs.mkdir(join(root, 'code-review'), { recursive: true });

    try {
      await expect(
        (
          adapter as unknown as {
            resolveSkillDirectory: (repoRoot: string, skillName: string) => Promise<string>;
          }
        ).resolveSkillDirectory(root, 'code-review'),
      ).rejects.toThrow(StorageError);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
