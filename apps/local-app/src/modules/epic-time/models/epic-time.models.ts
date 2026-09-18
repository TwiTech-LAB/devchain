import type {
  ExternalEstimateLogPendingPhase,
  ExternalEstimateLogPendingResolution,
  ExternalEstimateLogState,
  IntegrationProvider,
} from '../../storage/models/domain.models';

export type EpicTimeAttributionSource = 'direct' | 'team';

export interface EpicTimeSummaryItem {
  activityDate: string;
  agentId: string;
  agentName: string;
  // Optional at the shared client boundary so older or degraded payloads can
  // still normalize as direct time; the backend summary service always emits them.
  attributionSource?: EpicTimeAttributionSource;
  teamId?: string | null;
  teamName?: string | null;
  minutes: number;
}

export interface EpicTimeTaskItem {
  epicId: string;
  epicTitle: string;
  // Optional at the shared client boundary so older or degraded payloads can
  // still render the flat contributor list; the backend always emits both.
  groupEpicId?: string | null;
  groupEpicTitle?: string | null;
  isDirect: boolean;
  minutes: number;
}

export interface EpicTimeDetailSummary {
  isRoot: boolean;
  directMinutes: number;
  totalMinutes: number;
  /**
   * Scope flag, not a minute count: true whenever the resolved rollup admits
   * at least one routed Related root, even when that root has zero closed
   * segments.
   */
  includesRelatedTime: boolean;
  items: EpicTimeSummaryItem[];
  taskItems: EpicTimeTaskItem[];
}

export interface EpicTimeBatchSummaryItem {
  epicId: string;
  totalMinutes: number;
}

/**
 * Manual buffer assignment snapshot for one current same-project agent.
 * The token fingerprints the exact eligible rows behind the aggregate; no
 * segment, session, or team-membership detail rides on the wire.
 */
export interface AgentTimeBufferItem {
  agentId: string;
  snapshotToken: string;
  minutes: number;
  durationMs: number;
  segmentCount: number;
  oldestActivityAt: string;
  newestActivityAt: string;
}

export interface AgentTimeBufferSnapshot {
  /** Data-derived watermark: max updated_at over the eligible read; null when empty. */
  capturedAt: string | null;
  items: AgentTimeBufferItem[];
}

export interface AgentTimeBufferAssignmentInput {
  projectId: string;
  agentId: string;
  targetEpicId: string;
  capturedAt: string;
  snapshotToken: string;
}

export interface AgentTimeBufferAssignmentResult {
  workspaceId: string;
}

export interface AgentTimeBufferResetInput {
  projectId: string;
  agentId: string;
  capturedAt: string;
  snapshotToken: string;
}

export interface AgentTimeBufferResetResult {
  workspaceId: string;
}

export interface EpicTimeBatchSummary {
  items: EpicTimeBatchSummaryItem[];
}

/** One dated whole-minute total over the resolved Epic-time scope. */
export interface EpicTimeDailyTotal {
  activityDate: string;
  minutes: number;
}

/**
 * Daily projection of the resolved Epic-time scope in one canonical zone:
 * currentByDate groups EpicTimeDetailSummary.items by activityDate (all
 * agents and attribution sources summed), so its minutes sum exactly to
 * totalMinutes.
 */
export interface EpicTimeDailyProjection {
  canonicalTimeZone: string;
  totalMinutes: number;
  currentByDate: EpicTimeDailyTotal[];
}

export const EXTERNAL_ESTIMATE_TIME_ENTRY_NOTE = 'DevChain estimated agent time';

export interface ExternalEstimateTaskContext {
  projectId: string;
  provider: IntegrationProvider;
  remoteScopeKey: string;
  remoteTaskId: string;
  expectedEpoch: number;
}

export type ExternalEstimatePendingDisposition =
  | 'none'
  | 'busy'
  | 'outcome_unknown'
  | 'manual_review'
  | 'finishing';

/** One persisted dated-ledger row on the wire. */
export interface ExternalEstimateLoggedDay {
  activityDate: string;
  loggedMinutes: number;
}

export interface ExternalEstimateLogSnapshot {
  state: ExternalEstimateLogState | null;
  initialized: boolean;
  revision: number;
  loggedMinutes: number;
  /** Canonical IANA zone the dated ledger groups under; null until bound. */
  aggregationTimeZone: string | null;
  /** Sorted ascending by activityDate; bounded and never truncated. */
  days: ExternalEstimateLoggedDay[];
  /** Derived: loggedMinutes minus the dated sum. Never persisted, never drifting. */
  unallocatedLoggedMinutes: number;
  pendingDisposition: ExternalEstimatePendingDisposition;
  canVerify: boolean;
  /** Receipt-absolute Verify deadline; null whenever Verify is unavailable.
   * Clients schedule one deadline transition from it — never a TTL of
   * their own. */
  verifyExpiresAt: string | null;
}

export interface CreateExternalEstimateTimeEntryInput extends ExternalEstimateTaskContext {
  /** Fresh browser crypto.randomUUID for one click; never a stable Epic or task id. */
  requestKey: string;
  timeZone: string;
  estimateTotalMinutes: number;
  expectedRevision: number;
  /** Captured daily projection: unique canonical dates ascending, summing
   * exactly to estimateTotalMinutes, bounded at 3,660 entries. */
  dailySnapshot: EpicTimeDailyTotal[];
}

/** Why the create loop stopped, safe to render without provider detail. */
export type ExternalEstimateCreateStoppedReason =
  | 'completed'
  | 'entry_cap'
  | 'provider_error'
  | 'concurrent_write'
  | 'outcome_unknown';

export interface ExternalEstimateCreateOutcome {
  entriesLogged: number;
  minutesLogged: number;
  hasMore: boolean;
  stoppedReason: ExternalEstimateCreateStoppedReason;
  snapshot: ExternalEstimateLogSnapshot;
}

export type CreateExternalEstimateTimeEntryResult =
  | ({ outcome: 'logged' } & ExternalEstimateCreateOutcome)
  | ({ outcome: 'partially_logged' } & ExternalEstimateCreateOutcome)
  | ({ outcome: 'outcome_unknown' } & ExternalEstimateCreateOutcome);

export interface SetExternalEstimateLoggedMinutesInput extends ExternalEstimateTaskContext {
  loggedMinutes: number;
  expectedRevision: number;
  timeZone: string;
}

export type ExternalEstimateOperationAction = 'verify' | 'logged' | 'not_logged';

export interface ResolveExternalEstimateOperationInput extends ExternalEstimateTaskContext {
  operationId: string;
  action: ExternalEstimateOperationAction;
  expectedRevision: number;
}

export type ResolveExternalEstimateOperationResult =
  | { outcome: 'logged' | 'not_logged'; snapshot: ExternalEstimateLogSnapshot }
  | { outcome: 'unresolved'; snapshot: ExternalEstimateLogSnapshot };

export interface ExternalEstimatePendingOperationView {
  operationId: string;
  deltaMinutes: number;
  estimateTotalMinutes: number;
  startedAt: string;
  phase: ExternalEstimateLogPendingPhase;
  resolution: ExternalEstimateLogPendingResolution | null;
  /** Target activity date of the pending dated delta; null on legacy pending rows. */
  activityDate: string | null;
}

/** Safe wire projection of the checkpoint: no connection identity, receipt
 * tuple internals, or echoed provider/scope/task identifiers leave the API. */
export interface ExternalEstimateLogStateView {
  initialized: boolean;
  revision: number;
  loggedMinutes: number;
  aggregationTimeZone: string | null;
  days: ExternalEstimateLoggedDay[];
  unallocatedLoggedMinutes: number;
  pendingDisposition: ExternalEstimatePendingDisposition;
  canVerify: boolean;
  verifyExpiresAt: string | null;
  pending: ExternalEstimatePendingOperationView | null;
}

export interface ExternalEstimateCreateTimeEntryResponse {
  outcome: CreateExternalEstimateTimeEntryResult['outcome'];
  entriesLogged: number;
  minutesLogged: number;
  hasMore: boolean;
  stoppedReason: ExternalEstimateCreateStoppedReason;
  state: ExternalEstimateLogStateView;
}

export interface ExternalEstimateResolveOperationResponse {
  outcome: ResolveExternalEstimateOperationResult['outcome'];
  state: ExternalEstimateLogStateView;
}
