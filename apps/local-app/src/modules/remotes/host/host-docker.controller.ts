import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiConsumes, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { AppError } from '../../../common/errors/error-types';
import { requestAbortSignal } from '../../../common/http/request-abort-signal';
import { DockerEngineError, dockerErrorCode } from '../../core/controllers/docker-engine.client';
import { HostDockerService } from './host-docker.service';
import {
  DOCKER_API_VERSION_HEADER,
  DOCKER_ARCHIVE_SHA256_TRAILER,
  DockerArchiveRequestSchema,
  DockerBindPrepareSchema,
  DockerCapacityRequestSchema,
  DockerScanRequestSchema,
  DockerContainerCreateSchema,
  DockerIdsSchema,
  DockerNetworkCreateSchema,
  DockerOwnerSchema,
  DockerResourceIdSchema,
  DockerVolumeCreateSchema,
} from './host-docker.dto';

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestException('Invalid Docker request fields');
  return result.data;
}
function bodyStream(request: FastifyRequest): Readable {
  if (!(request.body instanceof Readable))
    throw new BadRequestException('A tar or binary stream is required');
  return request.body;
}

/** LAN-only host boundary. Settings carry Env; neither payloads nor raw engine failures are logged. */
@ApiTags('Host Docker')
@Controller('api/host/docker')
export class HostDockerController {
  constructor(private readonly docker: HostDockerService) {}

  @Get('version')
  @ApiOperation({ summary: 'Return engine API range for negotiation before import' })
  @ApiResponse({ status: 200 })
  version(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    return this.run(req, reply, (signal) => this.docker.version(signal));
  }

  @Post('scan')
  @HttpCode(200)
  @ApiOperation({ summary: 'Read projected Docker resources and bind-source existence' })
  @ApiResponse({ status: 200 })
  scan(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { paths, volumes } = parse(DockerScanRequestSchema, body);
    return this.run(req, reply, (signal, apiVersion) =>
      this.docker.scan(paths, signal, apiVersion, volumes),
    );
  }

  @Post('capacity')
  @HttpCode(200)
  @ApiOperation({ summary: 'Sample target filesystems for destinations under VM home' })
  @ApiResponse({ status: 200 })
  capacity(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { paths } = parse(DockerCapacityRequestSchema, body);
    return this.run(req, reply, (signal) => this.docker.capacity(paths, signal));
  }

  @Post('images/present')
  @HttpCode(200)
  @ApiOperation({ summary: 'Return image IDs already present on this engine' })
  @ApiResponse({ status: 200 })
  images(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const input = parse(DockerIdsSchema, body);
    return this.run(req, reply, (signal, apiVersion) =>
      this.docker.imagesPresent(input.ids, signal, apiVersion),
    );
  }
  @Post('images/load')
  @HttpCode(200)
  @ApiConsumes('application/x-tar', 'application/octet-stream')
  @ApiOperation({ summary: 'Stream an image archive into the engine and report each loaded image' })
  @ApiResponse({
    status: 200,
    description: 'The engine-assigned ID and RootFS layers of each loaded image',
  })
  load(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    return this.run(req, reply, (signal, apiVersion) =>
      this.docker.loadImage(bodyStream(req), signal, apiVersion),
    );
  }
  @Get('images/:id/archive')
  @ApiOperation({ summary: 'Stream a saved image archive' })
  @ApiResponse({ status: 200 })
  save(@Param('id') id: string, @Req() req: FastifyRequest, @Res() reply: FastifyReply) {
    parse(DockerResourceIdSchema, id);
    return this.run(req, reply, async (signal, apiVersion) => {
      reply.type('application/x-tar').send(await this.docker.saveImage(id, signal, apiVersion));
    });
  }
  @Post('volumes')
  @ApiOperation({
    summary: 'Create or reuse a project-owned volume; refuse unowned same-name volumes',
  })
  @ApiResponse({ status: 201 })
  @ApiResponse({ status: 409 })
  volume(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const input = parse(DockerVolumeCreateSchema, body);
    return this.run(req, reply, (signal, apiVersion) =>
      this.docker.createVolume(input, signal, apiVersion),
    );
  }
  @Post('networks')
  @ApiOperation({ summary: 'Create a project-owned bridge network' })
  @ApiResponse({ status: 201 })
  network(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const input = parse(DockerNetworkCreateSchema, body);
    return this.run(req, reply, (signal, apiVersion) =>
      this.docker.createNetwork(input, signal, apiVersion),
    );
  }
  @Post('containers')
  @ApiOperation({ summary: 'Create a stopped project container from reviewed settings' })
  @ApiResponse({ status: 201 })
  container(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const input = parse(DockerContainerCreateSchema, body);
    return this.run(req, reply, (signal, apiVersion) =>
      this.docker.createContainer(input, signal, apiVersion),
    );
  }
  @Get('volumes/:id/holders')
  @ApiOperation({ summary: 'List all containers holding a volume, including unrelated holders' })
  @ApiResponse({ status: 200 })
  holders(
    @Param('id') id: string,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    parse(DockerResourceIdSchema, id);
    return this.run(req, reply, (signal, apiVersion) =>
      this.docker.holders(id, signal, apiVersion),
    );
  }
  @Delete(':kind/:id')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Delete a project-owned resource, or a proven imported Compose volume holder',
  })
  @ApiResponse({ status: 204 })
  @ApiResponse({ status: 403 })
  remove(
    @Param('kind') kind: string,
    @Param('id') id: string,
    @Query() query: unknown,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const resourceKind = parse(z.enum(['volumes', 'containers', 'networks']), kind);
    parse(DockerResourceIdSchema, id);
    const { projectId } = parse(DockerOwnerSchema, query);
    return this.run(req, reply, (signal, apiVersion) =>
      this.docker.remove(resourceKind, id, projectId, signal, apiVersion),
    );
  }
  @Get('archive')
  @ApiOperation({ summary: 'Read project data through a never-started helper' })
  @ApiResponse({
    status: 200,
    description: `The tar stream; the ${DOCKER_ARCHIVE_SHA256_TRAILER} trailer carries its sha256`,
  })
  read(@Query() query: unknown, @Req() req: FastifyRequest, @Res() reply: FastifyReply) {
    const input = parse(DockerArchiveRequestSchema, query);
    return this.run(req, reply, async (signal, apiVersion) => {
      const archive = await this.docker.readArchive(input, signal, apiVersion);
      // Fastify ends a piped stream reply before its trailers are added, so the raw
      // response carries them. A failed transfer ends without the trailer.
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        'Content-Type': 'application/x-tar',
        Trailer: DOCKER_ARCHIVE_SHA256_TRAILER,
      });
      const hash = createHash('sha256');
      const hashing = new Transform({
        transform: (chunk: Buffer, _encoding, callback) => {
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      try {
        await pipeline(archive, hashing, res, { end: false });
        res.addTrailers({ [DOCKER_ARCHIVE_SHA256_TRAILER]: hash.digest('hex') });
        res.end();
      } catch {
        archive.destroy();
        res.destroy();
      }
    });
  }
  @Post('containers/:id/stop')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Stop a project container, or a Compose container of an imported project',
  })
  @ApiResponse({ status: 204 })
  @ApiResponse({ status: 403 })
  stopContainer(
    @Param('id') id: string,
    @Query() query: unknown,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    parse(DockerResourceIdSchema, id);
    const { projectId } = parse(DockerOwnerSchema, query);
    return this.run(req, reply, (signal, apiVersion) =>
      this.docker.stopContainer(id, projectId, signal, apiVersion),
    );
  }
  @Put('archive')
  @HttpCode(200)
  @ApiConsumes('application/x-tar')
  @ApiOperation({ summary: 'Restore project data under VM home or into a project-owned volume' })
  @ApiResponse({ status: 200, description: 'sha256 and size of the archive bytes received' })
  @ApiResponse({ status: 403 })
  write(
    @Query() query: unknown,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const input = parse(DockerArchiveRequestSchema, query);
    return this.run(req, reply, (signal, apiVersion) =>
      this.docker.writeArchive(input, bodyStream(req), signal, apiVersion),
    );
  }
  @Post('binds')
  @HttpCode(204)
  @ApiOperation({ summary: 'Create bind destinations under VM home, optionally emptied first' })
  @ApiResponse({ status: 204 })
  @ApiResponse({ status: 403 })
  binds(
    @Body() body: unknown,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const input = parse(DockerBindPrepareSchema, body);
    return this.run(req, reply, (signal, apiVersion) =>
      this.docker.prepareBinds(input, signal, apiVersion),
    );
  }
  @Post('projects/:projectId/stop')
  @HttpCode(200)
  @ApiOperation({ summary: "Stop the project's DevChain-labelled containers" })
  @ApiResponse({ status: 200 })
  stopProject(
    @Param('projectId') projectId: string,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const id = parse(DockerOwnerSchema, { projectId }).projectId;
    return this.run(req, reply, (signal, apiVersion) =>
      this.docker.stopProject(id, signal, apiVersion),
    );
  }
  @Post('probe')
  @HttpCode(204)
  @ApiConsumes('application/x-tar', 'application/octet-stream')
  @ApiOperation({ summary: 'Discard a streamed bandwidth probe without storage' })
  @ApiResponse({ status: 204 })
  probe(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    return this.run(req, reply, async () => {
      for await (const chunk of bodyStream(req)) {
        void chunk;
      }
    });
  }

  private async run<T>(
    req: FastifyRequest,
    reply: FastifyReply,
    action: (signal: AbortSignal, apiVersion?: string) => Promise<T>,
  ): Promise<T> {
    const apiVersion = parse(
      z
        .string()
        .regex(/^\d+\.\d+$/)
        .optional(),
      req.headers[DOCKER_API_VERSION_HEADER],
    );
    const signal = requestAbortSignal(req, reply);
    try {
      return await action(signal, apiVersion);
    } catch (error) {
      if (error instanceof AppError || error instanceof BadRequestException) throw error;
      if (error instanceof DockerEngineError) {
        const status =
          {
            'cannot-move': 400,
            unsupported: 400,
            'not-found': 404,
            conflict: 409,
            cancelled: 499,
            'engine-error': 502,
            'incompatible-api': 400,
            'invalid-response': 502,
            unavailable: 503,
          }[error.code] ?? 502;
        throw new AppError(error.message, dockerErrorCode(error.code), status);
      }
      throw new AppError('Docker host operation failed', 'DOCKER_HOST_ERROR', 502);
    }
  }
}
