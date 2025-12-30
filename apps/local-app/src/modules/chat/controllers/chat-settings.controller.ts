import { Body, Controller, Get, Put, Query } from '@nestjs/common';
import { ChatSettingsService } from '../services/chat-settings.service';
import { createLogger } from '../../../common/logging/logger';
import {
  ChatSettingsQuerySchema,
  ChatSettingsResponseSchema,
  UpdateChatSettingsSchema,
  type ChatSettingsResponseDto,
} from '../dtos/chat-settings.dto';
import { DEFAULT_INVITE_TEMPLATE } from '../services/invite-template.util';

const logger = createLogger('ChatSettingsController');

@Controller('api/chat')
export class ChatSettingsController {
  constructor(private readonly chatSettingsService: ChatSettingsService) {}

  @Get('settings')
  async getChatSettings(@Query() query: unknown): Promise<ChatSettingsResponseDto> {
    const { projectId } = ChatSettingsQuerySchema.parse(query);
    logger.info({ projectId }, 'GET /api/chat/settings');

    const storedTemplate = await this.chatSettingsService.getStoredInviteTemplate(projectId);
    const isDefault = !storedTemplate || storedTemplate.trim().length === 0;

    return ChatSettingsResponseSchema.parse({
      invite_template: isDefault ? DEFAULT_INVITE_TEMPLATE : storedTemplate,
      is_default: isDefault,
    });
  }

  @Put('settings')
  async updateChatSettings(@Body() body: unknown): Promise<ChatSettingsResponseDto> {
    const { projectId, invite_template: inviteTemplate = '' } =
      UpdateChatSettingsSchema.parse(body);
    logger.info({ projectId }, 'PUT /api/chat/settings');

    const effectiveTemplate = await this.chatSettingsService.updateInviteTemplate(
      projectId,
      inviteTemplate,
    );

    const isDefault = inviteTemplate.trim().length === 0;

    return ChatSettingsResponseSchema.parse({
      invite_template: effectiveTemplate,
      is_default: isDefault,
    });
  }
}
