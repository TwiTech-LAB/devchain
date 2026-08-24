import { Inject, Injectable } from '@nestjs/common';
import { BusyError, ConflictError, ValidationError } from '../../../common/errors/error-types';
import { STORAGE_SERVICE, type StorageService } from '../../storage/interfaces/storage.interface';
import type {
  IntegrationConnection,
  IntegrationCredentials,
  IntegrationProvider,
} from '../../storage/models/domain.models';
import { ExternalTaskProviderRegistry } from '../external-task-provider.registry';
import type {
  ExternalMyWorkCapability,
  ExternalMyWorkRequestOptions,
  ExternalMyWorkResult,
  ExternalProviderConnectionContext,
  ExternalProviderTaskDetail,
  ExternalTaskAction,
  ExternalTaskActionResult,
  ExternalTaskCommentInput,
  ExternalTaskCommentPage,
  ExternalTaskDetail,
  ExternalTaskLinkLookupInput,
  ExternalTaskLinkStateSummary,
  ExternalTaskStatusInput,
  ExternalTaskStatusOption,
  ExternalTaskStatus,
  ExternalTaskSubtaskSummary,
  ExternalTaskSummary,
  ExternalTaskTimeEntryHistory,
  ExternalWorkAreaColumn,
} from '../models/external-provider.models';

@Injectable()
export class ExternalMyWorkService {
  private readonly ownerRemoteIdCache = new Map<string, string>();

  constructor(
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly providers: ExternalTaskProviderRegistry,
  ) {}

  async getMyWork(
    provider: IntegrationProvider,
    options: ExternalMyWorkRequestOptions,
  ): Promise<ExternalMyWorkResult> {
    const adapter = this.providers.get(provider);
    const descriptor = this.providers.getDescriptor(provider);
    const { connection, credentials } = await this.loadStableConnection(provider);

    if (!adapter.myWork) {
      return { provider, descriptor, supported: false, reason: 'unsupported' };
    }

    const snapshot = await adapter.myWork.discover(credentials, {
      ...options,
      connectionId: connection.id,
      connectionGeneration: connection.generation,
    });
    // Explicit allowlist: never spread the snapshot, so vendor extras cannot
    // cross the service boundary (spec-enforced).
    return {
      provider,
      descriptor,
      supported: true,
      capabilities: snapshot.capabilities,
      workAreas: snapshot.workAreas,
      tasks: snapshot.tasks.map(({ workArea, task }) => ({
        workArea,
        task: this.projectTaskSummary(task),
      })),
      refreshedAt: snapshot.refreshedAt,
    };
  }

  async getTaskDetail(
    provider: IntegrationProvider,
    remoteTaskId: string,
  ): Promise<ExternalTaskDetail> {
    const detail = this.projectTaskDetail(
      await this.runTaskOperation(provider, 'task_detail', (myWork, credentials, context) =>
        myWork.getTaskDetail(credentials, context, remoteTaskId),
      ),
    );
    const link = await this.storage.findExternalTaskLink(
      provider,
      detail.location.scopeKey,
      detail.remoteId,
    );
    return {
      ...detail,
      linkState: link ? { linked: true, epicId: link.epicId } : { linked: false, epicId: null },
    };
  }

  async listTaskComments(
    provider: IntegrationProvider,
    remoteTaskId: string,
    cursor: string | null,
  ): Promise<ExternalTaskCommentPage> {
    // Loads the connection itself so the page read and the ownership
    // annotation share one connection epoch.
    const adapter = this.providers.get(provider);
    const { connection, credentials } = await this.loadStableConnection(provider);
    if (!adapter.myWork) {
      throw this.unsupportedCapability(provider, 'list_comments');
    }
    const context = this.connectionContext(connection);
    const page = await adapter.myWork.listComments(credentials, context, remoteTaskId, cursor);
    // Server-confirmed ownership: one owner-id read per connection epoch
    // (cached), compared against each comment's author id.
    const ownerRemoteId = await this.cachedOwnerRemoteId(provider, context);
    const ownedIds =
      ownerRemoteId === null
        ? null
        : new Set(
            page.comments
              .filter((comment) => comment.author.remoteId === ownerRemoteId)
              .map((comment) => comment.remoteId),
          );
    return this.projectCommentPage(page, ownedIds);
  }

  async changeTaskStatus(
    provider: IntegrationProvider,
    remoteTaskId: string,
    input: ExternalTaskStatusInput,
  ): Promise<ExternalTaskActionResult> {
    await this.runTaskOperation(provider, 'change_status', (myWork, credentials, context) =>
      myWork.changeStatus(credentials, context, remoteTaskId, input),
    );
    return this.actionResult(remoteTaskId, 'change_status');
  }

  async addTaskComment(
    provider: IntegrationProvider,
    remoteTaskId: string,
    input: ExternalTaskCommentInput,
  ): Promise<ExternalTaskActionResult> {
    await this.runTaskOperation(provider, 'add_comment', (myWork, credentials, context) =>
      myWork.addComment(credentials, context, remoteTaskId, input),
    );
    return this.actionResult(remoteTaskId, 'add_comment');
  }

  /**
   * Time-entry history read. The caller's expected connection epoch is a
   * precondition checked before any credentials load, so a stale UI cannot
   * redirect a read at a replacement connection.
   */
  async getTimeEntryHistory(
    provider: IntegrationProvider,
    remoteTaskId: string,
    expectedEpoch: number,
  ): Promise<ExternalTaskTimeEntryHistory> {
    const connection = await this.storage.getIntegrationConnection(provider);
    if (!connection || connection.provider !== provider) {
      throw this.notConnected(provider);
    }
    if (connection.generation !== expectedEpoch) {
      throw new ConflictError('The connection changed; reload and retry with the current epoch.', {
        provider,
        reason: 'connection_epoch_mismatch',
        expectedEpoch,
        currentEpoch: connection.generation,
      });
    }
    const history = await this.runTaskOperation(
      provider,
      'time_entry_history',
      (myWork, credentials, context) =>
        myWork.getTimeEntryHistory(credentials, context, remoteTaskId),
    );
    return this.projectTimeEntryHistory(history);
  }

  async getTaskLinkStates(
    provider: IntegrationProvider,
    inputs: ExternalTaskLinkLookupInput[],
  ): Promise<{ items: ExternalTaskLinkStateSummary[] }> {
    const connection = await this.storage.getIntegrationConnection(provider);
    if (!connection || connection.provider !== provider) {
      throw this.notConnected(provider);
    }
    const uniqueScopes = [...new Set(inputs.map((input) => input.scopeKey))];
    const linksByIdentity = new Map<
      string,
      Awaited<ReturnType<StorageService['findExternalTaskLink']>>
    >();
    const scopeLinks = await Promise.all(
      uniqueScopes.map((scopeKey) =>
        this.storage.listExternalTaskLinksByRemoteScope(provider, scopeKey),
      ),
    );
    for (const links of scopeLinks) {
      for (const link of links) {
        linksByIdentity.set(`${link.remoteScopeKey}\u0000${link.remoteTaskId}`, link);
      }
    }

    const matches: Array<{
      input: ExternalTaskLinkLookupInput;
      link: Awaited<ReturnType<StorageService['findExternalTaskLink']>>;
    }> = [];
    for (const input of inputs) {
      const link = linksByIdentity.get(`${input.scopeKey}\u0000${input.taskId}`) ?? null;
      matches.push({ input, link });
    }

    const epicIds = [...new Set(matches.flatMap(({ link }) => (link ? [link.epicId] : [])))];
    const epics = new Map(
      await Promise.all(epicIds.map(async (id) => [id, await this.storage.getEpic(id)] as const)),
    );
    const projectIds = [...new Set([...epics.values()].map((epic) => epic.projectId))];
    const projects = new Map(
      await Promise.all(
        projectIds.map(async (id) => [id, await this.storage.getProject(id)] as const),
      ),
    );

    const items: ExternalTaskLinkStateSummary[] = matches.map(({ input, link }) => {
      if (!link) {
        return { ...input, linked: false, epicId: null, projectId: null, projectName: null };
      }
      const epic = epics.get(link.epicId)!;
      const project = projects.get(epic.projectId)!;
      return {
        ...input,
        linked: true,
        epicId: epic.id,
        projectId: project.id,
        projectName: project.name,
      };
    });
    return { items };
  }

  private async runTaskOperation<T>(
    provider: IntegrationProvider,
    capability: 'task_detail' | 'list_comments' | 'time_entry_history' | ExternalTaskAction,
    run: (
      myWork: ExternalMyWorkCapability,
      credentials: IntegrationCredentials,
      context: ExternalProviderConnectionContext,
    ) => Promise<T>,
  ): Promise<T> {
    const adapter = this.providers.get(provider);
    const { connection, credentials } = await this.loadStableConnection(provider);
    if (!adapter.myWork) {
      throw this.unsupportedCapability(provider, capability);
    }
    return run(adapter.myWork, credentials, this.connectionContext(connection));
  }

  /**
   * Current vendor-user id for a connection epoch, cached per epoch. A
   * generation bump changes the key, so a replaced connection can never
   * reuse another account's ownership verdict.
   */
  private async cachedOwnerRemoteId(
    provider: IntegrationProvider,
    context: ExternalProviderConnectionContext,
  ): Promise<string | null> {
    const cacheKey = `${provider}:${context.connectionId}:${context.connectionGeneration}`;
    const cached = this.ownerRemoteIdCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
    const adapter = this.providers.get(provider);
    if (!adapter.ownedMutations) {
      return null;
    }
    const credentials = await this.storage.getIntegrationConnectionCredentials(provider);
    if (!credentials || credentials.provider !== provider) {
      return null;
    }
    try {
      const ownerRemoteId = await adapter.ownedMutations.getCurrentOwnerRemoteId(credentials);
      this.ownerRemoteIdCache.set(cacheKey, ownerRemoteId);
      return ownerRemoteId;
    } catch {
      // An identity read failure leaves ownership unconfirmed: no comment
      // receives owned affordances for this page.
      return null;
    }
  }

  private async loadStableConnection(provider: IntegrationProvider): Promise<{
    connection: IntegrationConnection;
    credentials: IntegrationCredentials;
  }> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = await this.storage.getIntegrationConnection(provider);
      if (!before || before.provider !== provider) {
        throw this.notConnected(provider);
      }
      const credentials = await this.storage.getIntegrationConnectionCredentials(provider);
      const after = await this.storage.getIntegrationConnection(provider);
      if (
        !credentials ||
        credentials.provider !== provider ||
        !after ||
        after.provider !== provider
      ) {
        throw this.notConnected(provider);
      }
      if (before.id === after.id && before.generation === after.generation) {
        return { connection: after, credentials };
      }
    }
    throw new BusyError('Integration connection changed during My Work refresh.', {
      provider,
      reason: 'connection_changed',
    });
  }

  private notConnected(provider: IntegrationProvider): ValidationError {
    return new ValidationError('Connect the integration before loading My Work.', {
      provider,
      reason: 'not_connected',
    });
  }

  private connectionContext(connection: IntegrationConnection): ExternalProviderConnectionContext {
    return {
      connectionId: connection.id,
      connectionGeneration: connection.generation,
    };
  }

  private unsupportedCapability(
    provider: IntegrationProvider,
    capability: 'task_detail' | 'list_comments' | 'time_entry_history' | ExternalTaskAction,
  ): ValidationError {
    return new ValidationError('The integration provider does not support this task operation.', {
      provider,
      capability,
      reason: 'unsupported_capability',
    });
  }

  private actionResult(remoteTaskId: string, action: ExternalTaskAction): ExternalTaskActionResult {
    return {
      remoteTaskId,
      action,
      succeeded: true,
      refresh: ['my_work', 'task_detail'],
    };
  }

  private projectCommentPage(
    page: ExternalTaskCommentPage,
    ownedIds: Set<string> | null,
  ): ExternalTaskCommentPage {
    return {
      comments: page.comments.map((comment) => ({
        remoteId: comment.remoteId,
        author: {
          remoteId: comment.author.remoteId,
          displayName: comment.author.displayName,
        },
        body: comment.body,
        bodyTruncated: comment.bodyTruncated,
        rich: comment.rich
          ? comment.rich.supported
            ? { document: comment.rich.document, supported: true }
            : { supported: false, readOnlyReason: comment.rich.readOnlyReason }
          : null,
        lookupToken: comment.lookupToken,
        owned: ownedIds?.has(comment.remoteId) ?? false,
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt,
      })),
      nextCursor: page.nextCursor,
    };
  }

  private projectTimeEntryHistory(
    history: ExternalTaskTimeEntryHistory,
  ): ExternalTaskTimeEntryHistory {
    // Explicit allowlist: vendor extras cannot cross the service boundary.
    return {
      windowDays: history.windowDays,
      entries: history.entries.map((entry) => ({
        remoteId: entry.remoteId,
        durationMs: entry.durationMs,
        startedAt: entry.startedAt,
        note: entry.note,
        noteTruncated: entry.noteTruncated,
        canDelete: entry.canDelete,
      })),
      truncated: history.truncated,
      hasRunningTimer: history.hasRunningTimer,
    };
  }

  private projectTaskDetail(detail: ExternalProviderTaskDetail): ExternalProviderTaskDetail {
    return {
      remoteId: detail.remoteId,
      remoteKey: detail.remoteKey,
      title: detail.title,
      description: detail.description,
      descriptionTruncated: detail.descriptionTruncated,
      status: this.projectColumn(detail.status),
      dueAt: detail.dueAt,
      priority: detail.priority ? { ...detail.priority } : null,
      subtasks: detail.subtasks.map((subtask) => this.projectSubtaskSummary(subtask)),
      subtasksTruncated: detail.subtasksTruncated,
      taskTotalDurationMs: detail.taskTotalDurationMs,
      webUrl: detail.webUrl,
      location: { ...detail.location },
      allowedStatuses: detail.allowedStatuses.map((option) => this.projectStatusOption(option)),
      actions: detail.actions.map((action) => ({ ...action })),
    };
  }

  private projectTaskSummary(task: ExternalTaskSummary): ExternalTaskSummary {
    return {
      remoteId: task.remoteId,
      parentRemoteTaskId: task.parentRemoteTaskId,
      title: task.title,
      status: this.projectTaskStatus(task.status),
      updatedAt: task.updatedAt,
      dueAt: task.dueAt,
      completedAt: task.completedAt,
      webUrl: task.webUrl,
    };
  }

  private projectSubtaskSummary(subtask: ExternalTaskSubtaskSummary): ExternalTaskSubtaskSummary {
    return {
      remoteId: subtask.remoteId,
      remoteKey: subtask.remoteKey,
      title: subtask.title,
      status: this.projectTaskStatus(subtask.status),
      webUrl: subtask.webUrl,
    };
  }

  private projectTaskStatus(status: ExternalTaskStatus): ExternalTaskStatus {
    return {
      ...(status.remoteId !== undefined ? { remoteId: status.remoteId } : {}),
      name: status.name,
      category: status.category,
    };
  }

  private projectStatusOption(option: ExternalTaskStatusOption): ExternalTaskStatusOption {
    return {
      actionValue: option.actionValue,
      ...(option.actionLabel !== undefined ? { actionLabel: option.actionLabel } : {}),
      remoteId: option.remoteId,
      ...(option.remoteStatusIds ? { remoteStatusIds: [...option.remoteStatusIds] } : {}),
      name: option.name,
      color: option.color,
      category: option.category,
      position: option.position,
    };
  }

  private projectColumn(column: ExternalWorkAreaColumn): ExternalWorkAreaColumn {
    return {
      ...column,
      ...(column.remoteStatusIds ? { remoteStatusIds: [...column.remoteStatusIds] } : {}),
    };
  }
}
