/**
 * The pending Vault request store. Unit layer: the store is in memory, its timer is the
 * TTL and the published events are its contract, so fake timers and a recording
 * `EventsService` exercise every transition. Each published payload is parsed with the
 * catalog schema, as `EventsService.publish` would.
 */
jest.mock('../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

import { eventCatalog, type EventName } from '../events/catalog';
import type { EventsService } from '../events/services/events.service';
import {
  VAULT_REQUEST_TTL_MS,
  VaultRequestStore,
  type NewVaultRequest,
} from './vault-request.store';

describe('VaultRequestStore', () => {
  let published: Array<{ name: EventName; payload: Record<string, unknown> }>;
  let store: VaultRequestStore;

  const ask = (overrides: Partial<NewVaultRequest> = {}): NewVaultRequest => ({
    projectId: 'A',
    sessionId: 'session-1',
    agentId: 'agent-1',
    agentName: 'Coder',
    familySlug: 'coder',
    type: 'create',
    name: 'API_TOKEN',
    description: 'Token for the tracker',
    kind: 'secret',
    entryId: null,
    ...overrides,
  });
  const resolvedStatuses = () =>
    published
      .filter((event) => event.name === 'vault.request.resolved')
      .map((event) => [event.payload.name, event.payload.status]);

  beforeEach(() => {
    jest.useFakeTimers();
    published = [];
    const events = {
      publish: jest.fn(async (name: EventName, payload: Record<string, unknown>) => {
        eventCatalog[name].parse(payload);
        published.push({ name, payload });
        return 'event-id';
      }),
    } as unknown as EventsService;
    store = new VaultRequestStore(events);
  });

  afterEach(() => {
    store.onModuleDestroy();
    jest.useRealTimers();
  });

  it('keeps one pending request per session and name', async () => {
    const first = await store.add(ask());
    const again = await store.add(ask({ description: 'Asked twice' }));
    const otherName = await store.add(ask({ name: 'OTHER_KEY' }));
    const otherSession = await store.add(ask({ sessionId: 'session-2' }));

    expect([first.created, again.created, otherName.created, otherSession.created]).toEqual([
      true,
      false,
      true,
      true,
    ]);
    expect(again.request.requestId).toBe(first.request.requestId);
    expect(store.listBySession('session-1').map((request) => request.name)).toEqual([
      'API_TOKEN',
      'OTHER_KEY',
    ]);
    expect(published.filter((event) => event.name === 'vault.request.pending')).toHaveLength(3);
  });

  it('ends a request once when two surfaces answer it at the same time', async () => {
    const { request } = await store.add(ask());

    const answers = await Promise.allSettled([
      store.resolve(request.requestId, 'fulfilled'),
      store.resolve(request.requestId, 'denied'),
    ]);

    expect(answers.map((answer) => answer.status)).toEqual(['fulfilled', 'rejected']);
    expect((answers[1] as PromiseRejectedResult).reason).toMatchObject({
      statusCode: 409,
      details: { code: 'VAULT_REQUEST_NOT_PENDING' },
    });
    expect(resolvedStatuses()).toEqual([['API_TOKEN', 'fulfilled']]);
    // The ended request no longer blocks a new one for the same name.
    expect((await store.add(ask())).created).toBe(true);
  });

  it('keeps a request pending when its answer fails, and lets a racer fail fast meanwhile', async () => {
    const { request } = await store.add(ask());
    let failWork!: (error: Error) => void;
    const answering = store.resolve(request.requestId, 'fulfilled', {
      work: () => new Promise<void>((_resolve, reject) => (failWork = reject)),
    });

    await expect(store.resolve(request.requestId, 'denied')).rejects.toMatchObject({
      details: { code: 'VAULT_REQUEST_NOT_PENDING' },
    });
    failWork(new Error('vault locked'));
    await expect(answering).rejects.toThrow('vault locked');

    expect(store.get(request.requestId)).toEqual(request);
    expect(resolvedStatuses()).toEqual([]);
    await store.resolve(request.requestId, 'denied', { reason: 'Not now' });
    expect(published.at(-1)?.payload).toMatchObject({ status: 'denied', reason: 'Not now' });
  });

  it('lets an answer that is running finish before an expiry that comes meanwhile', async () => {
    const { request } = await store.add(ask());
    let finishWork!: () => void;
    const answering = store.resolve(request.requestId, 'fulfilled', {
      work: () => new Promise<void>((resolve) => (finishWork = resolve)),
    });

    await jest.advanceTimersByTimeAsync(VAULT_REQUEST_TTL_MS);
    expect(resolvedStatuses()).toEqual([]);
    finishWork();
    await answering;

    expect(resolvedStatuses()).toEqual([['API_TOKEN', 'fulfilled']]);
  });

  it('expires a request after its TTL, and an answer after that is a conflict', async () => {
    const { request } = await store.add(ask());

    await jest.advanceTimersByTimeAsync(VAULT_REQUEST_TTL_MS - 1);
    expect(store.get(request.requestId)).not.toBeNull();
    await jest.advanceTimersByTimeAsync(1);

    expect(store.get(request.requestId)).toBeNull();
    expect(resolvedStatuses()).toEqual([['API_TOKEN', 'expired']]);
    await expect(store.resolve(request.requestId, 'fulfilled')).rejects.toMatchObject({
      details: { code: 'VAULT_REQUEST_NOT_PENDING' },
    });
  });

  it('adopts a mirrored request again after its home timer expired early, never an answered one', async () => {
    // The VM set expiresAt from its own clock; behind home, home's timer fires first.
    const mirrored = Object.freeze({
      ...ask(),
      requestId: '00000000-0000-4000-8000-00000000cafe',
      createdAt: Date.now(),
      expiresAt: Date.now() - 5_000,
    });

    await store.syncRemote('remote-1', [mirrored], 1_000);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(store.get(mirrored.requestId)).toBeNull();
    expect(resolvedStatuses()).toEqual([['API_TOKEN', 'expired']]);

    // The VM still reports it as pending: the next poll must bring it back.
    await store.syncRemote('remote-1', [mirrored], 1_000);
    expect(store.get(mirrored.requestId)).not.toBeNull();
    expect(store.remoteOrigin(mirrored.requestId)).toBe('remote-1');

    // An answered request stays gone, even when a stale report still lists it.
    await store.resolve(mirrored.requestId, 'denied');
    await store.syncRemote('remote-1', [mirrored], 1_000);
    expect(store.get(mirrored.requestId)).toBeNull();
  });

  it('forgets the origins of answered requests when their remote is dropped', async () => {
    const mirrored = Object.freeze({
      ...ask(),
      requestId: '00000000-0000-4000-8000-00000000beef',
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });
    await store.syncRemote('remote-1', [mirrored], 1_000);
    await store.resolve(mirrored.requestId, 'fulfilled');
    expect(store.remoteOrigin(mirrored.requestId)).toBe('remote-1');

    await store.dropRemote('remote-1');

    expect(store.remoteOrigin(mirrored.requestId)).toBeNull();
  });

  it.each([
    [
      'stop',
      (s: VaultRequestStore) =>
        s.onSessionStopped({ sessionId: 'session-1', source: 'web-api', reason: 'user-requested' }),
    ],
    [
      'crash',
      (s: VaultRequestStore) =>
        s.onSessionCrashed({ sessionId: 'session-1', sessionName: 'coder' }),
    ],
  ])('expires the requests of a session at its %s and keeps the others', async (_label, end) => {
    await store.add(ask());
    await store.add(ask({ name: 'OTHER_KEY' }));
    const kept = await store.add(ask({ sessionId: 'session-2' }));

    await end(store);

    expect(resolvedStatuses()).toEqual([
      ['API_TOKEN', 'expired'],
      ['OTHER_KEY', 'expired'],
    ]);
    expect(store.listPending()).toEqual([kept.request]);
    // The timers of ended requests are gone: only the kept one expires later.
    await jest.advanceTimersByTimeAsync(VAULT_REQUEST_TTL_MS);
    expect(resolvedStatuses()).toHaveLength(3);
  });
});
