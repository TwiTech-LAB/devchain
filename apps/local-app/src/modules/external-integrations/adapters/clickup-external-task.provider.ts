import { Injectable } from '@nestjs/common';
import type { IntegrationCredentials } from '../../storage/models/domain.models';
import { ClickUpProviderError } from '../errors/external-provider.errors';
import type { ExternalProviderAccount } from '../models/external-provider.models';
import {
  MAX_TASK_COMMENT_BODY_LENGTH,
  MAX_TASK_COMMENT_CURSOR_LENGTH,
  MAX_TASK_COMMENT_ID_LENGTH,
  MAX_TASK_DETAIL_TEXT_LENGTH,
  MAX_TIME_ENTRY_HISTORY_ENTRIES,
  MAX_TIME_ENTRY_NOTE_LENGTH,
  TIME_ENTRY_HISTORY_WINDOW_DAYS,
  type ExternalDescriptionEditCapability,
  type ExternalMyWorkCapability,
  type ExternalMyWorkOptions,
  type ExternalMyWorkSnapshot,
  type ExternalOwnedCommentSnapshot,
  type ExternalOwnedMutationsCapability,
  type ExternalProviderConnectionContext,
  type ExternalProviderTaskDetail,
  type ExternalTaskComment,
  type ExternalTaskCommentInput,
  type ExternalTaskCommentPage,
  type ExternalTaskStatusCategory,
  type ExternalTaskStatusInput,
  type ExternalTaskStatusOption,
  type ExternalTaskTimeEntry,
  type ExternalTaskTimeEntryHistory,
  type ExternalTaskTimeEntryInput,
  type ExternalTimeEntryCreateProof,
  type ExternalTimeEntryExactRead,
  type ExternalTimeEntryMutationsCapability,
  type ExternalTimeEntryRangeIds,
  type ExternalWorkArea,
  type ExternalWorkAreaColumn,
  type ExternalWorkAreaTask,
} from '../models/external-provider.models';
import { normalizeExternalTaskSourceUrl } from '../models/external-task-source';
import { encodeExternalCommentLookupToken } from '../models/external-comment-lookup-token';
import { clickupCommentDeltaToRichDocument } from './rich/clickup-comment-converter';
import { richDocumentToClickUpCommentDelta } from './rich/clickup-comment-converter';
import type { ExternalRichDocumentV1 } from '../models/external-rich-document';
import type { ExternalTaskProvider } from '../ports/external-task-provider';
import {
  SafeVendorHttpClient,
  type SafeVendorJsonRequest,
} from '../transport/safe-vendor-http-client';
import {
  RECENT_COMPLETED_WINDOW_MS,
  VENDOR_DISCOVERY_CONCURRENCY,
  VendorMetadataCache,
  WORK_AREA_METADATA_CACHE_MAX_ENTRIES,
  WORK_AREA_METADATA_TTL_MS,
  compareRemoteIds,
  createVendorValidators,
  isRecord,
  mapVendorTransportError,
  mapWithConcurrency,
  materializeWorkArea,
  vendorRetryAt,
  type CachedWorkAreaMetadata,
  type VendorCommentAuthorSpec,
} from './vendor-shared';

const CLICKUP_ORIGIN = 'https://api.clickup.com';
const CLICKUP_TASK_PAGE_SIZE = 100;
const CLICKUP_MAX_TASK_PAGES = 1_000;
const CLICKUP_COMMENT_PAGE_SIZE = 25;
const CLICKUP_COMMENT_CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/;
const CLICKUP_COMMENT_AUTHOR: VendorCommentAuthorSpec = {
  nameKey: 'username',
  idKey: 'id',
  idFormat: 'identifier',
};

interface ClickUpIdentityDto {
  user?: {
    id?: unknown;
    username?: unknown;
  };
}

interface ClickUpWorkspace {
  id: string;
  name: string;
}

@Injectable()
export class ClickUpExternalTaskProvider implements ExternalTaskProvider {
  readonly provider = 'clickup' as const;
  readonly descriptor = {
    provider: this.provider,
    displayName: 'ClickUp',
    capabilities: { myWork: true },
  } as const;
  readonly myWork: ExternalMyWorkCapability = {
    discover: (credentials, options) => this.discoverMyWork(credentials, options),
    getTaskDetail: (credentials, context, remoteTaskId) =>
      this.getTaskDetail(credentials, context, remoteTaskId),
    listComments: (credentials, context, remoteTaskId, cursor) =>
      this.listTaskComments(credentials, context, remoteTaskId, cursor),
    changeStatus: (credentials, context, remoteTaskId, input) =>
      this.changeTaskStatus(credentials, context, remoteTaskId, input),
    addComment: (credentials, context, remoteTaskId, input) =>
      this.addTaskComment(credentials, context, remoteTaskId, input),
    getTimeEntryHistory: (credentials, context, remoteTaskId) =>
      this.getTaskTimeEntryHistory(credentials, context, remoteTaskId),
  };

  readonly timeEntryMutations: ExternalTimeEntryMutationsCapability = {
    createTimeEntry: (credentials, context, remoteTaskId, input) =>
      this.createTimeEntry(credentials, context, remoteTaskId, input),
    deleteTimeEntry: (credentials, context, remoteTaskId, remoteEntryId) =>
      this.deleteTimeEntry(credentials, context, remoteTaskId, remoteEntryId),
    readTimeEntryExact: (credentials, context, remoteTaskId, remoteEntryId) =>
      this.readTimeEntryExact(credentials, context, remoteTaskId, remoteEntryId),
    listOwnTimeEntryIdsInRange: (
      credentials,
      context,
      remoteTaskId,
      startedAfterMs,
      startedBeforeMs,
    ) =>
      this.listOwnTimeEntryIdsInRange(
        credentials,
        context,
        remoteTaskId,
        startedAfterMs,
        startedBeforeMs,
      ),
    assertTimeEntryDeletable: (credentials, context, remoteTaskId, remoteEntryId) =>
      this.assertTimeEntryDeletable(credentials, context, remoteTaskId, remoteEntryId),
  };
  private readonly listMetadataCache = new VendorMetadataCache<CachedWorkAreaMetadata>(
    WORK_AREA_METADATA_CACHE_MAX_ENTRIES,
  );
  private readonly validate = createVendorValidators((reason) => new ClickUpProviderError(reason));

  constructor(private readonly http: SafeVendorHttpClient) {}

  readonly ownedMutations: ExternalOwnedMutationsCapability = {
    getCurrentOwnerRemoteId: (credentials) => this.getCurrentOwnerRemoteId(credentials),
    findComment: (credentials, context, remoteTaskId, commentId, pageProof) =>
      this.findComment(credentials, context, remoteTaskId, commentId, pageProof),
    deleteComment: (credentials, context, remoteTaskId, commentId) =>
      this.deleteComment(credentials, context, remoteTaskId, commentId),
    updateOwnedComment: (credentials, context, remoteTaskId, commentId, document, metadata) =>
      this.updateOwnedComment(credentials, context, remoteTaskId, commentId, document, metadata),
  };

  readonly descriptionEdit: ExternalDescriptionEditCapability = {
    readDescription: (credentials, context, remoteTaskId) =>
      this.readDescription(credentials, context, remoteTaskId),
    writeDescription: (credentials, context, remoteTaskId, raw) =>
      this.writeDescription(credentials, context, remoteTaskId, raw),
  };

  private async getCurrentOwnerRemoteId(credentials: IntegrationCredentials): Promise<string> {
    const token = this.requireToken(credentials);
    const payload = await this.requestJson(token, `${CLICKUP_ORIGIN}/api/v2/user`);
    const dto = payload as ClickUpIdentityDto;
    return this.validate.requiredIdentifier(dto?.user?.id);
  }

  /**
   * Bounded comment lookup: replays at most the producing page (the pageProof
   * cursor, or the newest page) plus one provider-issued adjacent page, then
   * stops. ClickUp has no exact-comment read, so this is the whole proof.
   */
  private async findComment(
    credentials: IntegrationCredentials,
    _context: ExternalProviderConnectionContext,
    remoteTaskId: string,
    commentId: string,
    pageProof: string | null,
  ): Promise<ExternalOwnedCommentSnapshot | null> {
    const token = this.requireToken(credentials);
    const taskId = this.validate.requiredTaskId(remoteTaskId);
    const normalizedCommentId = this.validate.requiredIdentifier(commentId);
    let position: { date: number; id: string } | null =
      pageProof === null ? null : this.decodeCommentCursor(pageProof);
    for (let hop = 0; hop < 2; hop += 1) {
      const url = new URL(`${CLICKUP_ORIGIN}/api/v2/task/${encodeURIComponent(taskId)}/comment`);
      if (position) {
        url.searchParams.set('start', String(position.date));
        url.searchParams.set('start_id', position.id);
      }
      const payload = await this.requestJson(token, url.toString());
      if (!isRecord(payload) || !Array.isArray(payload.comments)) {
        throw new ClickUpProviderError('invalid_response');
      }
      const match = (payload.comments as unknown[]).find(
        (value) =>
          isRecord(value) &&
          (typeof value.id === 'string' || typeof value.id === 'number') &&
          String(value.id) === normalizedCommentId,
      );
      if (match) {
        const snapshot = this.normalizeTaskComment(match);
        return {
          remoteId: snapshot.remoteId,
          authorRemoteId: snapshot.author.remoteId,
          createdAt: snapshot.createdAt,
          raw: (match as Record<string, unknown>).comment ?? null,
          metadata: this.commentMetadata(match),
        };
      }
      const last = (payload.comments as unknown[])[payload.comments.length - 1];
      const lastRecord = isRecord(last) ? last : null;
      if (!lastRecord) {
        return null;
      }
      const nextDate = this.requiredTimestamp(lastRecord.date);
      const nextId =
        typeof lastRecord.id === 'string' || typeof lastRecord.id === 'number'
          ? String(lastRecord.id)
          : null;
      if (nextId === null) {
        return null;
      }
      position = this.decodeCommentCursor(this.encodeCommentCursor(Date.parse(nextDate), nextId));
    }
    return null;
  }

  private async deleteComment(
    credentials: IntegrationCredentials,
    _context: ExternalProviderConnectionContext,
    remoteTaskId: string,
    commentId: string,
  ): Promise<void> {
    const token = this.requireToken(credentials);
    this.validate.requiredTaskId(remoteTaskId);
    const normalizedCommentId = this.validate.requiredIdentifier(commentId);
    await this.requestJson(
      token,
      `${CLICKUP_ORIGIN}/api/v2/comment/${encodeURIComponent(normalizedCommentId)}`,
      { method: 'DELETE' },
    );
  }

  /** ClickUp's update contract replaces the whole comment, so the current
   * assignee/resolved/group-assignee state must ride along unchanged. */
  private async updateOwnedComment(
    credentials: IntegrationCredentials,
    _context: ExternalProviderConnectionContext,
    remoteTaskId: string,
    commentId: string,
    document: ExternalRichDocumentV1,
    metadata: ExternalOwnedCommentSnapshot['metadata'],
  ): Promise<void> {
    const token = this.requireToken(credentials);
    this.validate.requiredTaskId(remoteTaskId);
    const normalizedCommentId = this.validate.requiredIdentifier(commentId);
    const emitted = richDocumentToClickUpCommentDelta(document);
    if (!emitted.ok) {
      throw new ClickUpProviderError('request_rejected');
    }
    await this.requestJson(
      token,
      `${CLICKUP_ORIGIN}/api/v2/comment/${encodeURIComponent(normalizedCommentId)}`,
      {
        method: 'PUT',
        body: JSON.stringify({
          comment: emitted.delta,
          assignee: metadata.assignee,
          resolved: metadata.resolved ?? false,
          ...(metadata.groupAssignee !== null ? { group_assignee: metadata.groupAssignee } : {}),
        }),
      },
    );
  }

  /** Reads the ClickUp comment state an update must preserve verbatim. */
  private commentMetadata(raw: unknown): ExternalOwnedCommentSnapshot['metadata'] {
    if (!isRecord(raw)) {
      return { assignee: null, resolved: null, groupAssignee: null };
    }
    const assignee = isRecord(raw.assignee) ? raw.assignee.id : raw.assignee;
    const groupAssignee = raw.group_assignee;
    return {
      assignee:
        typeof assignee === 'number' && Number.isSafeInteger(assignee)
          ? assignee
          : typeof assignee === 'string' && /^\d+$/.test(assignee)
            ? Number(assignee)
            : null,
      resolved: typeof raw.resolved === 'boolean' ? raw.resolved : null,
      groupAssignee: typeof groupAssignee === 'string' && groupAssignee ? groupAssignee : null,
    };
  }

  private async readDescription(
    credentials: IntegrationCredentials,
    _context: ExternalProviderConnectionContext,
    remoteTaskId: string,
  ): Promise<unknown> {
    const token = this.requireToken(credentials);
    const taskId = this.validate.requiredTaskId(remoteTaskId);
    const url = new URL(`${CLICKUP_ORIGIN}/api/v2/task/${encodeURIComponent(taskId)}`);
    url.searchParams.set('include_markdown_description', 'true');
    const payload = await this.requestJson(token, url.toString());
    if (!isRecord(payload)) {
      throw new ClickUpProviderError('invalid_response');
    }
    const markdown = payload.markdown_description;
    if (markdown === null || markdown === undefined) {
      return null;
    }
    if (typeof markdown !== 'string') {
      throw new ClickUpProviderError('invalid_response');
    }
    return markdown;
  }

  private async writeDescription(
    credentials: IntegrationCredentials,
    _context: ExternalProviderConnectionContext,
    remoteTaskId: string,
    raw: unknown,
  ): Promise<void> {
    const token = this.requireToken(credentials);
    const taskId = this.validate.requiredTaskId(remoteTaskId);
    if (typeof raw !== 'string' || !raw.trim()) {
      throw new ClickUpProviderError('request_rejected');
    }
    await this.requestJson(token, `${CLICKUP_ORIGIN}/api/v2/task/${encodeURIComponent(taskId)}`, {
      method: 'PUT',
      body: JSON.stringify({ markdown_description: raw }),
    });
  }

  async verifyCredentials(credentials: IntegrationCredentials): Promise<ExternalProviderAccount> {
    const token = this.requireToken(credentials);

    const payload = await this.requestJson(token, `${CLICKUP_ORIGIN}/api/v2/user`);

    const dto = payload as ClickUpIdentityDto;
    const remoteId = dto?.user?.id;
    const displayName = dto?.user?.username;
    if (typeof displayName !== 'string' || !displayName.trim()) {
      throw new ClickUpProviderError('invalid_response');
    }

    return {
      provider: this.provider,
      remoteId: this.validate.requiredIdentifier(remoteId),
      displayName: displayName.trim(),
    };
  }

  private async getTaskDetail(
    credentials: IntegrationCredentials,
    _context: ExternalProviderConnectionContext,
    remoteTaskId: string,
  ): Promise<ExternalProviderTaskDetail> {
    const token = this.requireToken(credentials);
    const taskId = this.validate.requiredTaskId(remoteTaskId);
    const payload = await this.requestJson(
      token,
      `${CLICKUP_ORIGIN}/api/v2/task/${encodeURIComponent(taskId)}`,
    );
    if (!isRecord(payload) || !isRecord(payload.status) || !isRecord(payload.list)) {
      throw new ClickUpProviderError('invalid_response');
    }
    const returnedId = this.validate.requiredIdentifier(payload.id);
    if (returnedId !== taskId) {
      throw new ClickUpProviderError('invalid_response');
    }
    const scopeKey = this.validate.requiredIdentifier(payload.team_id);
    const workAreaId = this.validate.requiredIdentifier(payload.list.id);
    const description = this.boundedTaskDescription(payload.text_content);
    const webUrl = this.requiredTaskUrl(payload.url);
    const allowedStatuses = await this.loadAllowedStatuses(token, workAreaId);
    const customId = payload.custom_id;
    if (customId !== null && customId !== undefined && typeof customId !== 'string') {
      throw new ClickUpProviderError('invalid_response');
    }

    return {
      remoteId: returnedId,
      remoteKey: typeof customId === 'string' && customId.trim() ? customId : returnedId,
      title: this.validate.requiredString(payload.name),
      description: description.value,
      descriptionTruncated: description.truncated,
      status: this.normalizeColumn(payload.status),
      dueAt: this.optionalTimestamp(payload.due_date),
      priority: this.normalizePriority(payload.priority),
      taskTotalDurationMs: this.taskTotalDurationMs(payload.time_spent),
      webUrl,
      location: {
        scopeKey,
        workAreaId,
        workAreaName: this.validate.requiredString(payload.list.name),
      },
      allowedStatuses,
      actions: [
        { action: 'change_status', supported: true },
        { action: 'add_comment', supported: true },
        { action: 'log_time', supported: true },
      ],
    };
  }

  private async listTaskComments(
    credentials: IntegrationCredentials,
    context: ExternalProviderConnectionContext,
    remoteTaskId: string,
    cursor: string | null,
  ): Promise<ExternalTaskCommentPage> {
    const token = this.requireToken(credentials);
    const taskId = this.validate.requiredTaskId(remoteTaskId);
    const position = cursor === null ? null : this.decodeCommentCursor(cursor);
    const url = new URL(`${CLICKUP_ORIGIN}/api/v2/task/${encodeURIComponent(taskId)}/comment`);
    if (position) {
      url.searchParams.set('start', String(position.date));
      url.searchParams.set('start_id', position.id);
    }
    const payload = await this.requestJson(token, url.toString());
    if (!isRecord(payload) || !Array.isArray(payload.comments)) {
      throw new ClickUpProviderError('invalid_response');
    }
    if (payload.comments.length > CLICKUP_COMMENT_PAGE_SIZE) {
      throw new ClickUpProviderError('invalid_response');
    }
    const comments = payload.comments.map((value) => {
      const comment = this.normalizeTaskComment(value);
      return this.enrichTaskComment(comment, value, taskId, cursor, context);
    });
    const last = comments[comments.length - 1];
    return {
      comments,
      nextCursor:
        comments.length === CLICKUP_COMMENT_PAGE_SIZE && last
          ? this.encodeCommentCursor(Date.parse(last.createdAt), last.remoteId)
          : null,
    };
  }

  /** Attaches the bounded canonical body and the server-issued lookup token
   * binding this comment to the page that produced it. */
  private enrichTaskComment(
    comment: Omit<ExternalTaskComment, 'rich' | 'lookupToken' | 'owned'>,
    raw: unknown,
    taskId: string,
    pageProof: string | null,
    context: ExternalProviderConnectionContext,
  ): ExternalTaskComment {
    const delta = isRecord(raw) ? raw.comment : undefined;
    const parsed =
      delta === undefined || delta === null ? null : clickupCommentDeltaToRichDocument(delta);
    return {
      ...comment,
      owned: false,
      rich:
        parsed === null
          ? null
          : parsed.supported
            ? { document: parsed.document, supported: true }
            : { supported: false, readOnlyReason: parsed.reason },
      lookupToken: encodeExternalCommentLookupToken({
        v: 1,
        provider: 'clickup',
        connectionId: context.connectionId,
        connectionGeneration: context.connectionGeneration,
        taskId,
        commentId: comment.remoteId,
        pageProof,
      }),
    };
  }

  private decodeCommentCursor(cursor: string): { date: number; id: string } {
    if (
      cursor.length > MAX_TASK_COMMENT_CURSOR_LENGTH ||
      !CLICKUP_COMMENT_CURSOR_PATTERN.test(cursor)
    ) {
      throw new ClickUpProviderError('request_rejected');
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    } catch {
      throw new ClickUpProviderError('request_rejected');
    }
    if (!isRecord(decoded)) {
      throw new ClickUpProviderError('request_rejected');
    }
    const id = decoded.id;
    if (typeof id !== 'string' || !id.trim() || id.trim().length > MAX_TASK_COMMENT_ID_LENGTH) {
      throw new ClickUpProviderError('request_rejected');
    }
    const date = decoded.date;
    if (typeof date !== 'number' || !Number.isSafeInteger(date) || date < 0) {
      throw new ClickUpProviderError('request_rejected');
    }
    return { date, id: id.trim() };
  }

  private encodeCommentCursor(date: number, id: string): string {
    return Buffer.from(JSON.stringify({ date, id }), 'utf8').toString('base64url');
  }

  private normalizeTaskComment(
    value: unknown,
  ): Omit<ExternalTaskComment, 'rich' | 'lookupToken' | 'owned'> {
    if (!isRecord(value)) {
      throw new ClickUpProviderError('invalid_response');
    }
    const remoteId = this.validate.requiredIdentifier(value.id);
    if (remoteId.length > MAX_TASK_COMMENT_ID_LENGTH) {
      throw new ClickUpProviderError('invalid_response');
    }
    const text = value.comment_text;
    if (text !== null && text !== undefined && typeof text !== 'string') {
      throw new ClickUpProviderError('invalid_response');
    }
    const body = text ?? '';
    return {
      remoteId,
      author: this.validate.commentAuthor(value.user, CLICKUP_COMMENT_AUTHOR),
      body: body.slice(0, MAX_TASK_COMMENT_BODY_LENGTH),
      bodyTruncated: body.length > MAX_TASK_COMMENT_BODY_LENGTH,
      createdAt: this.requiredTimestamp(value.date),
      updatedAt: null,
    };
  }

  private async changeTaskStatus(
    credentials: IntegrationCredentials,
    _context: ExternalProviderConnectionContext,
    remoteTaskId: string,
    input: ExternalTaskStatusInput,
  ): Promise<void> {
    const token = this.requireToken(credentials);
    const taskId = this.validate.requiredTaskId(remoteTaskId);
    const status = this.validate.statusInput(input);
    await this.requestJson(token, `${CLICKUP_ORIGIN}/api/v2/task/${encodeURIComponent(taskId)}`, {
      method: 'PUT',
      body: JSON.stringify({ status }),
    });
  }

  private async addTaskComment(
    credentials: IntegrationCredentials,
    _context: ExternalProviderConnectionContext,
    remoteTaskId: string,
    input: ExternalTaskCommentInput,
  ): Promise<void> {
    const token = this.requireToken(credentials);
    const taskId = this.validate.requiredTaskId(remoteTaskId);
    this.validate.commentInput(input);
    await this.requestJson(
      token,
      `${CLICKUP_ORIGIN}/api/v2/task/${encodeURIComponent(taskId)}/comment`,
      {
        method: 'POST',
        body: JSON.stringify({ comment_text: input.text, notify_all: input.notifyAll }),
      },
    );
  }

  private async loadTaskWorkspace(token: string, taskId: string): Promise<string> {
    const task = await this.requestJson(
      token,
      `${CLICKUP_ORIGIN}/api/v2/task/${encodeURIComponent(taskId)}`,
    );
    if (!isRecord(task) || this.validate.requiredIdentifier(task.id) !== taskId) {
      throw new ClickUpProviderError('invalid_response');
    }
    return this.validate.requiredIdentifier(task.team_id);
  }

  private async createTimeEntry(
    credentials: IntegrationCredentials,
    _context: ExternalProviderConnectionContext,
    remoteTaskId: string,
    input: ExternalTaskTimeEntryInput,
  ): Promise<ExternalTimeEntryCreateProof> {
    const token = this.requireToken(credentials);
    const taskId = this.validate.requiredTaskId(remoteTaskId);
    const startedAt = this.validate.timeEntryInput(input);

    const workspaceId = await this.loadTaskWorkspace(token, taskId);
    const body: Record<string, unknown> = {
      start: startedAt,
      duration: input.durationMs,
    };
    if (input.note !== null) {
      body.description = input.note;
    }
    body.tid = taskId;
    const payload = await this.requestJson(
      token,
      `${CLICKUP_ORIGIN}/api/v2/team/${encodeURIComponent(workspaceId)}/time_entries`,
      { method: 'POST', body: JSON.stringify(body) },
    );
    // A confirmed 200 must carry the documented created-entry receipt; any
    // parse or schema failure leaves the vendor outcome unknown.
    if (!isRecord(payload) || !this.isDocumentedCreateReceipt(payload, taskId)) {
      throw new ClickUpProviderError('invalid_response', undefined, true);
    }
    return { remoteEntryId: this.optionalIdentifier(payload.id) };
  }

  /**
   * The documented create response is a flat receipt — start, duration,
   * billable, assignee, tags, description, tid — with no entry id. The id
   * is not part of that contract: a compatible response may carry one, and
   * the create is proven without it. ClickUp sends numbers as numbers or
   * numeric strings, so both forms validate.
   */
  private isDocumentedCreateReceipt(payload: Record<string, unknown>, taskId: string): boolean {
    if (!this.isNumericValue(payload.start) || !this.isNumericValue(payload.duration)) {
      return false;
    }
    if (!this.isNumericValue(payload.assignee) || typeof payload.billable !== 'boolean') {
      return false;
    }
    if (!Array.isArray(payload.tags)) {
      return false;
    }
    if (
      payload.description !== null &&
      payload.description !== undefined &&
      typeof payload.description !== 'string'
    ) {
      return false;
    }
    const tid = this.optionalIdentifier(payload.tid);
    return tid !== null && tid === taskId;
  }

  /**
   * ClickUp documents the singular team time-entry GET/DELETE pair; both
   * carry the entry id, and both answer 200 with the entry under a data
   * envelope.
   */
  private async readTimeEntryExact(
    credentials: IntegrationCredentials,
    _context: ExternalProviderConnectionContext,
    remoteTaskId: string,
    remoteEntryId: string,
  ): Promise<ExternalTimeEntryExactRead | null> {
    const token = this.requireToken(credentials);
    const taskId = this.validate.requiredTaskId(remoteTaskId);
    const entryId = this.validate.requiredIdentifier(remoteEntryId);
    const ownerId = await this.getCurrentOwnerRemoteId(credentials);
    const workspaceId = await this.loadTaskWorkspace(token, taskId);
    let payload: unknown;
    try {
      payload = await this.requestJson(
        token,
        `${CLICKUP_ORIGIN}/api/v2/team/${encodeURIComponent(workspaceId)}/time_entries/${encodeURIComponent(entryId)}`,
      );
    } catch (error) {
      if (error instanceof ClickUpProviderError && error.details?.reason === 'not_found') {
        return null;
      }
      throw error;
    }
    const entry = this.singularTimeEntryBody(payload);
    if (entry === null) {
      throw new ClickUpProviderError('invalid_response');
    }
    const remoteId = this.optionalIdentifier(entry.id);
    if (remoteId === null || remoteId !== entryId) {
      throw new ClickUpProviderError('invalid_response');
    }
    const owner = isRecord(entry.user) ? this.validate.requiredIdentifier(entry.user.id) : null;
    if (owner === null) {
      throw new ClickUpProviderError('invalid_response');
    }
    return {
      remoteId,
      startedAt: new Date(this.numericValue(entry.start)).toISOString(),
      durationMs: this.numericValue(entry.duration),
      owned: owner === ownerId,
    };
  }

  /**
   * Unwraps a singular GET/DELETE body: the documented `{ data: entry }`
   * envelope, a one-element `data` array, or a flat entry object. Returns
   * null when the body cannot name exactly one entry; callers own the
   * failure semantics (a read fails, a dispatched delete goes unknown).
   */
  private singularTimeEntryBody(payload: unknown): Record<string, unknown> | null {
    if (!isRecord(payload)) {
      return null;
    }
    if (!('data' in payload)) {
      return payload;
    }
    const data: unknown = payload.data;
    if (isRecord(data)) {
      return data;
    }
    if (Array.isArray(data) && data.length === 1) {
      const only = data[0];
      if (isRecord(only)) {
        return only;
      }
    }
    return null;
  }

  private async deleteTimeEntry(
    credentials: IntegrationCredentials,
    _context: ExternalProviderConnectionContext,
    remoteTaskId: string,
    remoteEntryId: string,
  ): Promise<void> {
    const token = this.requireToken(credentials);
    const taskId = this.validate.requiredTaskId(remoteTaskId);
    const entryId = this.validate.requiredIdentifier(remoteEntryId);
    const workspaceId = await this.loadTaskWorkspace(token, taskId);
    const payload = await this.requestJson(
      token,
      `${CLICKUP_ORIGIN}/api/v2/team/${encodeURIComponent(workspaceId)}/time_entries/${encodeURIComponent(entryId)}`,
      { method: 'DELETE' },
    );
    // The documented DELETE answers 200 with the deleted entry; a mismatched
    // or unusable body proves nothing about what the vendor removed.
    const entry = this.singularTimeEntryBody(payload);
    if (entry === null) {
      throw new ClickUpProviderError('invalid_response', undefined, true);
    }
    const remoteId = this.optionalIdentifier(entry.id);
    if (remoteId !== entryId) {
      throw new ClickUpProviderError('invalid_response', undefined, true);
    }
  }

  /**
   * Own-entry ids in a window through the team range endpoint. ClickUp's
   * range response has no total or pagination, so completeness is never
   * provable.
   */
  private async listOwnTimeEntryIdsInRange(
    credentials: IntegrationCredentials,
    _context: ExternalProviderConnectionContext,
    remoteTaskId: string,
    startedAfterMs: number,
    startedBeforeMs: number,
  ): Promise<ExternalTimeEntryRangeIds> {
    const token = this.requireToken(credentials);
    const taskId = this.validate.requiredTaskId(remoteTaskId);
    const ownerId = await this.getCurrentOwnerRemoteId(credentials);
    const workspaceId = await this.loadTaskWorkspace(token, taskId);

    const url = new URL(
      `${CLICKUP_ORIGIN}/api/v2/team/${encodeURIComponent(workspaceId)}/time_entries`,
    );
    url.searchParams.set('start_date', String(startedAfterMs));
    url.searchParams.set('end_date', String(startedBeforeMs));
    url.searchParams.set('task_id', taskId);
    url.searchParams.append('assignee_ids[]', ownerId);
    const payload = await this.requestJson(token, url.toString());
    if (!isRecord(payload) || !Array.isArray(payload.data)) {
      throw new ClickUpProviderError('invalid_response');
    }
    const ids: string[] = [];
    for (const value of payload.data) {
      if (!isRecord(value)) {
        throw new ClickUpProviderError('invalid_response');
      }
      ids.push(this.validate.requiredIdentifier(value.id));
    }
    return { ids, complete: false };
  }

  /**
   * The one mandatory fresh range proof before a ClickUp delete: the entry
   * must appear in the task-filtered own-entry range window right now.
   */
  private async assertTimeEntryDeletable(
    credentials: IntegrationCredentials,
    context: ExternalProviderConnectionContext,
    remoteTaskId: string,
    remoteEntryId: string,
  ): Promise<void> {
    const now = Date.now();
    const range = await this.listOwnTimeEntryIdsInRange(
      credentials,
      context,
      remoteTaskId,
      now - TIME_ENTRY_HISTORY_WINDOW_DAYS * 86_400_000,
      now,
    );
    if (!range.ids.includes(remoteEntryId)) {
      throw new ClickUpProviderError('not_found');
    }
  }

  /**
   * Recent history through the team time-entries range endpoint only: the
   * response carries no total or pagination, so provider-side truncation is
   * undetectable and only the client-side entry cap marks `truncated`.
   * A non-positive duration is a running timer — it flags the history but
   * never becomes a completed row.
   */
  private async getTaskTimeEntryHistory(
    credentials: IntegrationCredentials,
    _context: ExternalProviderConnectionContext,
    remoteTaskId: string,
  ): Promise<ExternalTaskTimeEntryHistory> {
    const token = this.requireToken(credentials);
    const taskId = this.validate.requiredTaskId(remoteTaskId);
    const ownerId = await this.getCurrentOwnerRemoteId(credentials);

    const task = await this.requestJson(
      token,
      `${CLICKUP_ORIGIN}/api/v2/task/${encodeURIComponent(taskId)}`,
    );
    if (!isRecord(task) || this.validate.requiredIdentifier(task.id) !== taskId) {
      throw new ClickUpProviderError('invalid_response');
    }
    const workspaceId = this.validate.requiredIdentifier(task.team_id);

    const now = Date.now();
    const url = new URL(
      `${CLICKUP_ORIGIN}/api/v2/team/${encodeURIComponent(workspaceId)}/time_entries`,
    );
    url.searchParams.set('start_date', String(now - TIME_ENTRY_HISTORY_WINDOW_DAYS * 86_400_000));
    url.searchParams.set('end_date', String(now));
    url.searchParams.set('task_id', taskId);
    url.searchParams.append('assignee_ids[]', ownerId);
    const payload = await this.requestJson(token, url.toString());
    if (!isRecord(payload) || !Array.isArray(payload.data)) {
      throw new ClickUpProviderError('invalid_response');
    }

    const entries: ExternalTaskTimeEntry[] = [];
    let hasRunningTimer = false;
    for (const value of payload.data) {
      const normalized = this.normalizeTimeEntry(value, ownerId);
      if (normalized.running) {
        hasRunningTimer = true;
        continue;
      }
      if (normalized.entry) {
        entries.push(normalized.entry);
      }
    }
    this.sortTimeEntries(entries);

    return {
      windowDays: TIME_ENTRY_HISTORY_WINDOW_DAYS,
      truncated: entries.length > MAX_TIME_ENTRY_HISTORY_ENTRIES,
      hasRunningTimer,
      entries: entries.slice(0, MAX_TIME_ENTRY_HISTORY_ENTRIES),
    };
  }

  /** ClickUp sends durations, timestamps, and user ids as numbers or numeric
   * strings; both forms must normalize before any comparison. */
  private normalizeTimeEntry(
    value: unknown,
    ownerId: string,
  ): { entry: ExternalTaskTimeEntry | null; running: boolean } {
    if (!isRecord(value)) {
      throw new ClickUpProviderError('invalid_response');
    }
    const remoteId = this.validate.requiredIdentifier(value.id);
    const duration = this.numericValue(value.duration);
    if (!Number.isSafeInteger(duration)) {
      throw new ClickUpProviderError('invalid_response');
    }
    if (duration <= 0) {
      return { entry: null, running: true };
    }
    const start = this.numericValue(value.start);
    let startedAt: string;
    try {
      startedAt = new Date(start).toISOString();
    } catch {
      throw new ClickUpProviderError('invalid_response');
    }
    const owner = isRecord(value.user) ? this.validate.requiredIdentifier(value.user.id) : null;
    if (owner === null) {
      throw new ClickUpProviderError('invalid_response');
    }
    if (owner !== ownerId) {
      return { entry: null, running: false };
    }
    const description = value.description;
    if (description !== null && description !== undefined && typeof description !== 'string') {
      throw new ClickUpProviderError('invalid_response');
    }
    const note = description ?? '';
    return {
      entry: {
        remoteId,
        durationMs: duration,
        startedAt,
        note: note ? note.slice(0, MAX_TIME_ENTRY_NOTE_LENGTH) : null,
        noteTruncated: note.length > MAX_TIME_ENTRY_NOTE_LENGTH,
        // A personal token acts with its user's full rights, so owning the
        // entry is the whole permission proof ClickUp offers.
        canDelete: true,
      },
      running: false,
    };
  }

  private numericValue(value: unknown): number {
    const parsed =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim()
          ? Number(value)
          : Number.NaN;
    if (!Number.isFinite(parsed)) {
      throw new ClickUpProviderError('invalid_response');
    }
    return parsed;
  }

  private isNumericValue(value: unknown): boolean {
    if (typeof value === 'number') {
      return Number.isFinite(value);
    }
    return typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value));
  }

  /** Identifier read for fields whose absence is a rejection, not a crash. */
  private optionalIdentifier(value: unknown): string | null {
    if (
      (typeof value !== 'string' && typeof value !== 'number') ||
      (typeof value === 'number' && !Number.isFinite(value)) ||
      !String(value).trim()
    ) {
      return null;
    }
    return String(value).trim();
  }

  private taskTotalDurationMs(value: unknown): number | null {
    if (value === null || value === undefined || value === '') {
      return null;
    }
    const total = this.numericValue(value);
    if (!Number.isSafeInteger(total) || total < 0) {
      throw new ClickUpProviderError('invalid_response');
    }
    return total;
  }

  private sortTimeEntries(entries: ExternalTaskTimeEntry[]): void {
    entries.sort(
      (left, right) =>
        Date.parse(right.startedAt) - Date.parse(left.startedAt) ||
        compareRemoteIds(left.remoteId, right.remoteId),
    );
  }

  private async discoverMyWork(
    credentials: IntegrationCredentials,
    options: ExternalMyWorkOptions,
  ): Promise<ExternalMyWorkSnapshot> {
    const account = await this.verifyCredentials(credentials);
    const workspaces = await this.loadWorkspaces(credentials.token);
    const now = Date.now();
    const cutoff = now - RECENT_COMPLETED_WINDOW_MS;
    const tasks = new Map<string, ExternalWorkAreaTask>();

    const workspacePages = await mapWithConcurrency(
      workspaces,
      VENDOR_DISCOVERY_CONCURRENCY,
      async (workspace) => {
        const [active, completed] = await Promise.all([
          this.loadTaskPages(credentials.token, workspace, account.remoteId, {
            includeCompleted: false,
            cutoff,
            now,
          }),
          options.includeCompleted
            ? this.loadTaskPages(credentials.token, workspace, account.remoteId, {
                includeCompleted: true,
                cutoff,
                now,
              })
            : Promise.resolve<ExternalWorkAreaTask[]>([]),
        ]);
        return [...active, ...completed];
      },
    );
    for (const page of workspacePages) {
      this.addTasks(tasks, page);
    }

    const enriched = await this.enrichWorkAreas(credentials.token, options, [...tasks.values()]);

    return {
      capabilities: { timeTrackingEnabled: true },
      workAreas: enriched.workAreas,
      tasks: enriched.tasks,
      refreshedAt: new Date().toISOString(),
    };
  }

  private async loadWorkspaces(token: string): Promise<ClickUpWorkspace[]> {
    const payload = await this.requestJson(token, `${CLICKUP_ORIGIN}/api/v2/team`);
    if (!isRecord(payload) || !Array.isArray(payload.teams)) {
      throw new ClickUpProviderError('invalid_response');
    }
    return payload.teams.map((value) => {
      if (!isRecord(value)) {
        throw new ClickUpProviderError('invalid_response');
      }
      const id = this.validate.requiredIdentifier(value.id);
      const name = this.validate.requiredString(value.name);
      return { id, name };
    });
  }

  private async loadTaskPages(
    token: string,
    workspace: ClickUpWorkspace,
    ownerId: string,
    filter: { includeCompleted: boolean; cutoff: number; now: number },
  ): Promise<ExternalWorkAreaTask[]> {
    const result: ExternalWorkAreaTask[] = [];
    for (let page = 0; page < CLICKUP_MAX_TASK_PAGES; page += 1) {
      const url = new URL(`${CLICKUP_ORIGIN}/api/v2/team/${encodeURIComponent(workspace.id)}/task`);
      url.searchParams.set('page', String(page));
      url.searchParams.set('order_by', 'id');
      url.searchParams.set('subtasks', 'true');
      url.searchParams.append('assignees[]', ownerId);
      url.searchParams.set('include_closed', String(filter.includeCompleted));
      if (filter.includeCompleted) {
        url.searchParams.set('date_done_gt', String(filter.cutoff));
        url.searchParams.set('date_done_lt', String(filter.now));
      }

      const payload = await this.requestJson(token, url.toString());
      if (!isRecord(payload) || !Array.isArray(payload.tasks)) {
        throw new ClickUpProviderError('invalid_response');
      }
      if (payload.tasks.length > CLICKUP_TASK_PAGE_SIZE) {
        throw new ClickUpProviderError('invalid_response');
      }

      for (const value of payload.tasks) {
        const task = this.normalizeTask(value, workspace, ownerId);
        if (!task) {
          continue;
        }
        if (filter.includeCompleted) {
          if (
            task.task.status.category !== 'completed' ||
            task.task.completedAt === null ||
            Date.parse(task.task.completedAt) < filter.cutoff ||
            Date.parse(task.task.completedAt) > filter.now
          ) {
            continue;
          }
        } else if (task.task.status.category === 'completed') {
          continue;
        }
        result.push(task);
      }

      if (payload.tasks.length < CLICKUP_TASK_PAGE_SIZE) {
        return result;
      }
    }
    throw new ClickUpProviderError('invalid_response');
  }

  private normalizeTask(
    value: unknown,
    workspace: ClickUpWorkspace,
    ownerId: string,
  ): ExternalWorkAreaTask | null {
    if (
      !isRecord(value) ||
      !isRecord(value.status) ||
      !isRecord(value.list) ||
      !Array.isArray(value.assignees)
    ) {
      throw new ClickUpProviderError('invalid_response');
    }
    const assignedToOwner = value.assignees.some(
      (assignee) =>
        isRecord(assignee) &&
        (typeof assignee.id === 'string' || typeof assignee.id === 'number') &&
        String(assignee.id) === ownerId,
    );
    if (!assignedToOwner) {
      return null;
    }

    const remoteId = this.validate.requiredIdentifier(value.id);
    const statusType = this.validate.requiredString(value.status.type).toLowerCase();
    const completedAt = this.optionalTimestamp(value.date_done ?? value.date_closed);
    const workArea = {
      remoteId: this.validate.requiredIdentifier(value.list.id),
      scopeKey: workspace.id,
      name: this.validate.requiredString(value.list.name),
      kind: 'list' as const,
      description: null,
      assignedTaskCount: 0,
      hierarchy: [{ kind: 'workspace' as const, remoteId: workspace.id, name: workspace.name }],
      workflow: { isOverridden: false, columns: [] },
      refresh: {
        state: 'error' as const,
        refreshedAt: null,
        retryable: true,
        retryAt: null,
      },
    };
    return {
      workArea,
      task: {
        remoteId,
        title: this.validate.requiredString(value.name),
        status: {
          remoteId:
            value.status.id === null || value.status.id === undefined
              ? null
              : this.validate.requiredIdentifier(value.status.id),
          name: this.validate.requiredString(value.status.status),
          category: this.classifyStatus(statusType),
        },
        updatedAt: this.requiredTimestamp(value.date_updated),
        dueAt: this.optionalTimestamp(value.due_date),
        completedAt,
        webUrl: this.safeTaskUrl(value.url),
      },
    };
  }

  private addTasks(
    tasks: Map<string, ExternalWorkAreaTask>,
    additions: ExternalWorkAreaTask[],
  ): void {
    for (const item of additions) {
      const taskKey = `${item.workArea.scopeKey}:${item.task.remoteId}`;
      if (!tasks.has(taskKey)) {
        tasks.set(taskKey, item);
      }
    }
  }

  private async enrichWorkAreas(
    token: string,
    options: ExternalMyWorkOptions,
    tasks: ExternalWorkAreaTask[],
  ): Promise<{ workAreas: ExternalWorkArea[]; tasks: ExternalWorkAreaTask[] }> {
    const groups = new Map<string, { base: ExternalWorkArea; assignedTaskCount: number }>();
    for (const item of tasks) {
      const key = this.workAreaKey(item.workArea);
      const existing = groups.get(key);
      if (existing) {
        existing.assignedTaskCount += 1;
      } else {
        groups.set(key, { base: item.workArea, assignedTaskCount: 1 });
      }
    }

    const groupEntries = [...groups];
    const enriched = await mapWithConcurrency(
      groupEntries,
      VENDOR_DISCOVERY_CONCURRENCY,
      ([, group]) => this.loadWorkAreaMetadata(token, options, group.base, group.assignedTaskCount),
    );
    const enrichedByKey = new Map<string, ExternalWorkArea>(
      groupEntries.map(([key], index) => [key, enriched[index]!]),
    );

    return {
      workAreas: [...enrichedByKey.values()],
      tasks: tasks.map((item) => ({
        workArea: enrichedByKey.get(this.workAreaKey(item.workArea))!,
        task: item.task,
      })),
    };
  }

  private async loadWorkAreaMetadata(
    token: string,
    options: ExternalMyWorkOptions,
    base: ExternalWorkArea,
    assignedTaskCount: number,
  ): Promise<ExternalWorkArea> {
    const cacheKey = JSON.stringify([
      options.connectionId,
      options.connectionGeneration,
      base.scopeKey,
      base.remoteId,
    ]);
    const cached = this.listMetadataCache.get(cacheKey);
    const now = Date.now();
    if (cached && now - cached.fetchedAt <= WORK_AREA_METADATA_TTL_MS) {
      return materializeWorkArea(cached.value, assignedTaskCount, {
        state: 'fresh',
        refreshedAt: new Date(cached.fetchedAt).toISOString(),
        retryable: false,
        retryAt: null,
      });
    }

    try {
      const payload = await this.requestJson(
        token,
        `${CLICKUP_ORIGIN}/api/v2/list/${encodeURIComponent(base.remoteId)}`,
      );
      const metadata = this.normalizeListMetadata(payload, base);
      this.listMetadataCache.set(cacheKey, { value: metadata, fetchedAt: now });
      return materializeWorkArea(metadata, assignedTaskCount, {
        state: 'fresh',
        refreshedAt: new Date(now).toISOString(),
        retryable: false,
        retryAt: null,
      });
    } catch (error) {
      if (!(error instanceof ClickUpProviderError)) {
        throw error;
      }
      const retryAt = vendorRetryAt(error);
      if (cached) {
        return materializeWorkArea(cached.value, assignedTaskCount, {
          state: 'stale',
          refreshedAt: new Date(cached.fetchedAt).toISOString(),
          retryable: true,
          retryAt,
        });
      }
      return {
        ...base,
        assignedTaskCount,
        refresh: { state: 'error', refreshedAt: null, retryable: true, retryAt },
      };
    }
  }

  private normalizeListMetadata(value: unknown, base: ExternalWorkArea): CachedWorkAreaMetadata {
    if (
      !isRecord(value) ||
      !isRecord(value.space) ||
      !Array.isArray(value.statuses) ||
      typeof value.override_statuses !== 'boolean'
    ) {
      throw new ClickUpProviderError('invalid_response');
    }
    const remoteId = this.validate.requiredIdentifier(value.id);
    if (remoteId !== base.remoteId) {
      throw new ClickUpProviderError('invalid_response');
    }
    const hierarchy: ExternalWorkArea['hierarchy'] = [
      ...base.hierarchy.filter((location) => location.kind === 'workspace'),
      {
        kind: 'space' as const,
        remoteId: this.validate.requiredIdentifier(value.space.id),
        name: this.validate.requiredString(value.space.name),
      },
    ];
    if (value.folder !== null && value.folder !== undefined) {
      if (!isRecord(value.folder)) {
        throw new ClickUpProviderError('invalid_response');
      }
      hierarchy.push({
        kind: 'folder',
        remoteId: this.validate.requiredIdentifier(value.folder.id),
        name: this.validate.requiredString(value.folder.name),
      });
    }

    const columns = this.sortedColumns(value.statuses);

    return {
      remoteId,
      scopeKey: base.scopeKey,
      name: this.validate.requiredString(value.name),
      kind: 'list',
      description: this.optionalDescription(value.content),
      hierarchy,
      workflow: { isOverridden: value.override_statuses, columns },
    };
  }

  private normalizeColumn(value: unknown): ExternalWorkAreaColumn {
    if (!isRecord(value)) {
      throw new ClickUpProviderError('invalid_response');
    }
    if (
      (typeof value.orderindex !== 'string' && typeof value.orderindex !== 'number') ||
      (typeof value.orderindex === 'string' && !value.orderindex.trim())
    ) {
      throw new ClickUpProviderError('invalid_response');
    }
    const position = Number(value.orderindex);
    if (!Number.isFinite(position)) {
      throw new ClickUpProviderError('invalid_response');
    }
    return {
      remoteId:
        value.id === null || value.id === undefined
          ? null
          : this.validate.requiredIdentifier(value.id),
      name: this.requiredExactString(value.status),
      color: this.requiredExactString(value.color),
      category: this.classifyStatus(this.validate.requiredString(value.type).toLowerCase()),
      position,
    };
  }

  private async loadAllowedStatuses(
    token: string,
    workAreaId: string,
  ): Promise<ExternalTaskStatusOption[]> {
    const payload = await this.requestJson(
      token,
      `${CLICKUP_ORIGIN}/api/v2/list/${encodeURIComponent(workAreaId)}`,
    );
    if (
      !isRecord(payload) ||
      this.validate.requiredIdentifier(payload.id) !== workAreaId ||
      !Array.isArray(payload.statuses)
    ) {
      throw new ClickUpProviderError('invalid_response');
    }
    return this.sortedColumns(payload.statuses).map((column) => ({
      // ClickUp writes an exact List status name; the status id stays a
      // destination identity only.
      actionValue: column.name,
      ...(column.remoteId !== null ? { remoteStatusIds: [column.remoteId] } : {}),
      remoteId: column.remoteId,
      name: column.name,
      color: column.color,
      category: column.category,
      position: column.position,
    }));
  }

  private sortedColumns(statuses: unknown[]): ExternalWorkAreaColumn[] {
    return statuses
      .map((status, index) => ({ column: this.normalizeColumn(status), index }))
      .sort(
        (left, right) => left.column.position - right.column.position || left.index - right.index,
      )
      .map(({ column }) => column);
  }

  private boundedTaskDescription(value: unknown): {
    value: string | null;
    truncated: boolean;
  } {
    if (value === null || value === undefined || value === '') {
      return { value: null, truncated: false };
    }
    if (typeof value !== 'string') {
      throw new ClickUpProviderError('invalid_response');
    }
    return {
      value: value.slice(0, MAX_TASK_DETAIL_TEXT_LENGTH),
      truncated: value.length > MAX_TASK_DETAIL_TEXT_LENGTH,
    };
  }

  private normalizePriority(value: unknown): ExternalProviderTaskDetail['priority'] {
    if (value === null || value === undefined) {
      return null;
    }
    if (!isRecord(value)) {
      throw new ClickUpProviderError('invalid_response');
    }
    return {
      name: this.requiredExactString(value.priority),
      color: this.requiredExactString(value.color),
    };
  }

  private requiredTaskUrl(value: unknown): string {
    const url = this.safeTaskUrl(value);
    if (!url) {
      throw new ClickUpProviderError('invalid_response');
    }
    return url;
  }

  private workAreaKey(workArea: ExternalWorkArea): string {
    return JSON.stringify([workArea.scopeKey, workArea.remoteId]);
  }

  private optionalDescription(value: unknown): string | null {
    if (value === null || value === undefined || value === '') {
      return null;
    }
    if (typeof value !== 'string') {
      throw new ClickUpProviderError('invalid_response');
    }
    return value;
  }

  private requiredExactString(value: unknown): string {
    if (typeof value !== 'string' || !value.trim()) {
      throw new ClickUpProviderError('invalid_response');
    }
    return value;
  }

  private requireToken(credentials: IntegrationCredentials): string {
    if (credentials.provider !== this.provider || !credentials.token.trim()) {
      throw new ClickUpProviderError('request_rejected');
    }
    return credentials.token;
  }

  private classifyStatus(value: string): ExternalTaskStatusCategory {
    if (value === 'open' || value === 'custom') {
      return 'active';
    }
    if (value === 'done' || value === 'closed') {
      return 'completed';
    }
    return 'unknown';
  }

  private requiredTimestamp(value: unknown): string {
    const timestamp = this.optionalTimestamp(value);
    if (!timestamp) {
      throw new ClickUpProviderError('invalid_response');
    }
    return timestamp;
  }

  private optionalTimestamp(value: unknown): string | null {
    if (value === null || value === undefined) {
      return null;
    }
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new ClickUpProviderError('invalid_response');
    }
    if ((typeof value === 'string' && !value.trim()) || !Number.isFinite(Number(value))) {
      throw new ClickUpProviderError('invalid_response');
    }
    const milliseconds = Number(value);
    try {
      return new Date(milliseconds).toISOString();
    } catch {
      throw new ClickUpProviderError('invalid_response');
    }
  }

  private safeTaskUrl(value: unknown): string | null {
    return normalizeExternalTaskSourceUrl(this.provider, value);
  }

  private async requestJson(
    token: string,
    url: string,
    request: Pick<SafeVendorJsonRequest, 'method' | 'body'> = {},
  ): Promise<unknown> {
    try {
      return await this.http.requestJson({
        url,
        allowedOrigins: [CLICKUP_ORIGIN],
        ...(request.method ? { method: request.method } : {}),
        ...(request.body !== undefined ? { body: request.body } : {}),
        headers: {
          accept: 'application/json',
          authorization: token,
          ...(request.body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
      });
    } catch (error) {
      throw mapVendorTransportError(
        error,
        (reason, retryAt, dispatched) => new ClickUpProviderError(reason, retryAt, dispatched),
      );
    }
  }
}
