/**
 * Layer: module unit. Compiling the feature module in isolation is the cheapest
 * check that every constructor dependency is exported by an explicit import.
 */
import { Test } from '@nestjs/testing';
import { MetricsService } from '../metrics/services/metrics.service';
import { SessionReaderModule } from './session-reader.module';
import { SessionReaderService } from './services/session-reader.service';

describe('SessionReaderModule composition', () => {
  it('compiles standalone with its metrics dependency resolvable', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [SessionReaderModule],
    }).compile();

    expect(moduleRef.get(SessionReaderService)).toBeInstanceOf(SessionReaderService);
    expect(moduleRef.get(MetricsService)).toBeInstanceOf(MetricsService);

    await moduleRef.close();
  });
});
