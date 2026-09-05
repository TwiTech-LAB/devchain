import { Body, Controller, Get, Headers, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { IntegrationAdmissionGuard } from '../../../common/guards/integration-admission.guard';
import { ValidationError } from '../../../common/errors/error-types';
import type { IntegrationProvider } from '../../storage/models/domain.models';
import { parseOrThrow as parseWithFallback } from '../../external-integrations/request-validation';
import {
  MAX_TIME_OPERATION_ID_LENGTH,
  TIME_OPERATION_ID_PATTERN,
} from '../../external-integrations/models/external-time-mutation.models';
import {
  INTEGRATION_PROVIDER_IDS,
  MAX_REMOTE_TASK_ID_LENGTH,
  ESTIMATE_LOG_STATE_RESPONSE_SCHEMA,
  ESTIMATE_LOG_STATE_SET_INPUT_BODY_SCHEMA,
  ESTIMATE_TIME_ENTRY_CREATE_INPUT_BODY_SCHEMA,
  ESTIMATE_TIME_ENTRY_CREATE_RESPONSE_SCHEMA,
  ESTIMATE_TIME_OPERATION_RESOLVE_INPUT_BODY_SCHEMA,
  ESTIMATE_TIME_OPERATION_RESOLVE_RESPONSE_SCHEMA,
} from '../../external-integrations/my-work/external-my-work.openapi';
import type {
  ExternalEstimateCreateTimeEntryResponse,
  ExternalEstimateLogStateView,
  ExternalEstimateLogSnapshot,
  ExternalEstimateResolveOperationResponse,
} from '../models/epic-time.models';
import { EpicEstimateLoggingService } from '../services/epic-estimate-logging.service';

const providerSchema = z.enum(INTEGRATION_PROVIDER_IDS);
const projectIdSchema = z.string().uuid('projectId must be a valid UUID.');
const scopeKeySchema = z.string().trim().min(1).max(256);
const remoteTaskIdSchema = z.string().trim().min(1).max(MAX_REMOTE_TASK_ID_LENGTH);
const stateQuerySchema = z
  .object({
    projectId: projectIdSchema,
    scopeKey: scopeKeySchema,
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
const operationIdPathSchema = z.string().trim().min(1).max(MAX_TIME_OPERATION_ID_LENGTH);
const timeZoneSchema = z.string().trim().min(1).max(128);
const nonnegativeIntegerSchema = z.number().int().min(0);
/** Ten years of dates; the bounded array keeps the JSON body comfortably
 * inside the configured Fastify body limit. */
const dailySnapshotSchema = z
  .array(
    z
      .object({
        activityDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid activity date'),
        minutes: nonnegativeIntegerSchema,
      })
      .strict(),
  )
  .max(3_660);
const createInputSchema = z
  .object({
    scopeKey: scopeKeySchema,
    requestKey: z.string().uuid('requestKey must be a fresh UUID.'),
    timeZone: timeZoneSchema,
    estimateTotalMinutes: nonnegativeIntegerSchema,
    expectedRevision: nonnegativeIntegerSchema,
    dailySnapshot: dailySnapshotSchema,
  })
  .strict();
const setInputSchema = z
  .object({
    scopeKey: scopeKeySchema,
    loggedMinutes: nonnegativeIntegerSchema,
    expectedRevision: nonnegativeIntegerSchema,
    timeZone: timeZoneSchema,
  })
  .strict();
const resolveInputSchema = z
  .object({
    scopeKey: scopeKeySchema,
    action: z.enum(['verify', 'logged', 'not_logged']),
    expectedRevision: nonnegativeIntegerSchema,
  })
  .strict();

function parseOrThrow<T, I>(schema: z.ZodType<T, z.ZodTypeDef, I>, value: unknown): T {
  return parseWithFallback(schema, value, 'Invalid estimate request.');
}

function toStateView(snapshot: ExternalEstimateLogSnapshot): ExternalEstimateLogStateView {
  const stored = snapshot.state;
  const pending = stored?.pendingOperationId
    ? {
        operationId: stored.pendingOperationId,
        deltaMinutes: stored.pendingDeltaMinutes,
        estimateTotalMinutes: stored.pendingEstimateTotalMinutes,
        startedAt: stored.pendingStartedAt,
        phase: stored.pendingPhase,
        resolution: stored.pendingResolution,
        activityDate: stored.pendingActivityDate,
      }
    : null;
  return {
    initialized: snapshot.initialized,
    revision: snapshot.revision,
    loggedMinutes: snapshot.loggedMinutes,
    aggregationTimeZone: snapshot.aggregationTimeZone,
    days: snapshot.days,
    unallocatedLoggedMinutes: snapshot.unallocatedLoggedMinutes,
    pendingDisposition: snapshot.pendingDisposition,
    canVerify: snapshot.canVerify,
    verifyExpiresAt: snapshot.verifyExpiresAt,
    pending,
  };
}

/** The route family lives under the external My Work prefix even though this
 * module owns the hosting, so clients see one integration surface while the
 * estimate orchestration stays main-runtime-only with EpicTimeModule. */
@ApiTags('integrations')
@Controller('api/integrations/my-work')
@UseGuards(IntegrationAdmissionGuard)
@ApiQuery({ name: 'projectId', required: true, type: String })
@ApiResponse({ status: 400, description: 'Invalid request, connection, or checkpoint state' })
@ApiResponse({ status: 403, description: 'Integration operations are unavailable in this runtime' })
@ApiResponse({ status: 404, description: 'The linked task or checkpoint was not found' })
@ApiResponse({
  status: 409,
  description: 'Epoch precondition, revision conflict, pending operation, or receipt mismatch',
})
export class ExternalEstimateLogController {
  constructor(private readonly estimateLogging: EpicEstimateLoggingService) {}

  @Get(':provider/tasks/:taskId/estimate-log-state')
  @ApiOperation({
    summary: 'Read the durable incremental-estimate checkpoint of a linked remote task',
    description:
      'Intentional state-mutating read: an exact pending provider receipt may settle exactly once through tuple checks and compare-and-swap updates before the state returns. Requires the X-DevChain-Connection-Epoch header, validated before state or provider access.',
  })
  @ApiParam({ name: 'provider', enum: [...INTEGRATION_PROVIDER_IDS] })
  @ApiParam({ name: 'taskId', type: String })
  @ApiQuery({ name: 'scopeKey', required: true, type: String })
  @ApiResponse({
    status: 200,
    description:
      'Checkpoint state with a derived disposition and the durable pending operation when one exists',
    schema: ESTIMATE_LOG_STATE_RESPONSE_SCHEMA,
  })
  async getEstimateLogState(
    @Param('provider') providerValue: string,
    @Param('taskId') taskIdValue: string,
    @Headers('x-devchain-connection-epoch') epochValue: unknown,
    @Query() queryValue: unknown,
  ): Promise<ExternalEstimateLogStateView> {
    const { provider, taskId } = this.parseTaskPath(providerValue, taskIdValue);
    const query = parseOrThrow(stateQuerySchema, queryValue);
    const epoch = parseOrThrow(connectionEpochHeaderSchema, String(epochValue ?? ''));
    return toStateView(
      await this.estimateLogging.getState({
        projectId: query.projectId,
        provider,
        remoteScopeKey: query.scopeKey,
        remoteTaskId: taskId,
        expectedEpoch: epoch,
      }),
    );
  }

  @Put(':provider/tasks/:taskId/estimate-log-state')
  @ApiOperation({
    summary: 'Set the logged estimate checkpoint for bootstrap and correction',
    description:
      'Records DevChain submissions and explicit user assumptions. Requires the X-DevChain-Connection-Epoch header and the stored revision.',
  })
  @ApiParam({ name: 'provider', enum: [...INTEGRATION_PROVIDER_IDS] })
  @ApiParam({ name: 'taskId', type: String })
  @ApiBody({ schema: ESTIMATE_LOG_STATE_SET_INPUT_BODY_SCHEMA })
  @ApiResponse({ status: 200, schema: ESTIMATE_LOG_STATE_RESPONSE_SCHEMA })
  async setLoggedEstimate(
    @Param('provider') providerValue: string,
    @Param('taskId') taskIdValue: string,
    @Headers('x-devchain-connection-epoch') epochValue: unknown,
    @Body() body: unknown,
    @Query('projectId') projectIdValue: unknown,
  ): Promise<ExternalEstimateLogStateView> {
    const { provider, taskId } = this.parseTaskPath(providerValue, taskIdValue);
    const epoch = parseOrThrow(connectionEpochHeaderSchema, String(epochValue ?? ''));
    const input = parseOrThrow(setInputSchema, body);
    return toStateView(
      await this.estimateLogging.setLoggedMinutes({
        projectId: this.parseProjectId(projectIdValue),
        provider,
        remoteScopeKey: input.scopeKey,
        remoteTaskId: taskId,
        expectedEpoch: epoch,
        loggedMinutes: input.loggedMinutes,
        expectedRevision: input.expectedRevision,
        timeZone: input.timeZone,
      }),
    );
  }

  @Post(':provider/tasks/:taskId/estimate-time-entries')
  @ApiOperation({
    summary: 'Log only the unlogged dated estimate delta in bounded sequential entries',
    description:
      'Requires the X-DevChain-Connection-Epoch precondition header and an Idempotency-Key equal to the body requestKey (one fresh browser UUID per click). Durable state is prepared before each provider entry and settled before the next; at most 10 entries are written per request; a dispatched unknown outcome is never retried automatically and resolves through the estimate resolve route.',
  })
  @ApiParam({ name: 'provider', enum: [...INTEGRATION_PROVIDER_IDS] })
  @ApiParam({ name: 'taskId', type: String })
  @ApiBody({ schema: ESTIMATE_TIME_ENTRY_CREATE_INPUT_BODY_SCHEMA })
  @ApiResponse({
    status: 200,
    description:
      'Bounded dated settlement: logged, partially_logged after a durable prefix, or a receipt-bound unknown outcome',
    schema: ESTIMATE_TIME_ENTRY_CREATE_RESPONSE_SCHEMA,
  })
  @ApiResponse({ status: 400, description: 'Invalid input or unsupported checkpoint state' })
  @ApiResponse({
    status: 409,
    description: 'Epoch precondition, revision conflict, idempotency conflict, or busy gate',
  })
  async createEstimateTimeEntry(
    @Param('provider') providerValue: string,
    @Param('taskId') taskIdValue: string,
    @Headers('x-devchain-connection-epoch') epochValue: unknown,
    @Headers('idempotency-key') idempotencyKeyValue: unknown,
    @Body() body: unknown,
    @Query('projectId') projectIdValue: unknown,
  ): Promise<ExternalEstimateCreateTimeEntryResponse> {
    const { provider, taskId } = this.parseTaskPath(providerValue, taskIdValue);
    const epoch = parseOrThrow(connectionEpochHeaderSchema, String(epochValue ?? ''));
    const input = parseOrThrow(createInputSchema, body);
    const idempotencyKey = parseOrThrow(
      idempotencyKeyHeaderSchema,
      String(idempotencyKeyValue ?? ''),
    );
    if (idempotencyKey.toLowerCase() !== input.requestKey.toLowerCase()) {
      throw new ValidationError('The idempotency key must match the request key.', {
        field: 'idempotency-key',
      });
    }
    const result = await this.estimateLogging.createTimeEntry({
      projectId: this.parseProjectId(projectIdValue),
      provider,
      remoteScopeKey: input.scopeKey,
      remoteTaskId: taskId,
      expectedEpoch: epoch,
      requestKey: input.requestKey,
      timeZone: input.timeZone,
      estimateTotalMinutes: input.estimateTotalMinutes,
      expectedRevision: input.expectedRevision,
      dailySnapshot: input.dailySnapshot,
    });
    return {
      outcome: result.outcome,
      entriesLogged: result.entriesLogged,
      minutesLogged: result.minutesLogged,
      hasMore: result.hasMore,
      stoppedReason: result.stoppedReason,
      state: toStateView(result.snapshot),
    };
  }

  @Post(':provider/tasks/:taskId/estimate-time-operations/:operationId/resolve')
  @ApiOperation({
    summary: 'Verify or explicitly resolve the pending estimate operation',
    description:
      'Requires the X-DevChain-Connection-Epoch precondition header and an Idempotency-Key matching the resolved operation id. Verify needs the pending connection epoch; Mark logged and Mark not logged stay available after receipt loss or connection replacement.',
  })
  @ApiParam({ name: 'provider', enum: [...INTEGRATION_PROVIDER_IDS] })
  @ApiParam({ name: 'taskId', type: String })
  @ApiParam({ name: 'operationId', type: String })
  @ApiBody({ schema: ESTIMATE_TIME_OPERATION_RESOLVE_INPUT_BODY_SCHEMA })
  @ApiResponse({
    status: 200,
    description: 'Applied resolution or an unresolved outcome with the current checkpoint state',
    schema: ESTIMATE_TIME_OPERATION_RESOLVE_RESPONSE_SCHEMA,
  })
  @ApiResponse({ status: 404, description: 'The pending estimate operation was not found' })
  @ApiResponse({
    status: 409,
    description: 'Epoch precondition, revision conflict, busy operation, or receipt mismatch',
  })
  async resolveEstimateOperation(
    @Param('provider') providerValue: string,
    @Param('taskId') taskIdValue: string,
    @Param('operationId') operationIdValue: string,
    @Headers('x-devchain-connection-epoch') epochValue: unknown,
    @Headers('idempotency-key') idempotencyKeyValue: unknown,
    @Body() body: unknown,
    @Query('projectId') projectIdValue: unknown,
  ): Promise<ExternalEstimateResolveOperationResponse> {
    const { provider, taskId } = this.parseTaskPath(providerValue, taskIdValue);
    const operationId = parseOrThrow(operationIdPathSchema, operationIdValue);
    const epoch = parseOrThrow(connectionEpochHeaderSchema, String(epochValue ?? ''));
    const idempotencyKey = parseOrThrow(
      idempotencyKeyHeaderSchema,
      String(idempotencyKeyValue ?? ''),
    );
    if (idempotencyKey !== operationId) {
      throw new ValidationError('The idempotency key must match the resolved operation id.', {
        field: 'idempotency-key',
      });
    }
    const input = parseOrThrow(resolveInputSchema, body);
    const result = await this.estimateLogging.resolveOperation({
      projectId: this.parseProjectId(projectIdValue),
      provider,
      remoteScopeKey: input.scopeKey,
      remoteTaskId: taskId,
      expectedEpoch: epoch,
      operationId,
      action: input.action,
      expectedRevision: input.expectedRevision,
    });
    return { outcome: result.outcome, state: toStateView(result.snapshot) };
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
