import { Body, Controller, HttpCode, Param, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { RemoteApiKeyManagementService } from '../auth/remote-api-key-management.service';
import { RemoteApiKeySchema } from '../dtos/remote.dto';

const IdSchema = z.string().uuid();
const KeyBodySchema = z.object({ apiKey: RemoteApiKeySchema }).strict();

@Controller('api/remotes/:id/api-key')
export class RemoteApiKeyController {
  constructor(private readonly keys: RemoteApiKeyManagementService) {}

  @Put()
  @HttpCode(204)
  async enter(@Param('id') id: string, @Body() body: unknown): Promise<void> {
    const { apiKey } = KeyBodySchema.parse(body);
    await this.keys.enter(IdSchema.parse(id), apiKey);
  }

  @Post('reset')
  @HttpCode(204)
  async reset(@Param('id') id: string, @Body() body: unknown): Promise<void> {
    z.object({})
      .strict()
      .parse(body ?? {});
    await this.keys.reset(IdSchema.parse(id));
  }
}
