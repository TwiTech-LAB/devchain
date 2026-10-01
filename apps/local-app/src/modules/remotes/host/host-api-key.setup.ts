import type { INestApplication } from '@nestjs/common';
import { HostApiKeyService } from './host-api-key.service';
import { HostApiKeyIoAdapter } from './host-api-key-io.adapter';

/**
 * Registers the WebSocket half of the host API key boundary. The HTTP half is
 * installed by HostApiKeyModule. Production startup and the two-instance test
 * fixture both call this function, so a passing fixture proves the production
 * wiring instead of a parallel one built only for tests.
 */
export function registerHostApiKeyBoundary(app: INestApplication): void {
  app.useWebSocketAdapter(new HostApiKeyIoAdapter(app, app.get(HostApiKeyService)));
}
