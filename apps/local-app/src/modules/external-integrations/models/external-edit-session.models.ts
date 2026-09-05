/**
 * Provider-neutral edit-session model for bounded external mutations. A
 * session is created only by an explicit Edit or Delete action; read-only
 * rendering never allocates one. The session pins the connection identity
 * (id + generation) it was opened under, the writable baseline and its
 * semantic fingerprint, and a monotonic revision that a verified save
 * advances exactly once.
 */

import type { IntegrationProvider } from '../../storage/models/domain.models';

export const EDIT_SESSION_IDLE_LIMIT_MS = 15 * 60 * 1_000;
export const EDIT_SESSION_ABSOLUTE_LIMIT_MS = 2 * 60 * 60 * 1_000;
export const EDIT_SESSION_MAX_ENTRIES = 64;
/** Combined serialized-session budget; the LRU evicts oldest-first. */
export const EDIT_SESSION_MAX_TOTAL_BYTES = 512 * 1_024;
export const EDIT_SESSION_MAX_BASELINE_BYTES = 128 * 1_024;
export const EDIT_SESSION_ID_LENGTH = 36;

export type ExternalEditSessionState =
  | 'editable'
  | 'saved_unverified'
  | 'outcome_unknown'
  | 'diverged'
  | 'invalidated'
  | 'expired';

export type ExternalEditSessionKind = 'description_edit' | 'comment_edit' | 'comment_delete';

/**
 * Provider metadata a session must carry for its action. For ClickUp comment
 * deletion this includes the bounded-lookup proof token; for Jira it carries
 * the exact comment identities.
 */
export interface ExternalEditSessionProviderMetadata {
  lookupToken: string | null;
  ownerRemoteId: string;
}

export interface ExternalEditSessionBaseline {
  /** Canonical writable baseline document (description edit sessions). */
  document: unknown;
  /** Semantic fingerprint of the baseline document. */
  fingerprint: string;
}

export interface ExternalEditSessionPendingWrite {
  /** Semantic fingerprint of the dispatched payload (exact-retry matching). */
  fingerprint: string;
  dispatchedAt: number;
}

export interface ExternalEditSession {
  sessionId: string;
  kind: ExternalEditSessionKind;
  provider: IntegrationProvider;
  projectId: string;
  connectionId: string;
  connectionGeneration: number;
  scopeKey: string;
  remoteTaskId: string;
  remoteCommentId: string | null;
  baseline: ExternalEditSessionBaseline | null;
  providerMetadata: ExternalEditSessionProviderMetadata;
  revision: number;
  state: ExternalEditSessionState;
  pendingWrite: ExternalEditSessionPendingWrite | null;
  createdAt: number;
  lastActivityAt: number;
}

export interface ExternalEditSessionView {
  sessionId: string;
  kind: ExternalEditSessionKind;
  provider: IntegrationProvider;
  remoteTaskId: string;
  remoteCommentId: string | null;
  state: ExternalEditSessionState;
  revision: number;
  baselineFingerprint: string | null;
  createdAt: string;
  lastActivityAt: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
}

export type ExternalSessionWriteRejectionReason =
  | 'session_not_found'
  | 'session_expired'
  | 'session_not_editable'
  | 'revision_conflict'
  | 'operation_busy'
  | 'connection_superseded'
  | 'unsupported_content'
  | 'diverged'
  | 'target_gone';

export type ExternalSessionWriteOutcome =
  | {
      /** The post-write verification read confirmed the payload landed. */
      outcome: 'saved';
      revision: number;
      session: ExternalEditSessionView;
    }
  | {
      outcome: 'saved_unverified';
      session: ExternalEditSessionView;
    }
  | {
      outcome: 'outcome_unknown';
      session: ExternalEditSessionView;
    }
  | {
      outcome: 'pre_dispatch_rejected';
      reason: ExternalSessionWriteRejectionReason;
      session: ExternalEditSessionView | null;
    };

export type ExternalSessionReloadStatus = 'reloaded' | 'gone' | 'unsupported';

export interface ExternalSessionReloadResult {
  status: ExternalSessionReloadStatus;
  session: ExternalEditSessionView | null;
}

export type ExternalSessionVerifyRemoteState = 'new_payload' | 'old_baseline' | 'diverged' | 'gone';

export interface ExternalSessionVerifyResult {
  session: ExternalEditSessionView | null;
  remoteState: ExternalSessionVerifyRemoteState | null;
  reason: 'session_not_found' | 'session_expired' | null;
}

export type ExternalCommentDeleteRejectionReason =
  | 'session_not_found'
  | 'session_expired'
  | 'session_not_editable'
  | 'operation_busy'
  | 'not_owned'
  | 'connection_superseded'
  | 'delete_rejected';

export type ExternalCommentDeleteOutcome =
  | { outcome: 'deleted'; session: ExternalEditSessionView }
  | { outcome: 'already_deleted'; session: ExternalEditSessionView }
  | { outcome: 'outcome_unknown'; session: ExternalEditSessionView }
  | {
      outcome: 'rejected';
      reason: ExternalCommentDeleteRejectionReason;
      session: ExternalEditSessionView | null;
    };
