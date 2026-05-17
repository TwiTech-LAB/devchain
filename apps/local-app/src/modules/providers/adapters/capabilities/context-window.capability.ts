export type ModelFamily = 'opus' | 'sonnet' | 'haiku' | null;

export interface ContextWindowProviderState {
  oneMillionContextEnabled?: boolean;
  autoCompactThreshold?: number | null;
  autoCompactThreshold1m?: number | null;
}

export interface ContextWindowCapability {
  detectModelFamily(modelName: string): ModelFamily;

  is1mActiveForModel(oneMillionEnabled: boolean, modelName: string): boolean;

  applyContextWindowConfig(
    args: string[],
    env: Record<string, string>,
    provider: ContextWindowProviderState,
  ): { argv: string[]; env: Record<string, string> };

  getCompactThreshold(
    modelName: string | null,
    provider: ContextWindowProviderState,
  ): number | undefined;

  getReadTimeContextWindow(modelName: string, oneMillionEnabled: boolean): number | undefined;

  evaluateAutoCompactConfig(): Promise<{ enabled: boolean; reason?: string }>;
}
