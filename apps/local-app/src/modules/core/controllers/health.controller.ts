import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { getEnvConfig } from '../../../common/config/env.config';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

// Try to read version from root package.json (devchain-cli)
function getVersion(): string {
  try {
    // Try multiple possible locations for root package.json
    const possiblePaths = [
      // From dist/server/modules/core/controllers -> root (5 levels up)
      join(__dirname, '..', '..', '..', '..', '..', 'package.json'),
      // From apps/local-app/src/modules/core/controllers -> root (dev mode, 6 levels up)
      join(__dirname, '..', '..', '..', '..', '..', '..', 'package.json'),
      // From cwd (usually repo root)
      join(process.cwd(), 'package.json'),
    ];

    for (const pkgPath of possiblePaths) {
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        // Only use if it's the root devchain-cli package
        if (pkg.name === 'devchain-cli' && pkg.version) {
          return pkg.version;
        }
      }
    }
  } catch {
    // Ignore errors
  }
  return 'unknown';
}

@ApiTags('health')
@Controller('health')
export class HealthController {
  @Get()
  @ApiOperation({ summary: 'Health check endpoint' })
  @ApiResponse({ status: 200, description: 'Service is healthy' })
  check() {
    const config = getEnvConfig();
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      environment: config.NODE_ENV,
      version: getVersion(),
    };
  }
}
