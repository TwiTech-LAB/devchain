import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { HostSshKeysService } from './host-ssh-keys.service';
import { hostRoutes } from '../contract/host-routes';

@Controller('api/host/ssh-keys')
export class HostSshKeysController {
  constructor(private readonly sshKeys: HostSshKeysService) {}

  @Post()
  @HttpCode(200)
  // The client ignores this body (contract status 'none'); add a schema when a caller reads it.
  apply(@Body() body: unknown): Promise<{ added: number }> {
    return this.sshKeys.apply(hostRoutes.applySshKeys.body.parse(body).keys);
  }
}
