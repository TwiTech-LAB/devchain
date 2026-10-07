import { ViewportStreamerService } from './viewport-streamer.service';
import type { ActiveSessionLookup } from '../../sessions/services/active-session-lookup.service';
import type { TerminalViewportFacade } from '../../terminal/services/terminal-viewport/terminal-viewport.facade';
import type { ViewportCapture } from '../../terminal/services/terminal-viewport/terminal-viewport.facade';
import type { ViewportFrameSink } from './viewport-frame-sink';
import type {
  TunnelViewportCryptoService,
  ViewportChannel,
  ViewportChannelMode,
} from './tunnel-viewport-crypto.service';
import { ForbiddenError, NotFoundError } from '../../../common/errors/error-types';
import type { E2eeEnvelope, TunnelViewportFrame, ViewportScreen } from '@devchain/shared';

const SESSION_ID = 'sess-1';
const PROJECT_ID = 'proj-1';
const WORKSPACE_ID = 'workspace-1';
const INSTANCE_ID = 'inst-vp-1';
const OWNER_KID = 'device-kid';

/** A sentinel sealed-envelope the sealScreen mock wraps the screen in. */
const sealedEnvelope = (screen: ViewportScreen): E2eeEnvelope & { __screen: ViewportScreen } => ({
  v: 1,
  kid: 'pc-kid',
  alg: 'XC20P',
  nonce: 'n',
  ct: 'c',
  __screen: screen,
});

const SCREEN_A: ViewportCapture = {
  lines: ['row-0', 'row-1', 'row-2'],
  cursor: { x: 0, y: 0 },
  cols: 80,
  rows: 24,
};

function build(
  opts: {
    scope?: { sessionId: string; agentId: string | null; projectId: string } | null;
    hasSession?: boolean;
    canSend?: boolean;
    channelMode?: ViewportChannelMode;
    instanceId?: string | null;
    multiWorkspaceMode?: boolean;
    allowedWorkspaceIds?: string[];
  } = {},
) {
  const dataListeners: Array<() => void> = [];
  const readyListeners: Array<() => void> = [];
  const detachData = jest.fn();
  const channelMode: ViewportChannelMode = opts.channelMode ?? 'plaintext';

  const sealScreen = jest.fn(async (_sessionId: string, _seq: number, screen: ViewportScreen) =>
    sealedEnvelope(screen),
  );
  const viewportCrypto = {
    resolveViewportChannel: jest.fn(
      async (): Promise<ViewportChannel> =>
        channelMode === 'encrypted'
          ? { mode: 'encrypted', reason: 'both-capable', sealScreen: sealScreen as never }
          : {
              mode: channelMode,
              reason: channelMode === 'blocked' ? 'peer-incapable-required' : 'plaintext-mixed',
            },
    ),
  } as unknown as TunnelViewportCryptoService;

  const activeSessions = {
    getSessionProjectScope: jest
      .fn()
      .mockResolvedValue(
        opts.scope === undefined
          ? { sessionId: SESSION_ID, agentId: null, projectId: PROJECT_ID }
          : opts.scope,
      ),
  } as unknown as ActiveSessionLookup;

  const capture = jest.fn<Promise<ViewportCapture | null>, []>();
  const terminalViewport = {
    hasSession: jest.fn().mockReturnValue(opts.hasSession ?? true),
    capture,
    onData: jest.fn((_sessionId: string, listener: () => void) => {
      dataListeners.push(listener);
      return detachData;
    }),
  } as unknown as TerminalViewportFacade;

  const sent: TunnelViewportFrame[] = [];
  const sink = {
    sendViewport: jest.fn((frame: TunnelViewportFrame) => {
      const canSend = opts.canSend ?? true;
      if (canSend) sent.push(frame);
      return canSend;
    }),
    onPushReady: jest.fn((cb: () => void) => {
      readyListeners.push(cb);
      return jest.fn();
    }),
    getInstanceId: jest.fn(() => (opts.instanceId === undefined ? INSTANCE_ID : opts.instanceId)),
  } as unknown as ViewportFrameSink;

  const storage = {
    getProject: jest.fn().mockResolvedValue({ id: PROJECT_ID, workspaceId: WORKSPACE_ID }),
  };
  const deviceAccess = {
    getAccess: jest.fn((kid: string) => ({
      kid,
      explicit: true,
      workspaceIds: opts.allowedWorkspaceIds ?? [WORKSPACE_ID],
    })),
  };
  let modeCleanup: (() => void | Promise<void>) | null = null;
  const modeSnapshot = {
    multiWorkspaceMode: opts.multiWorkspaceMode ?? false,
    failClosedPending: false,
  };
  const workspaceMode = {
    getSnapshot: jest.fn(async () => ({ ...modeSnapshot })),
    registerCleanupHook: jest.fn((_name: string, hook: () => void | Promise<void>) => {
      modeCleanup = hook;
      return jest.fn();
    }),
  };

  const service = new ViewportStreamerService(
    activeSessions,
    terminalViewport,
    sink,
    viewportCrypto,
    storage as never,
    deviceAccess as never,
    workspaceMode as never,
  );
  service.onModuleInit();

  return {
    service,
    activeSessions,
    terminalViewport,
    sink,
    viewportCrypto,
    sealScreen,
    capture,
    detachData,
    storage,
    deviceAccess,
    modeSnapshot,
    sent,
    fireData: () => dataListeners.forEach((l) => l()),
    fireReady: () => readyListeners.forEach((l) => l()),
    runModeCleanup: async () => modeCleanup?.(),
  };
}

describe('ViewportStreamerService', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  describe('subscribe — source-side auth before streaming', () => {
    it('throws SESSION_NOT_RUNNING when there is no live terminal session', async () => {
      const h = build({ hasSession: false });
      await expect(
        h.service.subscribe({ sessionId: SESSION_ID, projectId: PROJECT_ID }),
      ).rejects.toMatchObject({ code: 'SESSION_NOT_RUNNING' });
      expect(h.sink.sendViewport).not.toHaveBeenCalled();
    });

    // ── Phase 4 Task:2 — auth runs BEFORE any crypto resolution ───────────────
    // Layer: local-app MODULE UNIT (mocked ActiveSessionLookup + crypto service).
    // Why cheapest: source-side ownership is a local-app invariant — the bridge
    // can't observe whether `assertSessionInProject` ran before `resolveViewportChannel`,
    // and an integration test would add SQLite + WebSocket flake without strengthening
    // the assertion. This is the only layer that can prove the encrypted lane is never
    // touched (no key resolution, no seal) when the session is unowned/cross-project,
    // so a future refactor that re-orders the checks would fail LOUDLY here.
    it('rejects an unknown session BEFORE any crypto resolution (encrypted lane untouched)', async () => {
      const h = build({ scope: null, channelMode: 'encrypted' });
      await expect(
        h.service.subscribe({ sessionId: SESSION_ID, projectId: PROJECT_ID }),
      ).rejects.toBeInstanceOf(NotFoundError);
      // Source-side auth ran before any streaming AND before any crypto work — the
      // encrypted lane resolver + seal were never invoked, so no key material was
      // touched for a session the caller doesn't own.
      expect(h.terminalViewport.onData).not.toHaveBeenCalled();
      expect(h.viewportCrypto.resolveViewportChannel).not.toHaveBeenCalled();
      expect(h.sealScreen).not.toHaveBeenCalled();
      expect(h.sink.sendViewport).not.toHaveBeenCalled();
    });

    it('rejects a cross-project session BEFORE any crypto resolution (encrypted lane untouched)', async () => {
      const h = build({
        scope: { sessionId: SESSION_ID, agentId: null, projectId: 'other-project' },
        channelMode: 'encrypted',
      });
      await expect(
        h.service.subscribe({ sessionId: SESSION_ID, projectId: PROJECT_ID }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(h.viewportCrypto.resolveViewportChannel).not.toHaveBeenCalled();
      expect(h.sealScreen).not.toHaveBeenCalled();
      expect(h.sink.sendViewport).not.toHaveBeenCalled();
    });
  });

  describe('streaming', () => {
    it('sends a FULL screen (seq 0) on subscribe and returns a subscriptionId', async () => {
      const h = build();
      h.capture.mockResolvedValueOnce(SCREEN_A);

      const result = await h.service.subscribe({ sessionId: SESSION_ID, projectId: PROJECT_ID });

      expect(result).toEqual({ subscriptionId: 'vp-1' });
      expect(h.service.resolveSubscriptionProjectId(result.subscriptionId)).toBe(PROJECT_ID);
      expect(h.sent).toHaveLength(1);
      expect(h.sent[0]).toMatchObject({
        type: 'viewport',
        v: 1,
        subscriptionId: 'vp-1',
        sessionId: SESSION_ID,
        seq: 0,
        body: { kind: 'full', screen: SCREEN_A },
      });
    });

    it('emits a line DIFF (seq 1) with only changed rows + moved cursor on new PTY bytes', async () => {
      const h = build();
      h.capture.mockResolvedValueOnce(SCREEN_A);
      await h.service.subscribe({ sessionId: SESSION_ID, projectId: PROJECT_ID });

      h.capture.mockResolvedValueOnce({
        lines: ['row-0', 'CHANGED', 'row-2'],
        cursor: { x: 5, y: 1 },
        cols: 80,
        rows: 24,
      });
      h.fireData();
      await jest.advanceTimersByTimeAsync(400);

      expect(h.sent).toHaveLength(2);
      expect(h.sent[1]).toMatchObject({
        seq: 1,
        body: {
          kind: 'diff',
          changedLines: [{ row: 1, text: 'CHANGED' }],
          cursor: { x: 5, y: 1 },
        },
      });
    });

    it('re-anchors with a FULL when geometry changes', async () => {
      const h = build();
      h.capture.mockResolvedValueOnce(SCREEN_A);
      await h.service.subscribe({ sessionId: SESSION_ID, projectId: PROJECT_ID });

      h.capture.mockResolvedValueOnce({ ...SCREEN_A, cols: 100 });
      h.fireData();
      await jest.advanceTimersByTimeAsync(400);

      expect(h.sent[1].body.kind).toBe('full');
    });

    it('sends nothing (no seq bump) when the screen is unchanged', async () => {
      const h = build();
      h.capture.mockResolvedValueOnce(SCREEN_A);
      await h.service.subscribe({ sessionId: SESSION_ID, projectId: PROJECT_ID });

      h.capture.mockResolvedValueOnce(SCREEN_A); // identical
      h.fireData();
      await jest.advanceTimersByTimeAsync(400);

      expect(h.sent).toHaveLength(1); // only the initial full
    });

    it('does not advance seq when the tunnel cannot send (re-anchors later)', async () => {
      const h = build({ canSend: false });
      h.capture.mockResolvedValue(SCREEN_A);

      await h.service.subscribe({ sessionId: SESSION_ID, projectId: PROJECT_ID });
      expect(h.sent).toHaveLength(0); // send refused
      // sendViewport was still attempted with seq 0
      expect(h.sink.sendViewport).toHaveBeenCalledWith(
        expect.objectContaining({ seq: 0, body: expect.objectContaining({ kind: 'full' }) }),
      );
    });

    it('coalesces a burst of PTY data into a single throttled capture (~fps ceiling)', async () => {
      const h = build();
      h.capture.mockResolvedValue(SCREEN_A);
      await h.service.subscribe({ sessionId: SESSION_ID, projectId: PROJECT_ID });
      h.capture.mockClear();

      h.fireData();
      h.fireData();
      h.fireData(); // 3 bytes-arrived signals in one window
      await jest.advanceTimersByTimeAsync(400);

      // One coalesced capture, not three.
      expect(h.capture).toHaveBeenCalledTimes(1);
    });
  });

  describe('lifecycle', () => {
    it('unsubscribe of an unknown subscriptionId returns { ok: false }', () => {
      const h = build();
      expect(h.service.unsubscribe({ subscriptionId: 'nope' })).toEqual({ ok: false });
    });

    it('makes unsubscribe by another kid a non-enumerating no-op', async () => {
      const h = build({ channelMode: 'encrypted' });
      h.capture.mockResolvedValueOnce(SCREEN_A);
      const { subscriptionId } = await h.service.subscribe(
        { sessionId: SESSION_ID, projectId: PROJECT_ID },
        { senderKid: OWNER_KID },
      );

      expect(h.service.unsubscribe({ subscriptionId }, { senderKid: 'other-kid' })).toEqual({
        ok: false,
      });
      expect(h.detachData).not.toHaveBeenCalled();
      expect(h.service.unsubscribe({ subscriptionId }, { senderKid: OWNER_KID })).toEqual({
        ok: true,
      });
    });

    it('keeps same-session leases independently bound across two-kid reconnects', async () => {
      const h = build({ channelMode: 'encrypted' });
      h.capture.mockResolvedValue(SCREEN_A);
      const first = await h.service.subscribe(
        { sessionId: SESSION_ID, projectId: PROJECT_ID },
        { senderKid: 'kid-one' },
      );
      const second = await h.service.subscribe(
        { sessionId: SESSION_ID, projectId: PROJECT_ID },
        { senderKid: 'kid-two' },
      );

      expect(h.viewportCrypto.resolveViewportChannel).toHaveBeenCalledWith(INSTANCE_ID, 'kid-one');
      expect(h.viewportCrypto.resolveViewportChannel).toHaveBeenCalledWith(INSTANCE_ID, 'kid-two');
      expect(h.service.unsubscribe(first, { senderKid: 'kid-two' })).toEqual({ ok: false });
      expect(h.service.unsubscribe(second, { senderKid: 'kid-two' })).toEqual({ ok: true });
      expect(h.service.unsubscribe(first, { senderKid: 'kid-one' })).toEqual({ ok: true });
    });

    it('tears down a subscription when the session ends mid-stream', async () => {
      const h = build();
      h.capture.mockResolvedValueOnce(SCREEN_A);
      await h.service.subscribe({ sessionId: SESSION_ID, projectId: PROJECT_ID });

      // Next capture returns null AND the session is gone → teardown.
      h.capture.mockResolvedValueOnce(null);
      (h.terminalViewport.hasSession as jest.Mock).mockReturnValue(false);
      h.fireData();
      await jest.advanceTimersByTimeAsync(400);

      expect(h.detachData).toHaveBeenCalledTimes(1);
    });

    it('re-anchors all live subscriptions with a FULL on tunnel (re)connect', async () => {
      const h = build();
      h.capture.mockResolvedValueOnce(SCREEN_A);
      await h.service.subscribe({ sessionId: SESSION_ID, projectId: PROJECT_ID });
      expect(h.sent).toHaveLength(1);

      // Tunnel reconnects → next capture must be a fresh full (lastScreen reset).
      h.capture.mockResolvedValueOnce(SCREEN_A);
      h.fireReady();
      await jest.advanceTimersByTimeAsync(400);

      expect(h.sent).toHaveLength(2);
      expect(h.sent[1].body.kind).toBe('full');
      expect(h.sent[1].seq).toBe(1);
    });

    it('onModuleDestroy tears down every active subscription', async () => {
      const h = build();
      h.capture.mockResolvedValueOnce(SCREEN_A);
      await h.service.subscribe({ sessionId: SESSION_ID, projectId: PROJECT_ID });

      h.service.onModuleDestroy();
      expect(h.detachData).toHaveBeenCalledTimes(1);
    });
  });

  describe('E2EE viewport (Phase 4) — full-frame-only sealing + guard', () => {
    it('seals the initial screen as an `enc-full` body when the lane is encrypted', async () => {
      const h = build({ channelMode: 'encrypted' });
      h.capture.mockResolvedValueOnce(SCREEN_A);

      await h.service.subscribe(
        { sessionId: SESSION_ID, projectId: PROJECT_ID },
        { senderKid: OWNER_KID },
      );

      expect(h.sent).toHaveLength(1);
      expect(h.sent[0]).toMatchObject({ type: 'viewport', v: 1, seq: 0 });
      expect(h.sent[0].body).toMatchObject({
        kind: 'enc-full',
        enc: { alg: 'XC20P', __screen: SCREEN_A },
      });
      // AAD bound to sessionId + the frame seq.
      expect(h.sealScreen).toHaveBeenCalledWith(SESSION_ID, 0, SCREEN_A);
    });

    it('sends a fresh `enc-full` (NOT a diff) on a changed screen — full-frame-only', async () => {
      const h = build({ channelMode: 'encrypted' });
      h.capture.mockResolvedValueOnce(SCREEN_A);
      await h.service.subscribe(
        { sessionId: SESSION_ID, projectId: PROJECT_ID },
        { senderKid: OWNER_KID },
      );

      h.capture.mockResolvedValueOnce({
        lines: ['row-0', 'CHANGED', 'row-2'],
        cursor: { x: 5, y: 1 },
        cols: 80,
        rows: 24,
      });
      h.fireData();
      await jest.advanceTimersByTimeAsync(400);

      expect(h.sent).toHaveLength(2);
      expect(h.sent[1].body.kind).toBe('enc-full');
      expect(h.sent[1].seq).toBe(1);
    });

    it('still skips an unchanged screen when encrypted (no seq bump, no re-seal)', async () => {
      const h = build({ channelMode: 'encrypted' });
      h.capture.mockResolvedValueOnce(SCREEN_A);
      await h.service.subscribe(
        { sessionId: SESSION_ID, projectId: PROJECT_ID },
        { senderKid: OWNER_KID },
      );
      h.sealScreen.mockClear();

      h.capture.mockResolvedValueOnce(SCREEN_A); // identical
      h.fireData();
      await jest.advanceTimersByTimeAsync(400);

      expect(h.sent).toHaveLength(1);
      expect(h.sealScreen).not.toHaveBeenCalled();
    });

    it('WITHHOLDS the frame entirely when E2EE is required but the peer is not capable (blocked)', async () => {
      const h = build({ channelMode: 'blocked' });
      h.capture.mockResolvedValueOnce(SCREEN_A);

      await expect(
        h.service.subscribe({ sessionId: SESSION_ID, projectId: PROJECT_ID }),
      ).rejects.toMatchObject({ code: 'VIEWPORT_E2EE_UNAVAILABLE' });

      // Terminal content must never ship plaintext when E2EE is required.
      expect(h.sink.sendViewport).not.toHaveBeenCalled();
      expect(h.sent).toHaveLength(0);
    });

    it('requires a sender kid before subscribing in multi-workspace mode', async () => {
      const h = build({ multiWorkspaceMode: true });
      await expect(
        h.service.subscribe({ sessionId: SESSION_ID, projectId: PROJECT_ID }),
      ).rejects.toMatchObject({
        details: expect.objectContaining({ code: 'WORKSPACE_DEVICE_PAIRING_REQUIRED' }),
      });
      expect(h.terminalViewport.capture).not.toHaveBeenCalled();
    });

    it('tears down an ownerless lease before workspace-mode prepare can acknowledge', async () => {
      const h = build();
      h.capture.mockResolvedValueOnce(SCREEN_A);
      await h.service.subscribe({ sessionId: SESSION_ID, projectId: PROJECT_ID });

      h.modeSnapshot.failClosedPending = true;
      await h.runModeCleanup();
      expect(h.detachData).toHaveBeenCalledTimes(1);
    });

    it('rechecks the current project workspace before a later emission', async () => {
      const h = build({ channelMode: 'encrypted' });
      h.capture.mockResolvedValueOnce(SCREEN_A);
      await h.service.subscribe(
        { sessionId: SESSION_ID, projectId: PROJECT_ID },
        { senderKid: OWNER_KID },
      );

      h.storage.getProject.mockResolvedValue({ id: PROJECT_ID, workspaceId: 'moved-workspace' });
      h.capture.mockResolvedValueOnce({ ...SCREEN_A, lines: ['changed'] });
      h.fireData();
      await jest.advanceTimersByTimeAsync(400);

      expect(h.sent).toHaveLength(1);
      expect(h.detachData).toHaveBeenCalledTimes(1);
    });

    it('rechecks global mode on capture even if the transition cleanup hook did not run', async () => {
      const h = build();
      h.capture.mockResolvedValueOnce(SCREEN_A);
      await h.service.subscribe({ sessionId: SESSION_ID, projectId: PROJECT_ID });

      h.modeSnapshot.multiWorkspaceMode = true;
      h.capture.mockResolvedValueOnce({ ...SCREEN_A, lines: ['changed'] });
      h.fireData();
      await jest.advanceTimersByTimeAsync(400);

      expect(h.sent).toHaveLength(1);
      expect(h.detachData).toHaveBeenCalledTimes(1);
    });

    it('rechecks the exact owner grant before every later emission', async () => {
      const allowedWorkspaceIds = [WORKSPACE_ID];
      const h = build({ channelMode: 'encrypted', allowedWorkspaceIds });
      h.capture.mockResolvedValueOnce(SCREEN_A);
      await h.service.subscribe(
        { sessionId: SESSION_ID, projectId: PROJECT_ID },
        { senderKid: OWNER_KID },
      );

      allowedWorkspaceIds.splice(0);
      h.capture.mockResolvedValueOnce({ ...SCREEN_A, lines: ['changed'] });
      h.fireData();
      await jest.advanceTimersByTimeAsync(400);

      expect(h.sent).toHaveLength(1);
      expect(h.detachData).toHaveBeenCalledTimes(1);
    });

    it('immediately ends idle leases on grant removal, revoke, and project move events', async () => {
      const h = build({ channelMode: 'encrypted' });
      h.capture.mockResolvedValue(SCREEN_A);
      await h.service.subscribe(
        { sessionId: SESSION_ID, projectId: PROJECT_ID },
        { senderKid: OWNER_KID },
      );
      h.service.handleDeviceAccessRevoked({
        deviceKid: OWNER_KID,
        reason: 'workspace-access-updated',
        workspaceIds: [WORKSPACE_ID],
      });
      expect(h.detachData).toHaveBeenCalledTimes(1);

      const h2 = build({ channelMode: 'encrypted' });
      h2.capture.mockResolvedValue(SCREEN_A);
      await h2.service.subscribe(
        { sessionId: SESSION_ID, projectId: PROJECT_ID },
        { senderKid: OWNER_KID },
      );
      h2.service.handleProjectWorkspaceChanged({
        projectId: PROJECT_ID,
        previousWorkspaceId: WORKSPACE_ID,
        workspaceId: 'moved-workspace',
      });
      expect(h2.detachData).toHaveBeenCalledTimes(1);

      const h3 = build({ channelMode: 'encrypted' });
      h3.capture.mockResolvedValue(SCREEN_A);
      await h3.service.subscribe(
        { sessionId: SESSION_ID, projectId: PROJECT_ID },
        { senderKid: OWNER_KID },
      );
      h3.service.handleDeviceAccessRevoked({
        deviceKid: OWNER_KID,
        reason: 'device-revoked',
      });
      expect(h3.detachData).toHaveBeenCalledTimes(1);
    });
  });

  // Cross-cutting MobileLiveViewport invariants (Task 7) — defense-in-depth on the
  // design guarantees a future refactor must never silently break: no mobile resize,
  // and the shared PTY/tmux pane outliving every viewport subscriber.
  describe('invariants (cross-cutting)', () => {
    it('no mobile resize: cols/rows on subscribe are ignored — capture uses the fixed pane geometry', async () => {
      const h = build();
      h.capture.mockResolvedValueOnce(SCREEN_A); // pane is 80×24

      // Mobile passes cols/rows; v1 has a single shared tmux pane and NO mobile resize.
      await h.service.subscribe({
        sessionId: SESSION_ID,
        projectId: PROJECT_ID,
        cols: 999,
        rows: 40,
      });

      // capture() is invoked with ONLY the sessionId — no dimensions are ever forwarded,
      // so nothing on this path can drive a tmux resize-pane.
      expect(h.terminalViewport.capture).toHaveBeenCalledTimes(1);
      expect(h.terminalViewport.capture).toHaveBeenCalledWith(SESSION_ID);
      // The emitted full screen carries the CAPTURED geometry (80×24), not the request (999×40).
      expect(h.sent).toHaveLength(1);
      expect(h.sent[0].body).toMatchObject({ kind: 'full', screen: { cols: 80, rows: 24 } });
    });

    it('PTY survives the LAST viewport unsubscribe: session stays live, further bytes are ignored (no re-capture)', async () => {
      const h = build();
      h.capture.mockResolvedValue(SCREEN_A);
      const { subscriptionId } = await h.service.subscribe({
        sessionId: SESSION_ID,
        projectId: PROJECT_ID,
      });
      expect(h.sent).toHaveLength(1); // initial full

      // The only subscriber leaves. Teardown DETACHES the read-only data listener — it
      // never kills the PTY (the streamer is a read-only consumer of the shared pane).
      expect(h.service.unsubscribe({ subscriptionId })).toEqual({ ok: true });
      expect(h.detachData).toHaveBeenCalledTimes(1);

      // The terminal session is still live for the web/other consumers...
      expect(h.terminalViewport.hasSession(SESSION_ID)).toBe(true);

      // ...and any further PTY output after the last unsubscribe is ignored: no capture,
      // no extra frame (the disposed subscription drops the data-gated trigger).
      h.capture.mockClear();
      h.fireData();
      await jest.advanceTimersByTimeAsync(400);
      expect(h.capture).not.toHaveBeenCalled();
      expect(h.sent).toHaveLength(1);
    });
  });
});
