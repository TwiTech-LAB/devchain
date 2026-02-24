import { Controller, Get, Req, Res } from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';

@Controller()
export class UiController {
  /**
   * Serve the SPA for all non-API routes (SPA fallback).
   * API paths (/api/...) are never served as HTML — return 404 so clients
   * get a proper JSON error instead of the SPA shell.
   */
  @Get('*')
  async serveSpa(@Req() req: FastifyRequest, @Res() res: FastifyReply): Promise<void> {
    const pathname = req.url.split('?')[0];
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      res.code(404).send({ statusCode: 404, message: 'Not Found' });
      return;
    }

    // Prefer production build path next to compiled server code
    const candidates = [
      // When running compiled code: dist/modules/ui/../../ui → dist/ui
      join(__dirname, '../../ui'),
      // When running TS tests: src/modules/ui/../../../dist/ui → dist/ui
      join(__dirname, '../../../dist/ui'),
    ];

    let indexPath: string | null = null;
    for (const base of candidates) {
      const candidate = join(base, 'index.html');
      if (existsSync(candidate)) {
        indexPath = candidate;
        break;
      }
    }

    // Check if UI build exists
    if (!indexPath) {
      res.code(503).send({
        statusCode: 503,
        message: 'UI not built. Run `pnpm --filter local-app build` first.',
      });
      return;
    }

    // Read and send index.html for SPA routing
    const html = readFileSync(indexPath, 'utf-8');
    res.type('text/html').send(html);
  }
}
