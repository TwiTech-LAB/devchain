import { Controller, Get, Res } from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';

@Controller()
export class UiController {
  /**
   * Serve the SPA for all non-API routes (SPA fallback)
   */
  @Get('*')
  async serveSpa(@Res() res: FastifyReply): Promise<void> {
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
