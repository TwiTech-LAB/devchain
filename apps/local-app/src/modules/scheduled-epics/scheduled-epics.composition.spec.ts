import { readFileSync } from 'fs';
import { join } from 'path';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { ProjectsModule } from '../projects/projects.module';
import { ScheduledEpicsModule } from './scheduled-epics.module';
import { SCHEDULED_EPIC_RUNNER_REFRESH } from './services/scheduled-epics.service';

describe('ScheduledEpicsModule app root composition', () => {
  it('is imported in app.normal.module.ts', () => {
    const source = readFileSync(join(__dirname, '../../app.normal.module.ts'), 'utf-8');
    expect(source).toContain('ScheduledEpicsModule');
  });

  it('is imported in app.main.module.ts', () => {
    const source = readFileSync(join(__dirname, '../../app.main.module.ts'), 'utf-8');
    expect(source).toContain('ScheduledEpicsModule');
  });

  it('exports the runner refresh token for cross-module imports', () => {
    const exports =
      (Reflect.getMetadata(MODULE_METADATA.EXPORTS, ScheduledEpicsModule) as unknown[]) ?? [];

    expect(exports).toContain(SCHEDULED_EPIC_RUNNER_REFRESH);
  });

  it('makes the runner refresh token visible to ProjectsModule', () => {
    const imports =
      (Reflect.getMetadata(MODULE_METADATA.IMPORTS, ProjectsModule) as unknown[]) ?? [];

    expect(imports).toContain(ScheduledEpicsModule);
  });
});
