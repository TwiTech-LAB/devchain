// Real capability — multiple adopters (Antigravity trusted-workspaces + Copilot trusted-folders).

export interface ProvisioningWarningItem {
  source: string;
  level: 'info' | 'warn';
  message: string;
  code?: string;
}

export interface ProvisioningResult {
  success: boolean;
  warnings: ProvisioningWarningItem[];
}

export interface ProjectProvisioningCapability {
  readonly requiresProjectProvisioning: true;
  provisionProjectPath(projectPath: string): Promise<ProvisioningResult>;
}
