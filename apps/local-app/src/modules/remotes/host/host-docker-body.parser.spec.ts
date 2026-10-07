import { HttpAdapterHost } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Readable } from 'node:stream';
import { HostDockerBodyParser } from './host-docker-body.parser';

// Exercise the parser Fastify registers directly: app.inject buffers stream
// fixtures before dispatch, so it cannot prove the parser's backpressure.
it('passes more than 1 GiB through the tar parser without a cap or whole-body buffering', async () => {
  const adapter = new FastifyAdapter({ bodyLimit: 1024 });
  const host = new HttpAdapterHost();
  host.httpAdapter = adapter;
  const register = jest.spyOn(adapter.getInstance(), 'addContentTypeParser');
  new HostDockerBodyParser(host).onModuleInit();
  const app = adapter.getInstance();
  const total = 1024 ** 3 + 1;
  const block = Buffer.alloc(64 * 1024);
  let produced = 0;
  let received = 0;
  let maximumAhead = 0;
  const body = new Readable({
    read() {
      if (produced === total) return void this.push(null);
      const size = Math.min(block.length, total - produced);
      produced += size;
      maximumAhead = Math.max(maximumAhead, produced - received);
      this.push(block.subarray(0, size));
    },
  });
  try {
    const parser = register.mock.calls.find(([type]) => type === 'application/x-tar')?.[1] as
      | ((
          request: unknown,
          payload: Readable,
          done: (error: Error | null, value: unknown) => void,
        ) => void)
      | undefined;
    let parsed: unknown;
    parser!({}, body, (error, value) => {
      expect(error).toBeNull();
      parsed = value;
    });
    expect(parsed).toBe(body);
    expect(produced).toBe(0);
    for await (const chunk of parsed as Readable) received += chunk.length;
    expect(received).toBe(total);
    expect(maximumAhead).toBeLessThan(32 * 1024 * 1024);
  } finally {
    register.mockRestore();
    await app.close();
  }
});
