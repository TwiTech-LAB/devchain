import type { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { Server, ServerOptions } from 'socket.io';
import { HostApiKeyService } from './host-api-key.service';

export class HostApiKeyIoAdapter extends IoAdapter {
  constructor(
    app: INestApplicationContext,
    private readonly keys: HostApiKeyService,
  ) {
    super(app);
  }

  createIOServer(port: number, options?: Partial<ServerOptions>): Server {
    return super.createIOServer(port, {
      ...options,
      allowRequest: (request, callback) => {
        const refusal = this.keys.allows(request, 'socket');
        if (refusal) {
          callback(refusal.code, false);
        } else if (options?.allowRequest) {
          options.allowRequest(request, callback);
        } else {
          callback(null, true);
        }
      },
    } satisfies Partial<ServerOptions>);
  }
}
