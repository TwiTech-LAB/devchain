import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { z } from 'zod';
import { SshPublicKeysSchema } from '../../../common/validation/ssh-public-key';
import { HostSshKeysService } from './host-ssh-keys.service';

const ApplySchema = z.object({ keys: SshPublicKeysSchema }).strict();

@Controller('api/host/ssh-keys')
export class HostSshKeysController {
  constructor(private readonly sshKeys: HostSshKeysService) {}

  @Post()
  @HttpCode(200)
  apply(@Body() body: unknown): Promise<{ added: number }> {
    return this.sshKeys.apply(ApplySchema.parse(body).keys);
  }
}
