import { MODULE_METADATA } from '@nestjs/common/constants';
import { MainAppModule } from '../app.main.module';
import { NormalAppModule } from '../app.normal.module';
import { TerminalModule } from '../modules/terminal/terminal.module';
import { SessionsModule } from '../modules/sessions/sessions.module';
import { ChatModule } from '../modules/chat/chat.module';
import { McpModule } from '../modules/mcp/mcp.module';
import { EpicsModule } from '../modules/epics/epics.module';
import { OrchestratorStorageModule } from '../modules/orchestrator/orchestrator-storage/orchestrator-storage.module';
import { OrchestratorDockerModule } from '../modules/orchestrator/docker/docker.module';
import { OrchestratorGitModule } from '../modules/orchestrator/git/git.module';
import { OrchestratorWorktreesModule } from '../modules/orchestrator/worktrees/worktrees.module';
import { OrchestratorSyncModule } from '../modules/orchestrator/sync/sync.module';
import { OrchestratorProxyModule } from '../modules/orchestrator/proxy/orchestrator-proxy.module';

describe('MainAppModule', () => {
  const mainImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, MainAppModule) ??
    []) as unknown[];
  const normalImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, NormalAppModule) ??
    []) as unknown[];

  it('loads normal modules that remain backend-enabled in main mode', () => {
    expect(mainImports).toContain(TerminalModule);
    expect(mainImports).toContain(SessionsModule);
    expect(mainImports).toContain(ChatModule);
    expect(mainImports).toContain(EpicsModule);
    expect(mainImports).toContain(McpModule);
  });

  it('loads orchestrator backend modules', () => {
    expect(mainImports).toContain(OrchestratorStorageModule);
    expect(mainImports).toContain(OrchestratorDockerModule);
    expect(mainImports).toContain(OrchestratorGitModule);
    expect(mainImports).toContain(OrchestratorWorktreesModule);
    expect(mainImports).toContain(OrchestratorSyncModule);
    expect(mainImports).toContain(OrchestratorProxyModule);
  });

  it('keeps normal root module unaffected', () => {
    expect(normalImports).not.toContain(OrchestratorStorageModule);
  });
});
