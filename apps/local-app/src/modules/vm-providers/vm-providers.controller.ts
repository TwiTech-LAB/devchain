import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { z } from 'zod';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CreateVmProviderConnectionSchema } from './vm-provider.dto';
import { VmProvidersService, type PublicVmProviderConnection } from './vm-providers.service';
import { ConnectProxmoxRequestSchema } from './proxmox/connection-string';
import { generateProxmoxSetupBlock, ProxmoxSetupBlockQuerySchema } from './proxmox/setup-block';

const IdSchema = z.string().uuid();

@ApiTags('vm-providers')
@Controller('api/vm-providers')
export class VmProvidersController {
  constructor(private readonly providers: VmProvidersService) {}

  @Get('proxmox/setup-block')
  @ApiOperation({ summary: 'Generate the Proxmox root-shell onboarding block' })
  @ApiQuery({
    name: 'address',
    required: false,
    description: 'Proxmox host name or IP used as the setup block default for PVE_HOST.',
  })
  @ApiResponse({ status: 200, description: 'One copy-paste shell block' })
  @ApiResponse({ status: 400, description: 'Invalid setup-block input' })
  setupBlock(@Query() query: unknown): { block: string } {
    return { block: generateProxmoxSetupBlock(ProxmoxSetupBlockQuerySchema.parse(query)) };
  }

  @Post('proxmox/connect')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Preview or confirm a Proxmox connection string' })
  @ApiResponse({
    status: 200,
    description: 'Fingerprint confirmation or saved connection and permission check',
  })
  connect(@Body() body: unknown) {
    const request = ConnectProxmoxRequestSchema.parse(body);
    return this.providers.connectFromString(
      request.connectionString,
      request.confirmFingerprint === true,
    );
  }

  @Get()
  @ApiOperation({ summary: 'List VM provider connections and address capabilities' })
  @ApiResponse({ status: 200, description: 'Connections without token secrets' })
  async list(): Promise<{
    items: PublicVmProviderConnection[];
    address: {
      kind: 'address';
      capabilities: { create: false; destroy: false; powerState: false };
    };
  }> {
    return {
      items: await this.providers.listConnections(),
      address: {
        kind: 'address',
        capabilities: { create: false, destroy: false, powerState: false },
      },
    };
  }

  @Post()
  @ApiOperation({ summary: 'Save an encrypted Proxmox connection' })
  @ApiResponse({ status: 201, description: 'Connection without token secret' })
  create(@Body() body: unknown): Promise<PublicVmProviderConnection> {
    return this.providers.createConnection(CreateVmProviderConnectionSchema.parse(body));
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete an unused VM provider connection' })
  @ApiResponse({ status: 200, description: 'Connection deleted' })
  delete(@Param('id') id: string): Promise<void> {
    return this.providers.deleteConnection(IdSchema.parse(id));
  }

  @Post(':id/check')
  @ApiOperation({ summary: 'Check Proxmox connection permissions' })
  @ApiResponse({ status: 201, description: 'Missing privileges by name' })
  check(@Param('id') id: string): Promise<{ ok: boolean; missing: string[] }> {
    return this.providers.checkPermissions(IdSchema.parse(id));
  }
}
