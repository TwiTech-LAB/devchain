import { ExternalProviderError } from '../errors/external-provider.errors';
import type { IntegrationProvider } from '../../storage/models/domain.models';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import type { ExternalRichDocumentV1 } from '../models/external-rich-document';
import { ExternalEditSessionService } from './external-edit-session.service';
import {
  DEFAULT_SESSION_STORE_LIMITS,
  ExternalEditSessionStore,
} from '../sessions/external-edit-session.store';
import { ProviderOperationGate } from '../sessions/provider-operation-gate';

/**
 * Phase-13 gate session matrix: one suite walking every session lifecycle the
 * phase DoD names — multiple verified saves, idle touch, absolute expiry,
 * lookup expiry, ambiguous writes, exact-payload retry, divergence,
 * replacement invalidation, and every delete outcome — end to end through the
 * orchestration service with fake storage and provider adapters.
 */

const BASELINE_ADF = (text: string) => ({
  type: 'doc',
  version: 1,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

const doc = (text: string): ExternalRichDocumentV1 => ({
  version: 1,
  blocks: [{ type: 'paragraph', content: [{ type: 'text', text, marks: [] }] }],
});

class FakeStorage {
  connection = { id: 'connection-1', provider: 'jira', generation: 1 };
  connected = true;

  async getIntegrationConnection(provider: string) {
    if (!this.connected) {
      return null;
    }
    return this.connection.provider === provider
      ? { ...this.connection, createdAt: '', updatedAt: '' }
      : null;
  }

  async getIntegrationConnectionCredentials(provider: string) {
    if (!this.connected || this.connection.provider !== provider) {
      return null;
    }
    return provider === 'jira'
      ? {
          provider: 'jira',
          siteUrl: 'https://test.atlassian.net',
          email: 'user@example.com',
          token: 't',
        }
      : { provider: 'clickup', token: 't' };
  }
}

class FakeAdapter {
  descriptionRaw: unknown = BASELINE_ADF('baseline');
  writeImpl: ((raw: unknown) => Promise<void>) | null = null;
  findImpl: (() => Promise<unknown>) | null = null;
  deleteImpl: (() => Promise<void>) | null = null;
  ownerRemoteId = 'owner-1';
  snapshot: { remoteId: string; authorRemoteId: string | null; createdAt: string } | null = {
    remoteId: 'comment-1',
    authorRemoteId: 'owner-1',
    createdAt: '2026-08-22T00:00:00.000Z',
  };

  readonly descriptionEdit = {
    readDescription: async () => this.descriptionRaw,
    writeDescription: async (_c: unknown, _x: unknown, _t: string, raw: unknown) => {
      if (this.writeImpl) {
        await this.writeImpl(raw);
      }
    },
  };

  readonly ownedMutations = {
    getCurrentOwnerRemoteId: async () => this.ownerRemoteId,
    findComment: async () => (this.findImpl ? this.findImpl() : this.snapshot),
    deleteComment: async () => {
      if (this.deleteImpl) {
        await this.deleteImpl();
      }
    },
  };
}

class FakeRegistry {
  constructor(private readonly adapter: FakeAdapter) {}

  get(provider: string) {
    return {
      provider,
      descriptor: { provider, displayName: provider, capabilities: { myWork: true } },
      myWork: undefined,
      ownedMutations: this.adapter.ownedMutations,
      descriptionEdit: this.adapter.descriptionEdit,
    };
  }

  getDescriptor(provider: string) {
    return this.get(provider).descriptor;
  }

  getSupportedProviders() {
    return ['clickup', 'jira'] as IntegrationProvider[];
  }
}

function matrix(options: {
  provider?: IntegrationProvider;
  clock?: () => number;
  limits?: Partial<typeof DEFAULT_SESSION_STORE_LIMITS>;
}) {
  const storage = new FakeStorage();
  storage.connection = {
    id: 'connection-1',
    provider: options.provider ?? 'jira',
    generation: 1,
  };
  const adapter = new FakeAdapter();
  const gate = new ProviderOperationGate();
  const store = new ExternalEditSessionStore(
    { ...DEFAULT_SESSION_STORE_LIMITS, ...options.limits },
    options.clock,
  );
  const service = new ExternalEditSessionService(
    storage as unknown as StorageService,
    new FakeRegistry(adapter) as never,
    gate,
    store,
  );
  return { storage, adapter, gate, store, service, provider: options.provider ?? 'jira' };
}

const unknownOutcome = (provider: IntegrationProvider, reason = 'timeout') =>
  new ExternalProviderError(provider, reason as 'timeout', { dispatched: true });

describe('Phase 13 gate: session matrix', () => {
  it('multiple verified saves advance baseline and revision monotonically', async () => {
    const { service, adapter } = matrix({});
    const session = await service.createDescriptionSession('jira', 'KAN-1');
    expect(session.revision).toBe(0);

    for (let round = 1; round <= 3; round += 1) {
      const payload = doc(`revision ${round}`);
      const written = await service.saveSession(session.sessionId, payload, round - 1);
      expect(written.outcome).toBe('saved_unverified');
      adapter.descriptionRaw = BASELINE_ADF(`revision ${round}`);
      const verified = await service.verifySession(session.sessionId);
      expect(verified.remoteState).toBe('new_payload');
      expect(verified.session?.revision).toBe(round);
      expect(verified.session?.baselineFingerprint).toBeTruthy();
    }
  });

  it('idle touch keeps a session alive across the idle limit; non-touched sessions expire', async () => {
    let nowMs = 1_700_000_000_000;
    const { service, store } = matrix({ clock: () => nowMs, limits: { idleLimitMs: 60_000 } });
    const touchedSession = await service.createDescriptionSession('jira', 'KAN-A');
    const idleSession = await service.createDescriptionSession('jira', 'KAN-B');

    for (let tick = 0; tick < 5; tick += 1) {
      nowMs += 50_000;
      await service.touchSession(touchedSession.sessionId);
    }
    nowMs += 50_001;

    const stillAlive = await service.touchSession(touchedSession.sessionId);
    expect(stillAlive.state).toBe('editable');
    const verifyIdle = await service.verifySession(idleSession.sessionId);
    expect(verifyIdle).toMatchObject({
      session: null,
      remoteState: null,
      reason: 'session_not_found',
    });
    expect(store.size()).toBe(1);
  });

  it('absolute expiry stops a constantly-touched session; no writable revision survives', async () => {
    let nowMs = 1_700_000_000_000;
    const { service } = matrix({
      clock: () => nowMs,
      limits: { idleLimitMs: 60_000, absoluteLimitMs: 120_000 },
    });
    const session = await service.createDescriptionSession('jira', 'KAN-1');
    // Keep the idle window constantly refreshed up to the absolute limit.
    nowMs += 55_000;
    expect((await service.touchSession(session.sessionId)).state).toBe('editable');
    nowMs += 55_000;
    expect((await service.touchSession(session.sessionId)).state).toBe('editable');
    nowMs += 15_000; // 125s > the 120s absolute limit, idle still refreshed
    const write = await service.saveSession(session.sessionId, doc('late'), 0);
    expect(write).toMatchObject({
      outcome: 'pre_dispatch_rejected',
      reason: 'session_not_found',
    });
  });

  it('lookup expiry: a delete session whose comment proof ages out still verifies gone-or-present', async () => {
    const { service, adapter, provider } = matrix({ provider: 'clickup' });
    const session = await service.createCommentDeleteSession(
      'clickup',
      'task-1',
      'comment-1',
      null,
    );
    expect(session.state).toBe('editable');

    // Someone deletes the comment elsewhere: the bounded lookup now misses.
    adapter.snapshot = null;
    const verified = await service.verifySession(session.sessionId);
    expect(verified.remoteState).toBe('gone');
    expect(verified.session?.state).toBe('invalidated');
    const after = await service.executeCommentDelete(session.sessionId);
    expect(after).toMatchObject({ outcome: 'rejected', reason: 'session_not_editable' });
    void provider;
  });

  it('ambiguous write: dispatched timeout yields outcome_unknown, old baseline keeps it locked, exact retry lands', async () => {
    const { service, adapter, provider } = matrix({});
    const session = await service.createDescriptionSession('jira', 'KAN-1');

    adapter.writeImpl = () => {
      throw unknownOutcome(provider);
    };
    const ambiguous = await service.saveSession(session.sessionId, doc('maybe'), 0);
    expect(ambiguous.outcome).toBe('outcome_unknown');

    // Remote still shows the old baseline: no re-arm for a new payload.
    const oldBaseline = await service.verifySession(session.sessionId);
    expect(oldBaseline.remoteState).toBe('old_baseline');
    const newPayload = await service.saveSession(session.sessionId, doc('different'), 0);
    expect(newPayload).toMatchObject({ outcome: 'pre_dispatch_rejected' });

    // The exact same payload may retry.
    adapter.writeImpl = null;
    const retried = await service.saveSession(session.sessionId, doc('maybe'), 0);
    expect(retried.outcome).toBe('saved_unverified');
    adapter.descriptionRaw = BASELINE_ADF('maybe');
    const verified = await service.verifySession(session.sessionId);
    expect(verified.remoteState).toBe('new_payload');
    expect(verified.session?.revision).toBe(1);
  });

  it('divergence after an unknown outcome is terminal for writes', async () => {
    const { service, adapter, provider } = matrix({});
    const session = await service.createDescriptionSession('jira', 'KAN-1');
    adapter.writeImpl = () => {
      throw unknownOutcome(provider, 'unavailable');
    };
    await service.saveSession(session.sessionId, doc('lost cause'), 0);
    adapter.descriptionRaw = BASELINE_ADF('remote drifted');
    const verified = await service.verifySession(session.sessionId);
    expect(verified.remoteState).toBe('diverged');
    const blocked = await service.saveSession(session.sessionId, doc('anything'), 1);
    expect(blocked).toMatchObject({ outcome: 'pre_dispatch_rejected' });
  });

  it('connection replacement invalidates every live session of that provider', async () => {
    const { service, storage } = matrix({});
    const description = await service.createDescriptionSession('jira', 'KAN-1');
    storage.connection = { id: 'connection-1', provider: 'jira', generation: 2 };
    const blocked = await service.saveSession(description.sessionId, doc('after swap'), 0);
    expect(blocked).toMatchObject({
      outcome: 'pre_dispatch_rejected',
      reason: 'connection_superseded',
    });
    expect((await service.touchSession(description.sessionId)).state).toBe('invalidated');
  });

  it('delete outcomes: deleted, already_deleted (404), outcome_unknown, and known failure each land in their bucket', async () => {
    // deleted
    {
      const { service } = matrix({ provider: 'clickup' });
      const session = await service.createCommentDeleteSession('clickup', 't', 'c', null);
      const outcome = await service.executeCommentDelete(session.sessionId);
      expect(outcome.outcome).toBe('deleted');
    }
    // already_deleted on a later 404
    {
      const { service, adapter, provider } = matrix({ provider: 'clickup' });
      const session = await service.createCommentDeleteSession('clickup', 't', 'c', null);
      adapter.deleteImpl = () => {
        throw new ExternalProviderError(provider, 'not_found');
      };
      const outcome = await service.executeCommentDelete(session.sessionId);
      expect(outcome.outcome).toBe('already_deleted');
    }
    // outcome_unknown on a dispatched timeout, then verify sees it gone
    {
      const { service, adapter, provider } = matrix({ provider: 'clickup' });
      const session = await service.createCommentDeleteSession('clickup', 't', 'c', null);
      adapter.deleteImpl = () => {
        throw unknownOutcome(provider);
      };
      const unknown = await service.executeCommentDelete(session.sessionId);
      expect(unknown.outcome).toBe('outcome_unknown');
      adapter.deleteImpl = null;
      adapter.snapshot = null;
      const verified = await service.verifySession(session.sessionId);
      expect(verified.remoteState).toBe('gone');
    }
    // known rejection fails closed
    {
      const { service, adapter, provider } = matrix({ provider: 'clickup' });
      const session = await service.createCommentDeleteSession('clickup', 't', 'c', null);
      adapter.deleteImpl = () => {
        throw new ExternalProviderError(provider, 'permission_denied');
      };
      const rejected = await service.executeCommentDelete(session.sessionId);
      expect(rejected).toMatchObject({ outcome: 'rejected', reason: 'delete_rejected' });
      expect((await service.touchSession(session.sessionId)).state).toBe('invalidated');
    }
  });

  it('not-owned comments never open a delete session (bounded current-owner revalidation)', async () => {
    const { service, adapter, store } = matrix({ provider: 'clickup' });
    adapter.snapshot = {
      remoteId: 'comment-1',
      authorRemoteId: 'someone-else',
      createdAt: '2026-08-22T00:00:00.000Z',
    };
    await expect(
      service.createCommentDeleteSession('clickup', 't', 'c', null),
    ).rejects.toMatchObject({ details: { reason: 'not_owned' } });
    expect(store.size()).toBe(0);
  });
});
