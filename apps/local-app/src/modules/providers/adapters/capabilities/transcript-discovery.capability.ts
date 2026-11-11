export interface TranscriptDiscoveryCapability {
  readonly transcriptDiscoveryStrategy: 'first' | 'all';
  readonly transcriptContentSearchMaxBytes?: number;
  readonly contentMatchMaxCandidates?: number;
  readonly providerSessionIdRequiredForRestore?: boolean;
  /**
   * The provider writes its transcript only after a turn completes, so the
   * launch-time discovery can finish before the file exists. When true, each
   * idle transition of a session that is not fully bound re-runs discovery.
   */
  readonly transcriptAppearsAfterTurn?: boolean;
}
