import { z } from 'zod';
import { TEMPLATE_SIZE_LIMIT } from '../services/invite-template.util';

export const ChatSettingsQuerySchema = z.object({
  projectId: z.string().uuid(),
});

export const ChatSettingsResponseSchema = z.object({
  invite_template: z.string(),
  is_default: z.boolean(),
});

export const UpdateChatSettingsSchema = z.object({
  projectId: z.string().uuid(),
  invite_template: z.string().max(TEMPLATE_SIZE_LIMIT).optional(),
});

export type ChatSettingsQueryDto = z.infer<typeof ChatSettingsQuerySchema>;
export type ChatSettingsResponseDto = z.infer<typeof ChatSettingsResponseSchema>;
export type UpdateChatSettingsDto = z.infer<typeof UpdateChatSettingsSchema>;
