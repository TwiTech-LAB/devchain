import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import type { RemoteNoticeDto } from '../dtos/remote-notices.dto';
import { SharedVmDismissSchema } from '../host/shared-vm.contract';
import { HomeSharedVmNoticesService } from '../services/home-shared-vm-notices.service';

@Controller('api/remotes')
@ApiTags('Remote notices')
export class HomeSharedVmNoticesController {
  constructor(private readonly notices: HomeSharedVmNoticesService) {}

  @Get('notices')
  @ApiOperation({ summary: 'Read notices received from the registered VM instances' })
  @ApiResponse({ status: 200, description: 'Notices from successful health polls' })
  list(): { notices: RemoteNoticeDto[] } {
    return { notices: this.notices.list() };
  }

  @Post(':id/notices/dismiss')
  @HttpCode(204)
  @ApiOperation({ summary: 'Dismiss one notice in the VM instance inbox' })
  @ApiResponse({ status: 204, description: 'Notice dismissed' })
  @ApiResponse({ status: 502, description: 'The VM did not accept dismissal' })
  dismiss(@Param('id') remoteId: string, @Body() body: unknown): Promise<void> {
    return this.notices.dismiss(
      z.string().uuid().parse(remoteId),
      SharedVmDismissSchema.parse(body).id,
    );
  }
}
