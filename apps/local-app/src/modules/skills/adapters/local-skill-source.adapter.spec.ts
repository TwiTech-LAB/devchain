import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { StorageError } from '../../../common/errors/error-types';
import type { LocalSkillSource } from '../../storage/models/domain.models';
import { LocalSkillSourceAdapter } from './local-skill-source.adapter';

describe('LocalSkillSourceAdapter', () => {
  const buildSource = (folderPath: string): LocalSkillSource => ({
    id: 'local-source-1',
    name: 'local-source',
    folderPath,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });

  it('lists skills from skills/<name> and parses SKILL.md manifests', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'local-source-adapter-'));
    const validSkillPath = join(root, 'skills', 'code-review');
    const missingSkillMdPath = join(root, 'skills', 'missing-skill-md');
    await fs.mkdir(validSkillPath, { recursive: true });
    await fs.mkdir(missingSkillMdPath, { recursive: true });
    await fs.writeFile(
      join(validSkillPath, 'SKILL.md'),
      `---
name: Code Review
description: Review code safely
resources:
  - https://example.test/resource
---
Inspect code diffs and suggest improvements.`,
      'utf-8',
    );

    try {
      const adapter = new LocalSkillSourceAdapter(buildSource(root));
      const manifests = await adapter.listSkills();

      expect(manifests.size).toBe(1);
      expect(manifests.get('code-review')).toMatchObject({
        name: 'Code Review',
        description: 'Review code safely',
        resources: ['https://example.test/resource'],
        instructionContent: 'Inspect code diffs and suggest improvements.',
        sourceUrl: pathToFileURL(join(root, 'skills', 'code-review')).toString(),
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('copies skill content from strict skills/<name> path', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'local-source-adapter-'));
    const skillPath = join(root, 'skills', 'code-review');
    const targetRoot = await fs.mkdtemp(join(tmpdir(), 'local-source-target-'));
    await fs.mkdir(skillPath, { recursive: true });
    await fs.writeFile(join(skillPath, 'SKILL.md'), '# Test Skill\n', 'utf-8');

    try {
      const adapter = new LocalSkillSourceAdapter(buildSource(root));
      const copiedPath = await adapter.downloadSkill('code-review', targetRoot);
      const copiedSkillMd = await fs.readFile(join(copiedPath, 'SKILL.md'), 'utf-8');

      expect(copiedPath).toBe(join(targetRoot, 'local-source', 'code-review'));
      expect(copiedSkillMd).toBe('# Test Skill\n');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(targetRoot, { recursive: true, force: true });
    }
  });

  it('does not fallback to root-level skill directories', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'local-source-adapter-'));
    await fs.mkdir(join(root, 'code-review'), { recursive: true });

    try {
      const adapter = new LocalSkillSourceAdapter(buildSource(root));
      await expect(adapter.downloadSkill('code-review', '')).rejects.toThrow(StorageError);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('returns stable commit hash when skill files are unchanged', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'local-source-adapter-'));
    const skillMdPath = join(root, 'skills', 'code-review', 'SKILL.md');
    await fs.mkdir(join(root, 'skills', 'code-review'), { recursive: true });
    await fs.writeFile(skillMdPath, '# Initial Skill\n', 'utf-8');

    try {
      const adapter = new LocalSkillSourceAdapter(buildSource(root));
      const firstHash = await adapter.getLatestCommit();
      const secondHash = await adapter.getLatestCommit();

      expect(firstHash).toMatch(/^[a-f0-9]{40}$/);
      expect(secondHash).toMatch(/^[a-f0-9]{40}$/);
      expect(secondHash).toBe(firstHash);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('changes commit hash when SKILL.md content is edited', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'local-source-adapter-'));
    const skillMdPath = join(root, 'skills', 'code-review', 'SKILL.md');
    await fs.mkdir(join(root, 'skills', 'code-review'), { recursive: true });
    await fs.writeFile(skillMdPath, '# Initial Skill\n', 'utf-8');

    try {
      const adapter = new LocalSkillSourceAdapter(buildSource(root));
      const firstHash = await adapter.getLatestCommit();

      await fs.writeFile(skillMdPath, '# Updated Skill\n', 'utf-8');
      const updatedStat = await fs.stat(skillMdPath);
      const nextTimestamp = new Date(updatedStat.mtime.getTime() + 2000);
      await fs.utimes(skillMdPath, nextTimestamp, nextTimestamp);

      const secondHash = await adapter.getLatestCommit();

      expect(firstHash).toMatch(/^[a-f0-9]{40}$/);
      expect(secondHash).toMatch(/^[a-f0-9]{40}$/);
      expect(secondHash).not.toBe(firstHash);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('changes commit hash when skill directories are added or removed', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'local-source-adapter-'));
    const firstSkillPath = join(root, 'skills', 'code-review', 'SKILL.md');
    const secondSkillDir = join(root, 'skills', 'security-review');
    const secondSkillPath = join(secondSkillDir, 'SKILL.md');
    await fs.mkdir(join(root, 'skills', 'code-review'), { recursive: true });
    await fs.writeFile(firstSkillPath, '# Code Review Skill\n', 'utf-8');

    try {
      const adapter = new LocalSkillSourceAdapter(buildSource(root));
      const initialHash = await adapter.getLatestCommit();

      await fs.mkdir(secondSkillDir, { recursive: true });
      await fs.writeFile(secondSkillPath, '# Security Review Skill\n', 'utf-8');
      const addedHash = await adapter.getLatestCommit();

      await fs.rm(secondSkillDir, { recursive: true, force: true });
      const removedHash = await adapter.getLatestCommit();

      expect(addedHash).not.toBe(initialHash);
      expect(removedHash).not.toBe(addedHash);
      expect(removedHash).toBe(initialHash);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
