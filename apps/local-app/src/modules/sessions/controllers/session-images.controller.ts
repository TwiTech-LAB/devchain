import {
  BadRequestException,
  Controller,
  Param,
  Post,
  Query,
  Req,
  Res,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { ApiConsumes, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { requestAbortSignal } from '../../../common/http/request-abort-signal';
import type { SessionImageReceipt } from '../../runtime-directory/session-image-store.service';
import { SessionImageUploadService } from '../services/session-image-upload.service';

const targetSchema = z.object({ sessionId: z.string().uuid(), projectId: z.string().uuid() });

@ApiTags('Sessions')
@Controller('api/sessions')
export class SessionImagesController {
  constructor(private readonly images: SessionImageUploadService) {}

  @Post(':id/attachments')
  @ApiOperation({ summary: 'Stage a copied image for a live project agent session' })
  @ApiConsumes('application/octet-stream')
  @ApiResponse({ status: 201, description: 'Session-scoped image reference' })
  async upload(
    @Param('id') sessionId: string,
    @Query('projectId') projectId: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SessionImageReceipt> {
    if (!targetSchema.safeParse({ sessionId, projectId }).success) {
      throw new BadRequestException('A valid project and session are required');
    }
    if (
      !(request.body instanceof Readable) ||
      request.headers['content-type']?.split(';')[0].trim().toLowerCase() !==
        'application/octet-stream'
    ) {
      throw new UnsupportedMediaTypeException('Expected application/octet-stream');
    }
    const header = request.headers['content-length'];
    if (header !== undefined && !/^\d+$/.test(header))
      throw new BadRequestException('Invalid Content-Length');
    return this.images.upload(
      projectId,
      sessionId,
      request.body,
      header === undefined ? undefined : Number(header),
      requestAbortSignal(request, reply),
    );
  }
}
