import { Body, Controller, Delete, Get, Param, Patch, Put, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { ValidationError } from '../../../common/errors/error-types';
import { IntegrationAdmissionGuard } from '../../../common/guards/integration-admission.guard';
import { INTEGRATION_PROVIDER_IDS } from '../../storage/models/domain.models';
import { parseOrThrow as parseWithFallback } from '../request-validation';
import {
  IntegrationConnectionsService,
  type IntegrationConnectionState,
  type ReplaceConnectionInput,
} from './integration-connections.service';

const tokenSchema = z.string().trim().min(1, 'API token is required.').max(4096);
const replaceConnectionSchema = z.discriminatedUnion('provider', [
  z
    .object({
      provider: z.literal('clickup'),
      token: tokenSchema,
      subtaskSyncEnabled: z.boolean().optional(),
      acknowledgeOrphanRisk: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
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
const syncSettingsSchema = z.object({ subtaskSyncEnabled: z.boolean() }).strict();
const orphanRiskAcknowledgementSchema = z
  .union([z.literal('true'), z.undefined()])
  .transform((value) => value === 'true');

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

  @Get()
  listConnections(): Promise<{ items: IntegrationConnectionState[] }> {
    return this.connections.listConnections();
  }

  @Put()
  async replaceConnection(@Body() body: unknown): Promise<IntegrationConnectionState> {
    return this.connections.replaceConnection(parseReplacement(body));
  }

  @Delete(':provider')
  async disconnectConnection(
    @Param('provider') provider: string,
    @Query('acknowledgeOrphanRisk') acknowledgeOrphanRisk?: string,
  ): Promise<IntegrationConnectionState> {
    return this.connections.disconnectConnection(
      parseOrThrow(providerSchema, provider),
      parseOrThrow(orphanRiskAcknowledgementSchema, acknowledgeOrphanRisk),
    );
  }

  @Patch(':provider/settings')
  async updateSyncSettings(
    @Param('provider') provider: string,
    @Body() body: unknown,
  ): Promise<IntegrationConnectionState> {
    return this.connections.updateSyncSettings(
      parseOrThrow(providerSchema, provider),
      parseOrThrow(syncSettingsSchema, body),
    );
  }
}
