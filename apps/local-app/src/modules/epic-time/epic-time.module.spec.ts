import 'reflect-metadata';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { MainAppModule } from '../../app.main.module';
import { NormalAppModule } from '../../app.normal.module';
import { EpicTimeModule } from './epic-time.module';

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
});
