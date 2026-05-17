export interface TranscriptDiscoveryCapability {
  readonly transcriptDiscoveryStrategy: 'first' | 'all';
  readonly transcriptContentSearchMaxBytes?: number;
  readonly contentMatchMaxCandidates?: number;
  readonly providerSessionIdRequiredForRestore?: boolean;
}
