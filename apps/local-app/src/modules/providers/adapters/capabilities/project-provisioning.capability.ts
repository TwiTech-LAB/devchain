// Real capability — Claude, Antigravity, Copilot, and Codex project trust.

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

export interface ProjectProvisioningContext {
  env?: Record<string, string>;
}

export interface ProjectProvisioningCapability {
  readonly requiresProjectProvisioning: true;
  provisionProjectPath(
    projectPath: string,
    context?: ProjectProvisioningContext,
  ): Promise<ProvisioningResult>;
}
