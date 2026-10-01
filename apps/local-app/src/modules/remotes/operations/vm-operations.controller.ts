import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import type { RemoteOperation } from '../../storage/models/domain.models';
import { CreateVmSchema, DestroyVmSchema, ResetVmSchema } from './vm-operations.dto';
import { VmOperationsService } from './vm-operations.service';

const IdSchema = z.string().uuid();

@ApiTags('vm-operations')
@Controller('api')
export class VmOperationsController {
  constructor(private readonly operations: VmOperationsService) {}

  @Post('vm-providers/:id/create-vm')
  @HttpCode(202)
  @ApiOperation({ summary: 'Create and claim a VM from the configured host image' })
  @ApiResponse({ status: 202, description: 'Persisted VM create operation' })
  create(@Param('id') id: string, @Body() body: unknown): Promise<RemoteOperation> {
    return this.operations.create(IdSchema.parse(id), CreateVmSchema.parse(body));
  }

  @Post('remotes/:id/reset')
  @HttpCode(202)
  @ApiOperation({ summary: 'Reset a managed VM and reconnect its projects' })
  @ApiResponse({ status: 202, description: 'Persisted VM reset operation' })
  reset(@Param('id') id: string, @Body() body: unknown): Promise<RemoteOperation> {
    return this.operations.reset(IdSchema.parse(id), ResetVmSchema.parse(body ?? {}));
  }

  @Post('remotes/:id/power-on')
  @HttpCode(200)
  @ApiOperation({ summary: 'Start a stopped managed VM' })
  @ApiResponse({ status: 200, description: 'The VM runs; DevChain on it may still be booting' })
  @ApiResponse({ status: 409, description: 'Not a managed VM, or a host operation is open' })
  powerOn(@Param('id') id: string): Promise<{ powerState: 'running' }> {
    return this.operations.powerOn(IdSchema.parse(id));
  }

  @Post('remotes/:id/destroy-vm')
  @HttpCode(202)
  @ApiOperation({ summary: 'Destroy a managed VM and remove its remote registration' })
  @ApiResponse({ status: 202, description: 'Persisted VM destroy operation' })
  destroy(@Param('id') id: string, @Body() body: unknown): Promise<RemoteOperation> {
    return this.operations.destroy(IdSchema.parse(id), DestroyVmSchema.parse(body ?? {}));
  }
}
