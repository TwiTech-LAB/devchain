import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Readable } from 'node:stream';
import {
  TranscriptFilesService,
  assertTranscriptSize,
} from '../transcripts/transcript-files.service';
import { TranscriptFileSchema } from '../transcripts/transcript-transfer.dto';
import { hostRoutes } from '../contract/host-routes';
import type { HostHandlerResponse } from '../contract/host-routes';

@ApiTags('Host transcripts')
@Controller('api/host/transcripts')
export class HostTranscriptsController {
  constructor(private readonly files: TranscriptFilesService) {}

  @Post('list')
  @HttpCode(200)
  @ApiOperation({ summary: 'List recorded transcript files' })
  @ApiResponse({ status: 200 })
  list(
    @Body() body: unknown,
  ): Promise<HostHandlerResponse<typeof hostRoutes.listTranscripts, 200>> {
    return this.files.list(hostRoutes.listTranscripts.body.parse(body).refs);
  }

  @Get()
  @ApiOperation({ summary: 'Stream a transcript file' })
  @ApiResponse({ status: 200 })
  async read(@Query() query: unknown, @Res() reply: FastifyReply): Promise<void> {
    const { stream, size } = await this.files.read(TranscriptFileSchema.parse(query));
    reply.header('Content-Length', size).type('application/octet-stream').send(stream);
  }

  @Put()
  @HttpCode(204)
  @ApiOperation({ summary: 'Atomically receive a transcript file' })
  @ApiResponse({ status: 204 })
  async write(@Query() query: unknown, @Req() request: FastifyRequest): Promise<void> {
    const file = TranscriptFileSchema.parse(query);
    const length = request.headers['content-length'];
    if (typeof length !== 'string' || !/^\d+$/.test(length))
      throw new BadRequestException('Content-Length is required');
    const size = Number(length);
    assertTranscriptSize(size);
    if (!(request.body instanceof Readable))
      throw new BadRequestException('application/octet-stream is required');
    await this.files.write(file, request.body, size);
  }
}
