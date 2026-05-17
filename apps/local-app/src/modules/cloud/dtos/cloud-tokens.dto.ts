import { z } from 'zod';

export const StoreCloudTokensSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
});

export type StoreCloudTokensDto = z.infer<typeof StoreCloudTokensSchema>;

export const MagicLinkRequestSchema = z.object({
  email: z.string().email(),
});

export type MagicLinkRequestDto = z.infer<typeof MagicLinkRequestSchema>;
