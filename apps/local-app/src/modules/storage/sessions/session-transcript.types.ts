export interface SessionTranscriptMetadata {
  transcript_path: string | null;
  provider_session_id: string | null;
}

export interface SessionTranscriptRow extends SessionTranscriptMetadata {
  provider_name_at_launch: string | null;
}

export interface TranscriptBindInput {
  sessionId: string;
  transcriptPath: string;
  providerSessionId: string | null;
  updatedAt: string;
}

export type TranscriptBindOutcome =
  | { kind: 'bound' }
  | { kind: 'needsBackfill' }
  | { kind: 'sessionNotFound' }
  | { kind: 'providerSessionIdTaken'; conflictingSessionId: string };

export interface TranscriptBackfillInput extends TranscriptBindInput {
  providerName: string;
  normalizedTranscriptPath: string;
}

export type TranscriptBackfillOutcome =
  | { kind: 'backfilledId'; sessionId: string }
  | { kind: 'alreadyComplete'; sessionId: string }
  | { kind: 'pathMismatch'; sessionId: string; existing: string; incoming: string }
  | { kind: 'skipped'; sessionId: string; reason: string }
  | { kind: 'noIdAvailable' };
