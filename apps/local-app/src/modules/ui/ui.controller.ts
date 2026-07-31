import { Controller, Get, Inject, Req, Res } from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { selectUiAsset } from '../../common/http/runtime-route-classification';
import { sendAllowlistedFile } from '../../common/http/send-allowlisted-file';
import { hasUiBuild } from './ui-root';
import { UI_ASSET_PATHS, UI_ASSET_SERVING_ENABLED, UI_ROOT } from './ui.tokens';

const SPA_FILE_ALLOWLIST = new Set(['index.html']);

@Controller()
export class UiController {
  constructor(
    @Inject(UI_ROOT) private readonly uiRoot: string,
    @Inject(UI_ASSET_PATHS) private readonly uiAssetPaths: ReadonlySet<string>,
    @Inject(UI_ASSET_SERVING_ENABLED) private readonly assetServingEnabled: boolean,
  ) {}

  /**
   * Serve the SPA for all non-API routes (SPA fallback).
   * API paths (/api/...) are never served as HTML — return 404 so clients
   * get a proper JSON error instead of the SPA shell.
   */
  @Get('*')
  serveSpa(@Req() req: FastifyRequest, @Res() res: FastifyReply): void {
    const pathname = req.raw.url?.split('?')[0] ?? req.url.split('?')[0];
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      res.code(404).send({ statusCode: 404, message: 'Not Found' });
      return;
    }

    const assetPath = selectUiAsset(pathname);
    if (assetPath !== undefined && !this.assetServingEnabled) {
      res.code(404).send();
      return;
    }

    if (!hasUiBuild(this.uiRoot)) {
      res.code(503).send({
        statusCode: 503,
        message: 'UI not built. Run `pnpm --filter local-app build` first.',
      });
      return;
    }

    if (assetPath === null) {
      res.code(404).send();
      return;
    }

    sendAllowlistedFile(req, res, {
      root: this.uiRoot,
      encodedRelativePath: assetPath ?? 'index.html',
      allowedRelativePaths: assetPath === undefined ? SPA_FILE_ALLOWLIST : this.uiAssetPaths,
    });
  }
}
