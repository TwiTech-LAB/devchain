import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { FastifyInstance } from 'fastify';
import getSwaggerUiAbsolutePath from 'swagger-ui-dist/absolute-path';
import { sendAllowlistedFile } from './send-allowlisted-file';

const SWAGGER_ROUTE = '/api/docs';
const SWAGGER_ASSETS = [
  'swagger-ui.css',
  'swagger-ui-bundle.js',
  'swagger-ui-standalone-preset.js',
  'favicon-32x32.png',
] as const;
const SWAGGER_ASSET_ALLOWLIST = new Set<string>(SWAGGER_ASSETS);

const SWAGGER_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Devchain Local App API</title>
    <link rel="icon" type="image/png" href="/api/docs/favicon-32x32.png" />
    <link rel="stylesheet" href="/api/docs/swagger-ui.css" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="/api/docs/swagger-ui-bundle.js"></script>
    <script src="/api/docs/swagger-ui-standalone-preset.js"></script>
    <script>
      window.onload = function () {
        window.ui = SwaggerUIBundle({
          url: '/api/docs-json',
          dom_id: '#swagger-ui',
          deepLinking: true,
          presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
          layout: 'StandaloneLayout'
        });
      };
    </script>
  </body>
</html>`;

export function configureSwagger(app: NestFastifyApplication): void {
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Devchain Local App API')
    .setDescription('Local-first AI agent orchestration API')
    .setVersion('0.1.0')
    .addTag('health', 'Health check endpoints')
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document, { swaggerUiEnabled: false });

  registerSwaggerUiRoutes(app.getHttpAdapter().getInstance() as unknown as FastifyInstance);
}

function registerSwaggerUiRoutes(fastify: FastifyInstance): void {
  const swaggerRoot = getSwaggerUiAbsolutePath();

  fastify.get(SWAGGER_ROUTE, (_request, reply) => {
    reply.type('text/html; charset=utf-8').send(SWAGGER_HTML);
  });
  fastify.get(`${SWAGGER_ROUTE}/`, (_request, reply) => {
    reply.type('text/html; charset=utf-8').send(SWAGGER_HTML);
  });

  for (const asset of SWAGGER_ASSETS) {
    fastify.get(`${SWAGGER_ROUTE}/${asset}`, (request, reply) => {
      sendAllowlistedFile(request, reply, {
        root: swaggerRoot,
        encodedRelativePath: asset,
        allowedRelativePaths: SWAGGER_ASSET_ALLOWLIST,
      });
    });
  }
}
