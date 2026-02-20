import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ValidationPipe } from '@nestjs/common';
import { getEnvConfig } from './common/config/env.config';
import { logger, createLogger } from './common/logging/logger';
import { join } from 'path';
import { existsSync } from 'fs';

async function bootstrap() {
  const mode = process.env.DEVCHAIN_MODE === 'main' ? 'main' : 'normal';
  const RootModule =
    mode === 'main'
      ? (await import('./app.main.module')).MainAppModule
      : (await import('./app.normal.module')).NormalAppModule;

  const config = getEnvConfig();
  const appLogger = createLogger('Bootstrap');

  // Configure logger levels based on LOG_LEVEL environment variable
  // Maps Pino log levels (used in env config) to NestJS log levels
  const logLevel = process.env.LOG_LEVEL?.toLowerCase() || 'info';
  const logLevels: Array<'error' | 'warn' | 'log' | 'debug' | 'verbose'> | false = (() => {
    switch (logLevel) {
      case 'silent':
      case 'fatal':
        return false; // Disable all logging
      case 'error':
        return ['error'];
      case 'warn':
        return ['error', 'warn'];
      case 'info':
      case 'log':
        return ['error', 'warn', 'log'];
      case 'debug':
        return ['error', 'warn', 'log', 'debug'];
      case 'trace':
      case 'verbose':
        return ['error', 'warn', 'log', 'debug', 'verbose'];
      default:
        return ['error', 'warn', 'log'];
    }
  })();

  // Configure Fastify logger based on LOG_LEVEL
  // When LOG_LEVEL is 'error', disable Fastify logging entirely for clean output
  const fastifyLogger =
    logLevel === 'error'
      ? false
      : {
          level: logLevel === 'warn' ? 'warn' : logLevel === 'debug' ? 'debug' : 'info',
        };

  const app = await NestFactory.create<NestFastifyApplication>(
    RootModule,
    new FastifyAdapter({
      logger: fastifyLogger,
      requestIdLogLabel: 'requestId',
      disableRequestLogging: logLevel === 'error', // Disable request logging in error-only mode
    }),
    {
      logger: logLevels,
    },
  );

  // Register static file serving for SPA assets (production mode only).
  const uiPath = join(__dirname, 'ui');
  const isProduction = config.NODE_ENV === 'production';

  if (isProduction && existsSync(uiPath)) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    await app.register(require('@fastify/static'), {
      root: uiPath,
      prefix: '/',
      decorateReply: false, // Don't override sendFile
      wildcard: false, // Don't create wildcard route - UiController handles SPA fallback
    });
    appLogger.info({ mode, path: uiPath }, 'Static UI assets registered');
  } else if (!isProduction) {
    appLogger.info('Development mode: UI served by Vite dev server at http://127.0.0.1:5175');
  } else {
    appLogger.warn('UI build not found. Run `pnpm --filter local-app build:ui`.');
  }

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Handle graceful shutdown - run OnModuleDestroy hooks before exit
  let isShuttingDown = false;
  const gracefulShutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    appLogger.info({ signal }, 'Received shutdown signal, starting graceful shutdown...');
    try {
      await app.close();
      appLogger.info('Graceful shutdown complete');
    } catch (error) {
      appLogger.error({ error }, 'Error during graceful shutdown');
    }
    process.exit(0);
  };

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

  // Swagger/OpenAPI documentation
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Devchain Local App API')
    .setDescription('Local-first AI agent orchestration API')
    .setVersion('0.1.0')
    .addTag('health', 'Health check endpoints')
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);

  // Bind to localhost only for security
  await app.listen(config.PORT, config.HOST);

  // Resolve actual port (may differ from config.PORT when PORT=0 for OS-assigned ports)
  const serverAddress = app.getHttpServer().address();
  const actualPort =
    serverAddress && typeof serverAddress === 'object' ? serverAddress.port : config.PORT;

  // Write runtime port file for parent process discovery (worktree process runtime)
  if (config.RUNTIME_PORT_FILE) {
    const { writeFileSync, mkdirSync } = await import('fs');
    const { dirname } = await import('path');
    try {
      mkdirSync(dirname(config.RUNTIME_PORT_FILE), { recursive: true });
      writeFileSync(
        config.RUNTIME_PORT_FILE,
        JSON.stringify({ port: actualPort, runtimeToken: config.RUNTIME_TOKEN ?? null }),
      );
      appLogger.info(
        { portFile: config.RUNTIME_PORT_FILE, actualPort },
        'Runtime port file written',
      );
    } catch (error) {
      appLogger.error(
        { error, portFile: config.RUNTIME_PORT_FILE },
        'Failed to write runtime port file',
      );
    }
  }

  appLogger.info(
    {
      mode,
      port: actualPort,
      host: config.HOST,
      env: config.NODE_ENV,
    },
    `Application is running on: http://${config.HOST}:${actualPort}`,
  );
  appLogger.info(`API Documentation: http://${config.HOST}:${actualPort}/api/docs`);
}

bootstrap().catch((error) => {
  logger.fatal(error, 'Failed to start application');
  process.exit(1);
});
