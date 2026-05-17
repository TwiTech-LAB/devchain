export interface ProjectMcpSettingsCapability {
  ensureProjectSettings(projectPath: string): Promise<void>;
}
