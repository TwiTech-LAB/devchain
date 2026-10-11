import { Injectable } from '@nestjs/common';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { EVENT_LISTENER_METADATA } from '@nestjs/event-emitter/dist/constants';
import { Test } from '@nestjs/testing';
import type { EventPayload } from './index';
import { OnCatalogEvent } from './on-catalog-event';
import type { CatalogEventOptions } from './on-catalog-event';

const options = {
  async: true,
  promisify: true,
  prependListener: true,
  suppressErrors: false,
} satisfies CatalogEventOptions;

@Injectable()
class CatalogListeners {
  @OnCatalogEvent('session.started')
  synchronous(payload: EventPayload<'session.started'>): string {
    return payload.sessionId;
  }

  @OnCatalogEvent('session.started', options)
  async asynchronous(payload: EventPayload<'session.started'>): Promise<string> {
    return payload.projectId;
  }

  @OnCatalogEvent('session.started')
  noArguments(): string {
    return 'no arguments';
  }

  @OnCatalogEvent('session.crashed', options)
  async failure(payload: EventPayload<'session.crashed'>): Promise<void> {
    throw new Error(payload.sessionName);
  }
}

export class InvalidCatalogListeners {
  // @ts-expect-error Unknown names cannot be registered as catalog events.
  @OnCatalogEvent('session.unknown')
  unknownEvent(): void {}

  // @ts-expect-error A stopped event cannot satisfy a number payload.
  @OnCatalogEvent('session.stopped')
  incompatiblePayload(payload: number): number {
    return payload;
  }

  // @ts-expect-error The catalog does not supply the required imaginary field.
  @OnCatalogEvent('session.started')
  extraRequiredField(payload: EventPayload<'session.started'> & { imaginary: string }): string {
    return payload.imaginary;
  }
}

// A real Nest module is the cheapest layer that exercises listener discovery and registration.
describe('OnCatalogEvent', () => {
  it('delegates metadata and listener options unchanged and registers every supported handler', async () => {
    const module = await Test.createTestingModule({
      imports: [EventEmitterModule.forRoot()],
      providers: [CatalogListeners],
    }).compile();
    const emitter = module.get(EventEmitter2);
    const prepend = jest.spyOn(emitter, 'prependListener');
    const payload: EventPayload<'session.started'> = {
      sessionId: 'session',
      projectId: 'project',
      agentId: 'agent',
      epicId: null,
      tmuxSessionName: 'tmux',
    };
    try {
      await module.init();
      const metadata: unknown = Reflect.getMetadata(
        EVENT_LISTENER_METADATA,
        CatalogListeners.prototype.asynchronous,
      );
      expect(metadata).toEqual([{ event: 'session.started', options }]);
      expect(prepend).toHaveBeenCalledWith('session.started', expect.any(Function), options);
      expect(prepend.mock.calls.find(([name]) => name === 'session.started')?.[2]).toBe(options);
      await expect(emitter.emitAsync('session.started', payload)).resolves.toEqual([
        'project',
        'session',
        'no arguments',
      ]);
      await expect(
        emitter.emitAsync('session.crashed', { sessionId: 'session', sessionName: 'failure' }),
      ).rejects.toThrow('failure');
    } finally {
      prepend.mockRestore();
      await module.close();
    }
  });
});
