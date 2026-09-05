import 'reflect-metadata';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { MainAppModule } from '../../app.main.module';
import { NormalAppModule } from '../../app.normal.module';
import { EpicTimeModule } from './epic-time.module';
import { AgentTimeBufferController } from './controllers/agent-time-buffer.controller';
import { ExternalEstimateLogController } from './controllers/external-estimate-log.controller';
import { ExternalIntegrationsModule } from '../external-integrations/external-integrations.module';

// Layer: backend unit. Nest module metadata directly proves runtime admission
// without booting either complete application graph.
describe('EpicTimeModule admission', () => {
  it('is loaded by the main runtime and excluded from normal child runtimes', () => {
    const mainImports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, MainAppModule) as unknown[];
    const normalImports = Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      NormalAppModule,
    ) as unknown[];

    expect(mainImports).toContain(EpicTimeModule);
    expect(normalImports).not.toContain(EpicTimeModule);
  });

  it('owns the one-way dependency on external integrations', () => {
    const epicTimeImports = Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      EpicTimeModule,
    ) as unknown[];
    const integrationImports = Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      ExternalIntegrationsModule,
    ) as unknown[];

    expect(epicTimeImports).toContain(ExternalIntegrationsModule);
    expect(integrationImports).not.toContain(EpicTimeModule);
  });

  it('hosts the guarded estimate-log routes while keeping hosting invisible to clients', () => {
    const controllers = Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      EpicTimeModule,
    ) as unknown[];

    expect(controllers).toContain(ExternalEstimateLogController);
  });

  it('hosts the agent time buffer routes', () => {
    const controllers = Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      EpicTimeModule,
    ) as unknown[];

    expect(controllers).toContain(AgentTimeBufferController);
  });
});
