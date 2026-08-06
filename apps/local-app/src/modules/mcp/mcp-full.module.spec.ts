import { MODULE_METADATA } from '@nestjs/common/constants';
import { ProjectCommunicationModule } from '../project-communication/project-communication.module';
import { McpFullModule } from './mcp-full.module';

describe('McpFullModule', () => {
  it('imports the real project communication provider module', () => {
    const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, McpFullModule) as unknown[];

    expect(imports).toContain(ProjectCommunicationModule);
  });
});
