import type {
  IntegrationCredentials,
  IntegrationProvider,
} from '../../storage/models/domain.models';
import type { ExternalRichDocumentV1 } from './external-rich-document';

export const MAX_REMOTE_TASK_ID_LENGTH = 256;
export const MAX_STATUS_LENGTH = 256;
export const MAX_COMMENT_LENGTH = 10_000;
export const MAX_TIME_ENTRY_NOTE_LENGTH = 10_000;
export const MAX_TIME_ENTRY_DURATION_MS = 7 * 24 * 60 * 60 * 1_000;
export const MAX_TASK_DETAIL_TEXT_LENGTH = 65_536;
export const MAX_TASK_DETAIL_SUBTASKS = 100;
export const MAX_TASK_COMMENT_BODY_LENGTH = 8_000;
export const MAX_TASK_COMMENT_AUTHOR_LENGTH = 256;
export const MAX_TASK_COMMENT_ID_LENGTH = 256;
export const MAX_TASK_COMMENT_CURSOR_LENGTH = 1_024;
export const MAX_EXTERNAL_SUBTASK_TITLE_LENGTH = 255;
export const MAX_EXTERNAL_SUBTASK_DESCRIPTION_LENGTH = 65_536;
export const MAX_EXTERNAL_SUBTASK_OWNERSHIP_TOKEN_LENGTH = 256;
export const EXTERNAL_SUBTASK_MANAGEMENT_NOTE =
  'Managed by DevChain. Update or delete this subtask in DevChain; remote changes are not imported.';
export const TIME_ENTRY_HISTORY_WINDOW_DAYS = 30;
export const MAX_TIME_ENTRY_HISTORY_ENTRIES = 100;

export interface ExternalProviderAccount {
  provider: IntegrationProvider;
  remoteId: string;
  displayName: string;
}

export interface ExternalProviderDescriptor {
  provider: IntegrationProvider;
  displayName: string;
  capabilities: {
    myWork: boolean;
  };
}

export type ExternalTaskStatusCategory = 'active' | 'completed' | 'unknown';

export interface ExternalTaskStatus {
  remoteId?: string | null;
  name: string;
  category: ExternalTaskStatusCategory;
}

export type ExternalWorkAreaKind = 'list' | 'board' | 'project';
export type ExternalWorkAreaLocationKind = 'workspace' | 'space' | 'folder' | 'project' | 'board';

export interface ExternalWorkAreaLocation {
  kind: ExternalWorkAreaLocationKind;
  remoteId: string;
  name: string;
}

export interface ExternalWorkAreaColumn {
  remoteId: string | null;
  remoteStatusIds?: string[];
  name: string;
  color: string;
  category: ExternalTaskStatusCategory;
  position: number;
}

export interface ExternalWorkAreaWorkflow {
  isOverridden: boolean;
  columns: ExternalWorkAreaColumn[];
}

/**
 * An actionable status destination. `actionValue` is both the unique UI
 * identity and the exact value the browser writes back through the status PUT
 * route (a ClickUp status name, a Jira transition ID). `actionLabel` carries
 * the vendor action label when it differs from the destination name and is
 * only ever set by Jira.
 */
export interface ExternalTaskStatusOption extends ExternalWorkAreaColumn {
  actionValue: string;
  actionLabel?: string;
}

export type ExternalWorkAreaRefreshState = 'fresh' | 'stale' | 'error';

export interface ExternalWorkAreaRefresh {
  state: ExternalWorkAreaRefreshState;
  refreshedAt: string | null;
  retryable: boolean;
  retryAt: string | null;
}

export interface ExternalWorkArea {
  remoteId: string;
  scopeKey: string;
  name: string;
  kind: ExternalWorkAreaKind;
  description: string | null;
  assignedTaskCount: number;
  hierarchy: ExternalWorkAreaLocation[];
  workflow: ExternalWorkAreaWorkflow;
  refresh: ExternalWorkAreaRefresh;
}

export interface ExternalTaskSummary {
  remoteId: string;
  parentRemoteTaskId: string | null;
  title: string;
  status: ExternalTaskStatus;
  updatedAt: string;
  dueAt: string | null;
  completedAt: string | null;
  webUrl: string | null;
}

export interface ExternalTaskSubtaskSummary {
  remoteId: string;
  remoteKey: string;
  title: string;
  status: ExternalTaskStatus;
  webUrl: string | null;
}

export interface ExternalWorkAreaTask {
  workArea: ExternalWorkArea;
  task: ExternalTaskSummary;
}

export type ExternalTaskAction = 'change_status' | 'add_comment' | 'log_time';

export interface ExternalTaskActionCapability {
  action: ExternalTaskAction;
  supported: boolean;
}

export interface ExternalTaskPriority {
  name: string;
  color: string;
}

export interface ExternalTaskLocation {
  scopeKey: string;
  workAreaId: string;
  workAreaName: string;
}

export interface ExternalTaskLinkState {
  linked: boolean;
  epicId: string | null;
}

export interface ExternalProviderTaskDetail {
  remoteId: string;
  remoteKey: string;
  title: string;
  description: string | null;
  descriptionTruncated: boolean;
  status: ExternalWorkAreaColumn;
  dueAt: string | null;
  priority: ExternalTaskPriority | null;
  subtasks: ExternalTaskSubtaskSummary[];
  subtasksTruncated: boolean;
  /** Total logged time on the task in ms; null when the provider reports none. */
  taskTotalDurationMs: number | null;
  webUrl: string;
  location: ExternalTaskLocation;
  allowedStatuses: ExternalTaskStatusOption[];
  actions: ExternalTaskActionCapability[];
}

export interface ExternalTaskDetail extends ExternalProviderTaskDetail {
  linkState: ExternalTaskLinkState;
}

export interface ExternalTaskStatusInput {
  status: string;
}

export interface ExternalTaskCommentInput {
  text: string;
  notifyAll: boolean;
}

export interface ExternalTaskCommentAuthor {
  remoteId: string | null;
  displayName: string;
}

/** Bounded canonical rendering of a comment's rich body, when parseable. */
export interface ExternalTaskCommentRich {
  document: ExternalRichDocumentV1;
  supported: true;
}

export type ExternalTaskCommentRichResult =
  | ExternalTaskCommentRich
  | { supported: false; readOnlyReason: string };

export interface ExternalTaskComment {
  remoteId: string;
  author: ExternalTaskCommentAuthor;
  body: string;
  bodyTruncated: boolean;
  /** Canonical rich body when the provider payload parses inside the closed set. */
  rich: ExternalTaskCommentRichResult | null;
  /** Server-issued lookup token (ClickUp); null on Jira, which reads comments exactly. */
  lookupToken: string | null;
  /**
   * Server-confirmed: the comment's author id equals the currently
   * connected vendor user. Drives owned edit/delete affordances; false when
   * the author is unknown or another user.
   */
  owned: boolean;
  createdAt: string;
  updatedAt: string | null;
}

export interface ExternalTaskCommentPage {
  comments: ExternalTaskComment[];
  nextCursor: string | null;
}

export interface ExternalTaskTimeEntryInput {
  startedAt: string;
  durationMs: number;
  note: string | null;
}

/**
 * One completed time entry of the connected user. `canDelete` is true only
 * for the current owner with a confirmed provider permission.
 */
export interface ExternalTaskTimeEntry {
  remoteId: string;
  durationMs: number;
  startedAt: string;
  note: string | null;
  noteTruncated: boolean;
  canDelete: boolean;
}

/**
 * Fixed-window, connected-user-only time-entry history. `truncated` marks
 * incomplete coverage (paging caps, provider truncation, or the entry cap);
 * `hasRunningTimer` is true when the provider reports a running timer that
 * never appears in `entries`.
 */
export interface ExternalTaskTimeEntryHistory {
  windowDays: 30;
  entries: ExternalTaskTimeEntry[];
  truncated: boolean;
  hasRunningTimer: boolean;
}

export interface ExternalTaskActionResult {
  remoteTaskId: string;
  action: ExternalTaskAction;
  succeeded: true;
  refresh: Array<'my_work' | 'task_detail'>;
}

export interface ExternalTaskLinkLookupInput {
  scopeKey: string;
  taskId: string;
}

export interface ExternalTaskLinkStateSummary extends ExternalTaskLinkLookupInput {
  linked: boolean;
  epicId: string | null;
  projectId: string | null;
  projectName: string | null;
}

export interface ExternalTaskSourceSummary {
  provider: IntegrationProvider;
  remoteTaskId: string;
  remoteKey: string;
  title: string;
  workAreaName: string;
  statusName: string;
  webUrl: string | null;
  linkedAt: string;
}

export interface ExternalTaskImportResponse {
  epic: {
    id: string;
    projectId: string;
  };
  created: boolean;
}

export interface ExternalMyWorkRequestOptions {
  includeCompleted: boolean;
}

export interface ExternalProviderConnectionContext {
  connectionId: string;
  connectionGeneration: number;
}

export interface ExternalMyWorkOptions
  extends ExternalMyWorkRequestOptions,
    ExternalProviderConnectionContext {}

export interface ExternalMyWorkCapabilities {
  timeTrackingEnabled: boolean;
}

export interface ExternalMyWorkSnapshot {
  capabilities: ExternalMyWorkCapabilities;
  workAreas: ExternalWorkArea[];
  tasks: ExternalWorkAreaTask[];
  refreshedAt: string;
}

export interface ExternalMyWorkCapability {
  discover(
    credentials: IntegrationCredentials,
    options: ExternalMyWorkOptions,
  ): Promise<ExternalMyWorkSnapshot>;
  getTaskDetail(
    credentials: IntegrationCredentials,
    context: ExternalProviderConnectionContext,
    remoteTaskId: string,
  ): Promise<ExternalProviderTaskDetail>;
  listComments(
    credentials: IntegrationCredentials,
    context: ExternalProviderConnectionContext,
    remoteTaskId: string,
    cursor: string | null,
  ): Promise<ExternalTaskCommentPage>;
  changeStatus(
    credentials: IntegrationCredentials,
    context: ExternalProviderConnectionContext,
    remoteTaskId: string,
    input: ExternalTaskStatusInput,
  ): Promise<void>;
  addComment(
    credentials: IntegrationCredentials,
    context: ExternalProviderConnectionContext,
    remoteTaskId: string,
    input: ExternalTaskCommentInput,
  ): Promise<void>;
  getTimeEntryHistory(
    credentials: IntegrationCredentials,
    context: ExternalProviderConnectionContext,
    remoteTaskId: string,
  ): Promise<ExternalTaskTimeEntryHistory>;
}

/** Exact single time-entry read; null only for a classified exact-resource 404. */
export interface ExternalTimeEntryExactRead {
  remoteId: string;
  startedAt: string;
  durationMs: number;
  owned: boolean;
}

/**
 * Own-entry ids whose start falls in the window. `complete` is true only
 * when the provider proves the window was fully covered.
 */
export interface ExternalTimeEntryRangeIds {
  ids: string[];
  complete: boolean;
}

/**
 * A provider-confirmed create. The documented ClickUp create response is a
 * flat receipt with no entry id, so a confirmed proof may name no entry.
 */
export interface ExternalTimeEntryCreateProof {
  remoteEntryId: string | null;
}

/**
 * Receipt-bound time-entry mutations. Every call may leave a dispatched
 * request with an unknown vendor outcome; proofs and 404s are the only
 * resolution evidence, never collection absence.
 */
export interface ExternalTimeEntryMutationsCapability {
  createTimeEntry(
    credentials: IntegrationCredentials,
    context: ExternalProviderConnectionContext,
    remoteTaskId: string,
    input: ExternalTaskTimeEntryInput,
  ): Promise<ExternalTimeEntryCreateProof>;
  deleteTimeEntry(
    credentials: IntegrationCredentials,
    context: ExternalProviderConnectionContext,
    remoteTaskId: string,
    remoteEntryId: string,
  ): Promise<void>;
  readTimeEntryExact(
    credentials: IntegrationCredentials,
    context: ExternalProviderConnectionContext,
    remoteTaskId: string,
    remoteEntryId: string,
  ): Promise<ExternalTimeEntryExactRead | null>;
  listOwnTimeEntryIdsInRange(
    credentials: IntegrationCredentials,
    context: ExternalProviderConnectionContext,
    remoteTaskId: string,
    startedAfterMs: number,
    startedBeforeMs: number,
  ): Promise<ExternalTimeEntryRangeIds>;
  /** Provider-specific delete preflight; throws classified errors when the
   * entry is missing, not owned, or not deletable. */
  assertTimeEntryDeletable(
    credentials: IntegrationCredentials,
    context: ExternalProviderConnectionContext,
    remoteTaskId: string,
    remoteEntryId: string,
  ): Promise<void>;
}

export interface ExternalSubtaskOwnershipProof {
  remoteTaskId: string;
  expectedParentRemoteTaskId: string;
  ownershipToken: string;
}

export interface ExternalSubtaskCreateInput {
  parentRemoteTaskId: string;
  ownershipToken: string;
  title: string;
  description: string | null;
}

export interface ExternalSubtaskUpdateInput extends ExternalSubtaskOwnershipProof {
  title?: string;
  description?: string | null;
}

/** Provider-neutral proof returned by exact reads and child enumeration. */
export interface ExternalSubtaskSnapshot {
  remoteTaskId: string;
  remoteKey: string;
  parentRemoteTaskId: string | null;
  workAreaRemoteId: string;
  ownershipToken: string | null;
  title: string;
  description: string | null;
}

export interface ExternalSubtaskChildrenResult {
  items: ExternalSubtaskSnapshot[];
  /** True only when the provider result proves every direct child was inspected. */
  complete: boolean;
}

export type ExternalSubtaskDeleteResult = { outcome: 'deleted' } | { outcome: 'already_absent' };

/**
 * Internal one-way managed-subtask capability. It deliberately remains
 * separate from the browser-facing task-action union.
 */
export interface ExternalSubtaskSyncCapability {
  create(
    credentials: IntegrationCredentials,
    context: ExternalProviderConnectionContext,
    input: ExternalSubtaskCreateInput,
  ): Promise<ExternalSubtaskSnapshot>;
  readExact(
    credentials: IntegrationCredentials,
    context: ExternalProviderConnectionContext,
    remoteTaskId: string,
  ): Promise<ExternalSubtaskSnapshot | null>;
  update(
    credentials: IntegrationCredentials,
    context: ExternalProviderConnectionContext,
    input: ExternalSubtaskUpdateInput,
  ): Promise<void>;
  delete(
    credentials: IntegrationCredentials,
    context: ExternalProviderConnectionContext,
    proof: ExternalSubtaskOwnershipProof,
  ): Promise<ExternalSubtaskDeleteResult>;
  listOwnedDirectChildren(
    credentials: IntegrationCredentials,
    context: ExternalProviderConnectionContext,
    parentRemoteTaskId: string,
    ownershipToken: string,
  ): Promise<ExternalSubtaskChildrenResult>;
  assertOwned(
    credentials: IntegrationCredentials,
    context: ExternalProviderConnectionContext,
    proof: ExternalSubtaskOwnershipProof,
  ): Promise<ExternalSubtaskSnapshot>;
}

/** A comment located through the provider's bounded lookup contract. */
export interface ExternalOwnedCommentSnapshot {
  remoteId: string;
  authorRemoteId: string | null;
  createdAt: string;
  /** Provider-native rich body (ClickUp delta array, Jira ADF document). */
  raw: unknown;
  /** ClickUp comment state that an update must preserve verbatim. */
  metadata: {
    assignee: number | null;
    resolved: boolean | null;
    groupAssignee: string | null;
  };
}

/**
 * Owner-scoped comment mutations. `findComment` is bounded: ClickUp replays
 * at most the producing page plus one provider-issued adjacent page; Jira
 * performs one exact-comment read. `pageProof` is the provider cursor of the
 * page that produced the comment, or null for the newest page.
 */
export interface ExternalOwnedMutationsCapability {
  getCurrentOwnerRemoteId(credentials: IntegrationCredentials): Promise<string>;
  findComment(
    credentials: IntegrationCredentials,
    context: ExternalProviderConnectionContext,
    remoteTaskId: string,
    commentId: string,
    pageProof: string | null,
  ): Promise<ExternalOwnedCommentSnapshot | null>;
  deleteComment(
    credentials: IntegrationCredentials,
    context: ExternalProviderConnectionContext,
    remoteTaskId: string,
    commentId: string,
  ): Promise<void>;
  /** Updates the comment's rich body with the canonical document, preserving
   * the freshly fetched ClickUp assignee/resolved/group-assignee values. */
  updateOwnedComment(
    credentials: IntegrationCredentials,
    context: ExternalProviderConnectionContext,
    remoteTaskId: string,
    commentId: string,
    document: ExternalRichDocumentV1,
    metadata: ExternalOwnedCommentSnapshot['metadata'],
  ): Promise<void>;
}

/**
 * Provider-native rich description read/write. `raw` is the vendor payload
 * (a Jira ADF document object, a ClickUp markdown string); conversion to the
 * canonical model happens above the adapter.
 */
export interface ExternalDescriptionEditCapability {
  readDescription(
    credentials: IntegrationCredentials,
    context: ExternalProviderConnectionContext,
    remoteTaskId: string,
  ): Promise<unknown>;
  writeDescription(
    credentials: IntegrationCredentials,
    context: ExternalProviderConnectionContext,
    remoteTaskId: string,
    raw: unknown,
  ): Promise<void>;
}

export type ExternalMyWorkResult =
  | {
      provider: IntegrationProvider;
      descriptor: ExternalProviderDescriptor;
      supported: false;
      reason: 'unsupported';
    }
  | ({
      provider: IntegrationProvider;
      descriptor: ExternalProviderDescriptor;
      supported: true;
    } & ExternalMyWorkSnapshot);
