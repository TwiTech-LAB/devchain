import { MODULE_METADATA } from '@nestjs/common/constants';
import { SessionsMessageLogReadModule } from './sessions-message-log-read.module';
import { SessionsModule } from './sessions.module';
import { SessionsMessageLogReadFacade } from './services/sessions-message-log-read.facade';
import { SessionsMessagePoolService } from './services/sessions-message-pool.service';

describe('SessionsMessageLogReadModule', () => {
  it('imports SessionsModule and exports ONLY the narrow read facade', () => {
    const imports =
      (Reflect.getMetadata(MODULE_METADATA.IMPORTS, SessionsMessageLogReadModule) as unknown[]) ??
      [];
    const providers =
      (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, SessionsMessageLogReadModule) as unknown[]) ??
      [];
    const exports =
      (Reflect.getMetadata(MODULE_METADATA.EXPORTS, SessionsMessageLogReadModule) as unknown[]) ??
      [];

    expect(imports).toEqual([SessionsModule]);
    expect(providers).toEqual([SessionsMessageLogReadFacade]);
    expect(exports).toEqual([SessionsMessageLogReadFacade]);
    // Guard: the heavy pool service must NEVER leak out of this narrow module.
    expect(exports).not.toEqual(expect.arrayContaining([SessionsMessagePoolService]));
  });
});
