/**
 * Bootstrap integration test — full app root DI validation.
 *
 * Layer: backend-integration
 * Justification: NormalAppModule and MainAppModule root compilation is the
 * cheapest reliable layer that proves the Nest runtime container can resolve
 * the full app graph; metadata-only tests cannot catch provider visibility or
 * initialization-order regressions.
 */

import { AgentMessageDeliveryService } from '../modules/agent-message-delivery/agent-message-delivery.service';
import { McpService } from '../modules/mcp/services/mcp.service';
import { ProviderAdapterFactory } from '../modules/providers/adapters';
import { SessionsService } from '../modules/sessions/services/sessions.service';
import { STORAGE_SERVICE } from '../modules/storage/interfaces/storage.interface';
import { REALTIME_BROADCASTER } from '../modules/realtime/ports/realtime-broadcaster.port';
import { TerminalIOService } from '../modules/terminal/services/terminal-io/terminal-io.service';
import { OrchestratorProxyService } from '../modules/orchestrator/proxy/services/orchestrator-proxy.service';
import { AppBootstrapFixture, compileAppBootstrapFixture } from './test/app-bootstrap.helper';

jest.setTimeout(60_000);

describe('app root bootstrap fixtures', () => {
  const fixtures: AppBootstrapFixture[] = [];

  afterEach(async () => {
    while (fixtures.length) {
      await fixtures.pop()?.close();
    }
  });

  it('compiles NormalAppModule and exposes representative providers', async () => {
    const fixture = await compileAppBootstrapFixture('normal');
    fixtures.push(fixture);
    const { moduleRef } = fixture;

    expect(moduleRef.get(STORAGE_SERVICE)).toBeDefined();
    expect(moduleRef.get(TerminalIOService)).toBeDefined();
    expect(moduleRef.get(ProviderAdapterFactory)).toBeDefined();
    expect(moduleRef.get(REALTIME_BROADCASTER)).toBeDefined();
    expect(moduleRef.get(SessionsService)).toBeInstanceOf(SessionsService);
    expect(moduleRef.get(McpService)).toBeInstanceOf(McpService);
    expect(moduleRef.get(AgentMessageDeliveryService)).toBeInstanceOf(AgentMessageDeliveryService);
  });

  it('compiles MainAppModule and exposes representative providers', async () => {
    const fixture = await compileAppBootstrapFixture('main');
    fixtures.push(fixture);
    const { moduleRef } = fixture;

    expect(moduleRef.get(STORAGE_SERVICE)).toBeDefined();
    expect(moduleRef.get(TerminalIOService)).toBeDefined();
    expect(moduleRef.get(ProviderAdapterFactory)).toBeDefined();
    expect(moduleRef.get(REALTIME_BROADCASTER)).toBeDefined();
    expect(moduleRef.get(SessionsService)).toBeInstanceOf(SessionsService);
    expect(moduleRef.get(McpService)).toBeInstanceOf(McpService);
    expect(moduleRef.get(OrchestratorProxyService)).toBeInstanceOf(OrchestratorProxyService);
  });
});
