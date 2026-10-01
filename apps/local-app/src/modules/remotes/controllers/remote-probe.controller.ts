import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { createLogger } from '../../../common/logging/logger';
import {
  ProbeAddressSchema,
  type ProbeResultDto,
  type RemoteReadinessDto,
} from '../dtos/remote-probe.dto';
import { RemoteProbeService } from '../services/remote-probe.service';

const logger = createLogger('RemoteProbeController');

/** Checks the Remote VMs page runs before it starts anything; neither route writes. */
@Controller('api/remotes')
export class RemoteProbeController {
  constructor(private readonly probeService: RemoteProbeService) {}

  /** What answers at an address: DevChain, the installer, or nothing. */
  @Post('probe')
  @HttpCode(200)
  probe(@Body() body: unknown): Promise<ProbeResultDto> {
    const input = ProbeAddressSchema.parse(body);
    logger.info({ address: input.address, checkSsh: input.checkSsh }, 'POST /api/remotes/probe');
    return this.probeService.probe(input);
  }

  /** Whether this PC can set up a VM: Syncthing, identity and Docker. */
  @Get('readiness')
  readiness(): Promise<RemoteReadinessDto> {
    logger.info('GET /api/remotes/readiness');
    return this.probeService.readiness();
  }
}
