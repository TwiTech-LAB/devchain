export const MAX_RUNTIME_CONTEXT_WINDOW_TOKENS = 10_000_000;

export interface RuntimeContextCaptureReport {
  readonly sessionId: string;
  readonly epoch: string;
  readonly sequence: number;
  readonly claudeSessionId: string;
  readonly modelId: string;
  readonly contextWindowTokens: number;
}

export interface RuntimeContextCaptureState {
  readonly sessionId: string;
  readonly epoch: string;
  readonly sequence: number;
  readonly claudeSessionId: string;
  readonly modelId: string;
  readonly contextWindowTokens: number;
}

export interface RuntimeContextCaptureSnapshot {
  readonly epoch: string;
  readonly state: RuntimeContextCaptureState | null;
  readonly configuredOverride: RuntimeContextConfiguredOverride | null;
}

export interface RuntimeContextConfiguredOverride {
  readonly modelId: string;
  readonly contextWindowTokens: number;
}

export interface RuntimeContextWindowLiveState {
  readonly configuredOverride: RuntimeContextConfiguredOverride | null;
  readonly claudeCapture: RuntimeContextCaptureState | null;
}

export type RuntimeContextCaptureIgnoredReason =
  | 'session-ineligible'
  | 'epoch-mismatch'
  | 'sequence-not-increasing';

export type RuntimeContextCaptureAcceptedChange = 'bound' | 'tuple-changed' | 'sequence-advanced';

export type RuntimeContextCaptureResult =
  | {
      readonly accepted: false;
      readonly reason: RuntimeContextCaptureIgnoredReason;
    }
  | {
      readonly accepted: true;
      readonly change: RuntimeContextCaptureAcceptedChange;
      readonly tupleChanged: boolean;
      readonly runtimeSessionChanged: boolean;
      readonly modelChanged: boolean;
      readonly contextWindowChanged: boolean;
      readonly current: RuntimeContextCaptureState;
    };
