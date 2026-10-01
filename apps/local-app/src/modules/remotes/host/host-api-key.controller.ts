import { BadRequestException, Body, Controller, Req, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import { HostApiKeyService } from './host-api-key.service';

const RotationSchema = z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

@ApiTags('host')
@Controller('api/host/api-key')
export class HostApiKeyController {
  constructor(private readonly keys: HostApiKeyService) {}

  @Post()
  @HttpCode(204)
  @ApiOperation({ summary: 'Replace the host API key digest using the current key' })
  @ApiResponse({ status: 204, description: 'Host API key replaced' })
  @ApiResponse({ status: 401, description: 'HOST_API_KEY_REJECTED' })
  rotate(@Req() request: FastifyRequest, @Body() body: unknown): void {
    const parsed = RotationSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Expected a lowercase SHA-256 digest');
    this.keys.rotate(request.raw, parsed.data.sha256);
  }
}
