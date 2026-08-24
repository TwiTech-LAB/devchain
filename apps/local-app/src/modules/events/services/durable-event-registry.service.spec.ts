import { DurableEventRegistryService } from './durable-event-registry.service';

// Layer: backend unit. Registration identity and key isolation are in-memory
// contracts, so no Nest container or database is needed.
describe('DurableEventRegistryService', () => {
  it('registers multiple distinct keys and selects each matching delivery', () => {
    const registry = new DurableEventRegistryService();
    registry.register({
      deliveryKey: 'external-sync',
      eventNames: ['epic.created'],
      handle: async () => undefined,
    });
    registry.register({
      deliveryKey: 'time-accounting',
      eventNames: ['epic.created', 'epic.updated'],
      ordered: true,
      handle: async () => undefined,
    });

    expect(registry.deliveryKeysFor('epic.created')).toEqual(['external-sync', 'time-accounting']);
    expect(registry.deliveryKeysFor('epic.updated')).toEqual(['time-accounting']);
    expect(registry.getSubscriber('external-sync')).toMatchObject({ ordered: false });
    expect(registry.getSubscriber('time-accounting')).toMatchObject({ ordered: true });
  });

  it('rejects a duplicate normalized key', () => {
    const registry = new DurableEventRegistryService();
    registry.register({
      deliveryKey: 'time-accounting',
      eventNames: ['epic.created'],
      handle: async () => undefined,
    });

    expect(() =>
      registry.register({
        deliveryKey: ' time-accounting ',
        eventNames: ['epic.updated'],
        handle: async () => undefined,
      }),
    ).toThrow('already registered');
  });

  it('does not let a stale unregister remove a replacement registration', () => {
    const registry = new DurableEventRegistryService();
    const unregisterFirst = registry.register({
      deliveryKey: 'time-accounting',
      eventNames: ['epic.created'],
      handle: async () => undefined,
    });
    unregisterFirst();

    const replacement = {
      deliveryKey: 'time-accounting',
      eventNames: ['epic.updated'] as const,
      handle: async () => undefined,
    };
    registry.register(replacement);
    unregisterFirst();

    expect(registry.getSubscriber('time-accounting')).toMatchObject({
      eventNames: ['epic.updated'],
    });
  });
});
