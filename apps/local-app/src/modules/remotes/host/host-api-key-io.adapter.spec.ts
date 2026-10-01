import { IoAdapter } from '@nestjs/platform-socket.io';
import type { INestApplicationContext } from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import type { ServerOptions } from 'socket.io';
import { HostApiKeyIoAdapter } from './host-api-key-io.adapter';
import type { HostApiKeyService } from './host-api-key.service';

// Capturing the options at the base adapter isolates option preservation and callback composition.
describe('HostApiKeyIoAdapter', () => {
  afterEach(() => jest.restoreAllMocks());

  it('preserves server options and applies admission before an existing allowRequest', () => {
    const base = jest.spyOn(IoAdapter.prototype, 'createIOServer').mockReturnValue({});
    const allows = jest.fn().mockReturnValue(false);
    const existing = jest.fn();
    const adapter = new HostApiKeyIoAdapter(
      {} as INestApplicationContext,
      { allows } as unknown as HostApiKeyService,
    );
    adapter.createIOServer(0, {
      path: '/socket.io',
      pingTimeout: 1234,
      cors: { origin: true },
      allowRequest: existing,
    });
    const options = base.mock.calls[0][1] as Partial<ServerOptions>;
    expect(options).toMatchObject({
      path: '/socket.io',
      pingTimeout: 1234,
      cors: { origin: true },
    });
    const callback = jest.fn();
    const request = {} as IncomingMessage;
    options.allowRequest!(request, callback);
    expect(callback).toHaveBeenCalledWith('HOST_API_KEY_REJECTED', false);
    expect(existing).not.toHaveBeenCalled();
    allows.mockReturnValue(true);
    options.allowRequest!(request, callback);
    expect(existing).toHaveBeenCalledWith(request, callback);
  });
});
