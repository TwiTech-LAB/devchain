import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { IntegrationAdmissionGuard } from '../../../common/guards/integration-admission.guard';
import type { IntegrationProvider } from '../../storage/models/domain.models';
import { parseOrThrow as parseWithFallback } from '../request-validation';
import type {
  ExternalMyWorkResult,
  ExternalTaskActionResult,
  ExternalTaskCommentPage,
  ExternalTaskDetail,
  ExternalTaskTimeEntryHistory,
} from '../models/external-provider.models';
import type {
  ExternalTimeEntryCreateResult,
  ExternalTimeEntryDeleteResult,
  ExternalTimeEntryUpdateResult,
  ExternalTimeOperationReceiptView,
  ExternalTimeOperationVerifyResult,
} from '../models/external-time-mutation.models';
import {
  MAX_TIME_OPERATION_ID_LENGTH,
  TIME_OPERATION_ID_PATTERN,
} from '../models/external-time-mutation.models';
import type {
  ExternalCommentDeleteOutcome,
  ExternalEditSessionView,
  ExternalSessionReloadResult,
  ExternalSessionVerifyResult,
  ExternalSessionWriteOutcome,
} from '../models/external-edit-session.models';
import type { ExternalRichDocumentV1 } from '../models/external-rich-document';
import type { ExternalRichDescriptionRead } from './external-edit-session.service';
import {
  COMMENT_DELETE_RESPONSE_SCHEMA,
  COMMENT_EDIT_SESSION_INPUT_BODY_SCHEMA,
  COMMENT_INPUT_BODY_SCHEMA,
  DELETE_SESSION_INPUT_BODY_SCHEMA,
  EDIT_SESSION_RELOAD_RESPONSE_SCHEMA,
  EDIT_SESSION_RESPONSE_SCHEMA,
  EDIT_SESSION_VERIFY_RESPONSE_SCHEMA,
  EDIT_SESSION_WRITE_RESPONSE_SCHEMA,
  RICH_DESCRIPTION_RESPONSE_SCHEMA,
  INTEGRATION_PROVIDER_IDS,
  MAX_COMMENT_LENGTH,
  MAX_REMOTE_TASK_ID_LENGTH,
  MAX_STATUS_LENGTH,
  MAX_TASK_COMMENT_CURSOR_LENGTH,
  MAX_TIME_ENTRY_DURATION_MS,
  MAX_TIME_ENTRY_NOTE_LENGTH,
  MY_WORK_RESPONSE_SCHEMA,
  STATUS_INPUT_BODY_SCHEMA,
  TASK_COMMENTS_RESPONSE_SCHEMA,
  TASK_DETAIL_RESPONSE_SCHEMA,
  TASK_TIME_ENTRIES_RESPONSE_SCHEMA,
  TIME_ENTRY_CREATE_RESPONSE_SCHEMA,
  TIME_ENTRY_DELETE_RESPONSE_SCHEMA,
  TIME_ENTRY_UPDATE_RESPONSE_SCHEMA,
  TIME_ENTRY_INPUT_BODY_SCHEMA,
  TIME_OPERATION_ACK_RESPONSE_SCHEMA,
  TIME_OPERATION_VERIFY_RESPONSE_SCHEMA,
  taskActionResponseSchema,
} from './external-my-work.openapi';
import { ExternalEditSessionService } from './external-edit-session.service';
import { ExternalMyWorkService } from './external-my-work.service';
import { ExternalTimeMutationService } from './external-time-mutation.service';

const providerSchema = z.enum(INTEGRATION_PROVIDER_IDS);
const projectIdSchema = z.string().uuid('projectId must be a valid UUID.');
const querySchema = z
  .object({
    projectId: projectIdSchema,
    includeCompleted: z.enum(['true', 'false']).optional(),
  })
  .strict();
const taskCommentsQuerySchema = z
  .object({
    projectId: projectIdSchema,
    cursor: z.string().trim().min(1).max(MAX_TASK_COMMENT_CURSOR_LENGTH).optional(),
  })
  .strict();
const remoteTaskIdSchema = z.string().trim().min(1).max(MAX_REMOTE_TASK_ID_LENGTH);
const remoteScopeKeySchema = z.string().trim().min(1).max(256);
const statusInputSchema = z
  .object({ status: z.string().trim().min(1).max(MAX_STATUS_LENGTH) })
  .strict();
const commentInputSchema = z
  .object({
    text: z.string().trim().min(1).max(MAX_COMMENT_LENGTH),
    notifyAll: z.boolean().optional(),
  })
  .strict();
const timeEntryInputSchema = z
  .object({
    startedAt: z.string().datetime({ offset: true }),
    durationMs: z.number().int().positive().max(MAX_TIME_ENTRY_DURATION_MS),
    note: z.string().trim().max(MAX_TIME_ENTRY_NOTE_LENGTH).nullable().optional(),
  })
  .strict();
const linkLookupInputSchema = z
  .object({
    scopeKey: z.string().trim().min(1).max(256),
    taskId: z.string().trim().min(1).max(MAX_REMOTE_TASK_ID_LENGTH),
  })
  .strict();
const linkLookupBodySchema = z
  .object({
    items: z.array(linkLookupInputSchema).min(1).max(1_000),
    includeLoggedMinutes: z.boolean().optional(),
  })
  .strict();
const sessionIdSchema = z.string().uuid();
const deleteSessionInputSchema = z
  .object({
    pageProof: z.string().trim().min(1).max(MAX_TASK_COMMENT_CURSOR_LENGTH).nullable().optional(),
  })
  .strict();
const descriptionWriteSchema = z
  .object({
    document: z.object({ version: z.literal(1), blocks: z.array(z.unknown()) }).strict(),
    revision: z.number().int().min(0),
  })
  .strict();
const remoteCommentIdSchema = z.string().trim().min(1).max(256);
const commentEditSessionInputSchema = z
  .object({
    lookupToken: z.string().trim().min(1).max(1_024).nullable().optional(),
  })
  .strict();
/** Connection epoch precondition: the generation the caller acts against. */
const connectionEpochHeaderSchema = z
  .string()
  .trim()
  .regex(/^\d{1,10}$/, 'Invalid connection epoch')
  .transform(Number);
const idempotencyKeyHeaderSchema = z
  .string()
  .trim()
  .regex(TIME_OPERATION_ID_PATTERN, 'Invalid idempotency key')
  .max(MAX_TIME_OPERATION_ID_LENGTH);
const remoteEntryIdSchema = z.string().trim().min(1).max(256);
const operationIdSchema = z.string().trim().min(1).max(MAX_TIME_OPERATION_ID_LENGTH);

function parseOrThrow<T, I>(schema: z.ZodType<T, z.ZodTypeDef, I>, value: unknown): T {
  return parseWithFallback(schema, value, 'Invalid My Work request.');
}

@ApiTags('integrations')
@Controller('api/integrations/my-work')
@UseGuards(IntegrationAdmissionGuard)
@ApiQuery({ name: 'projectId', required: true, type: String })
@ApiResponse({ status: 400, description: 'Invalid request, connection, or capability' })
@ApiResponse({ status: 403, description: 'The provider denied the operation' })
@ApiResponse({ status: 404, description: 'The remote task was not found' })
@ApiResponse({ status: 429, description: 'The provider rate limit was reached' })
@ApiResponse({
  status: 502,
  description: 'The provider returned an invalid or unavailable response',
})
@ApiResponse({ status: 504, description: 'The provider request timed out' })
export class ExternalMyWorkController {
  constructor(
    private readonly myWork: ExternalMyWorkService,
    private readonly editSessions: ExternalEditSessionService,
    private readonly timeMutations: ExternalTimeMutationService,
  ) {}

  @Get(':provider')
  @ApiOperation({ summary: 'Load normalized assigned work from a connected provider' })
  @ApiParam({ name: 'provider', enum: [...INTEGRATION_PROVIDER_IDS] })
  @ApiQuery({ name: 'includeCompleted', required: false, type: Boolean })
  @ApiResponse({
    status: 200,
    description: 'A supported My Work snapshot or a safe unsupported-capability response',
    schema: MY_WORK_RESPONSE_SCHEMA,
  })
  @ApiResponse({ status: 400, description: 'Invalid request or provider is not connected' })
  @ApiResponse({ status: 429, description: 'The upstream provider rate limit was reached' })
  @ApiResponse({ status: 502, description: 'The upstream provider response was unavailable' })
  async getMyWork(
    @Param('provider') providerValue: string,
    @Query() queryValue: unknown,
  ): Promise<ExternalMyWorkResult> {
    const provider = parseOrThrow(providerSchema, providerValue);
    const query = parseOrThrow(querySchema, queryValue);
    return this.myWork.getMyWork(query.projectId, provider, {
      includeCompleted: query.includeCompleted === 'true',
    });
  }

  @Get(':provider/tasks/:taskId')
  @ApiOperation({ summary: 'Load normalized detail and action capabilities for a remote task' })
  @ApiParam({ name: 'provider', enum: [...INTEGRATION_PROVIDER_IDS] })
  @ApiParam({ name: 'taskId', type: String })
  @ApiResponse({
    status: 200,
    description: 'Normalized remote task detail',
    schema: TASK_DETAIL_RESPONSE_SCHEMA,
  })
  @ApiResponse({ status: 400, description: 'Invalid input or unsupported capability' })
  async getTaskDetail(
    @Param('provider') providerValue: string,
    @Param('taskId') taskIdValue: string,
    @Query('projectId') projectIdValue: unknown,
  ): Promise<ExternalTaskDetail> {
    const { provider, taskId } = this.parseTaskPath(providerValue, taskIdValue);
    return this.myWork.getTaskDetail(this.parseProjectId(projectIdValue), provider, taskId);
  }

  @Get(':provider/tasks/:taskId/comments')
  @ApiOperation({ summary: 'Load normalized newest-first comment history for a remote task' })
  @ApiParam({ name: 'provider', enum: [...INTEGRATION_PROVIDER_IDS] })
  @ApiParam({ name: 'taskId', type: String })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiResponse({
    status: 200,
    description: 'Normalized plain-text comment page plus an optional older-history cursor',
    schema: TASK_COMMENTS_RESPONSE_SCHEMA,
  })
  @ApiResponse({ status: 400, description: 'Invalid input or unsupported capability' })
  async listTaskComments(
    @Param('provider') providerValue: string,
    @Param('taskId') taskIdValue: string,
    @Query() queryValue: unknown,
  ): Promise<ExternalTaskCommentPage> {
    const { provider, taskId } = this.parseTaskPath(providerValue, taskIdValue);
    const query = parseOrThrow(taskCommentsQuerySchema, queryValue);
    return this.myWork.listTaskComments(query.projectId, provider, taskId, query.cursor ?? null);
  }

  @Get(':provider/tasks/:taskId/time-entries')
  @ApiOperation({
    summary: "Load the connected user's normalized 30-day time-entry history for a remote task",
    description:
      'The window is fixed at 30 days and provider-neutral; only the connected user entries are returned, capped at 100 rows. Requires the X-DevChain-Connection-Epoch header, validated before credentials load.',
  })
  @ApiParam({ name: 'provider', enum: [...INTEGRATION_PROVIDER_IDS] })
  @ApiParam({ name: 'taskId', type: String })
  @ApiResponse({
    status: 200,
    description:
      'Strict 30-day connected-user time-entry history with truncation and running-timer state',
    schema: TASK_TIME_ENTRIES_RESPONSE_SCHEMA,
  })
  @ApiResponse({ status: 400, description: 'Invalid input or unsupported capability' })
  @ApiResponse({ status: 409, description: 'The connection epoch precondition failed' })
  async listTaskTimeEntries(
    @Param('provider') providerValue: string,
    @Param('taskId') taskIdValue: string,
    @Headers('x-devchain-connection-epoch') epochValue: unknown,
    @Query('projectId') projectIdValue: unknown,
  ): Promise<ExternalTaskTimeEntryHistory> {
    const { provider, taskId } = this.parseTaskPath(providerValue, taskIdValue);
    const epoch = parseOrThrow(connectionEpochHeaderSchema, String(epochValue ?? ''));
    return this.myWork.getTimeEntryHistory(
      this.parseProjectId(projectIdValue),
      provider,
      taskId,
      epoch,
    );
  }

  @Put(':provider/tasks/:taskId/status')
  @ApiOperation({ summary: 'Change a remote task status' })
  @ApiParam({ name: 'provider', enum: [...INTEGRATION_PROVIDER_IDS] })
  @ApiParam({ name: 'taskId', type: String })
  @ApiBody({ schema: STATUS_INPUT_BODY_SCHEMA })
  @ApiResponse({
    status: 200,
    description: 'Normalized action acknowledgement',
    schema: taskActionResponseSchema('change_status'),
  })
  async changeTaskStatus(
    @Param('provider') providerValue: string,
    @Param('taskId') taskIdValue: string,
    @Body() body: unknown,
    @Query('projectId') projectIdValue: unknown,
  ): Promise<ExternalTaskActionResult> {
    const { provider, taskId } = this.parseTaskPath(providerValue, taskIdValue);
    return this.myWork.changeTaskStatus(
      this.parseProjectId(projectIdValue),
      provider,
      taskId,
      parseOrThrow(statusInputSchema, body),
    );
  }

  @Post(':provider/tasks/:taskId/comments')
  @ApiOperation({ summary: 'Add a plain-text remote task comment' })
  @ApiParam({ name: 'provider', enum: [...INTEGRATION_PROVIDER_IDS] })
  @ApiParam({ name: 'taskId', type: String })
  @ApiBody({ schema: COMMENT_INPUT_BODY_SCHEMA })
  @ApiResponse({
    status: 200,
    description: 'Normalized action acknowledgement',
    schema: taskActionResponseSchema('add_comment'),
  })
  async addTaskComment(
    @Param('provider') providerValue: string,
    @Param('taskId') taskIdValue: string,
    @Body() body: unknown,
    @Query('projectId') projectIdValue: unknown,
  ): Promise<ExternalTaskActionResult> {
    const { provider, taskId } = this.parseTaskPath(providerValue, taskIdValue);
    const input = parseOrThrow(commentInputSchema, body);
    return this.myWork.addTaskComment(this.parseProjectId(projectIdValue), provider, taskId, {
      text: input.text,
      notifyAll: input.notifyAll ?? false,
    });
  }

  @Post(':provider/tasks/:taskId/time-entries')
  @ApiOperation({
    summary: 'Create a manual remote task time entry behind an operation receipt',
    description:
      'Requires the X-DevChain-Connection-Epoch precondition header and an Idempotency-Key operation id. One operation id and payload tuple dispatch at most once; a dispatched timeout, network loss, or unusable 5xx returns outcome_unknown and is never retried automatically.',
  })
  @ApiParam({ name: 'provider', enum: [...INTEGRATION_PROVIDER_IDS] })
  @ApiParam({ name: 'taskId', type: String })
  @ApiQuery({ name: 'scopeKey', type: String, required: true })
  @ApiBody({ schema: TIME_ENTRY_INPUT_BODY_SCHEMA })
  @ApiResponse({
    status: 200,
    description: 'Provider-confirmed create or a receipt-bound unknown outcome',
    schema: TIME_ENTRY_CREATE_RESPONSE_SCHEMA,
  })
  @ApiResponse({ status: 400, description: 'Invalid input or unsupported capability' })
  @ApiResponse({
    status: 409,
    description:
      'Epoch precondition, idempotency conflict, provider busy gate, or durable estimate operation pending',
  })
  async addTaskTimeEntry(
    @Param('provider') providerValue: string,
    @Param('taskId') taskIdValue: string,
    @Headers('x-devchain-connection-epoch') epochValue: unknown,
    @Headers('idempotency-key') idempotencyKeyValue: unknown,
    @Body() body: unknown,
    @Query('scopeKey') scopeKeyValue: unknown,
    @Query('projectId') projectIdValue: unknown,
  ): Promise<ExternalTimeEntryCreateResult> {
    const { provider, taskId } = this.parseTaskPath(providerValue, taskIdValue);
    const epoch = parseOrThrow(connectionEpochHeaderSchema, String(epochValue ?? ''));
    const operationId = parseOrThrow(idempotencyKeyHeaderSchema, String(idempotencyKeyValue ?? ''));
    const input = parseOrThrow(timeEntryInputSchema, body);
    return this.timeMutations.createTimeEntry(
      this.parseProjectId(projectIdValue),
      provider,
      taskId,
      {
        startedAt: input.startedAt,
        durationMs: input.durationMs,
        note: input.note ?? null,
      },
      operationId,
      epoch,
      parseOrThrow(remoteScopeKeySchema, String(scopeKeyValue ?? '')),
    );
  }

  @Put(':provider/tasks/:taskId/time-entries/:entryId')
  @ApiOperation({
    summary: 'Update an owned remote time entry behind an operation receipt',
    description:
      'Changes only the provider entry. The DevChain estimate checkpoint is never adjusted. Requires the connection epoch and an Idempotency-Key; ambiguous outcomes resolve from the exact entry state without automatic retry.',
  })
  @ApiParam({ name: 'provider', enum: [...INTEGRATION_PROVIDER_IDS] })
  @ApiParam({ name: 'taskId', type: String })
  @ApiParam({ name: 'entryId', type: String })
  @ApiQuery({ name: 'scopeKey', type: String, required: true })
  @ApiBody({ schema: TIME_ENTRY_INPUT_BODY_SCHEMA })
  @ApiResponse({ status: 200, schema: TIME_ENTRY_UPDATE_RESPONSE_SCHEMA })
  @ApiResponse({ status: 400, description: 'Invalid input or unsupported capability' })
  @ApiResponse({ status: 403, description: 'The entry is not editable by the connected user' })
  @ApiResponse({
    status: 409,
    description: 'Epoch, idempotency, busy, or estimate-pending conflict',
  })
  async updateTaskTimeEntry(
    @Param('provider') providerValue: string,
    @Param('taskId') taskIdValue: string,
    @Param('entryId') entryIdValue: string,
    @Headers('x-devchain-connection-epoch') epochValue: unknown,
    @Headers('idempotency-key') idempotencyKeyValue: unknown,
    @Body() body: unknown,
    @Query('scopeKey') scopeKeyValue: unknown,
    @Query('projectId') projectIdValue: unknown,
  ): Promise<ExternalTimeEntryUpdateResult> {
    const { provider, taskId } = this.parseTaskPath(providerValue, taskIdValue);
    const entryId = parseOrThrow(remoteEntryIdSchema, entryIdValue);
    const epoch = parseOrThrow(connectionEpochHeaderSchema, String(epochValue ?? ''));
    const operationId = parseOrThrow(idempotencyKeyHeaderSchema, String(idempotencyKeyValue ?? ''));
    const input = parseOrThrow(timeEntryInputSchema, body);
    return this.timeMutations.updateTimeEntry(
      this.parseProjectId(projectIdValue),
      provider,
      taskId,
      entryId,
      { startedAt: input.startedAt, durationMs: input.durationMs, note: input.note ?? null },
      operationId,
      epoch,
      parseOrThrow(remoteScopeKeySchema, String(scopeKeyValue ?? '')),
    );
  }

  @Delete(':provider/tasks/:taskId/time-entries/:entryId')
  @ApiOperation({
    summary: 'Delete an owned remote time entry behind an operation receipt',
    description:
      'Requires the X-DevChain-Connection-Epoch precondition header and an Idempotency-Key operation id. A provider preflight proves presence and ownership first; ambiguous outcomes resolve only through the exact-resource verify route.',
  })
  @ApiParam({ name: 'provider', enum: [...INTEGRATION_PROVIDER_IDS] })
  @ApiParam({ name: 'taskId', type: String })
  @ApiParam({ name: 'entryId', type: String })
  @ApiQuery({ name: 'scopeKey', type: String, required: true })
  @ApiResponse({
    status: 200,
    description: 'Deleted, already-deleted, not-applied, or a receipt-bound unknown outcome',
    schema: TIME_ENTRY_DELETE_RESPONSE_SCHEMA,
  })
  @ApiResponse({ status: 400, description: 'Invalid input or unsupported capability' })
  @ApiResponse({ status: 403, description: 'The entry is not deletable by the connected user' })
  @ApiResponse({
    status: 409,
    description:
      'Epoch precondition, idempotency conflict, provider busy gate, or durable estimate operation pending',
  })
  async deleteTaskTimeEntry(
    @Param('provider') providerValue: string,
    @Param('taskId') taskIdValue: string,
    @Param('entryId') entryIdValue: string,
    @Headers('x-devchain-connection-epoch') epochValue: unknown,
    @Headers('idempotency-key') idempotencyKeyValue: unknown,
    @Query('scopeKey') scopeKeyValue: unknown,
    @Query('projectId') projectIdValue: unknown,
  ): Promise<ExternalTimeEntryDeleteResult> {
    const { provider, taskId } = this.parseTaskPath(providerValue, taskIdValue);
    const entryId = parseOrThrow(remoteEntryIdSchema, entryIdValue);
    const epoch = parseOrThrow(connectionEpochHeaderSchema, String(epochValue ?? ''));
    const operationId = parseOrThrow(idempotencyKeyHeaderSchema, String(idempotencyKeyValue ?? ''));
    return this.timeMutations.deleteTimeEntry(
      this.parseProjectId(projectIdValue),
      provider,
      taskId,
      entryId,
      operationId,
      epoch,
      parseOrThrow(remoteScopeKeySchema, String(scopeKeyValue ?? '')),
    );
  }

  @Get(':provider/time-operations/:operationId')
  @ApiOperation({
    summary: 'Read one time-entry operation receipt',
    description: 'Requires the X-DevChain-Connection-Epoch precondition header.',
  })
  @ApiParam({ name: 'provider', enum: [...INTEGRATION_PROVIDER_IDS] })
  @ApiParam({ name: 'operationId', type: String })
  @ApiResponse({ status: 200, schema: TIME_OPERATION_ACK_RESPONSE_SCHEMA })
  @ApiResponse({ status: 404, description: 'The operation receipt is unknown or expired' })
  async getTimeOperation(
    @Param('provider') providerValue: string,
    @Param('operationId') operationIdValue: string,
    @Headers('x-devchain-connection-epoch') epochValue: unknown,
    @Query('projectId') projectIdValue: unknown,
  ): Promise<ExternalTimeOperationReceiptView> {
    const provider = parseOrThrow(providerSchema, providerValue);
    const operationId = parseOrThrow(operationIdSchema, operationIdValue);
    const epoch = parseOrThrow(connectionEpochHeaderSchema, String(epochValue ?? ''));
    return this.timeMutations.getOperation(
      this.parseProjectId(projectIdValue),
      provider,
      operationId,
      epoch,
    );
  }

  @Post(':provider/time-operations/:operationId/verify')
  @ApiOperation({
    summary: 'Resolve an unknown time-entry operation from exact provider proof',
    description:
      'Creates resolve only from complete before/after id sets plus exactly one new matching entry; updates compare the exact entry with desired and baseline tuples; deletes resolve only through the exact-resource read. Collection absence never resolves anything. An unknown create whose pre-dispatch baseline was incomplete returns completeness_not_provable without any provider access.',
  })
  @ApiParam({ name: 'provider', enum: [...INTEGRATION_PROVIDER_IDS] })
  @ApiParam({ name: 'operationId', type: String })
  @ApiResponse({ status: 200, schema: TIME_OPERATION_VERIFY_RESPONSE_SCHEMA })
  @ApiResponse({ status: 404, description: 'The operation receipt is unknown or expired' })
  @ApiResponse({ status: 409, description: 'Epoch precondition failed' })
  async verifyTimeOperation(
    @Param('provider') providerValue: string,
    @Param('operationId') operationIdValue: string,
    @Headers('x-devchain-connection-epoch') epochValue: unknown,
    @Query('projectId') projectIdValue: unknown,
  ): Promise<ExternalTimeOperationVerifyResult> {
    const provider = parseOrThrow(providerSchema, providerValue);
    const operationId = parseOrThrow(operationIdSchema, operationIdValue);
    const epoch = parseOrThrow(connectionEpochHeaderSchema, String(epochValue ?? ''));
    return this.timeMutations.verifyOperation(
      this.parseProjectId(projectIdValue),
      provider,
      operationId,
      epoch,
    );
  }

  @Post(':provider/time-operations/:operationId/acknowledge')
  @ApiOperation({
    summary: 'Acknowledge the duplicate risk of an unknown time-entry operation',
    description:
      'Transitions a live unknown receipt to terminal abandoned_unknown. This is the only way past an ambiguity that cannot be verified.',
  })
  @ApiParam({ name: 'provider', enum: [...INTEGRATION_PROVIDER_IDS] })
  @ApiParam({ name: 'operationId', type: String })
  @ApiResponse({ status: 200, schema: TIME_OPERATION_ACK_RESPONSE_SCHEMA })
  @ApiResponse({ status: 404, description: 'The operation receipt is unknown or expired' })
  @ApiResponse({ status: 409, description: 'The operation is not unresolved' })
  async acknowledgeTimeOperation(
    @Param('provider') providerValue: string,
    @Param('operationId') operationIdValue: string,
    @Headers('x-devchain-connection-epoch') epochValue: unknown,
    @Query('projectId') projectIdValue: unknown,
  ): Promise<ExternalTimeOperationReceiptView> {
    const provider = parseOrThrow(providerSchema, providerValue);
    const operationId = parseOrThrow(operationIdSchema, operationIdValue);
    const epoch = parseOrThrow(connectionEpochHeaderSchema, String(epochValue ?? ''));
    return this.timeMutations.acknowledgeOperation(
      this.parseProjectId(projectIdValue),
      provider,
      operationId,
      epoch,
    );
  }

  @Post(':provider/links/batch')
  @ApiOperation({ summary: 'Resolve DevChain link state for remote task cards' })
  @ApiParam({ name: 'provider', enum: [...INTEGRATION_PROVIDER_IDS] })
  async getTaskLinkStates(
    @Param('provider') providerValue: string,
    @Body() body: unknown,
    @Query('projectId') projectIdValue: unknown,
  ) {
    const provider = parseOrThrow(providerSchema, providerValue);
    const input = parseOrThrow(linkLookupBodySchema, body);
    return this.myWork.getTaskLinkStates(
      this.parseProjectId(projectIdValue),
      provider,
      input.items,
      { includeLoggedMinutes: input.includeLoggedMinutes ?? false },
    );
  }

  @Post(':provider/tasks/:taskId/edit-sessions')
  @ApiOperation({
    summary: 'Open a bounded description-edit session from a fresh baseline read',
    description:
      'Read-only rendering never allocates a session. Unsupported baseline content fails closed with unsupported_content and no session is created.',
  })
  @ApiParam({ name: 'provider', enum: [...INTEGRATION_PROVIDER_IDS] })
  @ApiParam({ name: 'taskId', type: String })
  @ApiResponse({
    status: 201,
    description: 'The opened edit session pinned to the current connection generation',
    schema: EDIT_SESSION_RESPONSE_SCHEMA,
  })
  async createDescriptionSession(
    @Param('provider') providerValue: string,
    @Param('taskId') taskIdValue: string,
    @Query('projectId') projectIdValue: unknown,
  ): Promise<ExternalEditSessionView> {
    const { provider, taskId } = this.parseTaskPath(providerValue, taskIdValue);
    return this.editSessions.createDescriptionSession(
      this.parseProjectId(projectIdValue),
      provider,
      taskId,
    );
  }

  @Post(':provider/tasks/:taskId/comments/:commentId/delete-sessions')
  @ApiOperation({
    summary: 'Open an owner-validated comment-deletion session through a bounded lookup',
    description:
      'ClickUp lookups replay at most the producing page plus one provider-issued adjacent page. A comment that is missing or not authored by the current user creates no session.',
  })
  @ApiParam({ name: 'provider', enum: [...INTEGRATION_PROVIDER_IDS] })
  @ApiParam({ name: 'taskId', type: String })
  @ApiParam({ name: 'commentId', type: String })
  @ApiBody({ schema: DELETE_SESSION_INPUT_BODY_SCHEMA })
  @ApiResponse({
    status: 201,
    description: 'The opened deletion session; deletion itself is a separate gated action',
    schema: EDIT_SESSION_RESPONSE_SCHEMA,
  })
  async createCommentDeleteSession(
    @Param('provider') providerValue: string,
    @Param('taskId') taskIdValue: string,
    @Param('commentId') commentIdValue: string,
    @Body() body: unknown,
    @Query('projectId') projectIdValue: unknown,
  ): Promise<ExternalEditSessionView> {
    const { provider, taskId } = this.parseTaskPath(providerValue, taskIdValue);
    const input = parseOrThrow(deleteSessionInputSchema, body ?? {});
    return this.editSessions.createCommentDeleteSession(
      this.parseProjectId(projectIdValue),
      provider,
      taskId,
      parseOrThrow(remoteCommentIdSchema, commentIdValue),
      input.pageProof ?? null,
    );
  }

  @Post('edit-sessions/:sessionId/touch')
  @ApiOperation({
    summary: 'Keep a dirty editor session active without contacting the provider',
  })
  @ApiParam({ name: 'sessionId', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, schema: EDIT_SESSION_RESPONSE_SCHEMA })
  async touchSession(
    @Param('sessionId') sessionIdValue: string,
    @Query('projectId') projectIdValue: unknown,
  ): Promise<ExternalEditSessionView> {
    return this.editSessions.touchSession(
      this.parseProjectId(projectIdValue),
      parseOrThrow(sessionIdSchema, sessionIdValue),
    );
  }

  @Post('edit-sessions/:sessionId/verify')
  @ApiOperation({
    summary: 'Verify a session against a fresh remote read after an unknown outcome',
    description:
      'Seeing the new payload commits the save exactly once; seeing the old baseline never re-arms writes; other content reports divergence.',
  })
  @ApiParam({ name: 'sessionId', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, schema: EDIT_SESSION_VERIFY_RESPONSE_SCHEMA })
  async verifySession(
    @Param('sessionId') sessionIdValue: string,
    @Query('projectId') projectIdValue: unknown,
  ): Promise<ExternalSessionVerifyResult> {
    return this.editSessions.verifySession(
      this.parseProjectId(projectIdValue),
      parseOrThrow(sessionIdSchema, sessionIdValue),
    );
  }

  @Post('edit-sessions/:sessionId/save')
  @ApiOperation({
    summary: 'Save canonical rich content through a current editable session',
    description:
      'A fresh provider read, revision and metadata comparison, connection-generation check, and one vendor mutation run inside the shared provider operation gate; the gate is then released and a read-only post-write verification runs with generation rechecks on both sides. A verified save returns the new revision. A dispatched timeout, network loss, or 5xx classifies as outcome_unknown. Neither provider offers compare-and-swap, so a remote edit landing between the preflight and verification reads can remain undetectable; divergence detection narrows but does not eliminate that window.',
  })
  @ApiParam({ name: 'sessionId', type: String, format: 'uuid' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['document', 'revision'],
      properties: {
        document: { type: 'object' },
        revision: { type: 'integer', minimum: 0 },
      },
    },
  })
  @ApiResponse({ status: 200, schema: EDIT_SESSION_WRITE_RESPONSE_SCHEMA })
  async saveSession(
    @Param('sessionId') sessionIdValue: string,
    @Body() body: unknown,
    @Query('projectId') projectIdValue: unknown,
  ): Promise<ExternalSessionWriteOutcome> {
    const input = parseOrThrow(descriptionWriteSchema, body);
    return this.editSessions.saveSession(
      this.parseProjectId(projectIdValue),
      parseOrThrow(sessionIdSchema, sessionIdValue),
      input.document as ExternalRichDocumentV1,
      input.revision,
    );
  }

  @Post('edit-sessions/:sessionId/reload')
  @ApiOperation({
    summary: 'Reload an editable or diverged session baseline from a fresh provider read',
    description:
      'Reads the current remote content and replaces the baseline for an editable or diverged session. A successful reload clears a pending write, sets the session to editable, and advances the revision once. The service checks the project, provider, connection ID, and connection generation before and after the provider read. A changed connection invalidates the old session and rejects the reload with connection_superseded; the provider request is not canceled. Sessions with outcome_unknown or saved_unverified must Verify or retry the exact payload instead. The related delete-verification path returns diverged when the same connection check detects replacement. Neither provider offers compare-and-swap, so a remote edit can still land between reads.',
  })
  @ApiParam({ name: 'sessionId', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, schema: EDIT_SESSION_RELOAD_RESPONSE_SCHEMA })
  async reloadSession(
    @Param('sessionId') sessionIdValue: string,
    @Query('projectId') projectIdValue: unknown,
  ): Promise<ExternalSessionReloadResult> {
    return this.editSessions.reloadSession(
      this.parseProjectId(projectIdValue),
      parseOrThrow(sessionIdSchema, sessionIdValue),
    );
  }

  @Get(':provider/tasks/:taskId/rich-description')
  @ApiOperation({
    summary: 'Stateless canonical rich-description read (allocates no session)',
    description:
      'Returns the bounded canonical document when the provider payload parses inside the closed set, plus capability flags and a read-only reason otherwise. Only the explicit edit-session route creates a session.',
  })
  @ApiParam({ name: 'provider', enum: [...INTEGRATION_PROVIDER_IDS] })
  @ApiParam({ name: 'taskId', type: String })
  @ApiResponse({ status: 200, schema: RICH_DESCRIPTION_RESPONSE_SCHEMA })
  async readRichDescription(
    @Param('provider') providerValue: string,
    @Param('taskId') taskIdValue: string,
    @Query('projectId') projectIdValue: unknown,
  ): Promise<ExternalRichDescriptionRead> {
    const { provider, taskId } = this.parseTaskPath(providerValue, taskIdValue);
    return this.editSessions.readRichDescription(
      this.parseProjectId(projectIdValue),
      provider,
      taskId,
    );
  }

  @Post(':provider/tasks/:taskId/comments/:commentId/edit-sessions')
  @ApiOperation({
    summary: 'Open an owner-validated comment-edit session through a bounded lookup',
    description:
      'The comment must parse inside the closed canonical set and belong to the authenticated user. ClickUp callers pass the server-issued lookup token from the comment page; Jira uses its exact-comment endpoint.',
  })
  @ApiParam({ name: 'provider', enum: [...INTEGRATION_PROVIDER_IDS] })
  @ApiParam({ name: 'taskId', type: String })
  @ApiParam({ name: 'commentId', type: String })
  @ApiBody({ schema: COMMENT_EDIT_SESSION_INPUT_BODY_SCHEMA })
  @ApiResponse({
    status: 201,
    description: 'The opened comment-edit session pinned to the current connection generation',
    schema: EDIT_SESSION_RESPONSE_SCHEMA,
  })
  async createCommentEditSession(
    @Param('provider') providerValue: string,
    @Param('taskId') taskIdValue: string,
    @Param('commentId') commentIdValue: string,
    @Body() body: unknown,
    @Query('projectId') projectIdValue: unknown,
  ): Promise<ExternalEditSessionView> {
    const { provider, taskId } = this.parseTaskPath(providerValue, taskIdValue);
    const input = parseOrThrow(commentEditSessionInputSchema, body ?? {});
    return this.editSessions.createCommentEditSession(
      this.parseProjectId(projectIdValue),
      provider,
      taskId,
      parseOrThrow(remoteCommentIdSchema, commentIdValue),
      input.lookupToken ?? null,
    );
  }

  @Delete('edit-sessions/:sessionId')
  @ApiOperation({
    summary: 'Execute the owned comment deletion of a current session',
    description:
      'A later vendor 404 is treated as already deleted. Known rejections fail closed and invalidate the session.',
  })
  @ApiParam({ name: 'sessionId', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, schema: COMMENT_DELETE_RESPONSE_SCHEMA })
  async executeCommentDelete(
    @Param('sessionId') sessionIdValue: string,
    @Query('projectId') projectIdValue: unknown,
  ): Promise<ExternalCommentDeleteOutcome> {
    return this.editSessions.executeCommentDelete(
      this.parseProjectId(projectIdValue),
      parseOrThrow(sessionIdSchema, sessionIdValue),
    );
  }

  private parseTaskPath(
    providerValue: string,
    taskIdValue: string,
  ): { provider: IntegrationProvider; taskId: string } {
    return {
      provider: parseOrThrow(providerSchema, providerValue),
      taskId: parseOrThrow(remoteTaskIdSchema, taskIdValue),
    };
  }

  private parseProjectId(value: unknown): string {
    return parseOrThrow(projectIdSchema, value);
  }
}
