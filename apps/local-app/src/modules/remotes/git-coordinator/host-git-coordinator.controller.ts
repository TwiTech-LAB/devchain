import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { HostProjectIdSchema } from '../host/host.dto';
import { hostRoutes } from '../contract/host-routes';
import type { HostHandlerResponse } from '../contract/host-routes';
import { GitCoordinatorService } from './git-coordinator.service';
import type { GitCoordinatorRecord } from './git-coordinator.dto';

@ApiTags('Host Git coordinator')
@Controller('api/host/projects/:id/git-coordinator')
export class HostGitCoordinatorController {
  constructor(private readonly coordinator: GitCoordinatorService) {}

  @Get()
  @ApiOperation({ summary: 'Read authoritative VM Git ownership and its journal' })
  @ApiOkResponse({ description: 'Durable coordinator record' })
  status(
    @Param('id') id: string,
  ): Promise<HostHandlerResponse<typeof hostRoutes.gitCoordinatorStatus, 200>> {
    return this.coordinator.status(HostProjectIdSchema.parse(id));
  }

  @Get('index')
  @ApiOperation({ summary: 'Read the VM root index for a handover to the PC' })
  @ApiOkResponse({ description: 'Self-contained index snapshot, empty without an index' })
  index(
    @Param('id') id: string,
  ): Promise<HostHandlerResponse<typeof hostRoutes.gitCoordinatorIndex, 200>> {
    return this.coordinator.indexSnapshot(HostProjectIdSchema.parse(id));
  }

  @Post('home-write-begin')
  @HttpCode(200)
  @ApiOperation({ summary: 'Register a home Git write before spawning Git' })
  @ApiOkResponse({ description: 'Record with the unconfirmed write' })
  homeWriteBegin(@Param('id') id: string, @Body() body: unknown): Promise<GitCoordinatorRecord> {
    return this.coordinator.homeWriteBegin(
      HostProjectIdSchema.parse(id),
      hostRoutes.homeWriteBegin.body.parse(body),
    );
  }

  @Post('home-write-end')
  @HttpCode(200)
  @ApiOperation({ summary: 'Save a home checkpoint after the caller confirms its sync barrier' })
  @ApiOkResponse({ description: 'Record with checkpoint and the write removed' })
  homeWriteEnd(@Param('id') id: string, @Body() body: unknown): Promise<GitCoordinatorRecord> {
    return this.coordinator.homeWriteEnd(
      HostProjectIdSchema.parse(id),
      hostRoutes.homeWriteEnd.body.parse(body),
    );
  }

  @Post('handover-begin')
  @HttpCode(200)
  @ApiOperation({ summary: 'Close new VM holds and journal a leased home handover' })
  @ApiOkResponse({ description: 'Record with the pending handover' })
  begin(@Param('id') id: string, @Body() body: unknown): Promise<GitCoordinatorRecord> {
    return this.coordinator.beginHandover(
      HostProjectIdSchema.parse(id),
      hostRoutes.handoverBegin.body.parse(body),
    );
  }

  @Post('handover-renew')
  @HttpCode(200)
  @ApiOperation({ summary: 'Renew the pending home handover lease' })
  @ApiOkResponse({ description: 'Record with renewed lease' })
  renew(@Param('id') id: string, @Body() body: unknown): Promise<GitCoordinatorRecord> {
    return this.coordinator.renewHandover(
      HostProjectIdSchema.parse(id),
      hostRoutes.handoverRenew.body.parse(body),
    );
  }

  @Post('handover-abort')
  @HttpCode(200)
  @ApiOperation({ summary: 'Remove the pre-flip VM guard before reopening holds' })
  @ApiOkResponse({ description: 'Record after confirmed cleanup' })
  abort(@Param('id') id: string, @Body() body: unknown): Promise<GitCoordinatorRecord> {
    return this.coordinator.abortHandover(
      HostProjectIdSchema.parse(id),
      hostRoutes.handoverAbort.body.parse(body),
    );
  }

  @Post('handover-phase')
  @HttpCode(200)
  @ApiOperation({ summary: 'Advance a journaled handover phase' })
  @ApiOkResponse({ description: 'Record after the phase, with the recorded VM sequences' })
  phase(@Param('id') id: string, @Body() body: unknown): Promise<GitCoordinatorRecord> {
    return this.coordinator.handoverPhase(
      HostProjectIdSchema.parse(id),
      hostRoutes.handoverPhase.body.parse(body),
    );
  }

  @Post('handover-complete')
  @HttpCode(200)
  @ApiOperation({ summary: 'Acknowledge home guard removal and root index installation' })
  @ApiOkResponse({ description: 'Record with the handover cleared' })
  complete(@Param('id') id: string, @Body() body: unknown): Promise<GitCoordinatorRecord> {
    return this.coordinator.handoverComplete(
      HostProjectIdSchema.parse(id),
      hostRoutes.handoverComplete.body.parse(body),
    );
  }

  @Post('close')
  @HttpCode(200)
  @ApiOperation({ summary: 'Close Git admission while the project disconnects' })
  @ApiOkResponse({ description: 'Record with admission closed; in-flight work continues' })
  close(
    @Param('id') id: string,
  ): Promise<HostHandlerResponse<typeof hostRoutes.gitCoordinatorClose, 200>> {
    return this.coordinator.close(HostProjectIdSchema.parse(id));
  }

  @Post('reopen')
  @HttpCode(200)
  @ApiOperation({ summary: 'Admit Git again after a cancelled Disconnect' })
  @ApiOkResponse({ description: 'Record with admission open' })
  reopen(
    @Param('id') id: string,
  ): Promise<HostHandlerResponse<typeof hostRoutes.gitCoordinatorReopen, 200>> {
    return this.coordinator.reopen(HostProjectIdSchema.parse(id));
  }
}
