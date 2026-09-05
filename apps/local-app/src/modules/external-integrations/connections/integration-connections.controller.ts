import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { ValidationError } from '../../../common/errors/error-types';
import { IntegrationAdmissionGuard } from '../../../common/guards/integration-admission.guard';
import { INTEGRATION_PROVIDER_IDS } from '../../storage/models/domain.models';
import { parseOrThrow as parseWithFallback } from '../request-validation';
import {
  IntegrationConnectionsService,
  type IntegrationConnectionDirectory,
  type IntegrationConnectionState,
  type ReplaceConnectionInput,
} from './integration-connections.service';

const projectIdSchema = z.string().uuid('projectId must be a valid UUID.');
const connectionIdSchema = z.string().uuid('connectionId must be a valid UUID.');
const tokenSchema = z.string().trim().min(1, 'API token is required.').max(4096);
const replaceConnectionSchema = z.discriminatedUnion('provider', [
  z
    .object({
      projectId: projectIdSchema,
      provider: z.literal('clickup'),
      token: tokenSchema,
      subtaskSyncEnabled: z.boolean().optional(),
      acknowledgeOrphanRisk: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      projectId: projectIdSchema,
      provider: z.literal('jira'),
      token: tokenSchema,
      siteUrl: z.string().trim().url('Enter a valid Jira site URL.').max(2048).optional(),
      email: z.string().trim().email('Enter a valid account email.').max(320).optional(),
      subtaskSyncEnabled: z.boolean().optional(),
      acknowledgeOrphanRisk: z.boolean().optional(),
    })
    .strict(),
]);
const providerSchema = z.enum(INTEGRATION_PROVIDER_IDS);
const syncSettingsSchema = z
  .object({ projectId: projectIdSchema, subtaskSyncEnabled: z.boolean() })
  .strict();
const disconnectQuerySchema = z
  .object({
    projectId: projectIdSchema,
    acknowledgeOrphanRisk: z
      .union([z.literal('true'), z.undefined()])
      .transform((value) => value === 'true'),
  })
  .strict();
const legacyAssignmentSchema = z.object({ projectId: projectIdSchema }).strict();
const legacyDisconnectQuerySchema = z
  .object({
    acknowledgeOrphanRisk: z
      .union([z.literal('true'), z.undefined()])
      .transform((value) => value === 'true'),
  })
  .strict();
function parseOrThrow<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): T {
  return parseWithFallback(schema, value, 'Invalid integration connection request.');
}

function parseReplacement(value: unknown): ReplaceConnectionInput {
  const parsed = parseOrThrow(replaceConnectionSchema, value);
  if (parsed.provider === 'jira') {
    if (parsed.siteUrl && !parsed.email) {
      throw new ValidationError('Account email is required when changing the Jira site URL.', {
        field: 'email',
      });
    }
    if (parsed.email && !parsed.siteUrl) {
      throw new ValidationError('Jira site URL is required when changing the account email.', {
        field: 'siteUrl',
      });
    }
  }
  return parsed;
}

@Controller('api/integrations/connections')
@UseGuards(IntegrationAdmissionGuard)
export class IntegrationConnectionsController {
  constructor(private readonly connections: IntegrationConnectionsService) {}

  @Get('directory')
  listDirectory(): Promise<IntegrationConnectionDirectory> {
    return this.connections.listDirectory();
  }

  @Get()
  listConnections(@Query('projectId') projectId?: string): Promise<{
    items: IntegrationConnectionState[];
  }> {
    return this.connections.listConnections(parseOrThrow(projectIdSchema, projectId));
  }

  @Put()
  async replaceConnection(@Body() body: unknown): Promise<IntegrationConnectionState> {
    return this.connections.replaceConnection(parseReplacement(body));
  }

  @Post('legacy/:connectionId/assign')
  async assignLegacyConnection(
    @Param('connectionId') connectionId: string,
    @Body() body: unknown,
  ): Promise<IntegrationConnectionState> {
    const parsed = parseOrThrow(legacyAssignmentSchema, body);
    return this.connections.assignLegacyConnection(
      parseOrThrow(connectionIdSchema, connectionId),
      parsed.projectId,
    );
  }

  @Delete('legacy/:connectionId')
  async disconnectLegacyConnection(
    @Param('connectionId') connectionId: string,
    @Query() query: unknown,
  ): Promise<IntegrationConnectionState> {
    const parsed = parseOrThrow(legacyDisconnectQuerySchema, query);
    return this.connections.disconnectLegacyConnection(
      parseOrThrow(connectionIdSchema, connectionId),
      parsed.acknowledgeOrphanRisk,
    );
  }

  @Delete(':provider')
  async disconnectConnection(
    @Param('provider') provider: string,
    @Query() query: unknown,
  ): Promise<IntegrationConnectionState> {
    const parsedQuery = parseOrThrow(disconnectQuerySchema, query);
    return this.connections.disconnectConnection(
      parsedQuery.projectId,
      parseOrThrow(providerSchema, provider),
      parsedQuery.acknowledgeOrphanRisk,
    );
  }

  @Patch(':provider/settings')
  async updateSyncSettings(
    @Param('provider') provider: string,
    @Body() body: unknown,
  ): Promise<IntegrationConnectionState> {
    const parsed = parseOrThrow(syncSettingsSchema, body);
    return this.connections.updateSyncSettings(
      parsed.projectId,
      parseOrThrow(providerSchema, provider),
      { subtaskSyncEnabled: parsed.subtaskSyncEnabled },
    );
  }
}
