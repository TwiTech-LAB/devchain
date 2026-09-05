import { Injectable } from '@nestjs/common';
import type { IntegrationCredentials } from '../../storage/models/domain.models';
import { JiraProviderError } from '../errors/external-provider.errors';
import {
  MAX_EXTERNAL_SUBTASK_DESCRIPTION_LENGTH,
  MAX_EXTERNAL_SUBTASK_TITLE_LENGTH,
  EXTERNAL_SUBTASK_SOURCE_ID_PATTERN,
  MAX_TASK_COMMENT_BODY_LENGTH,
  MAX_TASK_COMMENT_CURSOR_LENGTH,
  MAX_TASK_COMMENT_ID_LENGTH,
  MAX_REMOTE_TASK_ID_LENGTH,
  MAX_TASK_DETAIL_SUBTASKS,
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
  type ExternalProviderAccount,
  type ExternalProviderConnectionContext,
  type ExternalProviderTaskDetail,
  type ExternalSubtaskChildrenResult,
  type ExternalSubtaskCreateInput,
  type ExternalSubtaskDeleteResult,
  type ExternalSubtaskOwnershipProof,
  type ExternalSubtaskSnapshot,
  type ExternalSubtaskSyncCapability,
  type ExternalSubtaskUpdateInput,
  type ExternalTaskComment,
  type ExternalTaskCommentInput,
  type ExternalTaskCommentPage,
  type ExternalTaskStatusInput,
  type ExternalTaskStatusCategory,
  type ExternalTaskStatusOption,
  type ExternalTaskSubtaskSummary,
  type ExternalTaskTimeEntryHistory,
  type ExternalTaskTimeEntryInput,
  type ExternalTimeEntryCreateProof,
  type ExternalTimeEntryExactRead,
  type ExternalTimeEntryMutationsCapability,
  type ExternalTimeEntryRangeIds,
  type ExternalWorkArea,
  type ExternalWorkAreaTask,
} from '../models/external-provider.models';
import type { ExternalTaskProvider } from '../ports/external-task-provider';
import { adfToRichDocument } from './rich/jira-adf-converter';
import { richDocumentToAdf } from './rich/jira-adf-converter';
import type { ExternalRichDocumentV1 } from '../models/external-rich-document';
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
  compareTaskSubtaskSummaries,
  createVendorValidators,
  isRecord,
  mapVendorTransportError,
  mapWithConcurrency,
  materializeWorkArea,
  vendorRetryAt,
  type CachedWorkAreaMetadata,
  type VendorCommentAuthorSpec,
} from './vendor-shared';

const JIRA_TENANT_HOSTNAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.atlassian\.net$/;
const JIRA_SITE_URL = /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.atlassian\.net\/?$/i;
const JIRA_SEARCH_PAGE_SIZE = 100;
const JIRA_MAX_SEARCH_PAGES = 1_000;
const JIRA_COMMENT_PAGE_SIZE = 10;
const JIRA_COMMENT_MAX_START_AT = 1_000_000;
const JIRA_COMMENT_CURSOR_PATTERN = /^\d+$/;
const JIRA_COMMENT_AUTHOR: VendorCommentAuthorSpec = {
  nameKey: 'displayName',
  idKey: 'accountId',
  idFormat: 'string',
};
const JIRA_WORKLOG_PAGE_SIZE = 100;
const JIRA_WORKLOG_MAX_PAGES = 5;
const JIRA_WORKLOG_MAX_RAW = 500;
const JIRA_MANAGED_SUBTASK_PROPERTY = 'SourceId';
const OTHER_ASSIGNED_WORK_AREA_ID = 'other-assigned';
const JIRA_NEUTRAL_COLOR = '#6b778c';
const JIRA_COMPLETED_COLOR = '#36b37e';
const JIRA_DETAIL_FIELDS = [
  'summary',
  'description',
  'status',
  'duedate',
  'priority',
  'project',
  'subtasks',
  'timetracking',
] as const;
const JIRA_SEARCH_FIELDS = [
  'summary',
  'status',
  'assignee',
  'updated',
  'duedate',
  'resolutiondate',
  'project',
  'parent',
  'issuetype',
] as const;

interface JiraSite {
  origin: string;
  hostname: string;
  authorization: string;
}

interface JiraIdentity {
  accountId: string;
  displayName: string;
}

interface JiraAssignedTask {
  item: ExternalWorkAreaTask;
  projectKey: string;
}

interface JiraBoard {
  id: string;
  name: string;
}

interface JiraTransition {
  id: string;
  supported: boolean;
  option: ExternalTaskStatusOption;
}

/** A validated issue-worklog paging envelope. */
interface JiraWorklogPage {
  startAt: number;
  maxResults: number;
  total: number;
  worklogs: unknown[];
}

/** One parsed raw worklog before owner filtering or projection. */
interface JiraWorklogEntry {
  remoteId: string;
  authorAccountId: string | null;
  startedAtMs: number;
  durationMs: number;
  note: string | null;
  noteTruncated: boolean;
}

@Injectable()
export class JiraExternalTaskProvider implements ExternalTaskProvider {
  readonly provider = 'jira' as const;
  readonly descriptor = {
    provider: this.provider,
    displayName: 'Jira',
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
    updateTimeEntry: (credentials, context, remoteTaskId, remoteEntryId, input) =>
      this.updateTimeEntry(credentials, context, remoteTaskId, remoteEntryId, input),
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
    assertTimeEntryEditable: (credentials, context, remoteTaskId, remoteEntryId) =>
      this.assertTimeEntryEditable(credentials, context, remoteTaskId, remoteEntryId),
  };
  private readonly boardMetadataCache = new VendorMetadataCache<CachedWorkAreaMetadata>(
    WORK_AREA_METADATA_CACHE_MAX_ENTRIES,
  );
  private readonly subtaskIssueTypeCache = new VendorMetadataCache<string>(
    WORK_AREA_METADATA_CACHE_MAX_ENTRIES,
  );
  private readonly validate = createVendorValidators((reason) => new JiraProviderError(reason));

  constructor(private readonly http: SafeVendorHttpClient) {}

  readonly ownedMutations: ExternalOwnedMutationsCapability = {
    getCurrentOwnerRemoteId: (credentials) =>
      this.loadIdentity(this.resolveSite(credentials)).then((identity) => identity.accountId),
    findComment: (credentials, context, remoteTaskId, commentId) =>
      this.findComment(credentials, context, remoteTaskId, commentId),
    deleteComment: (credentials, context, remoteTaskId, commentId) =>
      this.deleteComment(credentials, context, remoteTaskId, commentId),
    updateOwnedComment: (credentials, context, remoteTaskId, commentId, document) =>
      this.updateOwnedComment(credentials, context, remoteTaskId, commentId, document),
  };

  readonly descriptionEdit: ExternalDescriptionEditCapability = {
    readDescription: (credentials, context, remoteTaskId) =>
      this.readDescription(credentials, context, remoteTaskId),
    writeDescription: (credentials, context, remoteTaskId, raw) =>
      this.writeDescription(credentials, context, remoteTaskId, raw),
  };

  readonly subtaskSync: ExternalSubtaskSyncCapability = {
    create: (credentials, context, input) => this.createSubtask(credentials, context, input),
    readExact: (credentials, context, remoteTaskId) =>
      this.readSubtaskExact(credentials, context, remoteTaskId),
    update: (credentials, context, input) => this.updateSubtask(credentials, context, input),
    delete: (credentials, context, proof) => this.deleteSubtask(credentials, context, proof),
    listOwnedDirectChildren: (credentials, context, parentRemoteTaskId, ownershipToken) =>
      this.listOwnedDirectChildren(credentials, context, parentRemoteTaskId, ownershipToken),
    assertOwned: (credentials, context, proof) =>
      this.assertOwnedSubtask(credentials, context, proof),
  };

  private async createSubtask(
    credentials: IntegrationCredentials,
    context: ExternalProviderConnectionContext,
    input: ExternalSubtaskCreateInput,
  ): Promise<ExternalSubtaskSnapshot> {
    const site = this.resolveSite(credentials);
    const parentTaskId = this.validate.requiredTaskId(input.parentRemoteTaskId);
    const ownershipToken = this.requireSubtaskOwnershipToken(input.ownershipToken);
    const title = this.requireSubtaskTitle(input.title);
    const description = this.requireSubtaskDescription(input.description);
    const parent = await this.loadSubtaskParent(site, parentTaskId);
    const issueTypeId = await this.loadSubtaskIssueType(site, context, parent.workAreaRemoteId);
    const identity = await this.loadIdentity(site);
    const propertyValue = { version: 1, sourceId: ownershipToken };
    const payload = await this.requestJson(site, '/rest/api/3/issue', {
      method: 'POST',
      body: JSON.stringify({
        fields: {
          project: { id: parent.workAreaRemoteId },
          issuetype: { id: issueTypeId },
          parent: { key: parent.remoteKey },
          summary: title,
          description: this.managedDescriptionAdf(description),
          assignee: { id: identity.accountId },
        },
        properties: [{ key: JIRA_MANAGED_SUBTASK_PROPERTY, value: propertyValue }],
      }),
    });
    try {
      if (!isRecord(payload)) {
        throw new JiraProviderError('invalid_response');
      }
      this.validate.requiredIdentifier(payload.id);
      const remoteKey = this.validate.requiredString(payload.key);
      return {
        remoteTaskId: remoteKey,
        remoteKey,
        parentRemoteTaskId: parent.remoteKey,
        workAreaRemoteId: parent.workAreaRemoteId,
        ownershipToken,
        title,
        description,
      };
    } catch (error) {
      if (error instanceof JiraProviderError) {
        throw new JiraProviderError('invalid_response', undefined, { dispatched: true });
      }
      throw error;
    }
  }

  private async loadSubtaskParent(
    site: JiraSite,
    parentTaskId: string,
  ): Promise<{ remoteTaskId: string; remoteKey: string; workAreaRemoteId: string }> {
    const url = new URL(`${site.origin}/rest/api/3/issue/${encodeURIComponent(parentTaskId)}`);
    url.searchParams.set('fields', 'project');
    const payload = await this.requestJson(site, `${url.pathname}${url.search}`);
    if (!isRecord(payload) || !isRecord(payload.fields) || !isRecord(payload.fields.project)) {
      throw new JiraProviderError('invalid_response');
    }
    const remoteTaskId = this.validate.requiredIdentifier(payload.id);
    const remoteKey = this.validate.requiredString(payload.key);
    if (remoteTaskId !== parentTaskId && remoteKey !== parentTaskId) {
      throw new JiraProviderError('invalid_response');
    }
    return {
      remoteTaskId,
      remoteKey,
      workAreaRemoteId: this.validate.requiredIdentifier(payload.fields.project.id),
    };
  }

  private async loadSubtaskIssueType(
    site: JiraSite,
    context: ExternalProviderConnectionContext,
    projectId: string,
  ): Promise<string> {
    const cacheKey = JSON.stringify([
      context.connectionId,
      context.connectionGeneration,
      site.hostname,
      projectId,
    ]);
    const cached = this.subtaskIssueTypeCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt <= WORK_AREA_METADATA_TTL_MS) {
      return cached.value;
    }
    const url = new URL(`${site.origin}/rest/api/3/issuetype/project`);
    url.searchParams.set('projectId', projectId);
    url.searchParams.set('level', '-1');
    const payload = await this.requestJson(site, `${url.pathname}${url.search}`);
    if (!Array.isArray(payload)) {
      throw new JiraProviderError('invalid_response');
    }
    let issueTypeId: string | null = null;
    for (const value of payload) {
      if (!isRecord(value)) {
        throw new JiraProviderError('invalid_response');
      }
      if (value.subtask === true && value.hierarchyLevel === -1 && issueTypeId === null) {
        issueTypeId = this.validate.requiredIdentifier(value.id);
      }
    }
    if (issueTypeId === null) {
      throw new JiraProviderError('unsupported_subtask_type');
    }
    this.subtaskIssueTypeCache.set(cacheKey, { value: issueTypeId, fetchedAt: Date.now() });
    return issueTypeId;
  }

  private async readSubtaskExact(
    credentials: IntegrationCredentials,
    _context: ExternalProviderConnectionContext,
    remoteTaskId: string,
  ): Promise<ExternalSubtaskSnapshot | null> {
    const site = this.resolveSite(credentials);
    const taskId = this.validate.requiredTaskId(remoteTaskId);
    const url = new URL(`${site.origin}/rest/api/3/issue/${encodeURIComponent(taskId)}`);
    url.searchParams.set('fields', 'summary,description,parent,project');
    url.searchParams.set('properties', JIRA_MANAGED_SUBTASK_PROPERTY);
    try {
      const payload = await this.requestJson(site, `${url.pathname}${url.search}`);
      const snapshot = this.normalizeManagedSubtask(payload);
      if (snapshot.remoteKey !== taskId) {
        throw new JiraProviderError('invalid_response');
      }
      return snapshot;
    } catch (error) {
      if (error instanceof JiraProviderError && error.details?.reason === 'not_found') {
        return null;
      }
      throw error;
    }
  }

  private async updateSubtask(
    credentials: IntegrationCredentials,
    context: ExternalProviderConnectionContext,
    input: ExternalSubtaskUpdateInput,
  ): Promise<void> {
    const current = await this.assertOwnedSubtask(credentials, context, input);
    const fields: Record<string, unknown> = {};
    if (input.title !== undefined) {
      fields.summary = this.requireSubtaskTitle(input.title);
    }
    if (input.description !== undefined) {
      fields.description = this.managedDescriptionAdf(
        this.requireSubtaskDescription(input.description),
      );
    }
    if (Object.keys(fields).length === 0) {
      throw new JiraProviderError('request_rejected');
    }
    await this.requestNoContent(
      this.resolveSite(credentials),
      `/rest/api/3/issue/${encodeURIComponent(current.remoteKey)}`,
      { method: 'PUT', body: JSON.stringify({ fields }) },
    );
  }

  private async deleteSubtask(
    credentials: IntegrationCredentials,
    context: ExternalProviderConnectionContext,
    proof: ExternalSubtaskOwnershipProof,
  ): Promise<ExternalSubtaskDeleteResult> {
    const current = await this.readSubtaskExact(credentials, context, proof.remoteTaskId);
    if (current === null) {
      return { outcome: 'already_absent' };
    }
    this.assertSubtaskProof(current, proof);
    try {
      await this.requestNoContent(
        this.resolveSite(credentials),
        `/rest/api/3/issue/${encodeURIComponent(current.remoteKey)}`,
        { method: 'DELETE' },
      );
    } catch (error) {
      if (error instanceof JiraProviderError && error.details?.reason === 'not_found') {
        return { outcome: 'already_absent' };
      }
      throw error;
    }
    return { outcome: 'deleted' };
  }

  private async listOwnedDirectChildren(
    credentials: IntegrationCredentials,
    context: ExternalProviderConnectionContext,
    parentRemoteTaskId: string,
    ownershipToken: string,
  ): Promise<ExternalSubtaskChildrenResult> {
    const site = this.resolveSite(credentials);
    const parentTaskId = this.validate.requiredTaskId(parentRemoteTaskId);
    const normalizedToken = this.requireSubtaskOwnershipToken(ownershipToken);
    const url = new URL(`${site.origin}/rest/api/3/issue/${encodeURIComponent(parentTaskId)}`);
    url.searchParams.set('fields', 'subtasks');
    const payload = await this.requestJson(site, `${url.pathname}${url.search}`);
    if (
      !isRecord(payload) ||
      !isRecord(payload.fields) ||
      !Array.isArray(payload.fields.subtasks)
    ) {
      throw new JiraProviderError('invalid_response');
    }
    const references = payload.fields.subtasks;
    const capped = references.length > MAX_TASK_DETAIL_SUBTASKS;
    const selected = references.slice(0, MAX_TASK_DETAIL_SUBTASKS).map((value) => {
      if (!isRecord(value)) {
        throw new JiraProviderError('invalid_response');
      }
      return this.validate.requiredTaskId(
        typeof value.key === 'string' && value.key.trim()
          ? value.key
          : this.validate.requiredIdentifier(value.id),
      );
    });
    let staleReference = false;
    const children = await mapWithConcurrency(
      selected,
      VENDOR_DISCOVERY_CONCURRENCY,
      async (childId) => {
        const child = await this.readSubtaskExact(credentials, context, childId);
        if (child === null) {
          staleReference = true;
        }
        return child;
      },
    );
    const items = children.filter(
      (child): child is ExternalSubtaskSnapshot =>
        child !== null &&
        (child.parentRemoteTaskId === parentTaskId ||
          child.parentRemoteTaskId === this.optionalJiraKey(payload)) &&
        child.ownershipToken === normalizedToken,
    );
    return { items, complete: !capped && !staleReference };
  }

  private optionalJiraKey(value: Record<string, unknown>): string | null {
    if (typeof value.key !== 'string') {
      return null;
    }
    const key = value.key.trim();
    return key.length > 0 && key.length <= MAX_REMOTE_TASK_ID_LENGTH ? key : null;
  }

  private async assertOwnedSubtask(
    credentials: IntegrationCredentials,
    context: ExternalProviderConnectionContext,
    proof: ExternalSubtaskOwnershipProof,
  ): Promise<ExternalSubtaskSnapshot> {
    const current = await this.readSubtaskExact(credentials, context, proof.remoteTaskId);
    if (current === null) {
      throw new JiraProviderError('not_found');
    }
    this.assertSubtaskProof(current, proof);
    return current;
  }

  private assertSubtaskProof(
    current: ExternalSubtaskSnapshot,
    proof: ExternalSubtaskOwnershipProof,
  ): void {
    const ownershipToken = this.requireSubtaskOwnershipToken(proof.ownershipToken);
    const expectedParent = this.validate.requiredTaskId(proof.expectedParentRemoteTaskId);
    if (current.ownershipToken !== ownershipToken) {
      throw new JiraProviderError('ownership_mismatch');
    }
    if (current.parentRemoteTaskId !== expectedParent) {
      throw new JiraProviderError('parent_mismatch');
    }
  }

  private normalizeManagedSubtask(value: unknown): ExternalSubtaskSnapshot {
    if (!isRecord(value) || !isRecord(value.fields) || !isRecord(value.fields.project)) {
      throw new JiraProviderError('invalid_response');
    }
    const parent = value.fields.parent;
    if (parent !== null && parent !== undefined && !isRecord(parent)) {
      throw new JiraProviderError('invalid_response');
    }
    const parentRemoteTaskId =
      parent === null || parent === undefined
        ? null
        : typeof parent.key === 'string' && parent.key.trim()
          ? parent.key.trim()
          : this.validate.requiredIdentifier(parent.id);
    const properties = value.properties;
    if (properties !== null && properties !== undefined && !isRecord(properties)) {
      throw new JiraProviderError('invalid_response');
    }
    const propertyValue = isRecord(properties)
      ? properties[JIRA_MANAGED_SUBTASK_PROPERTY]
      : undefined;
    const ownershipToken = this.parseJiraOwnershipProperty(propertyValue);
    this.validate.requiredIdentifier(value.id);
    const remoteKey = this.validate.requiredString(value.key);
    return {
      remoteTaskId: remoteKey,
      remoteKey,
      parentRemoteTaskId,
      workAreaRemoteId: this.validate.requiredIdentifier(value.fields.project.id),
      ownershipToken,
      title: this.validate.requiredString(value.fields.summary),
      description: this.parseManagedDescriptionAdf(value.fields.description),
    };
  }

  private parseJiraOwnershipProperty(value: unknown): string | null {
    if (!isRecord(value) || value.version !== 1 || typeof value.sourceId !== 'string') {
      return null;
    }
    return this.isSubtaskOwnershipToken(value.sourceId) ? value.sourceId : null;
  }

  /**
   * The managed-subtask description carries only the source description;
   * a null description must be sent as `null` because Jira rejects empty
   * ADF documents on create and update.
   */
  private managedDescriptionAdf(description: string | null): Record<string, unknown> | null {
    if (description === null) {
      return null;
    }
    return {
      type: 'doc',
      version: 1,
      content: description.split('\n').map((line) => ({
        type: 'paragraph',
        ...(line ? { content: [{ type: 'text', text: line }] } : {}),
      })),
    };
  }

  private parseManagedDescriptionAdf(value: unknown): string | null {
    if (value === null || value === undefined) {
      return null;
    }
    return this.flattenAdfText(value, 'preserve') || null;
  }

  private requireSubtaskTitle(value: unknown): string {
    if (
      typeof value !== 'string' ||
      !value.trim() ||
      value.length > MAX_EXTERNAL_SUBTASK_TITLE_LENGTH
    ) {
      throw new JiraProviderError('request_rejected');
    }
    return value.trim();
  }

  private requireSubtaskDescription(value: unknown): string | null {
    if (value === null || value === '') {
      return null;
    }
    if (typeof value !== 'string' || value.length > MAX_EXTERNAL_SUBTASK_DESCRIPTION_LENGTH) {
      throw new JiraProviderError('request_rejected');
    }
    return value;
  }

  private isSubtaskOwnershipToken(value: string): boolean {
    return EXTERNAL_SUBTASK_SOURCE_ID_PATTERN.test(value);
  }

  private requireSubtaskOwnershipToken(value: unknown): string {
    if (typeof value !== 'string' || !this.isSubtaskOwnershipToken(value)) {
      throw new JiraProviderError('request_rejected');
    }
    return value;
  }

  /** One exact-comment read; Jira documents GET comment by id. */
  private async findComment(
    credentials: IntegrationCredentials,
    _context: ExternalProviderConnectionContext,
    remoteTaskId: string,
    commentId: string,
  ): Promise<ExternalOwnedCommentSnapshot | null> {
    const site = this.resolveSite(credentials);
    const taskId = this.validate.requiredTaskId(remoteTaskId);
    const normalizedCommentId = this.validate.requiredIdentifier(commentId);
    const payload = await this.requestJson(
      site,
      `/rest/api/3/issue/${encodeURIComponent(taskId)}/comment/${encodeURIComponent(normalizedCommentId)}`,
    );
    if (!isRecord(payload)) {
      throw new JiraProviderError('invalid_response');
    }
    const snapshot = this.normalizeComment(payload);
    return {
      remoteId: snapshot.remoteId,
      authorRemoteId: snapshot.author.remoteId,
      createdAt: snapshot.createdAt,
      raw: payload.body ?? null,
      metadata: { assignee: null, resolved: null, groupAssignee: null },
    };
  }

  private async deleteComment(
    credentials: IntegrationCredentials,
    _context: ExternalProviderConnectionContext,
    remoteTaskId: string,
    commentId: string,
  ): Promise<void> {
    const site = this.resolveSite(credentials);
    const taskId = this.validate.requiredTaskId(remoteTaskId);
    const normalizedCommentId = this.validate.requiredIdentifier(commentId);
    // Jira answers 204 with a JSON content type and an empty body, so the
    // strict no-content reader is the only shape-true call here.
    await this.requestNoContent(
      site,
      `/rest/api/3/issue/${encodeURIComponent(taskId)}/comment/${encodeURIComponent(normalizedCommentId)}`,
      { method: 'DELETE' },
    );
  }

  private async updateOwnedComment(
    credentials: IntegrationCredentials,
    _context: ExternalProviderConnectionContext,
    remoteTaskId: string,
    commentId: string,
    document: ExternalRichDocumentV1,
  ): Promise<void> {
    const site = this.resolveSite(credentials);
    const taskId = this.validate.requiredTaskId(remoteTaskId);
    const normalizedCommentId = this.validate.requiredIdentifier(commentId);
    // Jira's exact-comment PUT replaces the ADF body and answers 200 with the
    // stored comment; no extra comment state exists to preserve.
    await this.requestJson(
      site,
      `/rest/api/3/issue/${encodeURIComponent(taskId)}/comment/${encodeURIComponent(normalizedCommentId)}`,
      { method: 'PUT', body: JSON.stringify({ body: richDocumentToAdf(document) }) },
    );
  }

  private async readDescription(
    credentials: IntegrationCredentials,
    _context: ExternalProviderConnectionContext,
    remoteTaskId: string,
  ): Promise<unknown> {
    const site = this.resolveSite(credentials);
    const taskId = this.validate.requiredTaskId(remoteTaskId);
    const url = new URL(`${site.origin}/rest/api/3/issue/${encodeURIComponent(taskId)}`);
    url.searchParams.set('fields', 'description');
    const payload = await this.requestJson(site, `${url.pathname}${url.search}`);
    if (!isRecord(payload) || !isRecord(payload.fields)) {
      throw new JiraProviderError('invalid_response');
    }
    return payload.fields.description ?? null;
  }

  private async writeDescription(
    credentials: IntegrationCredentials,
    _context: ExternalProviderConnectionContext,
    remoteTaskId: string,
    raw: unknown,
  ): Promise<void> {
    const site = this.resolveSite(credentials);
    const taskId = this.validate.requiredTaskId(remoteTaskId);
    if (!isRecord(raw) || raw.type !== 'doc' || raw.version !== 1 || !Array.isArray(raw.content)) {
      throw new JiraProviderError('request_rejected');
    }
    await this.requestNoContent(site, `/rest/api/3/issue/${encodeURIComponent(taskId)}`, {
      method: 'PUT',
      body: JSON.stringify({ fields: { description: raw } }),
    });
  }

  async verifyCredentials(credentials: IntegrationCredentials): Promise<ExternalProviderAccount> {
    const site = this.resolveSite(credentials);
    const identity = await this.loadIdentity(site);
    return {
      provider: this.provider,
      remoteId: identity.accountId,
      displayName: identity.displayName,
    };
  }

  private async getTaskDetail(
    credentials: IntegrationCredentials,
    _context: ExternalProviderConnectionContext,
    remoteTaskId: string,
  ): Promise<ExternalProviderTaskDetail> {
    const site = this.resolveSite(credentials);
    const taskId = this.validate.requiredTaskId(remoteTaskId);
    const issueUrl = new URL(`${site.origin}/rest/api/3/issue/${encodeURIComponent(taskId)}`);
    issueUrl.searchParams.set('fields', JIRA_DETAIL_FIELDS.join(','));
    const issue = await this.requestJson(site, `${issueUrl.pathname}${issueUrl.search}`);

    const [[transitionResult, configurationResult], childResult] = await Promise.all([
      Promise.allSettled([
        this.loadTransitions(site, taskId),
        this.requestJson(site, '/rest/api/3/configuration'),
      ]),
      this.normalizeTaskSubtasks(issue, site, taskId),
    ]);
    const transitions = transitionResult.status === 'fulfilled' ? transitionResult.value : [];
    const timeTrackingEnabled =
      configurationResult.status === 'fulfilled' &&
      isRecord(configurationResult.value) &&
      configurationResult.value.timeTrackingEnabled === true;
    const detail = this.normalizeTaskDetail(issue, site, taskId);
    const allowedStatuses = transitions
      .filter((transition) => transition.supported)
      .map((transition) => transition.option);

    return {
      ...detail,
      subtasks: childResult.items,
      subtasksTruncated: childResult.truncated,
      allowedStatuses,
      actions: [
        { action: 'change_status', supported: allowedStatuses.length > 0 },
        { action: 'add_comment', supported: true },
        { action: 'log_time', supported: timeTrackingEnabled },
      ],
    };
  }

  private async listTaskComments(
    credentials: IntegrationCredentials,
    _context: ExternalProviderConnectionContext,
    remoteTaskId: string,
    cursor: string | null,
  ): Promise<ExternalTaskCommentPage> {
    const site = this.resolveSite(credentials);
    const taskId = this.validate.requiredTaskId(remoteTaskId);
    const startAt = cursor === null ? 0 : this.decodeCommentCursor(cursor);
    const url = new URL(`${site.origin}/rest/api/3/issue/${encodeURIComponent(taskId)}/comment`);
    url.searchParams.set('maxResults', String(JIRA_COMMENT_PAGE_SIZE));
    url.searchParams.set('orderBy', '-created');
    url.searchParams.set('startAt', String(startAt));
    const payload = await this.requestJson(site, `${url.pathname}${url.search}`);
    if (
      !isRecord(payload) ||
      !Array.isArray(payload.comments) ||
      payload.comments.length > JIRA_COMMENT_PAGE_SIZE
    ) {
      throw new JiraProviderError('invalid_response');
    }
    const returnedStart = this.requiredCount(payload.startAt);
    const total = this.requiredCount(payload.total);
    const comments = payload.comments.map((value) => this.enrichComment(value));
    // The next offset must track the page position Jira actually returned, not
    // the requested cursor: a regressed or clamped page would otherwise yield a
    // cursor that skips comments this client never received.
    const nextStart = returnedStart + comments.length;
    return {
      comments,
      nextCursor:
        nextStart > startAt && nextStart < total && nextStart <= JIRA_COMMENT_MAX_START_AT
          ? String(nextStart)
          : null,
    };
  }

  /** Attaches the bounded canonical body parsed from the raw ADF. */
  private enrichComment(value: unknown): ExternalTaskComment {
    const comment = this.normalizeComment(value);
    const rawBody = isRecord(value) ? (value.body ?? null) : null;
    if (rawBody === null) {
      return { ...comment, owned: false, rich: null, lookupToken: null };
    }
    const parsed = adfToRichDocument(rawBody);
    return {
      ...comment,
      owned: false,
      rich: parsed.supported
        ? { document: parsed.document, supported: true }
        : { supported: false, readOnlyReason: parsed.reason },
      lookupToken: null,
    };
  }

  /** A non-negative page counter (`startAt`, `total`) from a Jira envelope. */
  private requiredCount(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new JiraProviderError('invalid_response');
    }
    return value;
  }

  private decodeCommentCursor(cursor: string): number {
    if (
      cursor.length > MAX_TASK_COMMENT_CURSOR_LENGTH ||
      !JIRA_COMMENT_CURSOR_PATTERN.test(cursor)
    ) {
      throw new JiraProviderError('request_rejected');
    }
    const startAt = Number(cursor);
    if (!Number.isSafeInteger(startAt) || startAt > JIRA_COMMENT_MAX_START_AT) {
      throw new JiraProviderError('request_rejected');
    }
    return startAt;
  }

  private normalizeComment(
    value: unknown,
  ): Omit<ExternalTaskComment, 'rich' | 'lookupToken' | 'owned'> {
    if (!isRecord(value)) {
      throw new JiraProviderError('invalid_response');
    }
    const remoteId = this.validate.requiredIdentifier(value.id);
    if (remoteId.length > MAX_TASK_COMMENT_ID_LENGTH) {
      throw new JiraProviderError('invalid_response');
    }
    const body = this.adfCommentBody(value.body);
    return {
      remoteId,
      author: this.validate.commentAuthor(value.author, JIRA_COMMENT_AUTHOR),
      body: body.value,
      bodyTruncated: body.truncated,
      createdAt: this.requiredTimestamp(value.created),
      updatedAt: this.optionalTimestamp(value.updated),
    };
  }

  private async changeTaskStatus(
    credentials: IntegrationCredentials,
    _context: ExternalProviderConnectionContext,
    remoteTaskId: string,
    input: ExternalTaskStatusInput,
  ): Promise<void> {
    const site = this.resolveSite(credentials);
    const taskId = this.validate.requiredTaskId(remoteTaskId);
    const transitionId = this.validate.statusInput(input);
    const transition = (await this.loadTransitions(site, taskId)).find(
      (candidate) => candidate.id === transitionId,
    );
    if (!transition?.supported) {
      throw new JiraProviderError('unsupported_transition', undefined, {
        completeInJiraUrl: this.issueWebUrl(site, taskId),
      });
    }
    await this.requestNoContent(
      site,
      `/rest/api/3/issue/${encodeURIComponent(taskId)}/transitions`,
      {
        method: 'POST',
        body: JSON.stringify({ transition: { id: transitionId } }),
      },
    );
  }

  private async addTaskComment(
    credentials: IntegrationCredentials,
    _context: ExternalProviderConnectionContext,
    remoteTaskId: string,
    input: ExternalTaskCommentInput,
  ): Promise<void> {
    const site = this.resolveSite(credentials);
    const taskId = this.validate.requiredTaskId(remoteTaskId);
    this.validate.commentInput(input);
    await this.requestJson(site, `/rest/api/3/issue/${encodeURIComponent(taskId)}/comment`, {
      method: 'POST',
      body: JSON.stringify({ body: this.plainTextAdf(input.text) }),
    });
  }

  private async createTimeEntry(
    credentials: IntegrationCredentials,
    _context: ExternalProviderConnectionContext,
    remoteTaskId: string,
    input: ExternalTaskTimeEntryInput,
  ): Promise<ExternalTimeEntryCreateProof> {
    const site = this.resolveSite(credentials);
    const taskId = this.validate.requiredTaskId(remoteTaskId);
    const startedAt = this.validate.timeEntryInput(input);
    if (input.durationMs % 1000 !== 0) {
      throw new JiraProviderError('request_rejected');
    }
    const configuration = await this.requestJson(site, '/rest/api/3/configuration');
    if (!isRecord(configuration)) {
      throw new JiraProviderError('invalid_response');
    }
    if (configuration.timeTrackingEnabled !== true) {
      throw new JiraProviderError('time_tracking_disabled');
    }

    const body: Record<string, unknown> = {
      started: new Date(startedAt).toISOString().replace('Z', '+0000'),
      timeSpentSeconds: input.durationMs / 1000,
    };
    if (input.note !== null && input.note !== '') {
      body.comment = this.plainTextAdf(input.note);
    }
    const payload = await this.requestJson(
      site,
      `/rest/api/3/issue/${encodeURIComponent(taskId)}/worklog?adjustEstimate=leave`,
      { method: 'POST', body: JSON.stringify(body) },
    );
    // A confirmed create must return the documented worklog JSON; anything
    // else leaves the vendor outcome unknown, never a silent failure.
    if (!isRecord(payload)) {
      throw new JiraProviderError('invalid_response', undefined, { dispatched: true });
    }
    const id = payload.id;
    if (
      (typeof id !== 'string' && typeof id !== 'number') ||
      !this.validate.requiredIdentifier(id)
    ) {
      throw new JiraProviderError('invalid_response', undefined, { dispatched: true });
    }
    return { remoteEntryId: this.validate.requiredIdentifier(id) };
  }

  /** Jira documents the exact worklog GET; a classified 404 is the only null. */
  private async readTimeEntryExact(
    credentials: IntegrationCredentials,
    _context: ExternalProviderConnectionContext,
    remoteTaskId: string,
    remoteEntryId: string,
  ): Promise<ExternalTimeEntryExactRead | null> {
    const site = this.resolveSite(credentials);
    const taskId = this.validate.requiredTaskId(remoteTaskId);
    const entryId = this.validate.requiredIdentifier(remoteEntryId);
    const [identityPayload, payload] = await Promise.all([
      this.requestJson(site, '/rest/api/3/myself'),
      this.requestJson(
        site,
        `/rest/api/3/issue/${encodeURIComponent(taskId)}/worklog/${encodeURIComponent(entryId)}`,
      ).catch((error: unknown) => {
        if (error instanceof JiraProviderError && error.details?.reason === 'not_found') {
          return null;
        }
        throw error;
      }),
    ]);
    if (payload === null) {
      return null;
    }
    if (!isRecord(identityPayload)) {
      throw new JiraProviderError('invalid_response');
    }
    const accountId = this.validate.requiredString(identityPayload.accountId);
    const parsed = this.parseWorklog(payload);
    if (parsed.remoteId !== entryId) {
      throw new JiraProviderError('invalid_response');
    }
    return {
      remoteId: parsed.remoteId,
      startedAt: new Date(parsed.startedAtMs).toISOString(),
      durationMs: parsed.durationMs,
      note: parsed.note,
      owned: parsed.authorAccountId === accountId,
    };
  }

  private async updateTimeEntry(
    credentials: IntegrationCredentials,
    _context: ExternalProviderConnectionContext,
    remoteTaskId: string,
    remoteEntryId: string,
    input: ExternalTaskTimeEntryInput,
  ): Promise<void> {
    const site = this.resolveSite(credentials);
    const taskId = this.validate.requiredTaskId(remoteTaskId);
    const entryId = this.validate.requiredIdentifier(remoteEntryId);
    const startedAt = this.validate.timeEntryInput(input);
    if (input.durationMs % 1000 !== 0) {
      throw new JiraProviderError('request_rejected');
    }
    const body: Record<string, unknown> = {
      started: new Date(startedAt).toISOString().replace('Z', '+0000'),
      timeSpentSeconds: input.durationMs / 1000,
      comment: this.plainTextAdf(input.note ?? ''),
    };
    const payload = await this.requestJson(
      site,
      `/rest/api/3/issue/${encodeURIComponent(taskId)}/worklog/${encodeURIComponent(entryId)}?adjustEstimate=leave&notifyUsers=false`,
      { method: 'PUT', body: JSON.stringify(body) },
    );
    if (!isRecord(payload) || this.validate.requiredIdentifier(payload.id) !== entryId) {
      throw new JiraProviderError('invalid_response', undefined, { dispatched: true });
    }
  }

  private async assertTimeEntryEditable(
    credentials: IntegrationCredentials,
    context: ExternalProviderConnectionContext,
    remoteTaskId: string,
    remoteEntryId: string,
  ): Promise<ExternalTimeEntryExactRead> {
    const exact = await this.readTimeEntryExact(credentials, context, remoteTaskId, remoteEntryId);
    if (exact === null) {
      throw new JiraProviderError('not_found');
    }
    if (!exact.owned) {
      throw new JiraProviderError('permission_denied');
    }
    const site = this.resolveSite(credentials);
    if (!(await this.loadOwnWorklogsPermission(site, 'EDIT_OWN_WORKLOGS'))) {
      throw new JiraProviderError('permission_denied');
    }
    return exact;
  }

  /**
   * Jira documents an exact-204 DELETE; adjustEstimate=leave keeps remaining
   * estimates untouched and notifyUsers=false suppresses watcher mail.
   */
  private async deleteTimeEntry(
    credentials: IntegrationCredentials,
    _context: ExternalProviderConnectionContext,
    remoteTaskId: string,
    remoteEntryId: string,
  ): Promise<void> {
    const site = this.resolveSite(credentials);
    const taskId = this.validate.requiredTaskId(remoteTaskId);
    const entryId = this.validate.requiredIdentifier(remoteEntryId);
    await this.requestNoContent(
      site,
      `/rest/api/3/issue/${encodeURIComponent(taskId)}/worklog/${encodeURIComponent(entryId)}?adjustEstimate=leave&notifyUsers=false`,
      { method: 'DELETE' },
    );
  }

  /**
   * Own worklog ids in a window. Completeness is proven only when the walk
   * reaches a short page or the envelope's positions cover the total.
   */
  private async listOwnTimeEntryIdsInRange(
    credentials: IntegrationCredentials,
    _context: ExternalProviderConnectionContext,
    remoteTaskId: string,
    startedAfterMs: number,
    startedBeforeMs: number,
  ): Promise<ExternalTimeEntryRangeIds> {
    const site = this.resolveSite(credentials);
    const taskId = this.validate.requiredTaskId(remoteTaskId);
    const identity = await this.loadIdentity(site);
    const ids: string[] = [];
    const seen = new Set<string>();
    let nextStart = 0;
    for (let page = 0; page < JIRA_WORKLOG_MAX_PAGES; page += 1) {
      const page_ = await this.requestWorklogPage(
        site,
        taskId,
        nextStart,
        JIRA_WORKLOG_PAGE_SIZE,
        startedAfterMs,
        startedBeforeMs,
      );
      for (const worklog of page_.worklogs) {
        const parsed = this.parseWorklog(worklog);
        if (parsed.authorAccountId !== identity.accountId) {
          continue;
        }
        if (!seen.has(parsed.remoteId)) {
          seen.add(parsed.remoteId);
          ids.push(parsed.remoteId);
        }
      }
      if (page_.worklogs.length < JIRA_WORKLOG_PAGE_SIZE) {
        return { ids, complete: true };
      }
      const stepped = page_.startAt + page_.worklogs.length;
      if (stepped <= nextStart || ids.length >= JIRA_WORKLOG_MAX_RAW) {
        return { ids, complete: false };
      }
      if (stepped >= page_.total) {
        return { ids, complete: true };
      }
      nextStart = stepped;
    }
    return { ids, complete: false };
  }

  /**
   * Jira delete preflight: exact worklog read proving presence, ownership
   * against /myself, and one DELETE_OWN_WORKLOGS permission read.
   */
  private async assertTimeEntryDeletable(
    credentials: IntegrationCredentials,
    context: ExternalProviderConnectionContext,
    remoteTaskId: string,
    remoteEntryId: string,
  ): Promise<void> {
    const exact = await this.readTimeEntryExact(credentials, context, remoteTaskId, remoteEntryId);
    if (exact === null) {
      throw new JiraProviderError('not_found');
    }
    if (!exact.owned) {
      throw new JiraProviderError('permission_denied');
    }
    const site = this.resolveSite(credentials);
    if (!(await this.loadDeleteOwnWorklogsPermission(site))) {
      throw new JiraProviderError('permission_denied');
    }
  }

  /**
   * Fixed 30-day connected-user history. Jira worklogs page in
   * creation-time ascending order and the envelope's `total` can count every
   * worklog on the issue rather than only the startedAfter/startedBefore
   * subset, so a maxResults=1 probe drives one of three walks (see
   * `fetchWindowedWorklogs`). DELETE_OWN_WORKLOGS is read once per history
   * response; every returned entry is re-checked against /myself.
   */
  private async getTaskTimeEntryHistory(
    credentials: IntegrationCredentials,
    _context: ExternalProviderConnectionContext,
    remoteTaskId: string,
  ): Promise<ExternalTaskTimeEntryHistory> {
    const site = this.resolveSite(credentials);
    const taskId = this.validate.requiredTaskId(remoteTaskId);
    const now = Date.now();
    const startedAfterMs = now - TIME_ENTRY_HISTORY_WINDOW_DAYS * 86_400_000;
    const [identity, ownPermissions] = await Promise.all([
      this.loadIdentity(site),
      this.loadOwnWorklogsPermissions(site, ['EDIT_OWN_WORKLOGS', 'DELETE_OWN_WORKLOGS']),
    ]);
    const { raw, complete } = await this.fetchWindowedWorklogs(site, taskId, startedAfterMs, now);
    const own: JiraWorklogEntry[] = [];
    for (const value of raw) {
      const parsed = this.parseWorklog(value);
      if (parsed.authorAccountId !== identity.accountId) {
        continue;
      }
      own.push(parsed);
    }
    own.sort(
      (left, right) =>
        right.startedAtMs - left.startedAtMs || compareRemoteIds(left.remoteId, right.remoteId),
    );

    return {
      windowDays: TIME_ENTRY_HISTORY_WINDOW_DAYS,
      truncated: !complete || own.length > MAX_TIME_ENTRY_HISTORY_ENTRIES,
      hasRunningTimer: false,
      entries: own.slice(0, MAX_TIME_ENTRY_HISTORY_ENTRIES).map((parsed) => ({
        remoteId: parsed.remoteId,
        durationMs: parsed.durationMs,
        startedAt: new Date(parsed.startedAtMs).toISOString(),
        note: parsed.note,
        noteTruncated: parsed.noteTruncated,
        canEdit: ownPermissions.EDIT_OWN_WORKLOGS,
        canDelete: ownPermissions.DELETE_OWN_WORKLOGS,
      })),
    };
  }

  /** One permission read per history response; per-entry canDelete derives
   * from it without further vendor calls. */
  private async loadDeleteOwnWorklogsPermission(site: JiraSite): Promise<boolean> {
    return (await this.loadOwnWorklogsPermissions(site, ['DELETE_OWN_WORKLOGS']))
      .DELETE_OWN_WORKLOGS;
  }

  private async loadOwnWorklogsPermission(
    site: JiraSite,
    permissionKey: 'EDIT_OWN_WORKLOGS' | 'DELETE_OWN_WORKLOGS',
  ): Promise<boolean> {
    return (await this.loadOwnWorklogsPermissions(site, [permissionKey]))[permissionKey];
  }

  private async loadOwnWorklogsPermissions(
    site: JiraSite,
    permissionKeys: ReadonlyArray<'EDIT_OWN_WORKLOGS' | 'DELETE_OWN_WORKLOGS'>,
  ): Promise<Record<'EDIT_OWN_WORKLOGS' | 'DELETE_OWN_WORKLOGS', boolean>> {
    const url = new URL(`${site.origin}/rest/api/3/mypermissions`);
    url.searchParams.set('permissions', permissionKeys.join(','));
    const payload = await this.requestJson(site, `${url.pathname}${url.search}`);
    if (!isRecord(payload) || !isRecord(payload.permissions)) {
      throw new JiraProviderError('invalid_response');
    }
    const result = { EDIT_OWN_WORKLOGS: false, DELETE_OWN_WORKLOGS: false };
    for (const permissionKey of permissionKeys) {
      const permission = payload.permissions[permissionKey];
      if (!isRecord(permission)) {
        throw new JiraProviderError('invalid_response');
      }
      result[permissionKey] = permission.enabled === true;
    }
    return result;
  }

  /**
   * Walks the window-filtered worklog pages behind a maxResults=1 probe:
   *
   * - a probe that ignores the requested bound already spans the whole
   *   filtered set and is consumed as-is;
   * - a probe page that fits `total` while `total` spans more pages starts
   *   the walk at the tail — creation order is ascending, so the tail holds
   *   the newest worklogs and covers the 30-day window first;
   * - an empty probe page against a positive total proves nothing about
   *   positions, so forward short pages from zero probe the true extent.
   *
   * Positions advance by each response's own startAt and page length, never
   * by the requested values. Five pages or 500 raw worklogs bound the walk;
   * an unfinished walk reports incomplete coverage.
   */
  private async fetchWindowedWorklogs(
    site: JiraSite,
    taskId: string,
    startedAfterMs: number,
    startedBeforeMs: number,
  ): Promise<{ raw: unknown[]; complete: boolean }> {
    const rawById = new Map<string, unknown>();
    const collect = (worklogs: unknown[]): void => {
      for (const worklog of worklogs) {
        if (!isRecord(worklog)) {
          throw new JiraProviderError('invalid_response');
        }
        rawById.set(this.validate.requiredIdentifier(worklog.id), worklog);
      }
    };
    const raw = (): unknown[] => [...rawById.values()];

    const probe = await this.requestWorklogPage(
      site,
      taskId,
      0,
      1,
      startedAfterMs,
      startedBeforeMs,
    );
    if (probe.worklogs.length > 1) {
      collect(probe.worklogs);
      return { raw: raw(), complete: rawById.size >= probe.total };
    }
    if (probe.total <= probe.worklogs.length) {
      collect(probe.worklogs);
      return { raw: raw(), complete: true };
    }
    if (probe.worklogs.length === 0) {
      return this.walkWorklogsForward(
        site,
        taskId,
        startedAfterMs,
        startedBeforeMs,
        rawById,
        collect,
        probe.total,
        raw,
      );
    }
    return this.walkWorklogsBackward(
      site,
      taskId,
      startedAfterMs,
      startedBeforeMs,
      rawById,
      collect,
      probe.total,
      raw,
    );
  }

  private async walkWorklogsBackward(
    site: JiraSite,
    taskId: string,
    startedAfterMs: number,
    startedBeforeMs: number,
    rawById: Map<string, unknown>,
    collect: (worklogs: unknown[]) => void,
    anchorTotal: number,
    raw: () => unknown[],
  ): Promise<{ raw: unknown[]; complete: boolean }> {
    let anchor = anchorTotal;
    let nextStart = Math.max(0, anchor - JIRA_WORKLOG_PAGE_SIZE);
    for (let pages = 1; pages < JIRA_WORKLOG_MAX_PAGES; pages += 1) {
      if (rawById.size >= JIRA_WORKLOG_MAX_RAW) {
        return { raw: raw(), complete: false };
      }
      const page = await this.requestWorklogPage(
        site,
        taskId,
        nextStart,
        JIRA_WORKLOG_PAGE_SIZE,
        startedAfterMs,
        startedBeforeMs,
      );
      if (page.total !== anchor) {
        anchor = page.total;
      }
      collect(page.worklogs);
      if (page.startAt === 0 || rawById.size >= anchor) {
        return { raw: raw(), complete: rawById.size >= anchor || page.startAt === 0 };
      }
      const stepped = page.startAt - JIRA_WORKLOG_PAGE_SIZE;
      if (stepped >= nextStart) {
        return { raw: raw(), complete: false };
      }
      nextStart = Math.max(0, stepped);
    }
    return { raw: raw(), complete: rawById.size >= anchor };
  }

  private async walkWorklogsForward(
    site: JiraSite,
    taskId: string,
    startedAfterMs: number,
    startedBeforeMs: number,
    rawById: Map<string, unknown>,
    collect: (worklogs: unknown[]) => void,
    anchorTotal: number,
    raw: () => unknown[],
  ): Promise<{ raw: unknown[]; complete: boolean }> {
    let anchor = anchorTotal;
    let nextStart = 0;
    for (let pages = 1; pages < JIRA_WORKLOG_MAX_PAGES; pages += 1) {
      if (rawById.size >= JIRA_WORKLOG_MAX_RAW) {
        return { raw: raw(), complete: false };
      }
      const page = await this.requestWorklogPage(
        site,
        taskId,
        nextStart,
        JIRA_WORKLOG_PAGE_SIZE,
        startedAfterMs,
        startedBeforeMs,
      );
      if (page.total !== anchor) {
        anchor = page.total;
      }
      collect(page.worklogs);
      if (page.worklogs.length < JIRA_WORKLOG_PAGE_SIZE) {
        return {
          raw: raw(),
          complete: page.worklogs.length > 0 || rawById.size >= anchor,
        };
      }
      if (rawById.size >= anchor) {
        return { raw: raw(), complete: true };
      }
      const stepped = page.startAt + page.worklogs.length;
      if (stepped <= nextStart) {
        return { raw: raw(), complete: false };
      }
      nextStart = stepped;
    }
    return { raw: raw(), complete: rawById.size >= anchor };
  }

  /** Validates the paging envelope on every response: the page must fit its
   * own declared bounds before any position math trusts it. */
  private parseWorklogPage(payload: unknown): JiraWorklogPage {
    if (!isRecord(payload) || !Array.isArray(payload.worklogs)) {
      throw new JiraProviderError('invalid_response');
    }
    const startAt = this.requiredCount(payload.startAt);
    const maxResults = this.requiredCount(payload.maxResults);
    const total = this.requiredCount(payload.total);
    if (payload.worklogs.length > maxResults) {
      throw new JiraProviderError('invalid_response');
    }
    if (payload.worklogs.length > 0 && startAt + payload.worklogs.length > total) {
      throw new JiraProviderError('invalid_response');
    }
    return { startAt, maxResults, total, worklogs: payload.worklogs };
  }

  private async requestWorklogPage(
    site: JiraSite,
    taskId: string,
    startAt: number,
    maxResults: number,
    startedAfterMs: number,
    startedBeforeMs: number,
  ): Promise<JiraWorklogPage> {
    const url = new URL(`${site.origin}/rest/api/3/issue/${encodeURIComponent(taskId)}/worklog`);
    url.searchParams.set('startedAfter', String(startedAfterMs));
    url.searchParams.set('startedBefore', String(startedBeforeMs));
    url.searchParams.set('startAt', String(startAt));
    url.searchParams.set('maxResults', String(maxResults));
    const payload = await this.requestJson(site, `${url.pathname}${url.search}`);
    return this.parseWorklogPage(payload);
  }

  private parseWorklog(value: unknown): JiraWorklogEntry {
    if (!isRecord(value)) {
      throw new JiraProviderError('invalid_response');
    }
    const author = value.author;
    if (author !== null && author !== undefined && !isRecord(author)) {
      throw new JiraProviderError('invalid_response');
    }
    const authorAccountId =
      author === null || author === undefined
        ? null
        : this.validate.requiredString(author.accountId);
    const seconds = value.timeSpentSeconds;
    if (typeof seconds !== 'number' || !Number.isSafeInteger(seconds) || seconds < 0) {
      throw new JiraProviderError('invalid_response');
    }
    const note = this.worklogNote(value.comment);
    return {
      remoteId: this.validate.requiredIdentifier(value.id),
      authorAccountId,
      startedAtMs: this.parseWorklogStarted(value.started),
      durationMs: seconds * 1_000,
      note: note.value,
      noteTruncated: note.truncated,
    };
  }

  private worklogNote(value: unknown): { value: string | null; truncated: boolean } {
    if (value === null || value === undefined) {
      return { value: null, truncated: false };
    }
    const text = this.flattenAdfText(value);
    return {
      value: text ? text.slice(0, MAX_TIME_ENTRY_NOTE_LENGTH) : null,
      truncated: text.length > MAX_TIME_ENTRY_NOTE_LENGTH,
    };
  }

  /** Jira sends offsets like "+0000"; normalize to the colon form before parsing. */
  private parseWorklogStarted(value: unknown): number {
    if (typeof value !== 'string' || !value.trim()) {
      throw new JiraProviderError('invalid_response');
    }
    const normalized = value.trim().replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
    const parsed = Date.parse(normalized);
    if (!Number.isFinite(parsed)) {
      throw new JiraProviderError('invalid_response');
    }
    return parsed;
  }

  /** Jira reports spent time in seconds; a site with time tracking disabled
   * omits the timetracking aggregate entirely. */
  private taskTotalDurationMs(value: unknown): number | null {
    if (value === null || value === undefined) {
      return null;
    }
    if (!isRecord(value)) {
      throw new JiraProviderError('invalid_response');
    }
    const seconds = value.timeSpentSeconds;
    if (seconds === null || seconds === undefined) {
      return null;
    }
    if (typeof seconds !== 'number' || !Number.isSafeInteger(seconds) || seconds < 0) {
      throw new JiraProviderError('invalid_response');
    }
    return seconds * 1_000;
  }

  private normalizeTaskDetail(
    value: unknown,
    site: JiraSite,
    taskId: string,
  ): Omit<
    ExternalProviderTaskDetail,
    'allowedStatuses' | 'actions' | 'subtasks' | 'subtasksTruncated'
  > {
    if (
      !isRecord(value) ||
      !isRecord(value.fields) ||
      this.validate.requiredString(value.key) !== taskId
    ) {
      throw new JiraProviderError('invalid_response');
    }
    const fields = value.fields;
    if (
      !isRecord(fields.status) ||
      !isRecord(fields.status.statusCategory) ||
      !isRecord(fields.project)
    ) {
      throw new JiraProviderError('invalid_response');
    }
    const category = this.classifyStatus(
      this.validate.requiredString(fields.status.statusCategory.key).toLowerCase(),
    );
    const description = this.adfPlainText(fields.description);
    const projectId = this.validate.requiredIdentifier(fields.project.id);
    const projectName = this.validate.requiredString(fields.project.name);
    const statusId = this.validate.requiredIdentifier(fields.status.id);
    return {
      remoteId: taskId,
      remoteKey: taskId,
      title: this.validate.requiredString(fields.summary),
      description: description.value,
      descriptionTruncated: description.truncated,
      status: {
        remoteId: statusId,
        remoteStatusIds: [statusId],
        name: this.validate.requiredString(fields.status.name),
        color: this.statusColor(category),
        category,
        position: 0,
      },
      dueAt: this.optionalDueDate(fields.duedate),
      priority: this.normalizePriority(fields.priority),
      taskTotalDurationMs: this.taskTotalDurationMs(fields.timetracking),
      webUrl: this.issueWebUrl(site, taskId),
      location: {
        scopeKey: site.hostname,
        workAreaId: projectId,
        workAreaName: projectName,
      },
    };
  }

  private async normalizeTaskSubtasks(
    value: unknown,
    site: JiraSite,
    parentRemoteTaskId: string,
  ): Promise<{ items: ExternalTaskSubtaskSummary[]; truncated: boolean }> {
    if (!isRecord(value) || !isRecord(value.fields) || !Array.isArray(value.fields.subtasks)) {
      throw new JiraProviderError('invalid_response');
    }
    const references = value.fields.subtasks;
    const selected = references.slice(0, MAX_TASK_DETAIL_SUBTASKS);
    const normalized = await mapWithConcurrency(
      selected,
      VENDOR_DISCOVERY_CONCURRENCY,
      (reference) => this.normalizeTaskSubtask(reference, site, parentRemoteTaskId),
    );
    const items = normalized
      .flatMap(({ item }) => (item === null ? [] : [item]))
      .sort(compareTaskSubtaskSummaries);
    return {
      items,
      truncated:
        references.length > MAX_TASK_DETAIL_SUBTASKS ||
        normalized.some((result) => result.truncated),
    };
  }

  private async normalizeTaskSubtask(
    reference: unknown,
    site: JiraSite,
    parentRemoteTaskId: string,
  ): Promise<{ item: ExternalTaskSubtaskSummary | null; truncated: boolean }> {
    if (!isRecord(reference)) {
      return { item: null, truncated: true };
    }
    const childKey = this.optionalJiraKey(reference);
    if (childKey === null) {
      return { item: null, truncated: true };
    }
    const rich = this.normalizeTaskSubtaskReference(reference, site, childKey);
    if (rich !== null) {
      return { item: rich, truncated: false };
    }
    return this.readTaskSubtaskFallback(site, childKey, parentRemoteTaskId);
  }

  private normalizeTaskSubtaskReference(
    value: Record<string, unknown>,
    site: JiraSite,
    childKey: string,
  ): ExternalTaskSubtaskSummary | null {
    if (
      !isRecord(value.fields) ||
      !isRecord(value.fields.status) ||
      !isRecord(value.fields.status.statusCategory)
    ) {
      return null;
    }
    try {
      const category = this.classifyStatus(
        this.validate.requiredString(value.fields.status.statusCategory.key).toLowerCase(),
      );
      return {
        remoteId: childKey,
        remoteKey: childKey,
        title: this.validate.requiredString(value.fields.summary),
        status: {
          remoteId: this.validate.requiredIdentifier(value.fields.status.id),
          name: this.validate.requiredString(value.fields.status.name),
          category,
        },
        webUrl: this.issueWebUrl(site, childKey),
      };
    } catch (error) {
      if (error instanceof JiraProviderError) {
        return null;
      }
      throw error;
    }
  }

  private async readTaskSubtaskFallback(
    site: JiraSite,
    childKey: string,
    parentRemoteTaskId: string,
  ): Promise<{ item: ExternalTaskSubtaskSummary | null; truncated: boolean }> {
    const url = new URL(`${site.origin}/rest/api/3/issue/${encodeURIComponent(childKey)}`);
    url.searchParams.set('fields', 'summary,status,parent');
    let payload: unknown;
    try {
      payload = await this.requestJson(site, `${url.pathname}${url.search}`);
    } catch (error) {
      if (error instanceof JiraProviderError && error.details?.reason === 'not_found') {
        return { item: null, truncated: true };
      }
      throw error;
    }
    if (
      !isRecord(payload) ||
      this.optionalJiraKey(payload) !== childKey ||
      !isRecord(payload.fields)
    ) {
      throw new JiraProviderError('invalid_response');
    }
    if (
      !isRecord(payload.fields.parent) ||
      this.optionalJiraKey(payload.fields.parent) !== parentRemoteTaskId
    ) {
      return { item: null, truncated: true };
    }
    const item = this.normalizeTaskSubtaskReference(payload, site, childKey);
    if (item === null) {
      throw new JiraProviderError('invalid_response');
    }
    return { item, truncated: false };
  }

  private async loadTransitions(site: JiraSite, taskId: string): Promise<JiraTransition[]> {
    const url = new URL(
      `${site.origin}/rest/api/3/issue/${encodeURIComponent(taskId)}/transitions`,
    );
    url.searchParams.set('expand', 'transitions.fields');
    const payload = await this.requestJson(site, `${url.pathname}${url.search}`);
    if (!isRecord(payload) || !Array.isArray(payload.transitions)) {
      throw new JiraProviderError('invalid_response');
    }
    return payload.transitions.map((value, position) => {
      if (!isRecord(value) || !isRecord(value.to) || !isRecord(value.to.statusCategory)) {
        throw new JiraProviderError('invalid_response');
      }
      if (!isRecord(value.fields)) {
        throw new JiraProviderError('invalid_response');
      }
      const hasRequiredFields = Object.values(value.fields).some((field) => {
        if (!isRecord(field)) {
          throw new JiraProviderError('invalid_response');
        }
        return field.required === true;
      });
      const category = this.classifyStatus(
        this.validate.requiredString(value.to.statusCategory.key).toLowerCase(),
      );
      const destinationStatusId = this.validate.requiredIdentifier(value.to.id);
      const transitionId = this.validate.requiredIdentifier(value.id);
      return {
        id: transitionId,
        supported: value.isAvailable !== false && !hasRequiredFields,
        option: {
          // The transition id is the write identity; its name is the action
          // label. Both stay separate from the destination status identity so
          // two transitions into one status never collide.
          actionValue: transitionId,
          actionLabel: this.validate.requiredString(value.name),
          remoteId: destinationStatusId,
          remoteStatusIds: [destinationStatusId],
          name: this.validate.requiredString(value.to.name),
          color: this.statusColor(category),
          category,
          position,
        },
      };
    });
  }

  private adfPlainText(value: unknown): { value: string | null; truncated: boolean } {
    const text = this.flattenAdfText(value);
    return {
      value: text ? text.slice(0, MAX_TASK_DETAIL_TEXT_LENGTH) : null,
      truncated: text.length > MAX_TASK_DETAIL_TEXT_LENGTH,
    };
  }

  private adfCommentBody(value: unknown): { value: string; truncated: boolean } {
    const text = this.flattenAdfText(value);
    return {
      value: text.slice(0, MAX_TASK_COMMENT_BODY_LENGTH),
      truncated: text.length > MAX_TASK_COMMENT_BODY_LENGTH,
    };
  }

  private flattenAdfText(value: unknown, terminalLineBreaks: 'trim' | 'preserve' = 'trim'): string {
    if (value === null || value === undefined) {
      return '';
    }
    if (
      !isRecord(value) ||
      value.type !== 'doc' ||
      value.version !== 1 ||
      !Array.isArray(value.content)
    ) {
      throw new JiraProviderError('invalid_response');
    }
    const fragments: string[] = [];
    const visit = (node: unknown, depth: number): void => {
      if (depth > 128) {
        throw new JiraProviderError('invalid_response');
      }
      if (!isRecord(node) || typeof node.type !== 'string') {
        throw new JiraProviderError('invalid_response');
      }
      if (node.type === 'text') {
        if (typeof node.text !== 'string') {
          throw new JiraProviderError('invalid_response');
        }
        fragments.push(node.text);
      } else if (node.type === 'hardBreak') {
        fragments.push('\n');
      } else if (node.type === 'mention' || node.type === 'status') {
        fragments.push(this.adfAttrFallback(node, 'text'));
      } else if (node.type === 'emoji') {
        fragments.push(this.adfAttrFallback(node, 'shortName'));
      } else if (node.type === 'inlineCard') {
        fragments.push(this.adfAttrFallback(node, 'url'));
      } else if (node.type === 'date') {
        fragments.push(this.adfDateFallback(node));
      }
      if (node.content !== undefined) {
        if (!Array.isArray(node.content)) {
          throw new JiraProviderError('invalid_response');
        }
        node.content.forEach((child) => visit(child, depth + 1));
      }
      if (node.type === 'paragraph' || node.type === 'heading') {
        fragments.push('\n');
      }
    };
    value.content.forEach((node) => visit(node, 0));
    const text = fragments.join('');
    return terminalLineBreaks === 'preserve' && text.endsWith('\n')
      ? text.slice(0, -1)
      : text.replace(/\n+$/, '');
  }

  private adfAttrFallback(node: Record<string, unknown>, attr: string): string {
    const attrs = node.attrs;
    if (attrs === null || attrs === undefined) {
      return '';
    }
    if (!isRecord(attrs)) {
      throw new JiraProviderError('invalid_response');
    }
    const value = attrs[attr];
    if (value === null || value === undefined) {
      return '';
    }
    if (typeof value !== 'string') {
      throw new JiraProviderError('invalid_response');
    }
    return value.trim() ? value : '';
  }

  private adfDateFallback(node: Record<string, unknown>): string {
    const attrs = node.attrs;
    if (!isRecord(attrs) || typeof attrs.timestamp !== 'string' || !/^\d+$/.test(attrs.timestamp)) {
      throw new JiraProviderError('invalid_response');
    }
    try {
      return new Date(Number(attrs.timestamp)).toISOString().slice(0, 10);
    } catch {
      throw new JiraProviderError('invalid_response');
    }
  }

  private plainTextAdf(text: string): Record<string, unknown> {
    return {
      type: 'doc',
      version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
    };
  }

  private normalizePriority(value: unknown): ExternalProviderTaskDetail['priority'] {
    if (value === null || value === undefined) {
      return null;
    }
    if (!isRecord(value)) {
      throw new JiraProviderError('invalid_response');
    }
    return { name: this.validate.requiredString(value.name), color: JIRA_NEUTRAL_COLOR };
  }

  private statusColor(category: ExternalTaskStatusCategory): string {
    return category === 'completed' ? JIRA_COMPLETED_COLOR : JIRA_NEUTRAL_COLOR;
  }

  private issueWebUrl(site: JiraSite, taskId: string): string {
    return `${site.origin}/browse/${encodeURIComponent(taskId)}`;
  }

  private async discoverMyWork(
    credentials: IntegrationCredentials,
    options: ExternalMyWorkOptions,
  ): Promise<ExternalMyWorkSnapshot> {
    const site = this.resolveSite(credentials);
    const now = Date.now();
    const cutoff = now - RECENT_COMPLETED_WINDOW_MS;
    const [identity, configuration, issues] = await Promise.all([
      this.loadIdentity(site),
      this.requestJson(site, '/rest/api/3/configuration'),
      this.searchAssignedIssues(site, options.includeCompleted),
    ]);
    if (!isRecord(configuration)) {
      throw new JiraProviderError('invalid_response');
    }
    const uniqueTasks = new Map<string, JiraAssignedTask>();
    for (const issue of issues) {
      const normalized = this.normalizeIssue(issue, site, identity, {
        includeCompleted: options.includeCompleted,
        cutoff,
        now,
      });
      if (normalized && !uniqueTasks.has(normalized.task.remoteId)) {
        uniqueTasks.set(normalized.task.remoteId, {
          item: normalized,
          projectKey: this.issueProjectKey(issue),
        });
      }
    }

    const routed = await this.discoverRelevantBoards(site, options, [...uniqueTasks.values()], now);
    return {
      capabilities: { timeTrackingEnabled: configuration.timeTrackingEnabled === true },
      workAreas: routed.workAreas,
      tasks: routed.tasks,
      refreshedAt: new Date(now).toISOString(),
    };
  }

  private async loadIdentity(site: JiraSite): Promise<JiraIdentity> {
    const payload = await this.requestJson(site, '/rest/api/3/myself');
    if (!isRecord(payload)) {
      throw new JiraProviderError('invalid_response');
    }
    return {
      accountId: this.validate.requiredString(payload.accountId),
      displayName: this.validate.requiredString(payload.displayName),
    };
  }

  private async searchAssignedIssues(
    site: JiraSite,
    includeCompleted: boolean,
  ): Promise<unknown[]> {
    const jql = this.assignedJql(includeCompleted);
    const issues: unknown[] = [];
    const seenTokens = new Set<string>();
    let nextPageToken: string | undefined;

    for (let page = 0; page < JIRA_MAX_SEARCH_PAGES; page += 1) {
      const body: Record<string, unknown> = {
        jql,
        fields: [...JIRA_SEARCH_FIELDS],
        maxResults: JIRA_SEARCH_PAGE_SIZE,
      };
      if (nextPageToken !== undefined) {
        body.nextPageToken = nextPageToken;
      }
      const payload = await this.requestJson(site, '/rest/api/3/search/jql', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      if (!isRecord(payload) || !Array.isArray(payload.issues)) {
        throw new JiraProviderError('invalid_response');
      }
      issues.push(...payload.issues);

      if (payload.nextPageToken === undefined || payload.nextPageToken === null) {
        return issues;
      }
      if (typeof payload.nextPageToken !== 'string' || !payload.nextPageToken.trim()) {
        throw new JiraProviderError('invalid_response');
      }
      nextPageToken = payload.nextPageToken.trim();
      if (seenTokens.has(nextPageToken)) {
        throw new JiraProviderError('invalid_response');
      }
      seenTokens.add(nextPageToken);
    }
    throw new JiraProviderError('invalid_response');
  }

  private normalizeIssue(
    value: unknown,
    site: JiraSite,
    identity: JiraIdentity,
    filter: { includeCompleted: boolean; cutoff: number; now: number },
  ): ExternalWorkAreaTask | null {
    if (!isRecord(value) || !isRecord(value.fields)) {
      throw new JiraProviderError('invalid_response');
    }
    const fields = value.fields;
    if (
      !isRecord(fields.status) ||
      !isRecord(fields.status.statusCategory) ||
      !isRecord(fields.assignee) ||
      !isRecord(fields.project)
    ) {
      throw new JiraProviderError('invalid_response');
    }
    if (this.validate.requiredString(fields.assignee.accountId) !== identity.accountId) {
      return null;
    }

    const category = this.classifyStatus(
      this.validate.requiredString(fields.status.statusCategory.key).toLowerCase(),
    );
    const completedAt = this.optionalTimestamp(fields.resolutiondate);
    if (category === 'completed') {
      const completedTime = completedAt === null ? Number.NaN : Date.parse(completedAt);
      if (
        !filter.includeCompleted ||
        !Number.isFinite(completedTime) ||
        completedTime < filter.cutoff ||
        completedTime > filter.now
      ) {
        return null;
      }
    }

    const remoteId = this.validate.requiredString(value.key);
    const projectId = this.validate.requiredIdentifier(fields.project.id);
    const projectName = this.validate.requiredString(fields.project.name);
    const workArea: ExternalWorkArea = {
      remoteId: projectId,
      scopeKey: site.hostname,
      name: projectName,
      kind: 'project',
      description: null,
      assignedTaskCount: 0,
      hierarchy: [
        { kind: 'workspace', remoteId: site.hostname, name: site.hostname },
        { kind: 'project', remoteId: projectId, name: projectName },
      ],
      workflow: { isOverridden: false, columns: [] },
      refresh: {
        state: 'fresh',
        refreshedAt: new Date(filter.now).toISOString(),
        retryable: false,
        retryAt: null,
      },
    };
    return {
      workArea,
      task: {
        remoteId,
        parentRemoteTaskId: this.normalizeIssueParent(fields),
        title: this.validate.requiredString(fields.summary),
        status: {
          remoteId: this.validate.requiredIdentifier(fields.status.id),
          name: this.validate.requiredString(fields.status.name),
          category,
        },
        updatedAt: this.requiredTimestamp(fields.updated),
        dueAt: this.optionalDueDate(fields.duedate),
        completedAt,
        webUrl: `${site.origin}/browse/${encodeURIComponent(remoteId)}`,
      },
    };
  }

  private normalizeIssueParent(fields: Record<string, unknown>): string | null {
    if (!isRecord(fields.issuetype) || fields.issuetype.subtask !== true) {
      return null;
    }
    return isRecord(fields.parent) ? this.optionalJiraKey(fields.parent) : null;
  }

  private async discoverRelevantBoards(
    site: JiraSite,
    options: ExternalMyWorkOptions,
    assignedTasks: JiraAssignedTask[],
    now: number,
  ): Promise<{ workAreas: ExternalWorkArea[]; tasks: ExternalWorkAreaTask[] }> {
    const projectKeys = [...new Set(assignedTasks.map(({ projectKey }) => projectKey))];
    const boards = await this.loadRelevantBoards(site, projectKeys);
    const assignedById = new Map(
      assignedTasks.map((assigned) => [assigned.item.task.remoteId, assigned]),
    );
    const matchedIds = new Set<string>();
    const workAreas: ExternalWorkArea[] = [];
    const tasks: ExternalWorkAreaTask[] = [];

    const boardResults = await mapWithConcurrency(
      boards,
      VENDOR_DISCOVERY_CONCURRENCY,
      async (board) => {
        const boardIssueIds = await this.loadBoardIssueIds(
          site,
          board.id,
          options.includeCompleted,
        );
        const boardTasks: JiraAssignedTask[] = [];
        const seenBoardTasks = new Set<string>();
        for (const remoteId of boardIssueIds) {
          const assigned = assignedById.get(remoteId);
          if (!assigned || seenBoardTasks.has(remoteId)) {
            continue;
          }
          seenBoardTasks.add(remoteId);
          boardTasks.push(assigned);
        }
        if (boardTasks.length === 0) {
          return null;
        }
        const workArea = await this.loadBoardMetadata(site, options, board, boardTasks.length, now);
        return { workArea, boardTasks };
      },
    );
    for (const result of boardResults) {
      if (!result) {
        continue;
      }
      workAreas.push(result.workArea);
      for (const assigned of result.boardTasks) {
        matchedIds.add(assigned.item.task.remoteId);
        tasks.push({ workArea: result.workArea, task: assigned.item.task });
      }
    }

    const unmatched = assignedTasks.filter(({ item }) => !matchedIds.has(item.task.remoteId));
    if (unmatched.length > 0) {
      const workArea = this.otherAssignedWorkArea(site, unmatched.length, now);
      workAreas.push(workArea);
      tasks.push(...unmatched.map(({ item }) => ({ workArea, task: item.task })));
    }
    return { workAreas, tasks };
  }

  private async loadRelevantBoards(site: JiraSite, projectKeys: string[]): Promise<JiraBoard[]> {
    const boardPages = await mapWithConcurrency(
      projectKeys,
      VENDOR_DISCOVERY_CONCURRENCY,
      (projectKey) => this.loadProjectBoards(site, projectKey),
    );
    const boards = new Map<string, JiraBoard>();
    for (const board of boardPages.flat()) {
      if (!boards.has(board.id)) {
        boards.set(board.id, board);
      }
    }
    return [...boards.values()];
  }

  private async loadProjectBoards(site: JiraSite, projectKey: string): Promise<JiraBoard[]> {
    const boards: JiraBoard[] = [];
    let startAt = 0;
    for (let page = 0; page < JIRA_MAX_SEARCH_PAGES; page += 1) {
      const url = new URL(`${site.origin}/rest/agile/1.0/board`);
      url.searchParams.set('projectKeyOrId', projectKey);
      url.searchParams.set('startAt', String(startAt));
      url.searchParams.set('maxResults', String(JIRA_SEARCH_PAGE_SIZE));
      const payload = await this.requestJson(site, `${url.pathname}${url.search}`);
      if (
        !isRecord(payload) ||
        !Array.isArray(payload.values) ||
        typeof payload.isLast !== 'boolean'
      ) {
        throw new JiraProviderError('invalid_response');
      }
      for (const value of payload.values) {
        if (!isRecord(value)) {
          throw new JiraProviderError('invalid_response');
        }
        boards.push({
          id: this.requiredBoardId(value.id),
          name: this.validate.requiredString(value.name),
        });
      }
      if (payload.isLast) {
        return boards;
      }
      if (payload.values.length === 0) {
        throw new JiraProviderError('invalid_response');
      }
      startAt += payload.values.length;
    }
    throw new JiraProviderError('invalid_response');
  }

  private async loadBoardIssueIds(
    site: JiraSite,
    boardId: string,
    includeCompleted: boolean,
  ): Promise<string[]> {
    const issueIds: string[] = [];
    const seenTokens = new Set<string>();
    let nextPageToken: string | undefined;
    for (let page = 0; page < JIRA_MAX_SEARCH_PAGES; page += 1) {
      const url = new URL(
        `${site.origin}/rest/software/1.0/board/${encodeURIComponent(boardId)}/issue`,
      );
      url.searchParams.set('maxResults', String(JIRA_SEARCH_PAGE_SIZE));
      url.searchParams.set('fields', 'key');
      url.searchParams.set('jql', this.assignedJql(includeCompleted));
      if (nextPageToken !== undefined) {
        url.searchParams.set('nextPageToken', nextPageToken);
      }
      const payload = await this.requestJson(site, `${url.pathname}${url.search}`);
      if (!isRecord(payload) || !Array.isArray(payload.issues)) {
        throw new JiraProviderError('invalid_response');
      }
      for (const issue of payload.issues) {
        if (!isRecord(issue)) {
          throw new JiraProviderError('invalid_response');
        }
        issueIds.push(this.validate.requiredString(issue.key));
      }
      if (payload.nextPageToken === undefined || payload.nextPageToken === null) {
        return issueIds;
      }
      if (typeof payload.nextPageToken !== 'string' || !payload.nextPageToken.trim()) {
        throw new JiraProviderError('invalid_response');
      }
      nextPageToken = payload.nextPageToken.trim();
      if (seenTokens.has(nextPageToken)) {
        throw new JiraProviderError('invalid_response');
      }
      seenTokens.add(nextPageToken);
    }
    throw new JiraProviderError('invalid_response');
  }

  private async loadBoardMetadata(
    site: JiraSite,
    options: ExternalMyWorkOptions,
    board: JiraBoard,
    assignedTaskCount: number,
    now: number,
  ): Promise<ExternalWorkArea> {
    const cacheKey = JSON.stringify([
      options.connectionId,
      options.connectionGeneration,
      site.hostname,
      board.id,
    ]);
    const cached = this.boardMetadataCache.get(cacheKey);
    if (cached && now - cached.fetchedAt <= WORK_AREA_METADATA_TTL_MS) {
      return materializeWorkArea(cached.value, assignedTaskCount, {
        state: 'fresh',
        refreshedAt: new Date(cached.fetchedAt).toISOString(),
        retryable: false,
        retryAt: null,
      });
    }

    const base = this.baseBoardWorkArea(site, board);
    try {
      const configuration = await this.requestJson(
        site,
        `/rest/agile/1.0/board/${encodeURIComponent(board.id)}/configuration`,
      );
      const metadataWithoutDescription = this.normalizeBoardConfiguration(
        configuration,
        base,
        board,
      );
      const filterId = this.boardFilterId(configuration);
      const filter = await this.requestJson(
        site,
        `/rest/api/3/filter/${encodeURIComponent(filterId)}`,
      );
      const metadata = {
        ...metadataWithoutDescription,
        description: this.filterDescription(filter),
      };
      this.boardMetadataCache.set(cacheKey, { value: metadata, fetchedAt: now });
      return materializeWorkArea(metadata, assignedTaskCount, {
        state: 'fresh',
        refreshedAt: new Date(now).toISOString(),
        retryable: false,
        retryAt: null,
      });
    } catch (error) {
      if (!(error instanceof JiraProviderError)) {
        throw error;
      }
      if (cached) {
        return materializeWorkArea(cached.value, assignedTaskCount, {
          state: 'stale',
          refreshedAt: new Date(cached.fetchedAt).toISOString(),
          retryable: true,
          retryAt: vendorRetryAt(error),
        });
      }
      return {
        ...base,
        assignedTaskCount,
        refresh: {
          state: 'error',
          refreshedAt: null,
          retryable: true,
          retryAt: vendorRetryAt(error),
        },
      };
    }
  }

  private normalizeBoardConfiguration(
    value: unknown,
    base: CachedWorkAreaMetadata,
    board: JiraBoard,
  ): CachedWorkAreaMetadata {
    if (
      !isRecord(value) ||
      this.requiredBoardId(value.id) !== board.id ||
      !isRecord(value.columnConfig) ||
      !Array.isArray(value.columnConfig.columns)
    ) {
      throw new JiraProviderError('invalid_response');
    }
    const name = this.validate.requiredString(value.name);
    const columns = this.normalizeBoardColumns(value.columnConfig.columns);
    const hierarchy: ExternalWorkArea['hierarchy'] = [
      { kind: 'workspace', remoteId: base.scopeKey, name: base.scopeKey },
    ];
    if (value.location !== undefined && value.location !== null) {
      if (!isRecord(value.location)) {
        throw new JiraProviderError('invalid_response');
      }
      if (value.location.type === 'project') {
        hierarchy.push({
          kind: 'project',
          remoteId: this.validate.requiredIdentifier(value.location.id),
          name: this.validate.requiredString(value.location.name),
        });
      }
    }
    return {
      ...base,
      name,
      hierarchy,
      workflow: { isOverridden: true, columns },
    };
  }

  private normalizeBoardColumns(values: unknown[]): ExternalWorkArea['workflow']['columns'] {
    const mapped = values.map((value, position) => {
      if (!isRecord(value) || !Array.isArray(value.statuses)) {
        throw new JiraProviderError('invalid_response');
      }
      return {
        name: this.validate.requiredString(value.name),
        remoteStatusIds: value.statuses.map((status) => {
          if (!isRecord(status)) {
            throw new JiraProviderError('invalid_response');
          }
          return this.validate.requiredIdentifier(status.id);
        }),
        position,
      };
    });
    let lastMappedPosition = -1;
    for (const column of mapped) {
      if (column.remoteStatusIds.length > 0) {
        lastMappedPosition = column.position;
      }
    }
    return mapped.map((column) => {
      const category: ExternalTaskStatusCategory =
        column.remoteStatusIds.length === 0
          ? 'unknown'
          : column.position === lastMappedPosition
            ? 'completed'
            : 'active';
      return {
        remoteId: null,
        remoteStatusIds: column.remoteStatusIds,
        name: column.name,
        color: this.statusColor(category),
        category,
        position: column.position,
      };
    });
  }

  private boardFilterId(value: unknown): string {
    if (!isRecord(value) || !isRecord(value.filter)) {
      throw new JiraProviderError('invalid_response');
    }
    return this.validate.requiredIdentifier(value.filter.id);
  }

  private filterDescription(value: unknown): string | null {
    if (!isRecord(value)) {
      throw new JiraProviderError('invalid_response');
    }
    if (value.description === undefined || value.description === null || value.description === '') {
      return null;
    }
    if (typeof value.description !== 'string') {
      throw new JiraProviderError('invalid_response');
    }
    return value.description;
  }

  private baseBoardWorkArea(site: JiraSite, board: JiraBoard): CachedWorkAreaMetadata {
    return {
      remoteId: board.id,
      scopeKey: site.hostname,
      name: board.name,
      kind: 'board',
      description: null,
      hierarchy: [{ kind: 'workspace', remoteId: site.hostname, name: site.hostname }],
      workflow: { isOverridden: false, columns: [] },
    };
  }

  private otherAssignedWorkArea(site: JiraSite, count: number, now: number): ExternalWorkArea {
    return {
      remoteId: OTHER_ASSIGNED_WORK_AREA_ID,
      scopeKey: site.hostname,
      name: 'Other assigned issues',
      kind: 'board',
      description: null,
      assignedTaskCount: count,
      hierarchy: [{ kind: 'workspace', remoteId: site.hostname, name: site.hostname }],
      workflow: { isOverridden: false, columns: [] },
      refresh: {
        state: 'fresh',
        refreshedAt: new Date(now).toISOString(),
        retryable: false,
        retryAt: null,
      },
    };
  }

  private issueProjectKey(value: unknown): string {
    if (!isRecord(value) || !isRecord(value.fields) || !isRecord(value.fields.project)) {
      throw new JiraProviderError('invalid_response');
    }
    return this.validate.requiredString(value.fields.project.key);
  }

  private assignedJql(includeCompleted: boolean): string {
    return includeCompleted
      ? 'assignee = currentUser() AND (statusCategory != Done OR resolutiondate >= -30d) ORDER BY updated DESC'
      : 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC';
  }

  private requiredBoardId(value: unknown): string {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
      throw new JiraProviderError('invalid_response');
    }
    return String(value);
  }

  private resolveSite(credentials: IntegrationCredentials): JiraSite {
    if (
      credentials.provider !== this.provider ||
      !credentials.email.trim() ||
      !credentials.token.trim()
    ) {
      throw new JiraProviderError('request_rejected');
    }
    try {
      if (!JIRA_SITE_URL.test(credentials.siteUrl)) {
        throw new Error('invalid Jira site URL');
      }
      const url = new URL(credentials.siteUrl);
      const hostname = url.hostname.toLowerCase();
      if (
        url.protocol !== 'https:' ||
        url.username !== '' ||
        url.password !== '' ||
        url.port !== '' ||
        url.pathname !== '/' ||
        url.search !== '' ||
        url.hash !== '' ||
        !JIRA_TENANT_HOSTNAME.test(hostname)
      ) {
        throw new Error('invalid Jira site URL');
      }
      return {
        origin: `https://${hostname}`,
        hostname,
        authorization: `Basic ${Buffer.from(`${credentials.email}:${credentials.token}`).toString(
          'base64',
        )}`,
      };
    } catch {
      throw new JiraProviderError('request_rejected');
    }
  }

  private async requestJson(
    site: JiraSite,
    path: string,
    request: Pick<SafeVendorJsonRequest, 'method' | 'body'> = {},
  ): Promise<unknown> {
    try {
      return await this.http.requestJson({
        url: `${site.origin}${path}`,
        allowedOrigins: [site.origin],
        ...request,
        headers: {
          accept: 'application/json',
          authorization: site.authorization,
          ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
      });
    } catch (error) {
      throw mapVendorTransportError(
        error,
        (reason, retryAt, dispatched) =>
          new JiraProviderError(reason, retryAt, dispatched ? { dispatched: true } : {}),
      );
    }
  }

  private async requestNoContent(
    site: JiraSite,
    path: string,
    request: Pick<SafeVendorJsonRequest, 'method' | 'body'>,
  ): Promise<void> {
    try {
      await this.http.requestNoContent({
        url: `${site.origin}${path}`,
        allowedOrigins: [site.origin],
        ...request,
        headers: {
          accept: 'application/json',
          authorization: site.authorization,
          ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
      });
    } catch (error) {
      throw mapVendorTransportError(
        error,
        (reason, retryAt, dispatched) =>
          new JiraProviderError(reason, retryAt, dispatched ? { dispatched: true } : {}),
      );
    }
  }

  private classifyStatus(key: string): ExternalTaskStatusCategory {
    if (key === 'done') {
      return 'completed';
    }
    if (key === 'new' || key === 'indeterminate') {
      return 'active';
    }
    return 'unknown';
  }

  private requiredTimestamp(value: unknown): string {
    const timestamp = this.optionalTimestamp(value);
    if (timestamp === null) {
      throw new JiraProviderError('invalid_response');
    }
    return timestamp;
  }

  private optionalTimestamp(value: unknown): string | null {
    if (value === null || value === undefined) {
      return null;
    }
    if (typeof value !== 'string' || !value.trim()) {
      throw new JiraProviderError('invalid_response');
    }
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) {
      throw new JiraProviderError('invalid_response');
    }
    return new Date(timestamp).toISOString();
  }

  private optionalDueDate(value: unknown): string | null {
    if (value === null || value === undefined) {
      return null;
    }
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new JiraProviderError('invalid_response');
    }
    const timestamp = Date.parse(`${value}T00:00:00.000Z`);
    if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
      throw new JiraProviderError('invalid_response');
    }
    return new Date(timestamp).toISOString();
  }
}
