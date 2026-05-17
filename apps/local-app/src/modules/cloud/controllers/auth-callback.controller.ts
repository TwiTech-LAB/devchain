import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  HttpCode,
  HttpStatus,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { CloudSessionManagerService } from '../services/cloud-session-manager.service';
import { StoreCloudTokensSchema } from '../dtos/cloud-tokens.dto';

@Controller('api/auth/cloud')
export class AuthCallbackController {
  constructor(private readonly cloudSessionManager: CloudSessionManagerService) {}

  @Post('tokens')
  @HttpCode(HttpStatus.OK)
  async storeTokens(@Body() body: unknown): Promise<{ userId: string; email?: string }> {
    const parsed = StoreCloudTokensSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((i) => i.message).join('; '));
    }

    try {
      const tokens = await this.cloudSessionManager.storeTokens(
        parsed.data.accessToken,
        parsed.data.refreshToken,
      );
      return { userId: tokens.userId, email: tokens.email };
    } catch (error) {
      if (error instanceof Error && error.message.includes('JWT')) {
        throw new BadRequestException('Invalid access token');
      }
      throw new InternalServerErrorException('Failed to store cloud tokens');
    }
  }

  @Get('status')
  getStatus() {
    return this.cloudSessionManager.getStatus();
  }

  @Delete('session')
  @HttpCode(HttpStatus.NO_CONTENT)
  async disconnect(): Promise<void> {
    await this.cloudSessionManager.disconnect();
  }
}
