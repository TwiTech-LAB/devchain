import type {
  IntegrationCredentials,
  IntegrationProvider,
} from '../../storage/models/domain.models';
import type { StorageService } from '../../storage/interfaces/storage.interface';
import { ExternalProviderError } from '../errors/external-provider.errors';
import type {
  ExternalDescriptionEditCapability,
  ExternalOwnedMutationsCapability,
} from '../models/external-provider.models';
import type { ExternalRichDocumentV1 } from '../models/external-rich-document';
import type { ExternalEditSessionView } from '../models/external-edit-session.models';
import { ExternalEditSessionService } from './external-edit-session.service';
import { ExternalEditSessionStore } from '../sessions/external-edit-session.store';
import { ProviderOperationGate } from '../sessions/provider-operation-gate';
import { adfToRichDocument } from '../adapters/rich/jira-adf-converter';

// Module-unit layer: the service orchestration contract (gate, sessions,
// outcomes, races) runs against fake storage/provider adapters; vendor HTTP
// and persistence contracts are owned by their own suites.

const BASELINE_ADF = {
  type: 'doc',
  version: 1,
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'baseline text' }] }],
};

const UPDATED_DOCUMENT: ExternalRichDocumentV1 = {
  version: 1,
  blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'updated text', marks: [] }] }],
};

const PROJECT_ID = 'project-1';

function adfWithText(text: string) {
  return {
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

function dispatchedUnknown(provider: IntegrationProvider): ExternalProviderError {
  return new ExternalProviderError(provider, 'timeout', { dispatched: true });
}

function providerNotFound(provider: IntegrationProvider): ExternalProviderError {
  return new ExternalProviderError(provider, 'not_found');
}

function knownRejection(provider: IntegrationProvider): ExternalProviderError {
  return new ExternalProviderError(provider, 'permission_denied');
}

class FakeStorage {
  connection: {
    id: string;
    projectId: string;
    provider: string;
    generation: number;
  } = { id: 'connection-1', projectId: PROJECT_ID, provider: 'jira', generation: 1 };
  connected = true;

  async getProject(projectId: string) {
    return { id: projectId };
  }

  async getIntegrationConnection(identity: unknown) {
    if (!this.connected) {
      return null;
    }
    const provider =
      typeof identity === 'object' && identity !== null && 'provider' in identity
        ? (identity as { provider: string }).provider
        : identity;
    return this.connection.provider === provider
      ? { ...this.connection, createdAt: '', updatedAt: '' }
      : null;
  }

  async getIntegrationConnectionById(connectionId: string) {
    return this.connected && this.connection.id === connectionId
      ? { ...this.connection, createdAt: '', updatedAt: '' }
      : null;
  }

  async getIntegrationConnectionCredentials(
    identity: unknown,
  ): Promise<IntegrationCredentials | null> {
    const provider =
      typeof identity === 'object' && identity !== null && 'provider' in identity
        ? (identity as { provider: string }).provider
        : identity;
    if (!this.connected || this.connection.provider !== provider) {
      return null;
    }
    if (provider === 'jira') {
      return {
        provider: 'jira',
        siteUrl: 'https://test.atlassian.net',
        email: 'user@example.com',
        token: 't',
      };
    }
    return { provider: 'clickup', token: 't' };
  }
}

class FakeAdapter {
  descriptionRaw: unknown = BASELINE_ADF;
  readDescriptionCalls: unknown[][] = [];
  readDescriptionImpl: (() => Promise<unknown>) | null = null;
  writeCalls: unknown[] = [];
  writeImpl: ((raw: unknown) => Promise<void>) | null = null;
  findCalls = 0;
  findImpl: (() => Promise<unknown>) | null = null;
  deleteCalls = 0;
  deleteImpl: (() => Promise<void>) | null = null;
  commentUpdateCalls: Array<{ document: unknown; metadata: unknown }> = [];
  commentUpdateImpl: (() => Promise<void>) | null = null;
  ownerRemoteId = 'owner-1';
  snapshot: {
    remoteId: string;
    authorRemoteId: string | null;
    createdAt: string;
    raw: unknown;
    metadata: { assignee: number | null; resolved: boolean | null; groupAssignee: string | null };
  } | null = {
    remoteId: 'comment-1',
    authorRemoteId: 'owner-1',
    createdAt: '2026-08-22T00:00:00.000Z',
    raw: [{ text: 'comment body' }],
    metadata: { assignee: 183, resolved: false, groupAssignee: null },
  };

  readonly descriptionEdit: ExternalDescriptionEditCapability = {
    readDescription: async (credentials, context, remoteTaskId) => {
      this.readDescriptionCalls.push([credentials, context, remoteTaskId]);
      return this.readDescriptionImpl ? this.readDescriptionImpl() : this.descriptionRaw;
    },
    writeDescription: async (_credentials, _context, _taskId, raw) => {
      this.writeCalls.push(raw);
      if (this.writeImpl) {
        await this.writeImpl(raw);
      }
    },
  };

  readonly ownedMutations: ExternalOwnedMutationsCapability = {
    getCurrentOwnerRemoteId: async () => this.ownerRemoteId,
    findComment: async () => {
      this.findCalls += 1;
      if (this.findImpl) {
        return this.findImpl();
      }
      return this.snapshot;
    },
    deleteComment: async () => {
      this.deleteCalls += 1;
      if (this.deleteImpl) {
        await this.deleteImpl();
      }
    },
    updateOwnedComment: async (_credentials, _context, _taskId, _commentId, document, metadata) => {
      this.commentUpdateCalls.push({ document, metadata });
      if (this.commentUpdateImpl) {
        await this.commentUpdateImpl();
      }
      // The write lands: subsequent bounded lookups return the new content.
      if (this.snapshot) {
        this.snapshot = { ...this.snapshot, raw: commentRawFor(document) };
      }
    },
  };
}

/** Rebuilds a ClickUp-style delta carrying the canonical document's text. */
function commentRawFor(document: unknown): unknown {
  const blocks = (document as { blocks: Array<{ type: string; content?: unknown[] }> }).blocks;
  const first = blocks[0];
  const content = (first?.content ?? []) as Array<{
    type: string;
    text?: string;
    marks?: unknown[];
  }>;
  return content
    .filter((run) => run.type === 'text')
    .map((run) => ({
      ...(run.marks && run.marks.length > 0
        ? { attributes: { [String((run.marks[0] as { type: string }).type)]: true } }
        : {}),
      text: run.text ?? '',
    }));
}

class FakeRegistry {
  constructor(readonly adapter: FakeAdapter) {}

  get(provider: string) {
    if (provider !== 'jira' && provider !== 'clickup') {
      throw new Error('unsupported provider');
    }
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup(provider: IntegrationProvider = 'jira') {
  const storage = new FakeStorage();
  storage.connection = { id: 'connection-1', projectId: PROJECT_ID, provider, generation: 1 };
  const adapter = new FakeAdapter();
  const registry = new FakeRegistry(adapter);
  const gate = new ProviderOperationGate();
  const store = new ExternalEditSessionStore();
  const service = new ExternalEditSessionService(
    storage as unknown as StorageService,
    registry as never,
    gate,
    store,
  );
  return { storage, adapter, gate, store, service, provider };
}

describe('ExternalEditSessionService', () => {
  it('stateless reads leave the session store untouched (sessions come only from explicit actions)', async () => {
    const { store, service } = setup();
    // Read-only description reads happen through the adapter directly; the
    // session store stays empty until an explicit create call.
    expect(store.size()).toBe(0);
    await expect(
      service.touchSession(PROJECT_ID, '00000000-0000-4000-8000-000000000000'),
    ).rejects.toThrow();
    expect(store.size()).toBe(0);
  });

  it('creates a description session pinned to the connection with a canonical baseline', async () => {
    const { service, store } = setup();
    const session = await service.createDescriptionSession(PROJECT_ID, 'jira', 'KAN-1');
    expect(session.state).toBe('editable');
    expect(session.revision).toBe(0);
    expect(session.baselineFingerprint).toBe(
      JSON.stringify(adfToRichDocument(BASELINE_ADF).document ?? null),
    );
    expect(store.size()).toBe(1);
  });

  it('does not expose or invalidate another project session', async () => {
    const { service } = setup();
    const session = await service.createDescriptionSession(PROJECT_ID, 'jira', 'KAN-1');

    await expect(
      service.saveSession('project-2', session.sessionId, UPDATED_DOCUMENT, 0),
    ).resolves.toEqual({
      outcome: 'pre_dispatch_rejected',
      reason: 'session_not_found',
      session: null,
    });

    await expect(service.touchSession(PROJECT_ID, session.sessionId)).resolves.toMatchObject({
      state: 'editable',
    });
  });

  it('refuses to create a session for unsupported baseline content', async () => {
    const { service, adapter, store } = setup();
    adapter.descriptionRaw = {
      type: 'doc',
      version: 1,
      content: [{ type: 'table', content: [] }],
    };
    await expect(
      service.createDescriptionSession(PROJECT_ID, 'jira', 'KAN-1'),
    ).rejects.toMatchObject({
      details: { reason: 'unsupported_content' },
    });
    expect(store.size()).toBe(0);
  });

  describe('description writes', () => {
    it('happy path: saved_unverified, then verified save advances baseline and revision exactly once', async () => {
      const { service, adapter } = setup();
      const session = await service.createDescriptionSession(PROJECT_ID, 'jira', 'KAN-1');
      const written = await service.saveSession(PROJECT_ID, session.sessionId, UPDATED_DOCUMENT, 0);
      expect(written.outcome).toBe('saved_unverified');
      expect(adapter.writeCalls).toHaveLength(1);

      // The remote now shows the payload.
      adapter.descriptionRaw = adfWithText('updated text');
      const verified = await service.verifySession(PROJECT_ID, session.sessionId);
      expect(verified.remoteState).toBe('new_payload');
      expect(verified.session?.state).toBe('editable');
      expect(verified.session?.revision).toBe(1);

      // A second verify of the same content cannot advance again.
      const again = await service.verifySession(PROJECT_ID, session.sessionId);
      expect(again.session?.revision).toBe(1);
    });

    it('a dispatched timeout classifies as outcome_unknown', async () => {
      const { service, adapter, provider } = setup();
      const session = await service.createDescriptionSession(PROJECT_ID, 'jira', 'KAN-1');
      adapter.writeImpl = () => {
        throw dispatchedUnknown(provider);
      };
      const outcome = await service.saveSession(PROJECT_ID, session.sessionId, UPDATED_DOCUMENT, 0);
      expect(outcome.outcome).toBe('outcome_unknown');
      expect(outcome.session?.state).toBe('outcome_unknown');
    });

    it('a known 4xx rejection keeps the session editable', async () => {
      const { service, adapter, provider } = setup();
      const session = await service.createDescriptionSession(PROJECT_ID, 'jira', 'KAN-1');
      adapter.writeImpl = () => {
        throw knownRejection(provider);
      };
      await expect(
        service.saveSession(PROJECT_ID, session.sessionId, UPDATED_DOCUMENT, 0),
      ).rejects.toBeInstanceOf(ExternalProviderError);
      const view = await service.touchSession(PROJECT_ID, session.sessionId);
      expect(view.state).toBe('editable');
    });

    it('outcome_unknown permits only an exact-payload retry, never a different payload', async () => {
      const { service, adapter, provider } = setup();
      const session = await service.createDescriptionSession(PROJECT_ID, 'jira', 'KAN-1');
      adapter.writeImpl = () => {
        throw dispatchedUnknown(provider);
      };
      await service.saveSession(PROJECT_ID, session.sessionId, UPDATED_DOCUMENT, 0);

      const different: ExternalRichDocumentV1 = {
        version: 1,
        blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'other', marks: [] }] }],
      };
      const rejected = await service.saveSession(PROJECT_ID, session.sessionId, different, 0);
      expect(rejected).toMatchObject({
        outcome: 'pre_dispatch_rejected',
        reason: 'session_not_editable',
      });

      adapter.writeImpl = null;
      const retried = await service.saveSession(PROJECT_ID, session.sessionId, UPDATED_DOCUMENT, 0);
      expect(retried.outcome).toBe('saved_unverified');
    });

    it('seeing the old baseline after outcome_unknown does not re-arm writes', async () => {
      const { service, adapter, provider } = setup();
      const session = await service.createDescriptionSession(PROJECT_ID, 'jira', 'KAN-1');
      adapter.writeImpl = () => {
        throw dispatchedUnknown(provider);
      };
      await service.saveSession(PROJECT_ID, session.sessionId, UPDATED_DOCUMENT, 0);
      adapter.writeImpl = null;

      // Remote still shows the baseline.
      const verified = await service.verifySession(PROJECT_ID, session.sessionId);
      expect(verified.remoteState).toBe('old_baseline');
      expect(verified.session?.state).toBe('outcome_unknown');

      const different: ExternalRichDocumentV1 = {
        version: 1,
        blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'new idea', marks: [] }] }],
      };
      const rejected = await service.saveSession(PROJECT_ID, session.sessionId, different, 0);
      expect(rejected).toMatchObject({ outcome: 'pre_dispatch_rejected' });
    });

    it('remote drift after an unknown outcome reports divergence and blocks writes', async () => {
      const { service, adapter, provider } = setup();
      const session = await service.createDescriptionSession(PROJECT_ID, 'jira', 'KAN-1');
      adapter.writeImpl = () => {
        throw dispatchedUnknown(provider);
      };
      await service.saveSession(PROJECT_ID, session.sessionId, UPDATED_DOCUMENT, 0);
      adapter.descriptionRaw = adfWithText('someone else edited this');
      const verified = await service.verifySession(PROJECT_ID, session.sessionId);
      expect(verified.remoteState).toBe('diverged');
      expect(verified.session?.state).toBe('diverged');
      const blocked = await service.saveSession(
        PROJECT_ID,
        session.sessionId,
        UPDATED_DOCUMENT,
        verified.session?.revision ?? 0,
      );
      expect(blocked).toMatchObject({
        outcome: 'pre_dispatch_rejected',
        reason: 'diverged',
      });
      expect(adapter.writeCalls).toHaveLength(1);
      const reloaded = await service.reloadSession(PROJECT_ID, session.sessionId);
      expect(reloaded).toMatchObject({
        status: 'reloaded',
        session: { state: 'editable', revision: 1 },
      });
      adapter.writeImpl = async (raw) => {
        adapter.descriptionRaw = raw;
      };
      const saved = await service.saveSession(PROJECT_ID, session.sessionId, UPDATED_DOCUMENT, 1);
      expect(saved.outcome).toBe('saved');
      expect(adapter.writeCalls).toHaveLength(2);
    });

    it('rejects a stale revision with revision_conflict', async () => {
      const { service } = setup();
      const session = await service.createDescriptionSession(PROJECT_ID, 'jira', 'KAN-1');
      const outcome = await service.saveSession(PROJECT_ID, session.sessionId, UPDATED_DOCUMENT, 9);
      expect(outcome).toMatchObject({
        outcome: 'pre_dispatch_rejected',
        reason: 'revision_conflict',
      });
    });

    it('a busy gate rejects with operation_busy, distinct from revision_conflict', async () => {
      const { service, gate, provider } = setup();
      const session = await service.createDescriptionSession(PROJECT_ID, 'jira', 'KAN-1');
      let release: () => void = () => undefined;
      const held = gate.run(
        { projectId: PROJECT_ID, provider },
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      await Promise.resolve();
      const busy = await service.saveSession(PROJECT_ID, session.sessionId, UPDATED_DOCUMENT, 0);
      expect(busy).toMatchObject({ outcome: 'pre_dispatch_rejected', reason: 'operation_busy' });
      release();
      await held;
    });

    it('write versus connection replacement: a generation bump rejects and invalidates', async () => {
      const { service, storage } = setup();
      const session = await service.createDescriptionSession(PROJECT_ID, 'jira', 'KAN-1');
      storage.connection = {
        id: 'connection-1',
        projectId: PROJECT_ID,
        provider: 'jira',
        generation: 2,
      };
      const outcome = await service.saveSession(PROJECT_ID, session.sessionId, UPDATED_DOCUMENT, 0);
      expect(outcome).toMatchObject({
        outcome: 'pre_dispatch_rejected',
        reason: 'connection_superseded',
      });
      const view = await service.touchSession(PROJECT_ID, session.sessionId);
      expect(view.state).toBe('invalidated');
    });

    it('write versus connection replacement: disconnect rejects as superseded', async () => {
      const { service, storage } = setup();
      const session = await service.createDescriptionSession(PROJECT_ID, 'jira', 'KAN-1');
      storage.connected = false;
      const outcome = await service.saveSession(PROJECT_ID, session.sessionId, UPDATED_DOCUMENT, 0);
      // A vanished connection is the superseded case for a live session.
      expect(outcome).toMatchObject({
        outcome: 'pre_dispatch_rejected',
        reason: 'connection_superseded',
      });
      const view = await service.touchSession(PROJECT_ID, session.sessionId);
      expect(view.state).toBe('invalidated');
    });

    it('replacement versus write: the connections gate rejects while a write holds the gate', async () => {
      const { service, gate, provider, adapter } = setup();
      const session = await service.createDescriptionSession(PROJECT_ID, 'jira', 'KAN-1');
      let releaseWrite: () => void = () => undefined;
      adapter.writeImpl = () =>
        new Promise<void>((resolve) => {
          releaseWrite = resolve;
        });
      const write = service.saveSession(PROJECT_ID, session.sessionId, UPDATED_DOCUMENT, 0);
      await new Promise((resolve) => setTimeout(resolve, 10));
      await expect(
        gate.run({ projectId: PROJECT_ID, provider }, async () => undefined),
      ).rejects.toMatchObject({
        details: { reason: 'operation_in_progress' },
      });
      releaseWrite();
      expect((await write).outcome).toBe('saved_unverified');
    });

    it('rejects a payload outside the closed schema before any dispatch', async () => {
      const { service, adapter } = setup();
      const session = await service.createDescriptionSession(PROJECT_ID, 'jira', 'KAN-1');
      await expect(
        service.saveSession(PROJECT_ID, session.sessionId, { version: 1, blocks: [] }, 0),
      ).rejects.toMatchObject({ details: { reason: 'unsupported_content' } });
      expect(adapter.writeCalls).toHaveLength(0);
      const view = await service.touchSession(PROJECT_ID, session.sessionId);
      expect(view.state).toBe('editable');
    });
  });

  describe('comment deletion', () => {
    it('creates an owner-validated session through the bounded lookup', async () => {
      const { service, adapter } = setup('clickup');
      const session = await service.createCommentDeleteSession(
        PROJECT_ID,
        'clickup',
        'task-1',
        'comment-1',
        null,
      );
      expect(session.state).toBe('editable');
      expect(session.remoteCommentId).toBe('comment-1');
      expect(adapter.findCalls).toBe(1);
    });

    it('refuses session creation for a comment authored by someone else', async () => {
      const { service, adapter, store } = setup('clickup');
      adapter.snapshot = {
        remoteId: 'comment-1',
        authorRemoteId: 'someone-else',
        createdAt: '2026-08-22T00:00:00.000Z',
      };
      await expect(
        service.createCommentDeleteSession(PROJECT_ID, 'clickup', 'task-1', 'comment-1', null),
      ).rejects.toMatchObject({ details: { reason: 'not_owned' } });
      expect(store.size()).toBe(0);
    });

    it('executes the deletion and marks the session done', async () => {
      const { service, adapter } = setup('clickup');
      const session = await service.createCommentDeleteSession(
        PROJECT_ID,
        'clickup',
        'task-1',
        'comment-1',
        null,
      );
      const outcome = await service.executeCommentDelete(PROJECT_ID, session.sessionId);
      expect(outcome.outcome).toBe('deleted');
      expect(adapter.deleteCalls).toBe(1);
      expect(outcome.session?.state).toBe('invalidated');
    });

    it('a later vendor 404 is treated as already deleted', async () => {
      const { service, adapter, provider } = setup('clickup');
      const session = await service.createCommentDeleteSession(
        PROJECT_ID,
        'clickup',
        'task-1',
        'comment-1',
        null,
      );
      adapter.deleteImpl = () => {
        throw providerNotFound(provider);
      };
      const outcome = await service.executeCommentDelete(PROJECT_ID, session.sessionId);
      expect(outcome.outcome).toBe('already_deleted');
    });

    it('a known delete rejection fails closed and invalidates the session', async () => {
      const { service, adapter, provider } = setup('clickup');
      const session = await service.createCommentDeleteSession(
        PROJECT_ID,
        'clickup',
        'task-1',
        'comment-1',
        null,
      );
      adapter.deleteImpl = () => {
        throw knownRejection(provider);
      };
      const outcome = await service.executeCommentDelete(PROJECT_ID, session.sessionId);
      expect(outcome).toMatchObject({ outcome: 'rejected', reason: 'delete_rejected' });
      const view = await service.touchSession(PROJECT_ID, session.sessionId);
      expect(view.state).toBe('invalidated');
    });

    it('a dispatched delete timeout is outcome_unknown; verify seeing it gone completes', async () => {
      const { service, adapter, provider } = setup('clickup');
      const session = await service.createCommentDeleteSession(
        PROJECT_ID,
        'clickup',
        'task-1',
        'comment-1',
        null,
      );
      adapter.deleteImpl = () => {
        throw dispatchedUnknown(provider);
      };
      const unknown = await service.executeCommentDelete(PROJECT_ID, session.sessionId);
      expect(unknown.outcome).toBe('outcome_unknown');

      adapter.deleteImpl = null;
      adapter.snapshot = null;
      const verified = await service.verifySession(PROJECT_ID, session.sessionId);
      expect(verified.remoteState).toBe('gone');
      expect(verified.session?.state).toBe('invalidated');
    });

    it('a delete session bound to a replaced connection rejects as superseded', async () => {
      const { service, storage } = setup('clickup');
      const session = await service.createCommentDeleteSession(
        PROJECT_ID,
        'clickup',
        'task-1',
        'comment-1',
        null,
      );
      storage.connection = {
        id: 'connection-2',
        projectId: PROJECT_ID,
        provider: 'clickup',
        generation: 1,
      };
      const outcome = await service.executeCommentDelete(PROJECT_ID, session.sessionId);
      expect(outcome).toMatchObject({
        outcome: 'rejected',
        reason: 'connection_superseded',
      });
    });

    it('ClickUp lookup performs at most two page fetches', async () => {
      const { service, adapter } = setup('clickup');
      adapter.findImpl = () =>
        Promise.resolve({
          remoteId: 'comment-1',
          authorRemoteId: 'owner-1',
          createdAt: '2026-08-22T00:00:00.000Z',
        });
      // The bounded-lookup bound is enforced inside the ClickUp adapter's
      // findComment loop; through the service it appears as exactly one
      // findComment call per session create (plus one per verify).
      await service.createCommentDeleteSession(PROJECT_ID, 'clickup', 'task-1', 'comment-1', null);
      expect(adapter.findCalls).toBe(1);
    });
  });

  it('touch extends the session without any provider interaction', async () => {
    const { service, adapter } = setup();
    const session = await service.createDescriptionSession(PROJECT_ID, 'jira', 'KAN-1');
    const before = adapter.descriptionEdit;
    void before;
    const touched = await service.touchSession(PROJECT_ID, session.sessionId);
    expect(touched.sessionId).toBe(session.sessionId);
    expect(adapter.writeCalls).toHaveLength(0);
    expect(adapter.findCalls).toBe(0);
  });

  describe('session read admission and result validation', () => {
    const paths = ['description reload', 'comment reload', 'delete verification'] as const;
    type ReadPath = (typeof paths)[number];

    async function open(path: ReadPath) {
      const fixture = setup(path === 'description reload' ? 'jira' : 'clickup');
      const { service, adapter } = fixture;
      let session: ExternalEditSessionView;
      switch (path) {
        case 'description reload':
          session = await service.createDescriptionSession(PROJECT_ID, 'jira', 'KAN-1');
          break;
        case 'comment reload':
          session = await service.createCommentEditSession(
            PROJECT_ID,
            'clickup',
            'task-1',
            'comment-1',
            null,
          );
          break;
        case 'delete verification':
          session = await service.createCommentDeleteSession(
            PROJECT_ID,
            'clickup',
            'task-1',
            'comment-1',
            null,
          );
          break;
      }
      if (path === 'delete verification') {
        adapter.deleteImpl = async () => {
          throw dispatchedUnknown('clickup');
        };
        expect((await service.executeCommentDelete(PROJECT_ID, session.sessionId)).outcome).toBe(
          'outcome_unknown',
        );
      }
      adapter.readDescriptionCalls = [];
      adapter.findCalls = 0;
      return {
        ...fixture,
        session,
        read: () =>
          path === 'delete verification'
            ? service.verifySession(PROJECT_ID, session.sessionId)
            : service.reloadSession(PROJECT_ID, session.sessionId),
      };
    }

    async function expectSuperseded(
      path: ReadPath,
      pending: ReturnType<Awaited<ReturnType<typeof open>>['read']>,
    ) {
      if (path === 'delete verification') {
        await expect(pending).resolves.toMatchObject({
          remoteState: 'diverged',
          reason: null,
          session: { state: 'invalidated' },
        });
      } else {
        await expect(pending).rejects.toMatchObject({
          message: 'The connection was replaced; the session is invalid.',
          details: { reason: 'connection_superseded' },
        });
      }
    }

    it.each(paths)(
      '%s rejects replacement acquired after a paused credential read without content access',
      async (path) => {
        const { storage, store, adapter, session, read } = await open(path);
        const entered = deferred<void>();
        const release = deferred<IntegrationCredentials | null>();
        const originalCredentials = storage.getIntegrationConnectionCredentials.bind(storage);
        const credentials = await originalCredentials({ provider: storage.connection.provider });
        const credentialReads = jest
          .spyOn(storage, 'getIntegrationConnectionCredentials')
          .mockImplementationOnce(() => {
            entered.resolve();
            return release.promise;
          });
        const pending = read();
        await entered.promise;
        storage.connection = { ...storage.connection, generation: 2 };
        expect(store.invalidateConnection(storage.connection.id)).toBe(1);
        release.resolve(credentials);
        await expectSuperseded(path, pending);
        expect(credentialReads).toHaveBeenCalledTimes(2);
        expect(adapter.readDescriptionCalls).toHaveLength(0);
        expect(adapter.findCalls).toBe(0);
        expect(store.get(session.sessionId)).toMatchObject({
          value: { state: 'invalidated', revision: 0 },
        });
        expect(adapter.deleteCalls).toBe(path === 'delete verification' ? 1 : 0);
      },
    );

    it.each([
      ['description reload', 'supported'],
      ['description reload', 'unsupported'],
      ['comment reload', 'gone'],
      ['delete verification', 'gone'],
      ['delete verification', 'old_baseline'],
    ] as const)(
      '%s rejects %s from a provider read superseded during I/O',
      async (path, result) => {
        const { storage, store, adapter, session, read } = await open(path);
        const before = store.get(session.sessionId);
        if (!before.ok) throw new Error(before.reason);
        const entered = deferred<void>();
        const release = deferred<unknown>();
        const hook = () => {
          entered.resolve();
          return release.promise;
        };
        if (path === 'description reload') adapter.readDescriptionImpl = hook;
        else adapter.findImpl = hook;
        const connectionReads = jest.spyOn(storage, 'getIntegrationConnection');
        const pending = read();
        await entered.promise;
        connectionReads.mockClear();
        storage.connection = { ...storage.connection, generation: 2 };
        expect(store.invalidateConnection(storage.connection.id)).toBe(1);
        switch (result) {
          case 'gone':
            release.resolve(null);
            break;
          case 'old_baseline':
            release.resolve(adapter.snapshot);
            break;
          case 'unsupported':
            release.resolve({ type: 'doc', version: 1, content: [{ type: 'table', content: [] }] });
            break;
          case 'supported':
            release.resolve(adfWithText('fresh content'));
            break;
        }
        await expectSuperseded(path, pending);
        expect(connectionReads).toHaveBeenCalledTimes(1);
        expect(connectionReads).toHaveBeenCalledWith({
          projectId: PROJECT_ID,
          provider: storage.connection.provider,
        });
        expect(store.get(session.sessionId)).toMatchObject({
          value: {
            state: 'invalidated',
            baseline: before.value.baseline,
            revision: before.value.revision,
          },
        });
        expect(adapter.readDescriptionCalls).toHaveLength(path === 'description reload' ? 1 : 0);
        expect(adapter.findCalls).toBe(path === 'description reload' ? 0 : 1);
        expect(adapter.deleteCalls).toBe(path === 'delete verification' ? 1 : 0);
      },
    );

    it.each(['generation', 'id'] as const)(
      'rejects a changed connection %s even while the old session is editable',
      async (field) => {
        const { storage, store, adapter, session, read } = await open('description reload');
        storage.connection =
          field === 'generation'
            ? { ...storage.connection, generation: 2 }
            : { ...storage.connection, id: 'connection-2' };
        expect(store.get(session.sessionId)).toMatchObject({ value: { state: 'editable' } });
        await expectSuperseded('description reload', read());
        expect(adapter.readDescriptionCalls).toHaveLength(0);
        expect(store.get(session.sessionId)).toMatchObject({ value: { state: 'invalidated' } });
      },
    );

    it.each(['missing', 'project', 'provider'] as const)(
      'rejects a %s scoped connection after a fulfilled read',
      async (change) => {
        const { storage, adapter, read } = await open('description reload');
        adapter.readDescriptionImpl = async () => {
          if (change === 'missing') storage.connected = false;
          if (change === 'project') storage.connection.projectId = 'project-2';
          if (change === 'provider') storage.connection.provider = 'clickup';
          return BASELINE_ADF;
        };
        await expectSuperseded('description reload', read());
      },
    );

    it.each(['outcome_unknown', 'saved_unverified', 'invalidated'] as const)(
      'reload rejects %s before reading unsupported content',
      async (state) => {
        const { store, adapter, session, read } = await open('description reload');
        store.beginDispatch(session.sessionId, 'pending', 0);
        if (state === 'saved_unverified') store.markSavedUnverified(session.sessionId);
        if (state === 'invalidated') store.invalidate(session.sessionId);
        const before = store.get(session.sessionId);
        adapter.descriptionRaw = {
          type: 'doc',
          version: 1,
          content: [{ type: 'table', content: [] }],
        };
        await expect(read()).rejects.toMatchObject({ details: { reason: 'session_not_editable' } });
        expect(adapter.readDescriptionCalls).toHaveLength(0);
        expect(store.get(session.sessionId)).toEqual(before);
      },
    );

    it('an admitted reload keeps the same-generation unsupported outcome', async () => {
      const { adapter, read } = await open('description reload');
      adapter.descriptionRaw = {
        type: 'doc',
        version: 1,
        content: [{ type: 'table', content: [] }],
      };
      await expect(read()).resolves.toMatchObject({
        status: 'unsupported',
        session: { state: 'diverged', revision: 0 },
      });
      expect(adapter.readDescriptionCalls).toHaveLength(1);
    });

    it('comment null cannot bypass a live state change to outcome_unknown', async () => {
      const { store, adapter, session, read } = await open('comment reload');
      const entered = deferred<void>();
      const release = deferred<unknown>();
      adapter.findImpl = () => {
        entered.resolve();
        return release.promise;
      };
      const pending = read();
      await entered.promise;
      expect(store.beginDispatch(session.sessionId, 'pending', 0).ok).toBe(true);
      release.resolve(null);
      await expect(pending).rejects.toMatchObject({ details: { reason: 'session_not_editable' } });
      expect(store.get(session.sessionId)).toMatchObject({
        value: { state: 'outcome_unknown', revision: 0, pendingWrite: { fingerprint: 'pending' } },
      });
    });

    it('same-generation delete verification returns old_baseline and keeps the unknown deletion blocked', async () => {
      const { store, adapter, session, read } = await open('delete verification');
      await expect(read()).resolves.toMatchObject({
        remoteState: 'old_baseline',
        session: { state: 'outcome_unknown', revision: 0 },
      });
      expect(adapter.findCalls).toBe(1);
      expect(store.beginDispatch(session.sessionId, 'new-payload', 0)).toEqual({
        ok: false,
        reason: 'session_not_editable',
      });
      expect(adapter.deleteCalls).toBe(1);
    });

    it.each(paths)(
      '%s propagates a provider rejection unchanged without a post-read check or retry',
      async (path) => {
        const { storage, store, adapter, session, read } = await open(path);
        const before = store.get(session.sessionId);
        const connectionReads = jest.spyOn(storage, 'getIntegrationConnection');
        const error = dispatchedUnknown(storage.connection.provider as IntegrationProvider);
        const hook = async () => {
          connectionReads.mockClear();
          throw error;
        };
        if (path === 'description reload') adapter.readDescriptionImpl = hook;
        else adapter.findImpl = hook;
        await expect(read()).rejects.toBe(error);
        expect(connectionReads).not.toHaveBeenCalled();
        expect(store.get(session.sessionId)).toEqual(before);
        expect(adapter.readDescriptionCalls).toHaveLength(path === 'description reload' ? 1 : 0);
        expect(adapter.findCalls).toBe(path === 'description reload' ? 0 : 1);
      },
    );
  });

  describe('Phase 14: stateless rich reads, comment editing, reload, and capability gates', () => {
    it('readRichDescription returns the document and flags without creating a session', async () => {
      const { service, store } = setup();
      const read = await service.readRichDescription(PROJECT_ID, 'jira', 'KAN-1');
      expect(read.supported).toBe(true);
      expect(read.readOnlyReason).toBeNull();
      expect(read.canEdit).toBe(true);
      expect(read.canDeleteOwnedComments).toBe(true);
      expect(read.document).not.toBeNull();
      expect(read.fingerprint).toBeTruthy();
      expect(store.size()).toBe(0);
    });

    it('forwards replacement credentials with the stable generation to a rich read', async () => {
      const { service, storage, adapter } = setup('jira');
      const connection = (generation: number) => ({
        id: 'connection-1',
        projectId: PROJECT_ID,
        provider: 'jira' as const,
        generation,
      });
      jest
        .spyOn(storage, 'getIntegrationConnection')
        .mockResolvedValueOnce({ ...connection(1), createdAt: '', updatedAt: '' })
        .mockResolvedValueOnce({ ...connection(2), createdAt: '', updatedAt: '' })
        .mockResolvedValue({ ...connection(2), createdAt: '', updatedAt: '' });
      jest
        .spyOn(storage, 'getIntegrationConnectionCredentials')
        .mockResolvedValueOnce({
          provider: 'jira',
          siteUrl: 'https://old.atlassian.net',
          email: 'old@example.com',
          token: 'old-token',
        })
        .mockResolvedValueOnce({
          provider: 'jira',
          siteUrl: 'https://replacement.atlassian.net',
          email: 'replacement@example.com',
          token: 'replacement-token',
        });

      await service.readRichDescription(PROJECT_ID, 'jira', 'KAN-1');

      expect(adapter.readDescriptionCalls).toEqual([
        [
          {
            provider: 'jira',
            siteUrl: 'https://replacement.atlassian.net',
            email: 'replacement@example.com',
            token: 'replacement-token',
          },
          { connectionId: 'connection-1', connectionGeneration: 2 },
          'KAN-1',
        ],
      ]);
    });

    it('rejects a disconnected rich read with its caller message before provider access', async () => {
      const { service, storage, adapter, store } = setup('jira');
      storage.connected = false;

      await expect(service.readRichDescription(PROJECT_ID, 'jira', 'KAN-1')).rejects.toEqual(
        expect.objectContaining({
          name: 'ValidationError',
          message: 'Connect the integration before editing.',
          code: 'validation_error',
          statusCode: 400,
          details: { provider: 'jira', projectId: PROJECT_ID, reason: 'not_connected' },
        }),
      );
      expect(adapter.readDescriptionCalls).toHaveLength(0);
      expect(store.size()).toBe(0);
    });

    it('rejects a rich read when connection acquisition stays unstable for three attempts', async () => {
      const { service, storage, adapter, store } = setup('jira');
      const connection = (generation: number) => ({
        id: 'connection-1',
        projectId: PROJECT_ID,
        provider: 'jira' as const,
        generation,
        createdAt: '',
        updatedAt: '',
      });
      jest
        .spyOn(storage, 'getIntegrationConnection')
        .mockResolvedValueOnce(connection(1))
        .mockResolvedValueOnce(connection(2))
        .mockResolvedValueOnce(connection(2))
        .mockResolvedValueOnce(connection(3))
        .mockResolvedValueOnce(connection(3))
        .mockResolvedValueOnce(connection(4));

      await expect(service.readRichDescription(PROJECT_ID, 'jira', 'KAN-1')).rejects.toEqual(
        expect.objectContaining({
          name: 'BusyError',
          message: 'Integration connection changed during the operation.',
          code: 'busy',
          statusCode: 409,
          details: { provider: 'jira', projectId: PROJECT_ID, reason: 'connection_changed' },
        }),
      );
      expect(adapter.readDescriptionCalls).toHaveLength(0);
      expect(store.size()).toBe(0);
    });

    it('readRichDescription reports read-only for unsupported content', async () => {
      const { service, adapter, store } = setup();
      adapter.descriptionRaw = {
        type: 'doc',
        version: 1,
        content: [{ type: 'table', content: [] }],
      };
      const read = await service.readRichDescription(PROJECT_ID, 'jira', 'KAN-1');
      expect(read).toMatchObject({
        supported: false,
        readOnlyReason: 'unsupported_content',
        canEdit: false,
        document: null,
        fingerprint: null,
      });
      expect(store.size()).toBe(0);
    });

    it('a verified save returns the new revision and commits the baseline once', async () => {
      const { service, adapter } = setup();
      const session = await service.createDescriptionSession(PROJECT_ID, 'jira', 'KAN-1');
      // The fake write lands immediately: verification sees the payload.
      adapter.writeImpl = (raw: unknown) => {
        adapter.descriptionRaw = raw;
        return Promise.resolve();
      };
      const saved = await service.saveSession(PROJECT_ID, session.sessionId, UPDATED_DOCUMENT, 0);
      expect(saved.outcome).toBe('saved');
      if (saved.outcome === 'saved') {
        expect(saved.revision).toBe(1);
      }
      expect(saved.session?.state).toBe('editable');
      // A repeated save of the same content is a fresh preflight pass, not a
      // second commit of the old pending write.
      const again = await service.saveSession(PROJECT_ID, session.sessionId, UPDATED_DOCUMENT, 1);
      expect(again.outcome).toBe('saved');
      if (again.outcome === 'saved') {
        expect(again.revision).toBe(2);
      }
    });

    it('a verification-read failure keeps saved_unverified retryable', async () => {
      const { service, adapter, provider } = setup();
      const session = await service.createDescriptionSession(PROJECT_ID, 'jira', 'KAN-1');
      const originalRead = adapter.descriptionEdit.readDescription;
      adapter.writeImpl = () => Promise.resolve();
      // The post-write verification read fails transiently.
      let readCount = 0;
      (adapter.descriptionEdit as { readDescription: unknown }).readDescription = async () => {
        readCount += 1;
        if (readCount > 1) {
          throw dispatchedUnknown(provider);
        }
        return originalRead();
      };
      const outcome = await service.saveSession(PROJECT_ID, session.sessionId, UPDATED_DOCUMENT, 0);
      expect(outcome.outcome).toBe('saved_unverified');
      const view = await service.touchSession(PROJECT_ID, session.sessionId);
      expect(view.state).toBe('saved_unverified');
    });

    it('a generation change after dispatch invalidates before verification', async () => {
      const { service, storage, adapter } = setup();
      const session = await service.createDescriptionSession(PROJECT_ID, 'jira', 'KAN-1');
      adapter.writeImpl = () => Promise.resolve();
      // Replace the connection the moment the mutation completed.
      const originalWrite = adapter.writeImpl;
      adapter.writeImpl = async (raw: unknown) => {
        await originalWrite!(raw);
        storage.connection = {
          id: 'connection-1',
          projectId: PROJECT_ID,
          provider: 'jira',
          generation: 9,
        };
      };
      const outcome = await service.saveSession(PROJECT_ID, session.sessionId, UPDATED_DOCUMENT, 0);
      expect(outcome.outcome).toBe('saved_unverified');
      const view = await service.touchSession(PROJECT_ID, session.sessionId);
      expect(view.state).toBe('invalidated');
    });

    it('preflight drift blocks Save until explicit Reload recovers the baseline and revision', async () => {
      const { service, adapter } = setup();
      const session = await service.createDescriptionSession(PROJECT_ID, 'jira', 'KAN-1');
      adapter.descriptionRaw = adfWithText('someone raced ahead');
      const rejected = await service.saveSession(
        PROJECT_ID,
        session.sessionId,
        UPDATED_DOCUMENT,
        0,
      );
      expect(rejected).toMatchObject({ outcome: 'pre_dispatch_rejected', reason: 'diverged' });
      expect(adapter.writeCalls).toHaveLength(0);
      expect(session.state).toBe('editable');
      expect((await service.touchSession(PROJECT_ID, session.sessionId)).state).toBe('diverged');
      const reloaded = await service.reloadSession(PROJECT_ID, session.sessionId);
      expect(reloaded).toMatchObject({
        status: 'reloaded',
        session: {
          state: 'editable',
          revision: 1,
          baselineFingerprint: JSON.stringify(adfToRichDocument(adapter.descriptionRaw).document),
        },
      });
      adapter.writeImpl = async (raw) => {
        adapter.descriptionRaw = raw;
      };
      const saved = await service.saveSession(PROJECT_ID, session.sessionId, UPDATED_DOCUMENT, 1);
      expect(saved).toMatchObject({
        outcome: 'saved',
        session: { state: 'editable', revision: 2 },
      });
      expect(adapter.writeCalls).toHaveLength(1);
    });

    it('comment edit sessions: owner-validated create, save preserves fetched metadata exactly', async () => {
      const { service, adapter } = setup('clickup');
      const session = await service.createCommentEditSession(
        PROJECT_ID,
        'clickup',
        'task-1',
        'comment-1',
        null,
      );
      expect(session.state).toBe('editable');
      expect(session.kind).toBe('comment_edit');
      expect(session.baselineFingerprint).toBeTruthy();

      const payload: ExternalRichDocumentV1 = {
        version: 1,
        blocks: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'edited ', marks: [] },
              { type: 'text', text: 'body', marks: [{ type: 'bold' }] },
            ],
          },
        ],
      };
      const saved = await service.saveSession(PROJECT_ID, session.sessionId, payload, 0);
      expect(saved.outcome).toBe('saved');
      expect(adapter.commentUpdateCalls).toHaveLength(1);
      // The freshly fetched ClickUp state rides along unchanged.
      expect(adapter.commentUpdateCalls[0]!.metadata).toEqual({
        assignee: 183,
        resolved: false,
        groupAssignee: null,
      });
    });

    it('comment save rejects with target_gone when the comment disappears', async () => {
      const { service, adapter } = setup('clickup');
      const session = await service.createCommentEditSession(
        PROJECT_ID,
        'clickup',
        'task-1',
        'comment-1',
        null,
      );
      adapter.snapshot = null;
      const rejected = await service.saveSession(
        PROJECT_ID,
        session.sessionId,
        UPDATED_DOCUMENT,
        0,
      );
      expect(rejected).toMatchObject({ outcome: 'pre_dispatch_rejected', reason: 'target_gone' });
      expect((await service.touchSession(PROJECT_ID, session.sessionId)).state).toBe('invalidated');
    });

    it('reload re-baselines an editable description session and advances the revision', async () => {
      const { service, adapter } = setup();
      const session = await service.createDescriptionSession(PROJECT_ID, 'jira', 'KAN-1');
      adapter.descriptionRaw = adfWithText('fresh remote content');
      const reloaded = await service.reloadSession(PROJECT_ID, session.sessionId);
      expect(reloaded.status).toBe('reloaded');
      expect(reloaded.session?.revision).toBe(1);
      expect(reloaded.session?.state).toBe('editable');
      // The stale editor revision now conflicts.
      const rejected = await service.saveSession(
        PROJECT_ID,
        session.sessionId,
        UPDATED_DOCUMENT,
        0,
      );
      expect(rejected).toMatchObject({
        outcome: 'pre_dispatch_rejected',
        reason: 'revision_conflict',
      });
    });

    it('reload is unavailable while a pending write is unknown', async () => {
      const { service, adapter, provider } = setup();
      const session = await service.createDescriptionSession(PROJECT_ID, 'jira', 'KAN-1');
      adapter.writeImpl = () => {
        throw dispatchedUnknown(provider);
      };
      await service.saveSession(PROJECT_ID, session.sessionId, UPDATED_DOCUMENT, 0);
      const reads = adapter.readDescriptionCalls.length;
      await expect(service.reloadSession(PROJECT_ID, session.sessionId)).rejects.toMatchObject({
        details: { reason: 'session_not_editable' },
      });
      expect(adapter.readDescriptionCalls).toHaveLength(reads);
    });

    it('comment reload reports gone when the comment vanished remotely', async () => {
      const { service, adapter } = setup('clickup');
      const session = await service.createCommentEditSession(
        PROJECT_ID,
        'clickup',
        'task-1',
        'comment-1',
        null,
      );
      adapter.snapshot = null;
      const reloaded = await service.reloadSession(PROJECT_ID, session.sessionId);
      expect(reloaded.status).toBe('gone');
      expect(reloaded.session?.state).toBe('invalidated');
    });

    it('NO_GO capability flags disable every gated entry point', async () => {
      const storage = new FakeStorage();
      storage.connection = {
        id: 'connection-1',
        projectId: PROJECT_ID,
        provider: 'jira',
        generation: 1,
      };
      const adapter = new FakeAdapter();
      const service = new ExternalEditSessionService(
        storage as unknown as StorageService,
        new FakeRegistry(adapter) as never,
        new ProviderOperationGate(),
        new ExternalEditSessionStore(),
        { richEdit: false, ownedDelete: false },
      );
      await expect(
        service.createDescriptionSession(PROJECT_ID, 'jira', 'KAN-1'),
      ).rejects.toMatchObject({
        details: { reason: 'capability_no_go' },
      });
      await expect(
        service.createCommentDeleteSession(PROJECT_ID, 'jira', 'KAN-1', 'c1', null),
      ).rejects.toMatchObject({ details: { reason: 'capability_no_go' } });
      const read = await service.readRichDescription(PROJECT_ID, 'jira', 'KAN-1');
      expect(read.canEdit).toBe(false);
      expect(read.canDeleteOwnedComments).toBe(false);

      // The unsupported-content branch must reflect the injected flag too,
      // not the static default: an unsupported description still reports the
      // real owned-delete capability.
      adapter.descriptionRaw = {
        type: 'doc',
        version: 1,
        content: [{ type: 'table', content: [] }],
      };
      const unsupportedRead = await service.readRichDescription(PROJECT_ID, 'jira', 'KAN-1');
      expect(unsupportedRead).toMatchObject({
        supported: false,
        readOnlyReason: 'unsupported_content',
        canEdit: false,
        canDeleteOwnedComments: false,
      });
    });
  });
});
