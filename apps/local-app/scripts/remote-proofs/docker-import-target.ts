// The VM side of docker-import.external.spec.ts: the product `api/host/docker`
// routes and the runtime Docker report, without the rest of DevChain, so a
// second instance never shares the installed service's Syncthing or database.
// Setup and cleanup: docker-import-external.md.
import 'reflect-metadata';
import { Controller, Get, Module, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';
import { createSecureContext } from 'node:tls';
import { AllExceptionsFilter } from '../../src/common/filters/http-exception.filter';
import { DockerArchiveJournal } from '../../src/modules/core/controllers/docker-archive-journal';
import { readDockerRuntime } from '../../src/modules/core/controllers/docker-runtime';
import { HostDockerController } from '../../src/modules/remotes/host/host-docker.controller';
import { HostDockerService } from '../../src/modules/remotes/host/host-docker.service';
import { HostDockerBodyParser } from '../../src/modules/remotes/host/host-docker-body.parser';
import { HostDockerRecoveryService } from '../../src/modules/remotes/host/host-docker-recovery.service';
import { HostTranscriptBodyParser } from '../../src/modules/remotes/host/host-transcript-body.parser';
import { installTlsFront } from '../../src/modules/remotes/host/host-tls-front';

/** The `/api/runtime` fields the Docker plan reads, computed as runtime.controller.ts does. */
@Controller('api/runtime')
class TargetRuntimeController {
  @Get()
  async runtime() {
    return {
      homePath: homedir(),
      uid: process.getuid?.() ?? null,
      gid: process.getgid?.() ?? null,
      docker: await readDockerRuntime(),
    };
  }
}

@Module({
  controllers: [HostDockerController, TargetRuntimeController],
  providers: [
    HostDockerService,
    HostDockerBodyParser,
    HostTranscriptBodyParser,
    HostDockerRecoveryService,
    { provide: DockerArchiveJournal, useFactory: () => new DockerArchiveJournal() },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
class TargetModule {}

async function main(): Promise<void> {
  const port = Number(process.env.PORT);
  const keyFile = process.env.TLS_KEY_FILE;
  const certFile = process.env.TLS_CERT_FILE;
  if (!process.env.DB_PATH || !Number.isInteger(port) || !keyFile || !certFile)
    throw new Error('DB_PATH, PORT, TLS_KEY_FILE and TLS_CERT_FILE are required');
  // Same adapter options as main.ts, so body limits and timeouts are the product's.
  const app = await NestFactory.create<NestFastifyApplication>(
    TargetModule,
    new FastifyAdapter({ logger: false }),
    { logger: ['error', 'warn'] },
  );
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.enableShutdownHooks();
  installTlsFront(app.getHttpServer(), {
    secureContext: createSecureContext({
      key: readFileSync(keyFile),
      cert: readFileSync(certFile),
    }),
  });
  await app.listen(port, '0.0.0.0');
  process.stdout.write(`docker-import-target listening on ${port}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'start failed'}\n`);
  process.exit(1);
});
