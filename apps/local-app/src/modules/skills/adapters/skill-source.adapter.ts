export const SKILL_SOURCE_ADAPTERS = 'SKILL_SOURCE_ADAPTERS';

export interface SkillManifest {
  name: string;
  displayName?: string;
  description: string;
  shortDescription?: string;
  license?: string;
  compatibility?: string;
  frontmatter: Record<string, unknown>;
  instructionContent: string;
  resources: string[];
  sourceUrl: string;
}

export interface SkillSourceSyncContext {
  manifests: Map<string, SkillManifest>;
  downloadSkill(skillName: string, targetPath: string): Promise<string>;
  dispose(): Promise<void>;
}

export interface SkillSourceAdapter {
  readonly sourceName: string;
  readonly repoUrl: string;
  createSyncContext(): Promise<SkillSourceSyncContext>;
  listSkills(): Promise<Map<string, SkillManifest>>;
  downloadSkill(skillName: string, targetPath: string): Promise<string>;
  getLatestCommit(): Promise<string>;
}
