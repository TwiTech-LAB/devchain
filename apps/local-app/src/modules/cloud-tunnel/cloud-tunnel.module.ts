import { Module } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { CloudModule } from '../cloud/cloud.module';
import { StorageModule } from '../storage/storage.module';
import { SessionsReadModule } from '../sessions/sessions-read.module';
import { SessionsLifecycleModule } from '../sessions/sessions-lifecycle.module';
import { SessionReaderModule } from '../session-reader/session-reader.module';
import { AgentMessageDeliveryModule } from '../agent-message-delivery/agent-message-delivery.module';
import { SessionsMessageLogReadModule } from '../sessions/sessions-message-log-read.module';
import { TeamsModule } from '../teams/teams.module';
import { EpicsModule } from '../epics/epics.module';
import { HooksModule } from '../hooks/hooks.module';
import { TerminalViewportModule } from '../terminal/terminal-viewport.module';
import { TerminalKeyInputModule } from '../terminal/terminal-key-input.module';
import { E2eeModule } from '../e2ee/e2ee.module';
import { TunnelKeypairService } from './services/tunnel-keypair.service';
import { TunnelHandlerService } from './services/tunnel-handler.service';
import { TunnelRpcCryptoService, E2EE_REQUIRED_POLICY } from './services/tunnel-rpc-crypto.service';
import { TunnelPushCryptoService } from './services/tunnel-push-crypto.service';
import { TunnelViewportCryptoService } from './services/tunnel-viewport-crypto.service';
import { TunnelClientService } from './services/tunnel-client.service';
import { TunnelEventForwarderService } from './services/tunnel-event-forwarder.service';
import { AskUserQuestionPushGateService } from './services/ask-user-question-push-gate.service';
import { MobileChatRpcService } from './services/mobile-chat-rpc.service';
import { MobileBoardRpcService } from './services/mobile-board-rpc.service';
import { LifecycleOperationTracker } from './services/lifecycle-operation-tracker';
import { ViewportStreamerService } from './services/viewport-streamer.service';
import { ViewportFrameSink } from './services/viewport-frame-sink';

@Module({
  // Mobile chat composes domain services through the *narrowest* facade modules
  // only — never HTTP controllers and never ChatModule (thread-free by design).
  // This makes CloudTunnelModule a leaf/transitive consumer of the allowlisted
  // Sessions↔Terminal SCC; see docs/cycle-allowlist.md.
  //   - SessionsReadModule        → ActiveSessionLookup (presence + ownership)
  //   - SessionReaderModule       → SessionReaderService (transcripts)
  //   - SessionsLifecycleModule   → SessionLifecycleFacade (launch/restart/restore/terminate)
  //   - AgentMessageDeliveryModule→ AgentMessageDeliveryService (thread-free send)
  imports: [
    CloudModule,
    StorageModule,
    SessionsReadModule,
    SessionsLifecycleModule,
    SessionReaderModule,
    AgentMessageDeliveryModule,
    // NARROW message-log read facade (SessionsMessageLogReadFacade only) for
    // chat.getPendingMessages. Imported instead of SessionsModule wholesale so
    // CloudTunnel never depends on SessionsMessagePoolService directly.
    SessionsMessageLogReadModule,
    TeamsModule,
    // Board mutations + comments route through EpicsService (events/invariants).
    // EpicsModule exports EpicsService and pulls Teams + AMD transitively (an SCC
    // CloudTunnel already participates in) — no NEW cycle (madge:check clean).
    EpicsModule,
    // PendingAskUserQuestionService (the in-memory store HooksService writes to on
    // a PreToolUse(AskUserQuestion) hook) is consumed by chat.listPendingAskQuestions
    // + cleared on send. Imported (not re-provided) so mobile reads the SAME
    // singleton the hooks write — re-providing would create a divergent instance.
    // HooksModule only adds StorageModule + EventsCoreModule edges (no new cycle).
    HooksModule,
    // NARROW viewport facade (TerminalViewportFacade only) for the live tmux viewport
    // streamer. Imported instead of TerminalModule wholesale so CloudTunnel stays a
    // leaf/transitive consumer of the Sessions↔Terminal SCC (docs/cycle-allowlist.md).
    TerminalViewportModule,
    // NARROW key-input facade (TerminalKeyInputFacade only) for discrete mobile key presses
    // (terminal.sendKey). Same leaf-consumer rationale as TerminalViewportModule above;
    // TerminalIOService is never injected into CloudTunnel — the facade owns the tmux send.
    TerminalKeyInputModule,
    // E2EE keypair (public-key export only) so the attest handshake can advertise this
    // PC's capability + X25519 public key for relayed delivery (Task:5). E2eeModule is a
    // DbModule-only leaf — no import cycle.
    E2eeModule,
  ],
  providers: [
    TunnelKeypairService,
    TunnelHandlerService,
    // RPC transport encryption seam (Phase 2): seals params/result around the handler,
    // decrypt-then-auth. Consumes E2eeKeypairService + E2eeDeviceStoreService (E2eeModule).
    TunnelRpcCryptoService,
    // Push transport encryption seam (Phase 3, Task:1): seals the push `payload` for the
    // paired mobile and decides the content-bearing guard mode. Consumes E2eeKeypairService +
    // E2eeDeviceStoreService (E2eeModule) — same key model as the RPC seam.
    TunnelPushCryptoService,
    // Viewport transport encryption seam (Phase 4, Task:1): seals the full tmux screen so the
    // bridge relays/buffers it opaque. Same key model + E2eeModule deps as the push seam.
    TunnelViewportCryptoService,
    // PC-side E2EE-required policy (Phase 2, Task:2): env-gated gradual-rollout flag. When
    // true, plaintext RPC params are rejected (fail closed) AND push to an incapable peer is
    // blocked. Default false = mixed-client.
    { provide: E2EE_REQUIRED_POLICY, useFactory: () => process.env.E2EE_REQUIRED === 'true' },
    TunnelClientService,
    TunnelEventForwarderService,
    AskUserQuestionPushGateService,
    MobileChatRpcService,
    MobileBoardRpcService,
    LifecycleOperationTracker,
    ViewportStreamerService,
    // Dependency-inversion binding: the viewport streamer pushes frames through the
    // ViewportFrameSink abstraction. The factory depends ONLY on ModuleRef and resolves the
    // concrete TunnelClientService LAZILY (at first send / onPushReady), so there is no
    // construction-time DI cycle (TunnelClient → TunnelHandler → ViewportStreamer →
    // ViewportFrameSink → ModuleRef) and the import graph stays acyclic.
    {
      provide: ViewportFrameSink,
      useFactory: (moduleRef: ModuleRef): ViewportFrameSink => ({
        sendViewport: (frame) =>
          moduleRef.get(TunnelClientService, { strict: false }).sendViewport(frame),
        onPushReady: (listener) =>
          moduleRef.get(TunnelClientService, { strict: false }).onPushReady(listener),
        getInstanceId: () => moduleRef.get(TunnelClientService, { strict: false }).getInstanceId(),
      }),
      inject: [ModuleRef],
    },
  ],
})
export class CloudTunnelModule {}
