export interface AutoCompactProviderState {
  autoCompactThreshold?: number | null;
}

export interface AutoCompactCapability {
  applyAutoCompactConfig(
    args: string[],
    env: Record<string, string>,
    provider: AutoCompactProviderState,
  ): { argv: string[]; env: Record<string, string> };

  evaluateAutoCompactConfig(): Promise<{ enabled: boolean; reason?: string }>;
}
